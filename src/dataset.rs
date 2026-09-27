//! `Dataset`: opening, creating, and the dataset-level accessors.
//!
//! Everything that outlives a call hangs off a [`DatasetRef`], so that `Dataset`
//! and the `RasterBand`s it hands out share one GDAL handle, and so a `close()`
//! invalidates every derived object rather than leaving a dangling pointer
//! behind. The `gdal` crate's `RasterBand<'a>` borrows the `Dataset`, which is
//! exactly why we never store one: bands are re-derived from the handle on each
//! call.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

#[cfg(gd_thread_safe)]
use gdal::ThreadSafeDataset;
use gdal::cpl::CslStringList;
use gdal::spatial_ref::SpatialRef;
use gdal::vector::{FieldDefn, LayerAccess, LayerOptions, OGRFieldType, OGRwkbGeometryType};
use gdal::{Dataset as GdalDataset, DatasetOptions, DriverManager, GdalOpenFlags, Metadata};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde_json::Value;

use crate::band::JsRasterBand;
use crate::dtype::DataType;
use crate::error::{GdalErrorCode, IntoGdalResult, Result, bad_argument, into_status_error, split};
use crate::programs;
use crate::progress::{JsProgressSink, ProgressCallback, ProgressUpdate};
use crate::raster_io::{
    build_creation_options, create_dataset, overview_levels, overview_resampling,
};
use crate::runtime::{ensure_initialized, lock_gdal, lock_gdal_shared};
use crate::spatial_ref::JsSpatialRef;
use crate::vector::{FieldDefinition, JsLayer};

pub struct DatasetHandle {
    /// `None` once closed. That is what makes `close()` idempotent and turns any
    /// later use of a stale `Dataset` or `RasterBand` into a clear error.
    dataset: Option<GdalDataset>,
}

pub type SharedDataset = Arc<Mutex<DatasetHandle>>;

/// A poisoned lock is recovered from on purpose: a panic in one operation must
/// not brick every object that shares the handle.
pub fn lock_handle(shared: &SharedDataset) -> MutexGuard<'_, DatasetHandle> {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl DatasetHandle {
    pub fn get(&self) -> Result<&GdalDataset> {
        self.dataset
            .as_ref()
            .ok_or_else(|| bad_argument("the dataset is closed"))
    }

    pub fn get_mut(&mut self) -> Result<&mut GdalDataset> {
        self.dataset
            .as_mut()
            .ok_or_else(|| bad_argument("the dataset is closed"))
    }

    fn into_shared(dataset: GdalDataset) -> SharedDataset {
        Arc::new(Mutex::new(Self {
            dataset: Some(dataset),
        }))
    }
}

/// A handle to an open dataset. Two flavours, differing only in how access is
/// serialised:
///
/// * [`DatasetRef::Serialised`] is what `open`/`create` produce. Every operation
///   takes the process-wide GDAL lock in *write* mode plus this dataset's own
///   mutex, so nothing runs concurrently — which is what GDAL's process-global
///   error state requires.
/// * `DatasetRef::Concurrent` comes from `openThreadSafe` and holds a
///   `GDALGetThreadSafeDataset`. Pixel reads take the process-wide lock in *read*
///   mode and skip the per-dataset mutex, so several of them genuinely run at
///   once. Everything else still takes the write lock.
#[derive(Clone)]
pub enum DatasetRef {
    Serialised(SharedDataset),
    #[cfg(gd_thread_safe)]
    Concurrent {
        /// `Some` until `close()`. The `Option` is what makes `close()` work the
        /// same way here as it does for the serialised flavour: taking the
        /// dataset out drops the last reference and GDAL closes the file. A read
        /// already in flight holds a clone, so it finishes against a live handle
        /// and only *later* reads fail.
        dataset: Arc<Mutex<Option<ThreadSafeDataset>>>,
    },
}

/// Clone the thread-safe dataset out of its slot, or report that it is closed.
#[cfg(gd_thread_safe)]
fn concurrent(slot: &Arc<Mutex<Option<ThreadSafeDataset>>>) -> Result<ThreadSafeDataset> {
    let slot = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    slot.clone()
        .ok_or_else(|| bad_argument("the dataset is closed"))
}

/// What every write attempt on a thread-safe dataset is told.
fn read_only() -> Error<GdalErrorCode> {
    bad_argument(
        "a thread-safe dataset is read-only: use open() if you need to write, or to reach \
         vector layers",
    )
}

impl DatasetRef {
    /// Wrap a freshly opened dataset the ordinary way.
    pub fn serialised(dataset: GdalDataset) -> Self {
        Self::Serialised(DatasetHandle::into_shared(dataset))
    }

    /// Run `f` with **read** access, under the shared lock when this handle is
    /// concurrent.
    ///
    /// # Lock rules
    ///
    /// Only pixel reads call this. **The closure must not reach anything that
    /// takes the write lock**: `RwLock` is not reentrant, so that deadlocks the
    /// process. Concretely — no [`Self::with_exclusive`], no [`Self::with_mut`],
    /// no second dataset, no program call. `read_window` only touches GDAL, so it
    /// is safe.
    pub fn with<T>(&self, f: impl FnOnce(&GdalDataset) -> Result<T>) -> Result<T> {
        match self {
            Self::Serialised(shared) => {
                let _guard = lock_gdal();
                let handle = lock_handle(shared);
                f(handle.get()?)
            }
            #[cfg(gd_thread_safe)]
            Self::Concurrent { dataset } => {
                let _guard = lock_gdal_shared();
                // Cloned out rather than read in place, so `close()` does not have
                // to wait for a whole pixel read to finish.
                let dataset = concurrent(dataset)?;
                f(dataset.as_ref())
            }
        }
    }

    /// Run `f` with read access under the **write** lock, even for a concurrent
    /// handle.
    ///
    /// Everything other than a pixel read uses this, because the rest of the API
    /// reaches into GDAL in ways that touch global state.
    pub fn with_exclusive<T>(&self, f: impl FnOnce(&GdalDataset) -> Result<T>) -> Result<T> {
        match self {
            Self::Serialised(shared) => {
                let _guard = lock_gdal();
                let handle = lock_handle(shared);
                f(handle.get()?)
            }
            #[cfg(gd_thread_safe)]
            Self::Concurrent { dataset } => {
                let _guard = lock_gdal();
                let dataset = concurrent(dataset)?;
                f(dataset.as_ref())
            }
        }
    }

    /// Run `f` with write access. A thread-safe dataset is read-only by
    /// construction, so it refuses.
    pub fn with_mut<T>(&self, f: impl FnOnce(&mut GdalDataset) -> Result<T>) -> Result<T> {
        match self {
            Self::Serialised(shared) => {
                let _guard = lock_gdal();
                let mut handle = lock_handle(shared);
                f(handle.get_mut()?)
            }
            #[cfg(gd_thread_safe)]
            Self::Concurrent { .. } => Err(read_only()),
        }
    }

