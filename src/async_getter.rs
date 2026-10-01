//! The `xxxAsync` halves of the read-only properties.
//!
//! A getter takes the process-wide lock, and on an ordinary dataset that is the
//! exclusive side: a getter called while a read is in flight waits for that read, with
//! the event loop stopped for the duration. The `xxxAsync` form does the same work on
//! the thread pool instead — the answer is identical, and the event loop keeps running
//! while it is waited for.
//!
//! Every one of them reads through the getter the synchronous side uses, on a band or
//! dataset rebuilt from the same handle: the work is shared, only the thread differs.
//!
//! The names are the reference's, and that is a deliberate exception. Everywhere else
//! the async form *drops* the `Sync` suffix rather than gaining an `Async` one
//! (`readPixelsSync` / `readPixels`). A getter has no zero-argument method form for the
//! async one to take — `band.dataType` is a property, so a `band.dataType()` cannot
//! exist beside it — which leaves `dataTypeAsync` as the only spelling that does not
//! collide.

use std::marker::PhantomData;

use napi::bindgen_prelude::*;
use napi::{Env, Error};

use crate::band::{BandKind, ColorTableEntry, JsRasterBand};
use crate::dataset::{DatasetRef, JsDataset, RasterSize};
use crate::dtype::DataType;
use crate::error::{GdalErrorCode, Result, bad_argument, into_status_error, split};
use crate::runtime::ensure_initialized;
use crate::spatial_ref::JsSpatialRef;

type OpResult<T> = std::result::Result<T, (GdalErrorCode, String)>;

fn op<T>(result: Result<T>) -> OpResult<T> {
    result.map_err(split)
}

/// The answer is not the shape this property has. Unreachable — the enum and the
/// implementations below are written to match — but a wrong `match` arm should say so
/// rather than panic in a worker thread.
fn wrong_shape(property: BandProperty, expected: &str) -> Error<GdalErrorCode> {
    bad_argument(format!(
        "{property:?} does not answer with {expected}; this is a bug in the binding"
    ))
}

/// Which read-only property of a band an `xxxAsync` getter wants. The variants are
/// grouped by the shape they answer with, which is the task's type parameter.
#[derive(Debug, Clone, Copy)]
pub enum BandProperty {
    Size,
    BlockSize,
    DataType,
    ColorInterpretation,
    Description,
    UnitType,
    NoDataValue,
    Scale,
    Offset,
    Minimum,
    Maximum,
    Id,
    ReadOnly,
    HasArbitraryOverviews,
    CategoryNames,
    ColorTable,
}

/// What one property answers with, and how to read it.
pub trait BandPropertyValue: Send + Sized + ToNapiValue + TypeName + 'static {
    fn read(property: BandProperty, band: &JsRasterBand) -> Result<Self>;
}

impl BandPropertyValue for Vec<u32> {
    fn read(property: BandProperty, band: &JsRasterBand) -> Result<Self> {
        match property {
            BandProperty::Size => band.size(),
            BandProperty::BlockSize => band.block_size(),
            other => Err(wrong_shape(other, "a size")),
        }
    }
}

impl BandPropertyValue for String {
    fn read(property: BandProperty, band: &JsRasterBand) -> Result<Self> {
        match property {
            BandProperty::DataType => Ok(band.data_type().name().to_string()),
            BandProperty::ColorInterpretation => band.color_interpretation(),
            other => Err(wrong_shape(other, "a string")),
        }
    }
}

impl BandPropertyValue for Option<String> {
    fn read(property: BandProperty, band: &JsRasterBand) -> Result<Self> {
        match property {
            BandProperty::Description => band.description(),
            BandProperty::UnitType => band.unit_type(),
            other => Err(wrong_shape(other, "a string or null")),
        }
    }
}

impl BandPropertyValue for Option<f64> {
    fn read(property: BandProperty, band: &JsRasterBand) -> Result<Self> {
        match property {
            BandProperty::NoDataValue => band.no_data_value(),
            BandProperty::Scale => band.scale(),
            BandProperty::Offset => band.offset(),
            BandProperty::Minimum => band.minimum(),
            BandProperty::Maximum => band.maximum(),
            other => Err(wrong_shape(other, "a number or null")),
        }
    }
}

impl BandPropertyValue for u32 {
    fn read(property: BandProperty, band: &JsRasterBand) -> Result<Self> {
        match property {
            BandProperty::Id => band.id(),
            other => Err(wrong_shape(other, "an index")),
        }
    }
}

impl BandPropertyValue for bool {
    fn read(property: BandProperty, band: &JsRasterBand) -> Result<Self> {
        match property {
            BandProperty::ReadOnly => band.read_only(),
            BandProperty::HasArbitraryOverviews => band.has_arbitrary_overviews(),
            other => Err(wrong_shape(other, "a flag")),
        }
    }
}

impl BandPropertyValue for Vec<String> {
    fn read(property: BandProperty, band: &JsRasterBand) -> Result<Self> {
        match property {
            BandProperty::CategoryNames => band.category_names(),
            other => Err(wrong_shape(other, "a list of names")),
        }
    }
}

