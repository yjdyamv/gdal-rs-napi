//! `Dataset`: opening, creating, and the dataset-level accessors.
//!
//! Everything that outlives a call hangs off a single `Arc<Mutex<DatasetHandle>>`
//! so that `Dataset` and the `RasterBand`s it hands out share one GDAL handle,
//! and so a `close()` invalidates every derived object rather than leaving a
//! dangling pointer behind. The `gdal` crate's `RasterBand<'a>` borrows the
//! `Dataset`, which is exactly why we never store one: bands are re-derived from
//! the handle on each call.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use gdal::cpl::CslStringList;
use gdal::spatial_ref::SpatialRef;
use gdal::vector::{LayerAccess, LayerOptions, OGRwkbGeometryType};
use gdal::{Dataset as GdalDataset, DatasetOptions, DriverManager, GdalOpenFlags, Metadata};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;

use crate::band::JsRasterBand;
use crate::dtype::DataType;
use crate::error::{GdalErrorCode, IntoGdalResult, Result, bad_argument, into_status_error, split};
use crate::raster_io::{build_creation_options, create_dataset};
use crate::runtime::{ensure_initialized, lock_gdal};
use crate::vector::JsLayer;

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
    /// EPSG code for the layer CRS. Default: no CRS.
    pub epsg: Option<u32>,
    /// Driver creation options, e.g. `{ SPATIAL_INDEX: 'YES' }`.
    pub options: Option<Value>,
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

#[napi(js_name = "Dataset")]
pub struct JsDataset {
    shared: SharedDataset,
    path: String,
}

impl JsDataset {
    fn wrap(dataset: GdalDataset, path: String) -> Self {
        Self {
            shared: Arc::new(Mutex::new(DatasetHandle {
                dataset: Some(dataset),
            })),
            path,
        }
    }