    /// Whether this handle can actually be read concurrently, for `dataset.threadSafe`.
    pub fn is_concurrent(&self) -> bool {
        match self {
            Self::Serialised(_) => false,
            #[cfg(gd_thread_safe)]
            Self::Concurrent { .. } => true,
        }
    }

    /// Reject vector access on a thread-safe handle.
    ///
    /// GDAL's thread-safe datasets are raster-only, so without this a layer call
    /// would fail with "layer index 0 is out of range" — true, but useless as an
    /// explanation.
    pub fn ensure_vector_capable(&self) -> Result<()> {
        if self.is_concurrent() {
            return Err(bad_argument(
                "a thread-safe dataset has no vector layers: GDAL's thread-safe datasets are \
                 read-only rasters. Use open() to read vector data instead.",
            ));
        }
        Ok(())
    }

    /// Release the handle. Idempotent.
    pub fn close(&self) -> Result<()> {
        match self {
            Self::Serialised(shared) => {
                let _guard = lock_gdal();
                let mut handle = lock_handle(shared);
                if let Some(dataset) = handle.dataset.take() {
                    dataset.close().gdal()?;
                }
                Ok(())
            }
            #[cfg(gd_thread_safe)]
            Self::Concurrent { dataset } => {
                // The write lock is what makes this safe: it waits for any read in
                // flight, and a read that already cloned the handle keeps it alive
                // until it is done, so nothing is closed from under it.
                let _guard = lock_gdal();
                let mut slot = dataset
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                *slot = None;
                Ok(())
            }
        }
    }
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct OpenOptions {
    /// Open for writing. Default false.
    pub update: Option<bool>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CreateOptions {
    /// Driver short name, e.g. `GTiff`, `GPKG`, `MEM`.
    pub driver: String,
    pub width: u32,
    pub height: u32,
    /// Default 1.
    pub band_count: Option<u32>,
    /// Default `Uint8`.
    pub data_type: Option<DataType>,
    /// Driver creation options, e.g. `{ TILED: true, COMPRESS: 'DEFLATE' }`.
    /// Values may be strings, numbers or booleans; GDAL wants text either way.
    pub options: Option<Value>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CreateLayerOptions {
    pub name: String,
    /// One of `Point`, `LineString`, `Polygon`, `MultiPoint`,
    /// `MultiLineString`, `MultiPolygon`, `GeometryCollection`, `Unknown`.
    /// Default `Unknown`.
    pub geometry_type: Option<String>,
    /// EPSG code for the layer CRS. Default: no CRS. Give this or `wkt`, not both.
    pub epsg: Option<u32>,
    /// CRS as WKT — a `SpatialRef`'s `wkt` getter is the usual source. Default: no
    /// CRS. Give this or `epsg`, not both.
    pub wkt: Option<String>,
    /// Driver creation options, e.g. `{ SPATIAL_INDEX: 'YES' }`.
    pub options: Option<Value>,
    /// Fields to declare up front — see `FieldDefinition`. Optional: without it,
    /// `createFeature` adds fields as it meets them, inferring each type from the
    /// first value it sees.
    pub fields: Option<Vec<FieldDefinition>>,
}

fn open_gdal(path: &str, update: bool) -> Result<GdalDataset> {
    ensure_initialized();
    let _guard = lock_gdal();

    let mut flags = GdalOpenFlags::GDAL_OF_RASTER | GdalOpenFlags::GDAL_OF_VECTOR;
    if update {
        flags |= GdalOpenFlags::GDAL_OF_UPDATE;
    }
    GdalDataset::open_ex(
        path,
        DatasetOptions {
            open_flags: flags,
            ..DatasetOptions::default()
        },
    )
    .gdal()
}

/// Open a dataset several threads can read at once.
///
/// GDAL only offers this for read-only rasters, which is why the flags stop at
/// `GDAL_OF_RASTER` — no `GDAL_OF_VECTOR`, no `GDAL_OF_UPDATE`.
#[cfg(gd_thread_safe)]
fn open_thread_safe_gdal(path: &str) -> Result<DatasetRef> {
    ensure_initialized();
    let _guard = lock_gdal();

    let dataset = GdalDataset::open_ex(
        path,
        DatasetOptions {
            open_flags: GdalOpenFlags::GDAL_OF_RASTER | GdalOpenFlags::GDAL_OF_THREAD_SAFE,
            ..DatasetOptions::default()
        },
    )
    .gdal()?;

    match dataset.try_into_thread_safe(GdalOpenFlags::GDAL_OF_RASTER) {
        Ok(dataset) => Ok(DatasetRef::Concurrent {
            dataset: Arc::new(Mutex::new(Some(dataset))),
        }),
        Err(err) => {
            let driver = err.into_inner().driver().short_name();
            Err(bad_argument(format!(
                "{driver} cannot be read from several threads: openThreadSafe() needs a read-only \
                 raster. Use open() and read it through the serialised API instead."
            )))
        }
    }
}

fn create_gdal(path: &str, options: &CreateOptions) -> Result<GdalDataset> {
    ensure_initialized();
    let _guard = lock_gdal();

    let driver = DriverManager::get_driver_by_name(&options.driver).gdal()?;
    create_dataset(
        &driver,
        path,
        options.width as usize,
        options.height as usize,
        options.band_count.unwrap_or(1) as usize,
        options.data_type.unwrap_or(DataType::Uint8),
        options.options.as_ref(),
    )
}

fn create_vector_gdal(path: &str, driver_name: &str) -> Result<GdalDataset> {
    ensure_initialized();
    let _guard = lock_gdal();

    let driver = DriverManager::get_driver_by_name(driver_name).gdal()?;
    driver.create_vector_only(path).gdal()
}

/// Build the pyramid. Takes `&mut Dataset` for two reasons: that is what
/// `build_overviews` asks for, and it is what refuses a thread-safe dataset —
/// which is read-only, so it could not write overviews anyway.
fn write_overviews(dataset: &mut GdalDataset, request: &BuildOverviewsRequest) -> Result<()> {
    let levels = match &request.levels {
        Some(levels) => levels.clone(),
        None => {
            let (width, height) = dataset.raster_size();
            overview_levels(width, height)
        }
    };

    dataset
        .build_overviews(request.resampling, &levels, &request.bands)
        .gdal()
}

/// The request that deletes overviews instead of building them.
fn remove_overviews_request() -> BuildOverviewsRequest {
    BuildOverviewsRequest {
        // Ignored with "NONE", which is GDAL's rule, and empty is honest about it.
        levels: Some(Vec::new()),
        resampling: "none",
        bands: Vec::new(),
    }
}

/// Removing overviews is the same call with the "NONE" resampling, which GDAL
/// reads as "delete them" — the mechanism behind `gdaladdo -clean`.
fn remove_overviews(dataset: &mut GdalDataset) -> Result<()> {
    dataset.build_overviews("NONE", &[], &[]).gdal()
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct BuildOverviewsOptions {
    /// Decimation factors to build, e.g. `[2, 4, 8]`. Default: powers of two
    /// until the smallest overview is below 256 pixels on its longer side, the
    /// rule `gdaladdo` documents. An empty list asks for no overviews at all.
    pub levels: Option<Vec<i32>>,
    /// One of `nearest` (default), `average`, `rms`, `gauss`, `bilinear`, `cubic`,
    /// `cubicspline`, `lanczos`, `average_magphase`, `mode`.
    pub resampling: Option<String>,
    /// Bands to build for, **0-based**. Default: every band. Note that GTiff —
    /// the only writable-overview driver compiled in here — refuses a partial
    /// list ("only supported when operating on all bands"), so this is handed to
    /// GDAL for the drivers that do accept it rather than quietly dropped.
    pub bands: Option<Vec<u32>>,
}

/// `BuildOverviewsOptions` with the resampling name checked and the band indices
/// translated. The levels are left as written, because the default depends on the
/// raster's size and that is only known once the dataset is in hand.
#[derive(Debug, Clone)]
pub struct BuildOverviewsRequest {
    levels: Option<Vec<i32>>,
    resampling: &'static str,
    /// GDAL's 1-based band numbers.
    bands: Vec<i32>,
}

pub fn build_overviews_request(
    options: Option<BuildOverviewsOptions>,
) -> Result<BuildOverviewsRequest> {
    let options = options.unwrap_or_default();

    let resampling = match options.resampling {
        Some(name) => overview_resampling(&name)?,
        None => "nearest",
    };

    if let Some(levels) = &options.levels
        && let Some(invalid) = levels.iter().find(|level| **level < 2)
    {
        return Err(bad_argument(format!(
            "overview levels are decimation factors, so each has to be at least 2, and {invalid} is not"
        )));
    }

    // The one place 0-based meets 1-based. GDAL takes band numbers, this API takes
    // indices, and an empty list means "all of them" on both sides.
    let bands = options
        .bands
        .unwrap_or_default()
        .into_iter()
        .map(|index| {
            i32::try_from(index)
                .map(|index| index + 1)
                .map_err(|_| bad_argument(format!("band index {index} is out of range")))
        })
        .collect::<Result<Vec<i32>>>()?;

    Ok(BuildOverviewsRequest {
        levels: options.levels,
        resampling,
        bands,
    })
}

#[napi(js_name = "Dataset")]
pub struct JsDataset {
    dataset: DatasetRef,
    path: String,
}

impl JsDataset {
    fn wrap_ref(dataset: DatasetRef, path: String) -> Self {
        Self { dataset, path }
    }

    fn wrap(dataset: GdalDataset, path: String) -> Self {
        Self::wrap_ref(DatasetRef::serialised(dataset), path)
    }
}

#[napi]
impl JsDataset {
    /// Path this dataset was opened from. Available without touching GDAL, and
    /// still readable after `close()`.
    #[napi(getter)]
    pub fn path(&self) -> String {
        self.path.clone()
    }

    /// Whether this handle is read concurrently. True only for `openThreadSafe`.
    #[napi(getter)]
    pub fn thread_safe(&self) -> bool {
        self.dataset.is_concurrent()
    }

    #[napi(getter)]
    pub fn driver(&self) -> Result<String> {
        self.dataset
            .with_exclusive(|dataset| Ok(dataset.driver().short_name()))
    }

    /// Raster width in pixels.
    #[napi(getter)]
    pub fn width(&self) -> Result<u32> {
        self.dataset
            .with_exclusive(|dataset| Ok(dataset.raster_size().0 as u32))
    }

    /// Raster height in pixels.
    #[napi(getter)]
    pub fn height(&self) -> Result<u32> {
        self.dataset
            .with_exclusive(|dataset| Ok(dataset.raster_size().1 as u32))
    }

    #[napi(getter)]
    pub fn band_count(&self) -> Result<u32> {
        self.dataset
            .with_exclusive(|dataset| Ok(dataset.raster_count() as u32))
    }

    /// Six affine geotransform coefficients, or `null` when the dataset has none
    /// (which is normal for an unreferenced raster).
    #[napi(getter)]
    pub fn geo_transform(&self) -> Result<Option<Vec<f64>>> {
        self.dataset
            .with_exclusive(|dataset| Ok(dataset.geo_transform().ok().map(|gt| gt.to_vec())))
    }

    /// Set the geotransform: `[originX, pixelWidth, rowRotation, originY,
    /// columnRotation, pixelHeight]`.
    #[napi]
    pub fn set_geo_transform(&self, transform: Vec<f64>) -> Result<()> {
        let array: [f64; 6] = transform.try_into().map_err(|values: Vec<f64>| {
            bad_argument(format!(
                "a geotransform needs exactly 6 numbers, got {}",
                values.len()
            ))
        })?;
        self.dataset
            .with_mut(|dataset| dataset.set_geo_transform(&array).gdal())
    }

    /// Set the CRS from a WKT string — see `epsgToWkt` for the usual way to get
    /// one. Anything an existing dataset or layer reports as `projection` /
    /// `spatialRefWkt` will do too.
    #[napi]
    pub fn set_projection(&self, wkt: String) -> Result<()> {
        self.dataset
            .with_mut(|dataset| dataset.set_projection(&wkt).gdal())
    }

    /// CRS as WKT, or `null` when the dataset has no projection.
    #[napi(getter)]
    pub fn projection(&self) -> Result<Option<String>> {
        self.dataset.with_exclusive(|dataset| {
            let wkt = dataset.projection();
            Ok(if wkt.is_empty() { None } else { Some(wkt) })
        })
    }

    /// The same CRS as `projection`, as an object — ready to hand to
    /// `CoordinateTransform`. `null` when the dataset has no projection.
    #[napi(getter)]
    pub fn spatial_ref(&self) -> Result<Option<JsSpatialRef>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let wkt = dataset.projection();
            if wkt.is_empty() {
                return Ok(None);
            }
            Ok(Some(JsSpatialRef::wrap(SpatialRef::from_wkt(&wkt).gdal()?)))
        })
    }

    /// Key/value metadata for `domain` (default: the plain-string domain).
    ///
    /// `IMAGE_STRUCTURE` lives here rather than on a band, which is how you check
    /// what a `createCopy` to COG actually produced.
    #[napi]
    pub fn metadata(&self, domain: Option<String>) -> Result<HashMap<String, String>> {
        let domain = domain.unwrap_or_default();
        self.dataset.with_exclusive(|dataset| {
            let mut out = HashMap::new();
            for entry in dataset.metadata() {
                if entry.domain == domain {
                    out.insert(entry.key, entry.value);
                }
            }
            Ok(out)
        })
    }

    #[napi]
    pub fn metadata_domains(&self) -> Result<Vec<String>> {
        self.dataset
            .with_exclusive(|dataset| Ok(dataset.metadata_domains()))
    }

    #[napi]
    pub fn set_metadata_item(
        &self,
        key: String,
        value: String,
        domain: Option<String>,
    ) -> Result<()> {
        let domain = domain.unwrap_or_default();
        self.dataset
            .with_mut(|dataset| dataset.set_metadata_item(&key, &value, &domain).gdal())
    }

    /// Band at `index`, **0-based** (GDAL itself is 1-based).
    #[napi]
    pub fn band(&self, index: u32) -> Result<JsRasterBand> {
        ensure_initialized();
        let data_type = self.dataset.with_exclusive(|dataset| {
            let band_count = dataset.raster_count();
            if index as usize >= band_count {
                return Err(bad_argument(format!(
                    "band index {index} is out of range: the dataset has {band_count} band(s)"
                )));
            }
            Ok(DataType::from_gdal(
                dataset.rasterband(index as usize + 1).gdal()?.band_type(),
            ))
        })?;

        Ok(JsRasterBand::new(
            self.dataset.clone(),
            index as usize,
            data_type,
        ))
    }

    #[napi]
    pub fn bands(&self) -> Result<Vec<JsRasterBand>> {
        let band_count = self
            .dataset
            .with_exclusive(|dataset| Ok(dataset.raster_count()))?;
        (0..band_count as u32)
            .map(|index| self.band(index))
            .collect()
    }

    /// Create a new vector layer, with `epsg` as its CRS. Lay the fields out by
    /// writing a feature whose properties name them — see `Layer.createFeature`.
    #[napi]
    pub fn create_layer(&self, options: CreateLayerOptions) -> Result<JsLayer> {
        ensure_initialized();
        self.dataset.ensure_vector_capable()?;

        let geometry_type = match &options.geometry_type {
            Some(name) => crate::vector::geometry_type_from_name(name)?,
            None => OGRwkbGeometryType::wkbUnknown,
        };
        // A CRS given twice is ambiguity rather than redundancy, so refuse.
        let srs = match (&options.wkt, options.epsg) {
            (Some(_), Some(_)) => {
                return Err(bad_argument(
                    "give the layer a CRS with `epsg` or `wkt`, not both",
                ));
            }
            (Some(wkt), None) => {
                // Resolving a CRS reaches into GDAL, so it happens under the lock.
                let _guard = lock_gdal();
                Some(SpatialRef::from_wkt(wkt).gdal()?)
            }
            (None, Some(code)) => {
                let _guard = lock_gdal();
                Some(SpatialRef::from_epsg(code).gdal()?)
            }
            (None, None) => None,
        };

        // Declared fields are checked here, before the lock, so a typo is thrown by
        // the call rather than half-way through creating the layer.
        let declared_fields: Vec<(String, OGRFieldType::Type, Option<i32>, Option<i32>)> = options
            .fields
            .unwrap_or_default()
            .into_iter()
            .map(|field| {
                Ok((
                    field.name,
                    crate::vector::field_type_from_name(&field.field_type)?,
                    field.width,
                    field.precision,
                ))
            })
            .collect::<Result<_>>()?;

        // GDAL takes layer creation options as `name=value` strings.
        let layer_options: Vec<String> = crate::json::option_pairs(options.options.as_ref())?
            .into_iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect();
        let layer_option_refs: Vec<&str> = layer_options.iter().map(String::as_str).collect();

        let index = self.dataset.with_mut(|dataset| {
            // A driver is free to name the layer differently, so record the
            // position rather than assuming it lands at the end.
            let index = dataset.layer_count();
            let layer = dataset
                .create_layer(LayerOptions {
                    name: &options.name,
                    srs: srs.as_ref(),
                    ty: geometry_type,
                    options: if layer_option_refs.is_empty() {
                        None
                    } else {
                        Some(layer_option_refs.as_slice())
                    },
                })
                .gdal()?;

            // Declared fields go in while the layer is in hand, so the schema
            // exists before the first feature does — and so a field keeps the type
            // it was declared with rather than the one inference would have picked.
            for (name, field_type, width, precision) in &declared_fields {
                let definition = FieldDefn::new(name, *field_type).gdal()?;
                if let Some(width) = width {
                    definition.set_width(*width);
                }
                if let Some(precision) = precision {
                    definition.set_precision(*precision);
                }
                definition.add_to_layer(&layer).gdal()?;
            }
            Ok(index)
        })?;

        Ok(JsLayer::new(self.dataset.clone(), index))
    }

    /// Number of vector layers.
    #[napi(getter)]
    pub fn layer_count(&self) -> Result<u32> {
        self.dataset.ensure_vector_capable()?;
        self.dataset
            .with_exclusive(|dataset| Ok(dataset.layer_count() as u32))
    }

    /// Layer at `index`, **0-based**.
    #[napi]
    pub fn layer(&self, index: u32) -> Result<JsLayer> {
        ensure_initialized();
        self.dataset.ensure_vector_capable()?;
        let layer_count = self
            .dataset
            .with_exclusive(|dataset| Ok(dataset.layer_count()))?;

        if index as usize >= layer_count {
            return Err(bad_argument(format!(
                "layer index {index} is out of range: the dataset has {layer_count} layer(s)"
            )));
        }
        Ok(JsLayer::new(self.dataset.clone(), index as usize))
    }

    #[napi]
    pub fn layer_by_name(&self, name: String) -> Result<JsLayer> {
        ensure_initialized();
        self.dataset.ensure_vector_capable()?;
        let found = self.dataset.with_exclusive(|dataset| {
            for candidate in 0..dataset.layer_count() {
                if dataset.layer(candidate).gdal()?.name() == name {
                    return Ok(Some(candidate));
                }
            }
            Ok(None)
        })?;

        match found {
            Some(index) => Ok(JsLayer::new(self.dataset.clone(), index)),
            None => Err(bad_argument(format!("no layer named {name:?}"))),
        }
    }

    #[napi]
    pub fn layers(&self) -> Result<Vec<JsLayer>> {
        self.dataset.ensure_vector_capable()?;
        let layer_count = self
            .dataset
            .with_exclusive(|dataset| Ok(dataset.layer_count()))?;
        (0..layer_count as u32)
            .map(|index| self.layer(index))
            .collect()
    }

    /// Write a copy of this dataset through another driver.
    ///
    /// This is the only road to drivers that implement `CreateCopy` but not
    /// `Create` — the COG driver is the one people ask for. `driver` is a short
    /// name such as `COG` or `JPEG`, and `options` are that driver's creation
    /// options (`{ COMPRESS: 'DEFLATE', BLOCKSIZE: 512 }`).
    #[napi]
    pub fn create_copy_sync(
        &self,
        path: String,
        driver: String,
        options: Option<Value>,
    ) -> Result<JsDataset> {
        ensure_initialized();
        let driver = DriverManager::get_driver_by_name(&driver).gdal()?;
        let creation_options = build_creation_options(options.as_ref())?;

        let dataset = self.dataset.with_exclusive(|source| {
            source.create_copy(&driver, &path, &creation_options).gdal()
        })?;
        Ok(JsDataset::wrap(dataset, path))
    }

    #[napi(ts_return_type = "Promise<Dataset>")]
    pub fn create_copy(
        &self,
        path: String,
        driver: String,
        options: Option<Value>,
    ) -> Result<AsyncTask<CopyTask>> {
        Ok(AsyncTask::new(CopyTask {
            dataset: self.dataset.clone(),
            path,
            driver,
            // `CslStringList` wraps a raw GDAL pointer, so the task carries plain
            // pairs and rebuilds the list on the worker thread.
            options: crate::json::option_pairs(options.as_ref())?,
        }))
    }

    #[napi]
    pub fn flush_sync(&self) -> Result<()> {
        self.dataset
            .with_mut(|dataset| dataset.flush_cache().gdal())
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn flush(&self) -> AsyncTask<FlushTask> {
        AsyncTask::new(FlushTask {
            dataset: self.dataset.clone(),
        })
    }

    /// Idempotent. After this every band object belonging to the dataset fails
    /// loudly instead of touching freed memory.
    #[napi]
    pub fn close(&self) -> Result<()> {
        self.dataset.close()
    }

    /// Run one of `gdaldem`'s terrain algorithms on this dataset: `hillshade`,
    /// `slope`, `aspect`, `color-relief`, `tri`, `tpi` or `roughness`.
    ///
    /// `args` are gdaldem's own command-line arguments, e.g.
    /// `['-az', '315', '-alt', '45']` for a hillshade. `colorFile` is read only by
    /// `color-relief`, which takes its palette from a separate file.
    ///
    /// The source wants a geotransform, and slope or aspect want a CRS with metric
    /// units — without one GDAL computes in pixel units, and says so.
    #[napi]
    pub fn dem_process_sync(
        &self,
        dest: String,
        algorithm: String,
        args: Option<Vec<String>>,
        color_file: Option<String>,
    ) -> Result<JsDataset> {
        let algorithm = programs::dem_algorithm(&algorithm)?;
        let args = args.unwrap_or_default();

        let dataset = self.dataset.with_exclusive(|source| {
            programs::dem_process(&dest, algorithm, color_file.as_deref(), source, &args)
        })?;
        Ok(JsDataset::wrap(dataset, dest))
    }

    #[napi(ts_return_type = "Promise<Dataset>")]
    pub fn dem_process(
        &self,
        dest: String,
        algorithm: String,
        args: Option<Vec<String>>,
        color_file: Option<String>,
        on_progress: Option<
            ThreadsafeFunction<ProgressUpdate, bool, ProgressUpdate, Status, false>,
        >,
    ) -> Result<AsyncTask<DemTask>> {
        Ok(AsyncTask::new(DemTask {
            // Checked here so a typo is thrown by the call rather than by the worker.
            algorithm: programs::dem_algorithm(&algorithm)?,
            dest,
            color_file,
            sources: ProgramSources::Open(self.dataset.clone()),
            args: args.unwrap_or_default(),
            progress: on_progress.map(Arc::new),
        }))
    }

    /// Delete a layer, **by name**.
    ///
    /// By name rather than by index because deleting shifts every later index, so
    /// a list of indices to delete is a trap. Not every driver can do it — GeoPackage
    /// can, an ESRI Shapefile cannot, and GDAL says so when asked.
    #[napi]
    pub fn delete_layer(&self, name: String) -> Result<()> {
        ensure_initialized();
        self.dataset.ensure_vector_capable()?;

        self.dataset.with_mut(|dataset| {
            let mut found = None;
            for candidate in 0..dataset.layer_count() {
                if dataset.layer(candidate).gdal()?.name() == name {
                    found = Some(candidate);
                    break;
                }
            }
            let index = found.ok_or_else(|| bad_argument(format!("no layer named {name:?}")))?;
            dataset.delete_layer(index).gdal()
        })
    }

    /// Remove every overview level — the counterpart of `buildOverviews`.
    ///
    /// The same call, with the "NONE" resampling that GDAL reads as "delete them",
    /// which is how `gdaladdo -clean` prunes a pyramid.
    #[napi]
    pub fn remove_overviews_sync(&self) -> Result<()> {
        self.dataset.with_mut(remove_overviews)
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn remove_overviews(&self) -> AsyncTask<BuildOverviewsTask> {
        AsyncTask::new(BuildOverviewsTask {
            dataset: self.dataset.clone(),
            request: remove_overviews_request(),
        })
    }

    /// Build overviews — a pyramid of progressively smaller copies — so reads at
    /// reduced resolution do not have to touch every pixel.
    ///
    /// This is the slowest call in the binding: it reads the raster and writes
    /// lower-resolution versions of it. Use the async form. Setting
    /// `GDAL_NUM_THREADS=ALL_CPUS` lets GDAL compute the levels in parallel, which
    /// is worth doing for a large raster.
    ///
    /// Where the overviews land depends on how the dataset was opened: with
    /// `{ update: true }` they go inside the file, while a read-only dataset gets
    /// an external `.ovr` beside it. That mirrors `gdaladdo`, where the same
    /// choice is `-ro`.
    #[napi]
    pub fn build_overviews_sync(&self, options: Option<BuildOverviewsOptions>) -> Result<()> {
        let request = build_overviews_request(options)?;
        self.dataset
            .with_mut(|dataset| write_overviews(dataset, &request))
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn build_overviews(
        &self,
        options: Option<BuildOverviewsOptions>,
    ) -> Result<AsyncTask<BuildOverviewsTask>> {
        let request = build_overviews_request(options)?;
        Ok(AsyncTask::new(BuildOverviewsTask {
            dataset: self.dataset.clone(),
            request,
        }))
    }

    /// Run `gdal_translate` on this dataset.
    ///
    /// `args` are GDAL's own command-line arguments, so anything in its
    /// documentation can be pasted in: `['-of', 'COG', '-co', 'COMPRESS=DEFLATE']`.
    /// There is no need to name the source or the destination — this dataset is
    /// the source and `dest` is the destination.
    #[napi]
    pub fn translate_sync(&self, dest: String, args: Option<Vec<String>>) -> Result<JsDataset> {
        let args = args.unwrap_or_default();
        let dataset = self.dataset.with_exclusive(|source| {
            programs::run(programs::Program::Translate, &dest, &[source], &args)
        })?;
        Ok(JsDataset::wrap(dataset, dest))
    }

    #[napi(ts_return_type = "Promise<Dataset>")]
    pub fn translate(
        &self,
        dest: String,
        args: Option<Vec<String>>,
        on_progress: Option<
            ThreadsafeFunction<ProgressUpdate, bool, ProgressUpdate, Status, false>,
        >,
    ) -> AsyncTask<ProgramTask> {
        program_task(
            programs::Program::Translate,
            dest,
            self.dataset.clone(),
            args,
            on_progress.map(Arc::new),
        )
    }

    /// Run `gdalwarp` with this dataset as its only source.
    #[napi]
    pub fn warp_sync(&self, dest: String, args: Option<Vec<String>>) -> Result<JsDataset> {
        let args = args.unwrap_or_default();
        let dataset = self.dataset.with_exclusive(|source| {
            programs::run(programs::Program::Warp, &dest, &[source], &args)
        })?;
        Ok(JsDataset::wrap(dataset, dest))
    }

    #[napi(ts_return_type = "Promise<Dataset>")]
    pub fn warp(
        &self,
        dest: String,
        args: Option<Vec<String>>,
        on_progress: Option<
            ThreadsafeFunction<ProgressUpdate, bool, ProgressUpdate, Status, false>,
        >,
    ) -> AsyncTask<ProgramTask> {
        program_task(
            programs::Program::Warp,
            dest,
            self.dataset.clone(),
            args,
            on_progress.map(Arc::new),
        )
    }

    /// Run `GDALVectorTranslate` (ogr2ogr) with this dataset as its only source.
    ///
    /// An existing layer is replaced by default; `-overwrite` drops the destination
    /// *file* first, which is what ogr2ogr's own flag does, and `-append` asks for
    /// the other behaviour.
    #[napi]
    pub fn vector_translate_sync(
        &self,
        dest: String,
        args: Option<Vec<String>>,
    ) -> Result<JsDataset> {
        let args = args.unwrap_or_default();
        let dataset = self.dataset.with_exclusive(|source| {
            programs::run(programs::Program::VectorTranslate, &dest, &[source], &args)
        })?;
        Ok(JsDataset::wrap(dataset, dest))
    }

    #[napi(ts_return_type = "Promise<Dataset>")]
    pub fn vector_translate(
        &self,
        dest: String,
        args: Option<Vec<String>>,
        on_progress: Option<
            ThreadsafeFunction<ProgressUpdate, bool, ProgressUpdate, Status, false>,
        >,
    ) -> AsyncTask<ProgramTask> {
        program_task(
            programs::Program::VectorTranslate,
            dest,
            self.dataset.clone(),
            args,
            on_progress.map(Arc::new),
        )
    }
}

/// `Task::compute` must be `Send`, and `napi::Error` is not guaranteed to be, so
/// failures travel as a plain pair and are rebuilt on the JS thread.
type OpResult<T> = std::result::Result<T, (GdalErrorCode, String)>;

fn op<T>(result: Result<T>) -> OpResult<T> {
    result.map_err(split)
}

/// What `OpenTask` should produce. One task type covers opening, raster creation,
/// vector creation and thread-safe opening, so the async surface stays uniform and
/// `napi::Task` is implemented only once.
enum OpenKind {
    Open {
        update: bool,
    },
    CreateRaster(CreateOptions),
    CreateVector {
        driver: String,
    },
    #[cfg(gd_thread_safe)]
    ThreadSafe,
}

pub struct OpenTask {
    path: String,
    kind: OpenKind,
}

impl Task for OpenTask {
    type Output = OpResult<DatasetRef>;
    type JsValue = JsDataset;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(op(match &self.kind {
            OpenKind::Open { update } => open_gdal(&self.path, *update).map(DatasetRef::serialised),
            OpenKind::CreateRaster(options) => {
                create_gdal(&self.path, options).map(DatasetRef::serialised)
            }
            OpenKind::CreateVector { driver } => {
                create_vector_gdal(&self.path, driver).map(DatasetRef::serialised)
            }
            #[cfg(gd_thread_safe)]
            OpenKind::ThreadSafe => open_thread_safe_gdal(&self.path),
        }))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(|dataset| JsDataset::wrap_ref(dataset, self.path.clone()))
            .map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Open an existing dataset. Runs on the libuv thread pool, so the event loop
/// stays free while GDAL reads the header.
#[napi(ts_return_type = "Promise<Dataset>")]
pub fn open(path: String, options: Option<OpenOptions>) -> AsyncTask<OpenTask> {
    let update = options.and_then(|options| options.update).unwrap_or(false);
    AsyncTask::new(OpenTask {
        path,
        kind: OpenKind::Open { update },
    })
}

#[napi]
pub fn open_sync(path: String, options: Option<OpenOptions>) -> Result<JsDataset> {
    let update = options.and_then(|options| options.update).unwrap_or(false);
    Ok(JsDataset::wrap(open_gdal(&path, update)?, path))
}

/// Open a read-only raster that several worker threads can read at the same time.
///
/// This is the only way to get real GDAL parallelism out of this binding: with
/// `open()` every call is serialised behind one process-wide lock. The trade-offs
/// are in the README — most drivers end up reopening the file per thread, so a high
/// read concurrency costs file descriptors.
#[cfg(gd_thread_safe)]
#[napi(ts_return_type = "Promise<Dataset>")]
pub fn open_thread_safe(path: String) -> AsyncTask<OpenTask> {
    AsyncTask::new(OpenTask {
        path,
        kind: OpenKind::ThreadSafe,
    })
}

#[cfg(gd_thread_safe)]
#[napi]
pub fn open_thread_safe_sync(path: String) -> Result<JsDataset> {
    Ok(JsDataset::wrap_ref(open_thread_safe_gdal(&path)?, path))
}

/// Create a raster dataset. `options.driver` must name a driver that supports
/// `Create` (GTiff, GPKG, MEM, ...); `band_count` defaults to 1 and
/// `data_type` to `Uint8`.
#[napi(ts_return_type = "Promise<Dataset>")]
pub fn create(path: String, options: CreateOptions) -> AsyncTask<OpenTask> {
    AsyncTask::new(OpenTask {
        path,
        kind: OpenKind::CreateRaster(options),
    })
}

#[napi]
pub fn create_sync(path: String, options: CreateOptions) -> Result<JsDataset> {
    Ok(JsDataset::wrap(create_gdal(&path, &options)?, path))
}

/// Create an empty vector dataset. Add layers with `dataset.createLayer(...)`.
#[napi(ts_return_type = "Promise<Dataset>")]
pub fn create_vector(path: String, driver: String) -> AsyncTask<OpenTask> {
    AsyncTask::new(OpenTask {
        path,
        kind: OpenKind::CreateVector { driver },
    })
}

#[napi]
pub fn create_vector_sync(path: String, driver: String) -> Result<JsDataset> {
    Ok(JsDataset::wrap(create_vector_gdal(&path, &driver)?, path))
}

// ---------------------------------------------------------------------------
// gdal_translate / gdalwarp / ogr2ogr, named by path
//
// The `Dataset` methods above cover an already-open source. These cover the case
// where it is not open — and, for `warp` and `vectorTranslate`, more than one.
// ---------------------------------------------------------------------------

/// `gdal_translate <args> source dest`, as one call.
#[napi(ts_return_type = "Promise<Dataset>")]
pub fn translate(
    dest: String,
    source: String,
    args: Option<Vec<String>>,
    on_progress: Option<ThreadsafeFunction<ProgressUpdate, bool, ProgressUpdate, Status, false>>,
) -> AsyncTask<ProgramTask> {
    program_task_paths(
        programs::Program::Translate,
        dest,
        vec![source],
        args,
        on_progress.map(Arc::new),
    )
}

#[napi]
pub fn translate_sync(
    dest: String,
    source: String,
    args: Option<Vec<String>>,
) -> Result<JsDataset> {
    let args = args.unwrap_or_default();
    let dataset =
        programs::run_with_paths(programs::Program::Translate, &dest, &[source], &args, None)?;
    Ok(JsDataset::wrap(dataset, dest))
}

/// `gdalwarp <args> sources... dest`, as one call. Several sources merge.
#[napi(ts_return_type = "Promise<Dataset>")]
pub fn warp(
    dest: String,
    sources: Vec<String>,
    args: Option<Vec<String>>,
    on_progress: Option<ThreadsafeFunction<ProgressUpdate, bool, ProgressUpdate, Status, false>>,
) -> AsyncTask<ProgramTask> {
    program_task_paths(
        programs::Program::Warp,
        dest,
        sources,
        args,
        on_progress.map(Arc::new),
    )
}

#[napi]
pub fn warp_sync(
    dest: String,
    sources: Vec<String>,
    args: Option<Vec<String>>,
) -> Result<JsDataset> {
    let args = args.unwrap_or_default();
    let dataset = programs::run_with_paths(programs::Program::Warp, &dest, &sources, &args, None)?;
    Ok(JsDataset::wrap(dataset, dest))
}

/// `ogr2ogr <args> dest sources...`, as one call.
#[napi(ts_return_type = "Promise<Dataset>")]
pub fn vector_translate(
    dest: String,
    sources: Vec<String>,
    args: Option<Vec<String>>,
    on_progress: Option<ThreadsafeFunction<ProgressUpdate, bool, ProgressUpdate, Status, false>>,
) -> AsyncTask<ProgramTask> {
    program_task_paths(
        programs::Program::VectorTranslate,
        dest,
        sources,
        args,
        on_progress.map(Arc::new),
    )
}

#[napi]
pub fn vector_translate_sync(
    dest: String,
    sources: Vec<String>,
    args: Option<Vec<String>>,
) -> Result<JsDataset> {
    let args = args.unwrap_or_default();
    let dataset = programs::run_with_paths(
        programs::Program::VectorTranslate,
        &dest,
        &sources,
        &args,
        None,
    )?;
    Ok(JsDataset::wrap(dataset, dest))
}

fn program_task(
    program: programs::Program,
    dest: String,
    dataset: DatasetRef,
    args: Option<Vec<String>>,
    progress: Option<Arc<ProgressCallback>>,
) -> AsyncTask<ProgramTask> {
    AsyncTask::new(ProgramTask {
        program,
        dest,
        sources: ProgramSources::Open(dataset),
        args: args.unwrap_or_default(),
        progress,
    })
}

fn program_task_paths(
    program: programs::Program,
    dest: String,
    sources: Vec<String>,
    args: Option<Vec<String>>,
    progress: Option<Arc<ProgressCallback>>,
) -> AsyncTask<ProgramTask> {
    AsyncTask::new(ProgramTask {
        program,
        dest,
        sources: ProgramSources::Paths(sources),
        args: args.unwrap_or_default(),
        progress,
    })
}

/// `gdaldem <algorithm> source dest`, as one call. `colorFile` is read only by the
/// `color-relief` algorithm.
///
/// `onProgress` runs on the JS thread while the work happens on a worker, and
/// returning `false` from it cancels — see the progress section of the README.
#[napi(ts_return_type = "Promise<Dataset>")]
pub fn dem_process(
    dest: String,
    source: String,
    algorithm: String,
    args: Option<Vec<String>>,
    color_file: Option<String>,
    on_progress: Option<ThreadsafeFunction<ProgressUpdate, bool, ProgressUpdate, Status, false>>,
) -> Result<AsyncTask<DemTask>> {
    Ok(AsyncTask::new(DemTask {
        algorithm: programs::dem_algorithm(&algorithm)?,
        dest,
        color_file,
        sources: ProgramSources::Paths(vec![source]),
        args: args.unwrap_or_default(),
        progress: on_progress.map(Arc::new),
    }))
}

#[napi]
pub fn dem_process_sync(
    dest: String,
    source: String,
    algorithm: String,
    args: Option<Vec<String>>,
    color_file: Option<String>,
) -> Result<JsDataset> {
    let algorithm = programs::dem_algorithm(&algorithm)?;
    let args = args.unwrap_or_default();

    let dataset = dem_with_paths(
        algorithm,
        &dest,
        color_file.as_deref(),
        &[source],
        &args,
        None,
    )?;
    Ok(JsDataset::wrap(dataset, dest))
}

/// Open the source and run the terrain tool on it, holding the lock throughout.
fn dem_with_paths(
    algorithm: &str,
    dest: &str,
    color_file: Option<&str>,
    paths: &[String],
    args: &[String],
    progress: Option<&dyn programs::ProgressSink>,
) -> Result<GdalDataset> {
    ensure_initialized();
    let _guard = lock_gdal();

    let opened = paths
        .iter()
        .map(|path| {
            GdalDataset::open_ex(
                path,
                DatasetOptions {
                    open_flags: GdalOpenFlags::GDAL_OF_RASTER,
                    ..DatasetOptions::default()
                },
            )
            .gdal()
        })
        .collect::<Result<Vec<_>>>()?;

    if opened.len() != 1 {
        return Err(bad_argument("gdaldem takes exactly one source dataset"));
    }
    programs::dem_process_with_progress(dest, algorithm, color_file, &opened[0], args, progress)
}

/// `gdaldem` on the thread pool: each algorithm reads the whole raster, so it
/// belongs off the event loop just as much as a warp does.
pub struct DemTask {
    algorithm: &'static str,
    dest: String,
    color_file: Option<String>,
    sources: ProgramSources,
    args: Vec<String>,
    /// Present only when the caller asked for progress. The sync entry points have
    /// no way to run it, so they pass `None` — see `programs::run_with_progress`.
    progress: Option<Arc<ProgressCallback>>,
}

impl Task for DemTask {
    type Output = OpResult<GdalDataset>;
    type JsValue = JsDataset;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let DemTask {
            algorithm,
            dest,
            color_file,
            sources,
            args,
            progress,
        } = self;

        // The sink owns whatever the callback needs; `progress` below is the trait
        // object the programs take, and is `None` when nobody asked.
        let sink = progress
            .as_ref()
            .map(|callback| JsProgressSink::new(Arc::clone(callback)));
        let progress = sink
            .as_ref()
            .map(|sink| sink as &dyn programs::ProgressSink);

        Ok(op(match sources {
            ProgramSources::Paths(paths) => dem_with_paths(
                algorithm,
                dest,
                color_file.as_deref(),
                paths,
                args,
                progress,
            ),
            ProgramSources::Open(dataset) => dataset.with_exclusive(|source| {
                programs::dem_process_with_progress(
                    dest,
                    algorithm,
                    color_file.as_deref(),
                    source,
                    args,
                    progress,
                )
            }),
        }))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(|dataset| JsDataset::wrap(dataset, self.dest.clone()))
            .map_err(|(code, reason)| into_status_error(code, reason))
    }
}

pub struct FlushTask {
    dataset: DatasetRef,
}

impl Task for FlushTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(op(self
            .dataset
            .with_mut(|dataset| dataset.flush_cache().gdal())))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// `createCopy` on the thread pool: writing a whole COG is exactly the kind of
/// operation that should not hold up the event loop.
pub struct CopyTask {
    dataset: DatasetRef,
    path: String,
    driver: String,
    options: Vec<(String, String)>,
}

impl Task for CopyTask {
    type Output = OpResult<GdalDataset>;
    type JsValue = JsDataset;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let CopyTask {
            dataset,
            path,
            driver,
            options,
        } = self;

        Ok(op(dataset.with_exclusive(|source| {
            let driver = DriverManager::get_driver_by_name(driver).gdal()?;

            let mut list = CslStringList::new();
            for (name, value) in options.iter() {
                list.add_name_value(name, value).gdal()?;
            }

            source.create_copy(&driver, path, &list).gdal()
        })))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(|dataset| JsDataset::wrap(dataset, self.path.clone()))
            .map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Where a program's sources come from.
pub enum ProgramSources {
    /// Paths to open inside the worker — the module-level API.
    Paths(Vec<String>),
    /// A dataset the caller already has open — the `Dataset` methods.
    Open(DatasetRef),
}

/// `gdal_translate` / `gdalwarp` / `ogr2ogr` on the thread pool. A warp of a large
/// raster is the longest single operation this binding offers, so it had better
/// not block the event loop.
pub struct ProgramTask {
    program: programs::Program,
    dest: String,
    sources: ProgramSources,
    args: Vec<String>,
    /// See `DemTask::progress`: present only when the caller asked for progress.
    progress: Option<Arc<ProgressCallback>>,
}

impl Task for ProgramTask {
    type Output = OpResult<GdalDataset>;
    type JsValue = JsDataset;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let ProgramTask {
            program,
            dest,
            sources,
            args,
            progress,
        } = self;

        let sink = progress
            .as_ref()
            .map(|callback| JsProgressSink::new(Arc::clone(callback)));
        let progress = sink
            .as_ref()
            .map(|sink| sink as &dyn programs::ProgressSink);

        Ok(op(match sources {
            ProgramSources::Paths(paths) => {
                programs::run_with_paths(*program, dest, paths, args, progress)
            }
            ProgramSources::Open(dataset) => dataset.with_exclusive(|source| {
                programs::run_with_progress(*program, dest, &[source], args, progress)
            }),
        }))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(|dataset| JsDataset::wrap(dataset, self.dest.clone()))
            .map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Building overviews reads the whole raster and writes smaller copies of it, so
/// of everything this binding offers it is the one that most needs to be off the
/// event loop.
pub struct BuildOverviewsTask {
    dataset: DatasetRef,
    request: BuildOverviewsRequest,
}

impl Task for BuildOverviewsTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let BuildOverviewsTask { dataset, request } = self;
        Ok(op(
            dataset.with_mut(|source| write_overviews(source, request))
        ))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Where this API's 0-based indices meet GDAL's 1-based band numbers. GTiff
    /// will not take a partial band list, so this cannot be pinned from a test
    /// against a real file — hence a unit test on the translation itself.
    #[test]
    fn overviews_translate_band_indices_to_gdals_numbering() {
        let request = build_overviews_request(Some(BuildOverviewsOptions {
            bands: Some(vec![0, 2]),
            ..Default::default()
        }))
        .unwrap();
        assert_eq!(request.bands, vec![1, 3]);

        // No bands and no levels means "all bands" and "whatever suits this size",
        // both of which are settled later, once the dataset is in hand.
        let defaults = build_overviews_request(None).unwrap();
        assert!(defaults.bands.is_empty());
        assert!(defaults.levels.is_none());
        assert_eq!(defaults.resampling, "nearest");
    }

    #[test]
    fn overviews_take_their_options_as_written() {
        let request = build_overviews_request(Some(BuildOverviewsOptions {
            levels: Some(vec![2, 4]),
            // Checked, and handed on in GDAL's own spelling.
            resampling: Some("CUBIC".to_string()),
            ..Default::default()
        }))
        .unwrap();
        assert_eq!(request.levels, Some(vec![2, 4]));
        assert_eq!(request.resampling, "cubic");

        // A decimation factor of 1 would ask for an overview the size of the
        // raster itself, which is not an overview.
        let err = build_overviews_request(Some(BuildOverviewsOptions {
            levels: Some(vec![4, 1]),
            ..Default::default()
        }))
        .unwrap_err();
        assert!(err.reason.contains("at least 2"), "{}", err.reason);

        let err = build_overviews_request(Some(BuildOverviewsOptions {
            resampling: Some("cubicc".to_string()),
            ..Default::default()
        }))
        .unwrap_err();
        assert!(
            err.reason.contains("unknown overview resampling"),
            "{}",
            err.reason
        );
    }
}