impl BandPropertyValue for Option<Vec<ColorTableEntry>> {
    fn read(property: BandProperty, band: &JsRasterBand) -> Result<Self> {
        match property {
            BandProperty::ColorTable => band.color_table(),
            other => Err(wrong_shape(other, "a colour table")),
        }
    }
}

/// One band property, fetched on the thread pool.
pub struct BandPropertyTask<T> {
    dataset: DatasetRef,
    kind: BandKind,
    /// The band's sample type, cached on the handle it came from. `data_type` answers
    /// from this rather than asking GDAL, so it has to travel with the task.
    data_type: DataType,
    property: BandProperty,
    answer: PhantomData<T>,
}

impl<T: BandPropertyValue> Task for BandPropertyTask<T> {
    type Output = OpResult<T>;
    type JsValue = T;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let band = JsRasterBand::from_kind(self.dataset.clone(), self.kind, self.data_type);
        Ok(op(T::read(self.property, &band)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

impl JsRasterBand {
    /// The task for one of this band's properties. The `xxxAsync` methods themselves
    /// live beside the class they belong to — napi only registers an `impl` block that
    /// is in the module declaring the type.
    pub(crate) fn property<T: BandPropertyValue>(
        &self,
        property: BandProperty,
    ) -> AsyncTask<BandPropertyTask<T>> {
        ensure_initialized();
        AsyncTask::new(BandPropertyTask {
            dataset: self.dataset_ref().clone(),
            kind: self.kind(),
            data_type: self.data_type(),
            property,
            answer: PhantomData,
        })
    }
}

/// Which read-only property of a dataset an `xxxAsync` getter wants.
#[derive(Debug, Clone, Copy)]
pub enum DatasetProperty {
    RasterSize,
    GeoTransform,
}

/// What one dataset property answers with.
pub trait DatasetPropertyValue: Send + Sized + ToNapiValue + TypeName + 'static {
    fn read(property: DatasetProperty, dataset: &JsDataset) -> Result<Self>;
}

impl DatasetPropertyValue for RasterSize {
    fn read(property: DatasetProperty, dataset: &JsDataset) -> Result<Self> {
        match property {
            DatasetProperty::RasterSize => dataset.raster_size(),
            other => Err(bad_argument(format!(
                "{other:?} does not answer with a size; this is a bug in the binding"
            ))),
        }
    }
}

impl DatasetPropertyValue for Option<Vec<f64>> {
    fn read(property: DatasetProperty, dataset: &JsDataset) -> Result<Self> {
        match property {
            DatasetProperty::GeoTransform => dataset.geo_transform(),
            other => Err(bad_argument(format!(
                "{other:?} does not answer with a geotransform; this is a bug in the binding"
            ))),
        }
    }
}

/// One dataset property, fetched on the thread pool.
pub struct DatasetPropertyTask<T> {
    dataset: DatasetRef,
    property: DatasetProperty,
    answer: PhantomData<T>,
}

impl<T: DatasetPropertyValue> Task for DatasetPropertyTask<T> {
    type Output = OpResult<T>;
    type JsValue = T;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(op(T::read(
            self.property,
            &JsDataset::detached(self.dataset.clone()),
        )))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// The dataset's CRS, fetched on the thread pool. The CRS itself is not `Send`, so the
/// WKT crosses the boundary and the object is built again on the JS thread.
pub struct SpatialRefTask {
    dataset: DatasetRef,
}

impl Task for SpatialRefTask {
    type Output = OpResult<Option<String>>;
    type JsValue = Option<JsSpatialRef>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let dataset = JsDataset::detached(self.dataset.clone());
        let wkt = dataset
            .spatial_ref()
            .and_then(|spatial_ref| match spatial_ref {
                Some(spatial_ref) => spatial_ref.wkt().map(Some),
                None => Ok(None),
            });
        Ok(op(wkt))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        match output {
            Ok(None) => Ok(None),
            Ok(Some(wkt)) => JsSpatialRef::from_definition(wkt)
                .map(Some)
                .map_err(|error| {
                    let (code, reason) = split(error);
                    into_status_error(code, reason)
                }),
            Err((code, reason)) => Err(into_status_error(code, reason)),
        }
    }
}

impl JsDataset {
    /// The task for one of this dataset's properties — see `JsRasterBand::property`.
    pub(crate) fn property<T: DatasetPropertyValue>(
        &self,
        property: DatasetProperty,
    ) -> AsyncTask<DatasetPropertyTask<T>> {
        ensure_initialized();
        AsyncTask::new(DatasetPropertyTask {
            dataset: self.handle().clone(),
            property,
            answer: PhantomData,
        })
    }

    /// The task for this dataset's CRS, which cannot cross a thread boundary itself.
    pub(crate) fn spatial_ref_task(&self) -> AsyncTask<SpatialRefTask> {
        ensure_initialized();
        AsyncTask::new(SpatialRefTask {
            dataset: self.handle().clone(),
        })
    }
}