    pub fn shared(&self) -> &SharedDataset {
        &self.shared
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

    #[napi(getter)]
    pub fn driver(&self) -> Result<String> {
        let _guard = lock_gdal();
        let handle = lock_handle(&self.shared);
        Ok(handle.get()?.driver().short_name())
    }

    /// Raster width in pixels.
    #[napi(getter)]
    pub fn width(&self) -> Result<u32> {
        let _guard = lock_gdal();
        let handle = lock_handle(&self.shared);
        Ok(handle.get()?.raster_size().0 as u32)
    }

    /// Raster height in pixels.
    #[napi(getter)]
    pub fn height(&self) -> Result<u32> {
        let _guard = lock_gdal();
        let handle = lock_handle(&self.shared);
        Ok(handle.get()?.raster_size().1 as u32)
    }

    #[napi(getter)]
    pub fn band_count(&self) -> Result<u32> {
        let _guard = lock_gdal();
        let handle = lock_handle(&self.shared);
        Ok(handle.get()?.raster_count() as u32)
    }

    /// Six affine geotransform coefficients, or `null` when the dataset has none
    /// (which is normal for an unreferenced raster).
    #[napi(getter)]
    pub fn geo_transform(&self) -> Result<Option<Vec<f64>>> {
        let _guard = lock_gdal();
        let handle = lock_handle(&self.shared);
        Ok(handle.get()?.geo_transform().ok().map(|gt| gt.to_vec()))
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

        let _guard = lock_gdal();
        let mut handle = lock_handle(&self.shared);
        handle
            .dataset
            .as_mut()
            .ok_or_else(|| bad_argument("the dataset is closed"))?
            .set_geo_transform(&array)
            .gdal()
    }

    /// Set the CRS from a WKT string — see `epsgToWkt` for the usual way to get
    /// one. Anything an existing dataset or layer reports as `projection` /
    /// `spatialRefWkt` will do too.
    #[napi]
    pub fn set_projection(&self, wkt: String) -> Result<()> {
        let _guard = lock_gdal();
        let mut handle = lock_handle(&self.shared);
        handle
            .dataset
            .as_mut()
            .ok_or_else(|| bad_argument("the dataset is closed"))?
            .set_projection(&wkt)
            .gdal()
    }

    /// CRS as WKT, or `null` when the dataset has no projection.
    #[napi(getter)]
    pub fn projection(&self) -> Result<Option<String>> {
        let _guard = lock_gdal();
        let handle = lock_handle(&self.shared);
        let wkt = handle.get()?.projection();
        Ok(if wkt.is_empty() { None } else { Some(wkt) })
    }

    /// Key/value metadata for `domain` (default: the plain-string domain).
    #[napi]
    pub fn metadata(&self, domain: Option<String>) -> Result<HashMap<String, String>> {
        let _guard = lock_gdal();
        let handle = lock_handle(&self.shared);
        let domain = domain.unwrap_or_default();

        let mut out = HashMap::new();
        for entry in handle.get()?.metadata() {
            if entry.domain == domain {
                out.insert(entry.key, entry.value);
            }
        }
        Ok(out)
    }

    #[napi]
    pub fn metadata_domains(&self) -> Result<Vec<String>> {
        let _guard = lock_gdal();
        let handle = lock_handle(&self.shared);
        Ok(handle.get()?.metadata_domains())
    }

    #[napi]
    pub fn set_metadata_item(
        &self,
        key: String,
        value: String,
        domain: Option<String>,
    ) -> Result<()> {
        let _guard = lock_gdal();
        let mut handle = lock_handle(&self.shared);
        let domain = domain.unwrap_or_default();
        // `set_metadata_item` needs `&mut Dataset`, but the handle owns it, so a
        // local mutable borrow is enough.
        let dataset = handle
            .dataset
            .as_mut()
            .ok_or_else(|| bad_argument("the dataset is closed"))?;
        dataset.set_metadata_item(&key, &value, &domain).gdal()
    }

    /// Band at `index`, **0-based** (GDAL itself is 1-based).
    #[napi]
    pub fn band(&self, index: u32) -> Result<JsRasterBand> {
        ensure_initialized();
        let _guard = lock_gdal();

        let data_type = {
            let handle = lock_handle(&self.shared);
            let dataset = handle.get()?;
            let band_count = dataset.raster_count();
            if index as usize >= band_count {
                return Err(bad_argument(format!(
                    "band index {index} is out of range: the dataset has {band_count} band(s)"
                )));
            }
            DataType::from_gdal(dataset.rasterband(index as usize + 1).gdal()?.band_type())
        };

        Ok(JsRasterBand::new(
            Arc::clone(&self.shared),
            index as usize,
            data_type,
        ))
    }

    #[napi]
    pub fn bands(&self) -> Result<Vec<JsRasterBand>> {
        let band_count = {
            let _guard = lock_gdal();
            let handle = lock_handle(&self.shared);
            handle.get()?.raster_count()
        };
        (0..band_count as u32)
            .map(|index| self.band(index))
            .collect()
    }

    /// Create a new vector layer, with `epsg` as its CRS. Lay the fields out by
    /// writing a feature whose properties name them — see `Layer.createFeature`.
    #[napi]
    pub fn create_layer(&self, options: CreateLayerOptions) -> Result<JsLayer> {
        ensure_initialized();
        let _guard = lock_gdal();
        let mut handle = lock_handle(&self.shared);

        let geometry_type = match &options.geometry_type {
            Some(name) => crate::vector::geometry_type_from_name(name)?,
            None => OGRwkbGeometryType::wkbUnknown,
        };
        let srs = match options.epsg {
            Some(code) => Some(SpatialRef::from_epsg(code).gdal()?),
            None => None,
        };

        // GDAL takes layer creation options as `name=value` strings.
        let layer_options: Vec<String> = crate::json::option_pairs(options.options.as_ref())?
            .into_iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect();
        let layer_option_refs: Vec<&str> = layer_options.iter().map(String::as_str).collect();

        let index = {
            let dataset = handle
                .dataset
                .as_mut()
                .ok_or_else(|| bad_argument("the dataset is closed"))?;
            // A driver is free to name the layer differently, so record the
            // position rather than assuming it lands at the end.
            let index = dataset.layer_count();
            dataset
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
            index
        };

        Ok(JsLayer::new(Arc::clone(&self.shared), index))
    }

    /// Number of vector layers.
    #[napi(getter)]
    pub fn layer_count(&self) -> Result<u32> {
        let _guard = lock_gdal();
        let handle = lock_handle(&self.shared);
        Ok(handle.get()?.layer_count() as u32)
    }

    /// Layer at `index`, **0-based**.
    #[napi]
    pub fn layer(&self, index: u32) -> Result<JsLayer> {
        ensure_initialized();
        let layer_count = {
            let _guard = lock_gdal();
            let handle = lock_handle(&self.shared);
            handle.get()?.layer_count()
        };
        if index as usize >= layer_count {
            return Err(bad_argument(format!(
                "layer index {index} is out of range: the dataset has {layer_count} layer(s)"
            )));
        }
        Ok(JsLayer::new(Arc::clone(&self.shared), index as usize))
    }

    #[napi]
    pub fn layer_by_name(&self, name: String) -> Result<JsLayer> {
        ensure_initialized();
        let found = {
            let _guard = lock_gdal();
            let handle = lock_handle(&self.shared);
            let dataset = handle.get()?;
            let mut found = None;
            for candidate in 0..dataset.layer_count() {
                if dataset.layer(candidate).gdal()?.name() == name {
                    found = Some(candidate);
                    break;
                }
            }
            found
        };
        match found {
            Some(index) => Ok(JsLayer::new(Arc::clone(&self.shared), index)),
            None => Err(bad_argument(format!("no layer named {name:?}"))),
        }
    }

    #[napi]
    pub fn layers(&self) -> Result<Vec<JsLayer>> {
        let layer_count = {
            let _guard = lock_gdal();
            let handle = lock_handle(&self.shared);
            handle.get()?.layer_count()
        };
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
        let _guard = lock_gdal();
        let handle = lock_handle(&self.shared);
        let source = handle.get()?;

        let driver = DriverManager::get_driver_by_name(&driver).gdal()?;
        let creation_options = build_creation_options(options.as_ref())?;
        let dataset = source
            .create_copy(&driver, &path, &creation_options)
            .gdal()?;
        Ok(JsDataset::wrap(dataset, path))
    }

    #[napi]
    pub fn create_copy(
        &self,
        path: String,
        driver: String,
        options: Option<Value>,
    ) -> Result<AsyncTask<CopyTask>> {
        Ok(AsyncTask::new(CopyTask {
            shared: Arc::clone(&self.shared),
            path,
            driver,
            // `CslStringList` wraps a raw GDAL pointer, so the task carries plain
            // pairs and rebuilds the list on the worker thread.
            options: crate::json::option_pairs(options.as_ref())?,
        }))
    }

    #[napi]
    pub fn flush_sync(&self) -> Result<()> {
        let _guard = lock_gdal();
        let mut handle = lock_handle(&self.shared);
        let dataset = handle
            .dataset
            .as_mut()
            .ok_or_else(|| bad_argument("the dataset is closed"))?;
        dataset.flush_cache().gdal()
    }

    #[napi]
    pub fn flush(&self) -> AsyncTask<FlushTask> {
        AsyncTask::new(FlushTask {
            shared: Arc::clone(&self.shared),
        })
    }

    /// Idempotent. After this every band object belonging to the dataset fails
    /// loudly instead of touching freed memory.
    #[napi]
    pub fn close(&self) -> Result<()> {
        let _guard = lock_gdal();
        let mut handle = lock_handle(&self.shared);
        if let Some(dataset) = handle.dataset.take() {
            dataset.close().gdal()?;
        }
        Ok(())
    }
}

/// `Task::compute` must be `Send`, and `napi::Error` is not guaranteed to be, so
/// failures travel as a plain pair and are rebuilt on the JS thread.
type OpResult<T> = std::result::Result<T, (GdalErrorCode, String)>;

fn op<T>(result: Result<T>) -> OpResult<T> {
    result.map_err(split)
}

/// What `OpenTask` should produce. One task type covers opening, raster
/// creation and vector creation so the async surface stays uniform and
/// `napi::Task` is implemented only once.
enum OpenKind {
    Open { update: bool },
    CreateRaster(CreateOptions),
    CreateVector { driver: String },
}

pub struct OpenTask {
    path: String,
    kind: OpenKind,
}

impl Task for OpenTask {
    type Output = OpResult<GdalDataset>;
    type JsValue = JsDataset;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(op(match &self.kind {
            OpenKind::Open { update } => open_gdal(&self.path, *update),
            OpenKind::CreateRaster(options) => create_gdal(&self.path, options),
            OpenKind::CreateVector { driver } => create_vector_gdal(&self.path, driver),
        }))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(|dataset| JsDataset::wrap(dataset, self.path.clone()))
            .map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Open an existing dataset. Runs on the libuv thread pool, so the event loop
/// stays free while GDAL reads the header.
#[napi]
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

/// Create a raster dataset. `options.driver` must name a driver that supports
/// `Create` (GTiff, GPKG, MEM, ...); `band_count` defaults to 1 and
/// `data_type` to `Uint8`.
#[napi]
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
#[napi]
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

pub struct FlushTask {
    shared: SharedDataset,
}

impl Task for FlushTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let _guard = lock_gdal();
        let mut handle = lock_handle(&self.shared);
        Ok(op(handle
            .dataset
            .as_mut()
            .ok_or_else(|| bad_argument("the dataset is closed"))
            .and_then(|dataset| dataset.flush_cache().gdal())))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// `createCopy` on the thread pool: writing a whole COG is exactly the kind of
/// operation that should not hold up the event loop.
pub struct CopyTask {
    shared: SharedDataset,
    path: String,
    driver: String,
    options: Vec<(String, String)>,
}

impl Task for CopyTask {
    type Output = OpResult<GdalDataset>;
    type JsValue = JsDataset;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let _guard = lock_gdal();
        let handle = lock_handle(&self.shared);

        Ok(op((|| {
            let source = handle.get()?;
            let driver = DriverManager::get_driver_by_name(&self.driver).gdal()?;

            let mut list = CslStringList::new();
            for (name, value) in &self.options {
                list.add_name_value(name, value).gdal()?;
            }

            source.create_copy(&driver, &self.path, &list).gdal()
        })()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(|dataset| JsDataset::wrap(dataset, self.path.clone()))
            .map_err(|(code, reason)| into_status_error(code, reason))
    }
}
