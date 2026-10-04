//! `Dataset`: opening, creating, and the dataset-level accessors.
//!
//! Everything that outlives a call hangs off a [`DatasetRef`], so that `Dataset`
//! and the `RasterBand`s it hands out share one GDAL handle, and so a `close()`
//! invalidates every derived object rather than leaving a dangling pointer
//! behind. The `gdal` crate's `RasterBand<'a>` borrows the `Dataset`, which is
//! exactly why we never store one: bands are re-derived from the handle on each
//! call.

use std::collections::HashMap;
use std::ffi::{CString, c_char, c_int};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::ThreadId;

#[cfg(gd_thread_safe)]
use gdal::ThreadSafeDataset;
use gdal::cpl::CslStringList;
use gdal::programs::raster::{BuildVRTOptions, build_vrt as gdal_build_vrt};
use gdal::spatial_ref::SpatialRef;
use gdal::vector::{LayerAccess, LayerOptions, OGRwkbGeometryType};
use gdal::{Dataset as GdalDataset, DatasetOptions, DriverManager, GdalOpenFlags, Metadata};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde_json::Value;

use crate::async_getter::{DatasetProperty, DatasetPropertyTask, SpatialRefTask};
use crate::band::JsRasterBand;
use crate::driver::JsDriver;
use crate::dtype::DataType;
use crate::error::{
    GdalErrorCode, IntoGdalResult, Result, bad_argument, cpl_failure, cpl_result,
    into_status_error, split,
};
use crate::geometry::{GeometryEnvelope, JsGeometry};
use crate::programs;
use crate::progress::{JsProgressSink, ProgressCallback, ProgressUpdate};
use crate::raster_io::{
    build_creation_options, create_dataset, overview_levels, overview_resampling,
};
use crate::raster_tools::{
    RasterizeOptions, RasterizeRequest, ReprojectImageOptions, ReprojectImageRequest,
    SuggestedWarpOptions, SuggestedWarpOutput, SuggestedWarpRequest,
    rasterize as rasterize_geometries, rasterize_request, reproject_image, reproject_image_request,
    suggested_warp_output, suggested_warp_request,
};
use crate::runtime::{ensure_initialized, lock_gdal, lock_gdal_shared};
use crate::spatial_ref::JsSpatialRef;
use crate::vector::{FeatureRecord, FieldDefinition, JsLayer};

pub struct DatasetHandle {
    /// `None` once closed. That is what makes `close()` idempotent and turns any
    /// later use of a stale `Dataset` or `RasterBand` into a clear error.
    dataset: Option<GdalDataset>,
    /// The `/vsimem/` file an `open(buffer)` dataset owns. It is unlinked when the
    /// last reference to this handle goes — an explicit `close()`, or the GC of an
    /// object that was never closed. Owning it *here* rather than on `JsDataset` is
    /// what keeps a band that outlives its dataset readable: the file lives exactly as
    /// long as the dataset it holds.
    mem_file: Option<String>,
}

pub type SharedDataset = Arc<Mutex<DatasetHandle>>;

/// A poisoned lock is recovered from on purpose: a panic in one operation must
/// not brick every object that shares the handle.
pub fn lock_handle(shared: &SharedDataset) -> MutexGuard<'_, DatasetHandle> {
    match shared.try_lock() {
        Ok(handle) => handle,
        Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => {
            // A worker waiting for a progress callback holds this mutex; if this is the
            // JavaScript thread it is waiting on, the wait can never end — diagnose it.
            crate::runtime::diagnose_progress_deadlock("the dataset");
            shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        }
    }
}

impl Drop for DatasetHandle {
    fn drop(&mut self) {
        // This is the last reference (the `Arc` is gone), so nothing else is using the
        // dataset. Close it first: a `/vsimem/` file cannot be unlinked while a handle
        // still has it open, and on Windows the attempt simply fails.
        //
        // The exclusive lock is taken when it is free, so this matches the explicit
        // `close()` path. It is deliberately *not* a blocking acquisition: this can
        // run from a napi finalizer, where waiting on the lock held by an operation
        // on this very thread would deadlock, and where the reentrancy guard would
        // panic. When the lock is contended the close proceeds as it always did —
        // GDAL's `/vsimem/` tree is internally synchronised, and no other object
        // references this dataset by the time its last `Arc` goes.
        let _guard = crate::runtime::try_lock_gdal();
        drop(self.dataset.take());
        if let Some(path) = self.mem_file.take() {
            let _ = gdal::vsi::unlink_mem_file(&path);
        }
    }
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
        Self::into_shared_with_file(dataset, None)
    }

    fn into_shared_with_file(dataset: GdalDataset, mem_file: Option<String>) -> SharedDataset {
        Arc::new(Mutex::new(Self {
            dataset: Some(dataset),
            mem_file,
        }))
    }
}

/// A handle to an open dataset. Two flavours, differing only in how access is
/// serialised:
///
/// * [`DatasetRef::Serialised`] is what `open`/`create` produce. Every operation
///   takes the process-wide GDAL lock in *write* mode plus this dataset's own
///   mutex, so nothing runs concurrently — which is what GDAL is not thread-safe
///   for, one dataset reached from two threads.
/// * `DatasetRef::Concurrent` comes from `openThreadSafe` and holds a
///   `GDALGetThreadSafeDataset`, which GDAL has been asked to make safe for
///   concurrent reads. Reads take the process-wide lock in *read* mode and skip the
///   per-dataset mutex, so several of them genuinely run at once — pixel reads, and
///   the accessors that only look at the dataset's own read-only state (sizes,
///   geotransform, projection, metadata, band and overview lookup). Anything that
///   writes, caches a computed value, or reaches into another GDAL object still
///   takes the write lock.
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

    /// Wrap a dataset opened from bytes, recording the `/vsimem/` file it owns so the
    /// handle unlinks it when the last reference goes.
    pub fn serialised_mem_file(dataset: GdalDataset, mem_file: String) -> Self {
        Self::Serialised(DatasetHandle::into_shared_with_file(
            dataset,
            Some(mem_file),
        ))
    }

    /// Run `f` with **read** access, under the shared lock when this handle is
    /// concurrent.
    ///
    /// This is for work that reads the dataset and nothing else: a pixel window, or
    /// one of the accessors that report what the dataset already knows. On a
    /// `Serialised` handle the exclusion is the handle's own mutex, so this is the same
    /// as [`Self::with_exclusive`] there — the difference only ever shows on a
    /// thread-safe one, and neither flavour holds up another dataset.
    ///
    /// # Lock rules
    ///
    /// **The closure must not reach anything that takes the write lock**: `RwLock` is
    /// not reentrant, so that deadlocks the process. Concretely — no
    /// [`Self::with_exclusive`], no [`Self::with_mut`], no second dataset, no program
    /// call, and no band method that caches (`statistics`, `histogram`). A window
    /// read and the metadata getters only look, so they are safe.
    pub fn with<T>(&self, f: impl FnOnce(&GdalDataset) -> Result<T>) -> Result<T> {
        match self {
            Self::Serialised(shared) => {
                let _guard = lock_gdal_shared();
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
    /// What is left for it is what a plain read is not: writes, anything that caches
    /// what it computes, the vector side, and the programs, which build datasets of
    /// their own.
    pub fn with_exclusive<T>(&self, f: impl FnOnce(&GdalDataset) -> Result<T>) -> Result<T> {
        match self {
            Self::Serialised(shared) => {
                // The handle's own mutex *is* the exclusion here: taking the process-wide
                // lock in write mode as well would serialise this dataset against every
                // other one, which is exactly what it must not do.
                let _guard = lock_gdal_shared();
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
                let _guard = lock_gdal_shared();
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

    /// Whether two handles name the *same* underlying dataset — two clones of one
    /// `Arc`, not two opens of the same file.
    ///
    /// [`with_two`] takes both per-dataset mutexes, and they are not reentrant, so a
    /// caller that needs two datasets has to know when it actually has one before it
    /// deadlocks on itself.
    pub(crate) fn same_dataset(&self, other: &Self) -> bool {
        match self {
            Self::Serialised(first) => {
                matches!(other, Self::Serialised(second) if Arc::ptr_eq(first, second))
            }
            #[cfg(gd_thread_safe)]
            Self::Concurrent { dataset: first } => {
                matches!(other, Self::Concurrent { dataset: second } if Arc::ptr_eq(first, second))
            }
        }
    }

    /// The handle behind **one** mutex, without taking the process-wide lock — for
    /// the callers that already hold it (see [`with_two`]).
    ///
    /// A thread-safe dataset is a `ThreadSafeDataset` with no writable `GdalDataset`
    /// to hand out, which is the same reason it refuses every write.
    pub(crate) fn owned_handle(&self) -> Result<MutexGuard<'_, DatasetHandle>> {
        match self {
            Self::Serialised(shared) => Ok(lock_handle(shared)),
            #[cfg(gd_thread_safe)]
            Self::Concurrent { .. } => Err(read_only()),
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
                // Closing is a write on *this* dataset and nothing else, so it takes the
                // handle mutex like any other operation — a thread closing another
                // dataset does not have to wait for it.
                let _guard = lock_gdal_shared();
                let mut handle = lock_handle(shared);
                let closed = match handle.dataset.take() {
                    Some(dataset) => dataset.close().gdal_context("close"),
                    None => Ok(()),
                };
                // Unlink now rather than leaving it to the handle's `Drop`, so `close()`
                // keeps its promise that the `/vsimem/` file is gone. Done whether or not
                // the close reported an error: a dataset that failed to close still has
                // no business keeping the file alive.
                if let Some(path) = handle.mem_file.take() {
                    let _ = gdal::vsi::unlink_mem_file(&path);
                }
                closed
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
    /// Short names of the drivers to try, in order — GDAL's
    /// `papszAllowedDrivers`. Omit it (or pass an empty array) and every driver is
    /// considered, which is the ordinary `open()`. Naming one is how a
    /// driver-scoped open is spelled, and it is the difference between "nothing
    /// could read this" and "*this driver* could not".
    pub drivers: Option<Vec<String>>,
    /// Open GDAL's multidimensional model as well as the raster one — GDAL's
    /// `GDAL_OF_MULTIDIM_RASTER`. Without it a NetCDF or HDF5 dataset has no
    /// `Dataset.root`, because GDAL only builds the root group in that mode.
    /// Default false.
    ///
    /// A file that has a multidimensional model is then handed over *as* that
    /// model: `root` is populated, and the band side is empty, so read it through
    /// `MDArray` — or open the same path without this to get the bands instead. A
    /// file without one, a GeoTIFF say, opens as a plain raster exactly as before.
    pub multidimensional: Option<bool>,
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

/// Run `f` with two datasets in hand at once, under a single acquisition of the
/// process-wide lock.
///
/// The lock is not reentrant, so an operation that reaches into two datasets — a
/// raster band written out as polygons in another dataset's layer, say — cannot go
/// through `with_exclusive` twice. Both handles come from here instead, which also
/// means the two per-dataset mutexes are never taken in a cycle: one thread holds
/// the process-wide lock for the duration.
pub(crate) fn with_two<T>(
    first: &DatasetRef,
    second: &DatasetRef,
    f: impl FnOnce(&mut GdalDataset, &mut GdalDataset) -> Result<T>,
) -> Result<T> {
    // Both per-dataset mutexes are taken below, and they are not reentrant: two
    // handles naming one dataset would deadlock the process on the second `lock()`
    // — while holding the write side, so every other thread hangs with it. Checked
    // here rather than at each call site, so no caller can reach the deadlock by
    // forgetting to ask `same_dataset` first.
    if first.same_dataset(second) {
        return Err(bad_argument(
            "this operation needs two datasets, but both handles name the same one; open a \
             second dataset instead",
        ));
    }
    let _guard = lock_gdal();
    let mut first = first.owned_handle()?;
    let mut second = second.owned_handle()?;
    f(first.get_mut()?, second.get_mut()?)
}

/// Write bytes into GDAL's memory file system — `/vsimem/` — and open them. On
/// failure the file is unlinked again, so a `Buffer` that turns out not to be a
/// dataset does not sit in memory for the life of the process; on success the caller
/// owns the file and unlinks it when the dataset closes.
fn open_bytes_gdal(
    path: &str,
    bytes: &[u8],
    update: bool,
    drivers: Option<&[String]>,
    multidimensional: bool,
) -> Result<GdalDataset> {
    write_mem_file(path, bytes)?;
    match open_gdal(path, update, drivers, multidimensional) {
        Ok(dataset) => Ok(dataset),
        Err(error) => {
            let _guard = lock_gdal();
            let _ = gdal::vsi::unlink_mem_file(path);
            Err(error)
        }
    }
}

/// Hand bytes to GDAL's memory file system. They are GDAL's from here on: both what
/// the dataset reads and what `gdal.fs.readFile` can hand back.
fn write_mem_file(path: &str, bytes: &[u8]) -> Result<()> {
    ensure_initialized();
    let _guard = lock_gdal();
    gdal::vsi::create_mem_file(path, bytes.to_vec()).gdal()
}

/// A unique `/vsimem/` name for bytes that arrive without one. The extension means
/// nothing — the format is sniffed from the content — and is there only so the path
/// looks like a file.
fn mem_file_name() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let count = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("/vsimem/gdal-rs-napi-{}-{count}.bin", std::process::id())
}

fn open_gdal(
    path: &str,
    update: bool,
    drivers: Option<&[String]>,
    multidimensional: bool,
) -> Result<GdalDataset> {
    ensure_initialized();
    // An open reads the driver registry (frozen after `ensure_initialized`) and one
    // file; it changes no global state, so it takes the read side and two opens can
    // overlap. Driver *registration* is behind the `OnceLock` in `ensure_initialized`,
    // which is what makes this safe even on the very first call.
    let _guard = lock_gdal_shared();

    // `GDAL_OF_VERBOSE_ERROR` is what makes a failed open *say why*. Without it
    // GDAL returns a null handle in silence — no message in its last-error store —
    // and the `gdal` crate can only report the bare `GDALOpenEx: ` the caller
    // saw. With it, GDAL explains ("No such file or directory", "not recognized
    // as a supported file format"), which is the half of the failure that helps.
    let mut flags = GdalOpenFlags::GDAL_OF_RASTER
        | GdalOpenFlags::GDAL_OF_VECTOR
        | GdalOpenFlags::GDAL_OF_VERBOSE_ERROR;
    if multidimensional {
        // The two modes sit together: the raster side keeps working, and `root`
        // becomes reachable. A driver that has no multidimensional model is
        // simply opened as a raster, which is what GDAL does with the extra bit.
        flags |= GdalOpenFlags::GDAL_OF_MULTIDIM_RASTER;
    }
    if update {
        flags |= GdalOpenFlags::GDAL_OF_UPDATE;
    }
    // `DatasetOptions` borrows the names, so they have to outlive the call. An
    // empty list means the same thing as no list to GDAL, but `None` is the honest
    // way to say it.
    let allowed: Option<Vec<&str>> = drivers
        .filter(|names| !names.is_empty())
        .map(|names| names.iter().map(String::as_str).collect());
    GdalDataset::open_ex(
        path,
        DatasetOptions {
            open_flags: flags,
            allowed_drivers: allowed.as_deref(),
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
    // The whole point of this handle is that its reads overlap, so its open does not
    // hold the write side either.
    let _guard = lock_gdal_shared();

    let dataset = GdalDataset::open_ex(
        path,
        DatasetOptions {
            open_flags: GdalOpenFlags::GDAL_OF_RASTER
                | GdalOpenFlags::GDAL_OF_THREAD_SAFE
                | GdalOpenFlags::GDAL_OF_VERBOSE_ERROR,
            ..DatasetOptions::default()
        },
    )
    .gdal_context("open_thread_safe_gdal")?;

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

/// Create a dataset through a named driver. `pub(crate)` because the band
/// arithmetic builds its results as in-memory datasets and needs the same door.
pub(crate) fn create_gdal(path: &str, options: &CreateOptions) -> Result<GdalDataset> {
    ensure_initialized();
    let _guard = lock_gdal();

    let driver = DriverManager::get_driver_by_name(&options.driver).gdal_context("create_gdal")?;
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

    let driver =
        DriverManager::get_driver_by_name(driver_name).gdal_context("create_vector_gdal")?;
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

/// Raster dimensions, grouped the way `gdalinfo` reports them.
#[napi(object)]
pub struct RasterSize {
    pub width: u32,
    pub height: u32,
}

/// `GDALGetFileList`, whose answer is a CPL string list owned by the caller.
///
/// The `gdal` crate has no wrapper, so the list is walked by hand and destroyed
/// after. A null pointer — GDAL's "no answer" — and an empty list both become an
/// empty array, because either way the caller has nothing to copy.
fn file_list(dataset: &GdalDataset) -> Result<Vec<String>> {
    let list = unsafe { gdal_sys::GDALGetFileList(dataset.c_dataset()) };
    if list.is_null() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    let mut index = 0;
    loop {
        let entry = unsafe { *list.add(index) };
        if entry.is_null() {
            break;
        }
        files.push(crate::runtime::c_string(entry));
        index += 1;
    }
    unsafe { gdal_sys::CSLDestroy(list) };
    Ok(files)
}

/// A ground control point: a known correspondence between a pixel/line in the
/// raster and a coordinate in the dataset's `gcpProjection`. The other way to
/// georeference a raster, beside the affine `geoTransform`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct Gcp {
    /// GDAL's identifier for the point, often numeric.
    pub id: String,
    /// A free-form note, or the empty string.
    pub info: String,
    /// The pixel (column) the control point sits on.
    pub pixel: f64,
    /// The line (row) the control point sits on.
    pub line: f64,
    /// The georeferenced X for that pixel and line.
    pub x: f64,
    /// The georeferenced Y for that pixel and line.
    pub y: f64,
    /// The georeferenced Z, or `0` when the point has none.
    pub z: f64,
}

#[napi(js_name = "Dataset")]
pub struct JsDataset {
    dataset: DatasetRef,
    path: String,
}

impl JsDataset {
    /// A handle to the same open dataset, for work that only reads through it: the
    /// `xxxAsync` getters build one on a worker thread and never look at the path.
    pub(crate) fn detached(dataset: DatasetRef) -> Self {
        Self {
            dataset,
            path: String::new(),
        }
    }

    /// The open dataset behind this handle, for the callers that pass it along to a
    /// worker thread rather than using it here.
    pub(crate) fn handle(&self) -> &DatasetRef {
        &self.dataset
    }

    pub(crate) fn wrap_ref(dataset: DatasetRef, path: String) -> Self {
        Self { dataset, path }
    }

    pub(crate) fn wrap(dataset: GdalDataset, path: String) -> Self {
        Self::wrap_ref(DatasetRef::serialised(dataset), path)
    }

    /// The handle behind this dataset, for the operations that need two datasets at
    /// once — see [`with_two`]. The same shape as `JsLayer::dataset`.
    pub(crate) fn dataset(&self) -> &DatasetRef {
        &self.dataset
    }
}

#[napi]
impl JsDataset {
    /// Path this dataset was opened from. Available without touching GDAL, and
    /// still readable after `close()`.
    #[napi(catch_unwind, getter)]
    pub fn path(&self) -> String {
        self.path.clone()
    }

    /// Whether this handle is read concurrently. True only for `openThreadSafe`.
    #[napi(catch_unwind, getter)]
    pub fn thread_safe(&self) -> bool {
        self.dataset.is_concurrent()
    }

    /// The driver that opened this dataset, as an object. `driver.name` is the
    /// short name — `GTiff`, `GPKG`, `VRT` — and the rest of the object is that
    /// driver's own metadata: `longName`, `description`, `metadata('DMD_...')`,
    /// `testCapability('DCAP_...')`.
    ///
    /// `String(dataset.driver)` and `dataset.driver.name` both give the short name,
    /// which is what this getter returned before it handed back an object.
    #[napi(catch_unwind, getter)]
    pub fn driver(&self) -> Result<JsDriver> {
        let name = self
            .dataset
            .with(|dataset| Ok(dataset.driver().short_name()))?;
        Ok(JsDriver::new(name))
    }

    /// The dataset's description — for a file, that is the file name, so it is
    /// usually `path`. It differs where GDAL names the dataset itself: a
    /// `/vsimem/` dataset reports the name it was created under, and a subdataset
    /// reports the subdataset string.
    #[napi(catch_unwind, getter)]
    pub fn description(&self) -> Result<String> {
        self.dataset.with(|dataset| dataset.description().gdal())
    }

    /// Whether this dataset can do `capability`, in GDAL's own vocabulary — the
    /// driver's `CreateDataSource` / `DeleteDataSource` (`ODrC*`, which GDAL forwards
    /// to the driver) and the datasource's `CreateLayer` / `DeleteLayer` /
    /// `CreateGeomFieldAfterCreateLayer` (`ODsC*`).
    ///
    /// A name GDAL does not know answers `false` rather than throwing: the call is a
    /// question, and "no" is one of its answers — the same rule
    /// `Layer.testCapability` follows.
    #[napi(catch_unwind)]
    pub fn test_capability(&self, capability: String) -> Result<bool> {
        ensure_initialized();
        self.dataset.with(|dataset| {
            let capability = CString::new(capability)
                .map_err(|_| bad_argument("a capability name cannot contain a NUL byte"))?;
            let answer = unsafe {
                gdal_sys::GDALDatasetTestCapability(dataset.c_dataset(), capability.as_ptr())
            };
            Ok(answer != 0)
        })
    }

    /// Raster dimensions as one object, the shape `gdalinfo` prints. `width` and
    /// `height` remain as the flat accessors; this is the same pair grouped.
    #[napi(catch_unwind, getter)]
    pub fn raster_size(&self) -> Result<RasterSize> {
        self.dataset.with(|dataset| {
            let (width, height) = dataset.raster_size();
            Ok(RasterSize {
                width: width as u32,
                height: height as u32,
            })
        })
    }

    /// Every file GDAL believes is part of this dataset — the counterpart of
    /// `gdalinfo`'s `Files:` section, and the answer to "what do I have to ship
    /// alongside this?"
    ///
    /// A file-backed dataset reports its file, a `/vsimem/` one reports the
    /// `/vsimem/` name (which is real, and `gdal.fs.readFile` can read it), and only
    /// a dataset with nothing behind it at all — a `MEM` one — comes back empty. An
    /// empty list is not an error, so a caller copying files should read it as
    /// "nothing to copy".
    #[napi(catch_unwind)]
    pub fn get_file_list(&self) -> Result<Vec<String>> {
        self.dataset.with(file_list)
    }

    /// The dataset's bounding box as `{ minX, minY, maxX, maxY }`, or `null` when
    /// there is nothing to measure.
    ///
    /// A **raster's** envelope is its four corners under the geotransform, so the
    /// bounding box of a rotated raster is larger than the raster's own rectangle —
    /// which is the honest answer rather than a wrong small one. A **vector**
    /// dataset's is what its layers cover between them, the union of their extents.
    #[napi(catch_unwind)]
    pub fn get_envelope(&self) -> Result<Option<GeometryEnvelope>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            if let Ok(transform) = dataset.geo_transform() {
                let (width, height) = dataset.raster_size();
                let (width, height) = (width as f64, height as f64);
                let mut envelope: Option<GeometryEnvelope> = None;
                for (pixel, line) in [(0.0, 0.0), (width, 0.0), (0.0, height), (width, height)] {
                    let x = transform[0] + pixel * transform[1] + line * transform[2];
                    let y = transform[3] + pixel * transform[4] + line * transform[5];
                    envelope = Some(match envelope {
                        None => GeometryEnvelope {
                            min_x: x,
                            min_y: y,
                            max_x: x,
                            max_y: y,
                        },
                        Some(seen) => GeometryEnvelope {
                            min_x: seen.min_x.min(x),
                            min_y: seen.min_y.min(y),
                            max_x: seen.max_x.max(x),
                            max_y: seen.max_y.max(y),
                        },
                    });
                }
                return Ok(envelope);
            }

            // A vector dataset has no geotransform, and asking for it leaves GDAL's
            // error state holding that refusal. It is not this call's failure — the
            // vector answer below is the success — so clear it rather than let
            // `lastError()` report a failure that has already been handled.
            unsafe { gdal_sys::CPLErrorReset() };

            // No geotransform, so this is the vector side: what the layers cover.
            let mut envelope: Option<GeometryEnvelope> = None;
            for index in 0..dataset.layer_count() {
                let layer = dataset.layer(index).gdal_context("get_envelope")?;
                let Some(extent) = layer.try_get_extent().gdal_context("get_envelope")? else {
                    continue;
                };
                envelope = Some(match envelope {
                    None => GeometryEnvelope {
                        min_x: extent.MinX,
                        min_y: extent.MinY,
                        max_x: extent.MaxX,
                        max_y: extent.MaxY,
                    },
                    Some(seen) => GeometryEnvelope {
                        min_x: seen.min_x.min(extent.MinX),
                        min_y: seen.min_y.min(extent.MinY),
                        max_x: seen.max_x.max(extent.MaxX),
                        max_y: seen.max_y.max(extent.MaxY),
                    },
                });
            }
            Ok(envelope)
        })
    }

    /// Raster width in pixels.
    #[napi(catch_unwind, getter)]
    pub fn width(&self) -> Result<u32> {
        self.dataset
            .with(|dataset| Ok(dataset.raster_size().0 as u32))
    }

    /// Raster height in pixels.
    #[napi(catch_unwind, getter)]
    pub fn height(&self) -> Result<u32> {
        self.dataset
            .with(|dataset| Ok(dataset.raster_size().1 as u32))
    }

    #[napi(catch_unwind, getter)]
    pub fn band_count(&self) -> Result<u32> {
        self.dataset
            .with(|dataset| Ok(dataset.raster_count() as u32))
    }

    /// Six affine geotransform coefficients, or `null` when the dataset has none
    /// (which is normal for an unreferenced raster).
    #[napi(catch_unwind, getter)]
    pub fn geo_transform(&self) -> Result<Option<Vec<f64>>> {
        self.dataset
            .with(|dataset| Ok(dataset.geo_transform().ok().map(|gt| gt.to_vec())))
    }

    /// Set the geotransform: `[originX, pixelWidth, rowRotation, originY,
    /// columnRotation, pixelHeight]`.
    #[napi(catch_unwind)]
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

    /// Set the CRS from a WKT string, or from a `SpatialRef`.
    ///
    /// A string is anything an existing dataset or layer reports as `projection` /
    /// `spatialRefWkt` (and `epsgToWkt` is the usual way to make one). A
    /// `SpatialRef` is the object `dataset.spatialRef` and `SpatialRef.fromEpsg`
    /// hand back — passed as-is rather than through its `wkt`, so a caller who has
    /// one never has to spell the round trip out.
    ///
    /// ```js
    /// dataset.setProjection(gdal.epsgToWkt(4326))
    /// dataset.setProjection(gdal.SpatialRef.fromEpsg(3857))
    /// ```
    #[napi(catch_unwind)]
    pub fn set_projection(&self, projection: Either<String, &JsSpatialRef>) -> Result<()> {
        // Resolve a `SpatialRef` before taking the lock: `wkt()` takes it itself,
        // and the lock is not reentrant.
        let wkt = match projection {
            Either::A(wkt) => wkt,
            Either::B(spatial_ref) => spatial_ref.wkt()?,
        };
        self.dataset
            .with_mut(|dataset| dataset.set_projection(&wkt).gdal())
    }

    /// CRS as WKT, or `null` when the dataset has no projection.
    #[napi(catch_unwind, getter)]
    pub fn projection(&self) -> Result<Option<String>> {
        self.dataset.with(|dataset| {
            let wkt = dataset.projection();
            Ok(if wkt.is_empty() { None } else { Some(wkt) })
        })
    }

    /// The same CRS as `projection`, as an object — ready to hand to
    /// `CoordinateTransform`. `null` when the dataset has no projection.
    #[napi(catch_unwind, getter)]
    pub fn spatial_ref(&self) -> Result<Option<JsSpatialRef>> {
        ensure_initialized();
        self.dataset.with(|dataset| {
            let wkt = dataset.projection();
            if wkt.is_empty() {
                return Ok(None);
            }
            Ok(Some(JsSpatialRef::wrap(
                SpatialRef::from_wkt(&wkt).gdal_context("spatial_ref")?,
            )))
        })
    }

    /// Key/value metadata for `domain` (default: the plain-string domain).
    ///
    /// `IMAGE_STRUCTURE` lives here rather than on a band, which is how you check
    /// what a `createCopy` to COG actually produced.
    #[napi(catch_unwind)]
    pub fn metadata(&self, domain: Option<String>) -> Result<HashMap<String, String>> {
        let domain = domain.unwrap_or_default();
        self.dataset.with(|dataset| {
            let mut out = HashMap::new();
            for entry in dataset.metadata() {
                if entry.domain == domain {
                    out.insert(entry.key, entry.value);
                }
            }
            Ok(out)
        })
    }

    #[napi(catch_unwind)]
    pub fn metadata_domains(&self) -> Result<Vec<String>> {
        self.dataset.with(|dataset| Ok(dataset.metadata_domains()))
    }

    #[napi(catch_unwind)]
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

    /// How many ground control points the dataset carries.
    #[napi(catch_unwind, getter)]
    pub fn gcp_count(&self) -> Result<u32> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            // GDAL answers -1 for "error"; treat anything negative as none.
            Ok(unsafe { gdal_sys::GDALGetGCPCount(dataset.c_dataset()) }.max(0) as u32)
        })
    }

    /// The CRS the ground control points are expressed in, or `null` when there is
    /// none. Distinct from `projection`, which is the raster's own georeferencing.
    #[napi(catch_unwind, getter)]
    pub fn gcp_projection(&self) -> Result<Option<String>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let text = crate::runtime::c_string(unsafe {
                gdal_sys::GDALGetGCPProjection(dataset.c_dataset())
            });
            Ok(if text.is_empty() { None } else { Some(text) })
        })
    }

    /// The root group of the multidimensional model, or `null` when this dataset has
    /// none. It is the way in to `MDArray`, `Attribute` and `Dimension`.
    #[napi(catch_unwind, getter)]
    pub fn root(&self) -> Result<Option<crate::multidim::JsGroup>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let handle = unsafe { gdal_sys::GDALDatasetGetRootGroup(dataset.c_dataset()) };
            if handle.is_null() {
                return Ok(None);
            }
            Ok(Some(crate::multidim::JsGroup::new(
                handle,
                self.dataset.clone(),
            )))
        })
    }

    /// The ground control points, in order — `[]` when there are none.
    #[napi(catch_unwind, js_name = "getGCPs")]
    pub fn get_gcps(&self) -> Result<Vec<Gcp>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let count = unsafe { gdal_sys::GDALGetGCPCount(dataset.c_dataset()) };
            if count <= 0 {
                return Ok(Vec::new());
            }
            let list = unsafe { gdal_sys::GDALGetGCPs(dataset.c_dataset()) };
            if list.is_null() {
                return Ok(Vec::new());
            }
            Ok((0..count as usize)
                .map(|index| {
                    let gcp = unsafe { *list.add(index) };
                    Gcp {
                        id: crate::runtime::c_string(gcp.pszId),
                        info: crate::runtime::c_string(gcp.pszInfo),
                        pixel: gcp.dfGCPPixel,
                        line: gcp.dfGCPLine,
                        x: gcp.dfGCPX,
                        y: gcp.dfGCPY,
                        z: gcp.dfGCPZ,
                    }
                })
                .collect())
        })
    }

    /// Write the ground control points back, with the CRS they are in.
    ///
    /// This is the other way to georeference a raster — a set of correspondences
    /// rather than an affine `geoTransform` — and the warper uses it when a warp is
    /// asked for `-tps` or the source has no transform. `projection` is the CRS the
    /// points are expressed in; pass `null` to leave the stored one alone.
    #[napi(catch_unwind, js_name = "setGCPs")]
    pub fn set_gcps(&self, gcps: Vec<Gcp>, projection: Option<String>) -> Result<()> {
        ensure_initialized();
        // The C struct holds `const char *`, so the strings have to outlive the call.
        let ids: Vec<CString> = gcps
            .iter()
            .map(|gcp| CString::new(gcp.id.as_str()))
            .collect::<std::result::Result<_, _>>()
            .map_err(|_| bad_argument("a GCP id cannot contain a NUL byte"))?;
        let infos: Vec<CString> = gcps
            .iter()
            .map(|gcp| CString::new(gcp.info.as_str()))
            .collect::<std::result::Result<_, _>>()
            .map_err(|_| bad_argument("a GCP info cannot contain a NUL byte"))?;
        let projection = projection
            .map(CString::new)
            .transpose()
            .map_err(|_| bad_argument("a projection cannot contain a NUL byte"))?;

        self.dataset.with_mut(|dataset| {
            let points: Vec<gdal_sys::GDAL_GCP> = gcps
                .iter()
                .enumerate()
                .map(|(index, gcp)| gdal_sys::GDAL_GCP {
                    pszId: ids[index].as_ptr() as *mut c_char,
                    pszInfo: infos[index].as_ptr() as *mut c_char,
                    dfGCPPixel: gcp.pixel,
                    dfGCPLine: gcp.line,
                    dfGCPX: gcp.x,
                    dfGCPY: gcp.y,
                    dfGCPZ: gcp.z,
                })
                .collect();
            let status = unsafe {
                gdal_sys::GDALSetGCPs(
                    dataset.c_dataset(),
                    points.len() as c_int,
                    points.as_ptr(),
                    projection
                        .as_ref()
                        .map_or(std::ptr::null(), |text| text.as_ptr()),
                )
            };
            cpl_result(status)
        })
    }

    /// Band at `index`, **0-based** (GDAL itself is 1-based).
    #[napi(catch_unwind)]
    pub fn band(&self, index: u32) -> Result<JsRasterBand> {
        ensure_initialized();
        let data_type = self.dataset.with(|dataset| {
            let band_count = dataset.raster_count();
            if index as usize >= band_count {
                return Err(bad_argument(format!(
                    "band index {index} is out of range: the dataset has {band_count} band(s)"
                )));
            }
            Ok(DataType::from_gdal(
                dataset
                    .rasterband(index as usize + 1)
                    .gdal_context("band")?
                    .band_type(),
            ))
        })?;

        Ok(JsRasterBand::new(
            self.dataset.clone(),
            index as usize,
            data_type,
        ))
    }

    #[napi(catch_unwind)]
    pub fn bands(&self) -> Result<Vec<JsRasterBand>> {
        let band_count = self.dataset.with(|dataset| Ok(dataset.raster_count()))?;
        (0..band_count as u32)
            .map(|index| self.band(index))
            .collect()
    }

    /// Add a band to an existing dataset — GDAL's `GDALAddBand`, the reference's
    /// `dataset.bands.create(dataType, options)`.
    ///
    /// The dataset has to be writable and its driver has to implement `AddBand`;
    /// a driver that does not answers GDAL's own refusal. The new band is answered
    /// back, and `dataType` takes the same names `band.dataType` reports.
    #[napi(catch_unwind)]
    pub fn create_band(&self, data_type: DataType, options: Option<Value>) -> Result<JsRasterBand> {
        ensure_initialized();
        let gdal_type = data_type
            .to_gdal()
            .ok_or_else(|| bad_argument("Unknown is not a band type that can be added"))?;
        let options = build_creation_options(options.as_ref())?;
        let index = self.dataset.with_mut(|dataset| {
            let status = unsafe {
                gdal_sys::GDALAddBand(dataset.c_dataset(), gdal_type as u32, options.as_ptr())
            };
            cpl_result(status)?;
            Ok(dataset.raster_count() - 1)
        })?;
        self.band(index as u32)
    }

    /// Create a new vector layer, with `epsg` as its CRS. Lay the fields out by
    /// writing a feature whose properties name them — see `Layer.createFeature`.
    #[napi(catch_unwind)]
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
                // Resolving a CRS reads the CRS database and nothing else, so it runs
                // on the same side as the rest of the CRS module — this happens before
                // the dataset closure is entered, which is what keeps it from nesting.
                let _guard = lock_gdal_shared();
                Some(SpatialRef::from_wkt(wkt).gdal_context("create_layer")?)
            }
            (None, Some(code)) => {
                let _guard = lock_gdal_shared();
                Some(SpatialRef::from_epsg(code).gdal_context("create_layer")?)
            }
            (None, None) => None,
        };

        // Declared fields are built here, before the lock, so a typo is thrown by
        // the call rather than half-way through creating the layer. The builder is
        // shared with `Layer.addField`, so a schema declared up front and one grown
        // afterwards cannot differ.
        let declared_fields: Vec<crate::vector::FieldDefnHandle> = options
            .fields
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(crate::vector::build_field_defn)
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
                .gdal_context("create_layer")?;

            // Declared fields go in while the layer is in hand, so the schema
            // exists before the first feature does — and so a field keeps the type
            // it was declared with rather than the one inference would have picked.
            for definition in &declared_fields {
                crate::vector::add_field_to_layer(definition, &layer)?;
            }
            Ok(index)
        })?;

        Ok(JsLayer::new(self.dataset.clone(), index))
    }

    /// Copy an existing layer — schema, features and all — into this dataset under a
    /// new name. GDAL's `GDALDatasetCopyLayer`, the way a whole layer moves between
    /// two datasets without re-reading it feature by feature.
    ///
    /// `source` must belong to a **different** dataset. Copying a layer into the
    /// dataset it is already in is refused: two handles to one dataset would have to
    /// be held at once, and GDAL's per-dataset mutex is not reentrant. `options` are
    /// GDAL's own layer-creation options (`name=value`), as elsewhere.
    ///
    /// ```js
    /// const source = gdal.openSync('places.geojson')
    /// const target = gdal.createSync('places.gpkg', { driver: 'GPKG' })
    /// target.copyLayer(source.layer(0), 'places')
    /// ```
    #[napi(catch_unwind)]
    pub fn copy_layer(
        &self,
        source: &JsLayer,
        name: String,
        options: Option<Value>,
    ) -> Result<JsLayer> {
        ensure_initialized();
        self.dataset.ensure_vector_capable()?;
        source.dataset().ensure_vector_capable()?;

        if self.dataset.same_dataset(source.dataset()) {
            return Err(bad_argument(
                "a layer cannot be copied into the dataset it is already in: open a second \
                 dataset as the destination instead",
            ));
        }

        let name_c = CString::new(name.as_str())
            .map_err(|_| bad_argument("a layer name cannot contain a NUL byte"))?;
        let option_strings: Vec<CString> = crate::json::option_pairs(options.as_ref())?
            .into_iter()
            .map(|(key, value)| format!("{key}={value}"))
            .map(|option| {
                CString::new(option)
                    .map_err(|_| bad_argument("a layer option cannot contain a NUL byte"))
            })
            .collect::<Result<_>>()?;
        let mut option_ptrs: Vec<*mut c_char> = option_strings
            .iter()
            .map(|option| option.as_ptr().cast_mut())
            .collect();
        option_ptrs.push(std::ptr::null_mut());

        let index = with_two(&self.dataset, source.dataset(), |dest, src| {
            let src_layer = src
                .layer(source.index() as usize)
                .gdal_context("copy_layer")?;
            // GDAL appends the copy, so record where the layer list ended before it did.
            let index = dest.layer_count();
            let handle = unsafe {
                gdal_sys::GDALDatasetCopyLayer(
                    dest.c_dataset(),
                    src_layer.c_layer(),
                    name_c.as_ptr(),
                    option_ptrs.as_mut_ptr(),
                )
            };
            if handle.is_null() {
                return Err(cpl_failure(format!(
                    "the driver could not copy the layer as {name:?}"
                )));
            }
            Ok(index)
        })?;

        Ok(JsLayer::new(self.dataset.clone(), index))
    }

    /// Number of vector layers.
    #[napi(catch_unwind, getter)]
    pub fn layer_count(&self) -> Result<u32> {
        self.dataset.ensure_vector_capable()?;
        self.dataset
            .with_exclusive(|dataset| Ok(dataset.layer_count() as u32))
    }

    /// Layer at `index`, **0-based**.
    #[napi(catch_unwind)]
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

    #[napi(catch_unwind)]
    pub fn layer_by_name(&self, name: String) -> Result<JsLayer> {
        ensure_initialized();
        self.dataset.ensure_vector_capable()?;
        let found = self.dataset.with_exclusive(|dataset| {
            for candidate in 0..dataset.layer_count() {
                if dataset
                    .layer(candidate)
                    .gdal_context("layer_by_name")?
                    .name()
                    == name
                {
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

    #[napi(catch_unwind)]
    pub fn layers(&self) -> Result<Vec<JsLayer>> {
        self.dataset.ensure_vector_capable()?;
        let layer_count = self
            .dataset
            .with_exclusive(|dataset| Ok(dataset.layer_count()))?;
        (0..layer_count as u32)
            .map(|index| self.layer(index))
            .collect()
    }

    /// Run a SQL query against this dataset — GDAL's `GDALDatasetExecuteSQL` —
    /// and get the rows back.
    ///
    /// A query has no layer behind it, so the answer is an array of records rather
    /// than a `Layer`: it can join layers, alias or aggregate fields, and none of
    /// that maps back to a layer index. Each record has the shape `featuresSync()`
    /// gives — `{ fid, properties, geometry }`, with `null` for what is absent.
    ///
    /// `dialect` names GDAL's SQL dialect, `"OGRSQL"` or `"SQLITE"`; omit it for
    /// the driver's own default. A statement with no result (an `ALTER TABLE`, say)
    /// comes back as an empty array.
    ///
    /// ```js
    /// dataset.executeSql('SELECT name, population FROM places WHERE population > 1000')
    /// ```
    #[napi(catch_unwind)]
    pub fn execute_sql(&self, sql: String, dialect: Option<String>) -> Result<Vec<FeatureRecord>> {
        ensure_initialized();
        self.dataset.ensure_vector_capable()?;
        self.dataset
            .with_exclusive(|dataset| crate::vector::execute_sql(dataset, &sql, dialect.as_deref()))
    }

    /// Burn GeoJSON geometries into this dataset's bands — GDAL's
    /// `GDALRasterizeGeometries`, the algorithm behind `gdal_rasterize`.
    ///
    /// The geometries have to be in the dataset's own coordinate system: this does
    /// not reproject, so a geometry in WGS 84 aimed at a Web Mercator raster lands
    /// in the wrong place rather than being moved. `warp` is the tool that moves
    /// things.
    ///
    /// `options.burnValues` takes one value per geometry, positionally, and
    /// `options.bands` picks the bands by **0-based** index (default: the first
    /// one). Everything else in `options` is a `GDALRasterizeGeometries` option,
    /// passed through as written — `ALL_TOUCHED`, `MERGE_ALG`, `INIT_DEST`, ...
    ///
    /// ```js
    /// dataset.rasterizeSync([{ type: 'Polygon', coordinates: [ring] }], {
    ///   burnValues: [1],
    ///   options: { ALL_TOUCHED: true },
    /// })
    /// ```
    #[napi(catch_unwind)]
    pub fn rasterize_sync(
        &self,
        geometries: Vec<Either<&JsGeometry, Unknown<'_>>>,
        options: RasterizeOptions,
    ) -> Result<()> {
        let geometries = geometry_values(geometries)?;
        let request = rasterize_request(Some(options), geometries.len())?;
        self.dataset.with_mut(|dataset| {
            let geometries = geometries
                .iter()
                .map(crate::vector::from_geojson)
                .collect::<Result<Vec<_>>>()?;
            rasterize_geometries(dataset, &geometries, &request)
        })
    }

    /// The same, on the thread pool: burning geometry means reading and writing the
    /// raster.
    #[napi(catch_unwind, ts_return_type = "Promise<void>")]
    pub fn rasterize(
        &self,
        geometries: Vec<Either<&JsGeometry, Unknown<'_>>>,
        options: RasterizeOptions,
    ) -> Result<AsyncTask<RasterizeTask>> {
        let geometries = geometry_values(geometries)?;
        // Resolved here, so a burn-value mismatch is thrown by the call rather than
        // surfacing on the worker.
        let request = rasterize_request(Some(options), geometries.len())?;
        Ok(AsyncTask::new(RasterizeTask {
            dataset: self.dataset.clone(),
            geometries,
            request,
        }))
    }

    /// What `gdalwarp` would make of this dataset: the geotransform, size and extent
    /// of the warped output, worked out without doing the warp itself.
    ///
    /// `dstWkt` is the CRS to warp to. With no `dstWkt` this reports the grid the
    /// dataset already has, so the interesting call names one — and the answer is
    /// what `reprojectImage` needs for the destination it is given.
    #[napi(catch_unwind)]
    pub fn suggested_warp_output_sync(
        &self,
        options: Option<SuggestedWarpOptions>,
    ) -> Result<SuggestedWarpOutput> {
        let request = suggested_warp_request(options)?;
        self.dataset
            .with_exclusive(|dataset| suggested_warp_output(dataset, &request))
    }

    #[napi(catch_unwind, ts_return_type = "Promise<SuggestedWarpOutput>")]
    pub fn suggested_warp_output(
        &self,
        options: Option<SuggestedWarpOptions>,
    ) -> Result<AsyncTask<SuggestedWarpOutputTask>> {
        Ok(AsyncTask::new(SuggestedWarpOutputTask {
            dataset: self.dataset.clone(),
            request: suggested_warp_request(options)?,
        }))
    }

    /// Warp this dataset into another one, both open — GDAL's `GDALReprojectImage`.
    ///
    /// The destination has to exist already, with the size and geotransform you want
    /// — `suggestedWarpOutput` is what says what those should be for a given
    /// `dstWkt`. `srcWkt` and `dstWkt` supply (or override) the two CRSes, so a
    /// dataset with no projection is still usable.
    #[napi(catch_unwind)]
    pub fn reproject_image_sync(
        &self,
        dest: &JsDataset,
        options: Option<ReprojectImageOptions>,
    ) -> Result<()> {
        let request = reproject_image_request(options)?;
        with_two(&self.dataset, dest.dataset(), |source, target| {
            reproject_image(source, target, &request)
        })
    }

    /// The same, on the thread pool: a warp reads the source and writes the
    /// destination.
    #[napi(catch_unwind, ts_return_type = "Promise<void>")]
    pub fn reproject_image(
        &self,
        dest: &JsDataset,
        options: Option<ReprojectImageOptions>,
    ) -> Result<AsyncTask<ReprojectImageTask>> {
        Ok(AsyncTask::new(ReprojectImageTask {
            dataset: self.dataset.clone(),
            dest: dest.dataset().clone(),
            request: reproject_image_request(options)?,
        }))
    }

    /// Write a copy of this dataset through another driver.
    ///
    /// This is the only road to drivers that implement `CreateCopy` but not
    /// `Create` — the COG driver is the one people ask for. `driver` is a short
    /// name such as `COG` or `JPEG`, and `options` are that driver's creation
    /// options (`{ COMPRESS: 'DEFLATE', BLOCKSIZE: 512 }`).
    #[napi(catch_unwind)]
    pub fn create_copy_sync(
        &self,
        path: String,
        driver: String,
        options: Option<Value>,
    ) -> Result<JsDataset> {
        create_copy_sync_with(&driver, &path, &self.dataset, options.as_ref())
    }

    #[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
    pub fn create_copy(
        &self,
        path: String,
        driver: String,
        options: Option<Value>,
    ) -> Result<AsyncTask<CopyTask>> {
        Ok(AsyncTask::new(CopyTask::new(
            self.dataset.clone(),
            path,
            driver,
            options.as_ref(),
        )?))
    }

    #[napi(catch_unwind)]
    pub fn flush_sync(&self) -> Result<()> {
        self.dataset
            .with_mut(|dataset| dataset.flush_cache().gdal())
    }

    #[napi(catch_unwind, ts_return_type = "Promise<void>")]
    pub fn flush(&self) -> AsyncTask<FlushTask> {
        AsyncTask::new(FlushTask {
            dataset: self.dataset.clone(),
        })
    }

    /// Idempotent. After this every band object belonging to the dataset fails
    /// loudly instead of touching freed memory.
    ///
    /// A dataset opened from a `Buffer` also owns the `/vsimem/` file holding those
    /// bytes — its `path` — and closing is when that file goes away. Read anything
    /// you want to keep back first, with `gdal.fs.readFile(dataset.path)`, and
    /// `flushSync()` before reading if the dataset was written to: GDAL keeps the
    /// dirty blocks in memory until then, exactly as it would for a file on disk.
    #[napi(catch_unwind)]
    pub fn close(&self) -> Result<()> {
        // The `/vsimem/` file an `open(buffer)` dataset owns is unlinked by
        // `DatasetRef::close` (and, if this is never called, when the last reference to
        // the dataset is dropped).
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
    #[napi(catch_unwind)]
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

    #[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
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
            js_thread: std::thread::current().id(),
        }))
    }

    /// Delete a layer, **by name**.
    ///
    /// By name rather than by index because deleting shifts every later index, so
    /// a list of indices to delete is a trap. Not every driver can do it — GeoPackage
    /// can, an ESRI Shapefile cannot, and GDAL says so when asked.
    #[napi(catch_unwind)]
    pub fn delete_layer(&self, name: String) -> Result<()> {
        ensure_initialized();
        self.dataset.ensure_vector_capable()?;

        self.dataset.with_mut(|dataset| {
            let mut found = None;
            for candidate in 0..dataset.layer_count() {
                if dataset
                    .layer(candidate)
                    .gdal_context("delete_layer")?
                    .name()
                    == name
                {
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
    #[napi(catch_unwind)]
    pub fn remove_overviews_sync(&self) -> Result<()> {
        self.dataset.with_mut(remove_overviews)
    }

    #[napi(catch_unwind, ts_return_type = "Promise<void>")]
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
    #[napi(catch_unwind)]
    pub fn build_overviews_sync(&self, options: Option<BuildOverviewsOptions>) -> Result<()> {
        let request = build_overviews_request(options)?;
        self.dataset
            .with_mut(|dataset| write_overviews(dataset, &request))
    }

    #[napi(catch_unwind, ts_return_type = "Promise<void>")]
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
    #[napi(catch_unwind)]
    pub fn translate_sync(&self, dest: String, args: Option<Vec<String>>) -> Result<JsDataset> {
        let args = args.unwrap_or_default();
        let dataset = self.dataset.with_exclusive(|source| {
            programs::run(programs::Program::Translate, &dest, &[source], &args)
        })?;
        Ok(JsDataset::wrap(dataset, dest))
    }

    #[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
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
    #[napi(catch_unwind)]
    pub fn warp_sync(&self, dest: String, args: Option<Vec<String>>) -> Result<JsDataset> {
        let args = args.unwrap_or_default();
        let dataset = self.dataset.with_exclusive(|source| {
            programs::run(programs::Program::Warp, &dest, &[source], &args)
        })?;
        Ok(JsDataset::wrap(dataset, dest))
    }

    #[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
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
    #[napi(catch_unwind)]
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

    #[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
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

/// Open an existing dataset. Runs on the libuv thread pool, so the event loop
/// stays free while GDAL reads the header.
///
/// Pass a path — an ordinary one, or a `/vsimem/`, `/vsizip/`, `/vsicurl/` one — or
/// a `Buffer` of bytes to open from memory, in which case they go to a `/vsimem/`
/// file first. That file becomes the dataset's `path`, which is how bytes that were
/// written to can be read back with `gdal.fs.readFile(dataset.path)`; closing the
/// dataset unlinks it. Bytes have no filename, so they have to identify themselves —
/// GDAL sniffs the content, which covers GTiff, PNG, JPEG, VRT, GeoJSON and GPKG,
/// but not a format a driver only knows by its extension. When the name matters, use
/// `gdal.fs.writeFile('/vsimem/data.tif', bytes)` and open that path.
#[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
pub fn open(source: Either<String, Buffer>, options: Option<OpenOptions>) -> AsyncTask<OpenTask> {
    let OpenOptions {
        update,
        drivers,
        multidimensional,
    } = options.unwrap_or_default();
    let update = update.unwrap_or(false);
    let multidimensional = multidimensional.unwrap_or(false);
    match source {
        Either::A(path) => AsyncTask::new(OpenTask {
            path,
            kind: OpenKind::Open {
                update,
                drivers,
                multidimensional,
            },
        }),
        Either::B(bytes) => AsyncTask::new(OpenTask {
            path: mem_file_name(),
            kind: OpenKind::OpenBytes {
                bytes: bytes.to_vec(),
                update,
                drivers,
                multidimensional,
            },
        }),
    }
}

/// The blocking twin of [`open`], bytes included.
#[napi(catch_unwind)]
pub fn open_sync(
    source: Either<String, Buffer>,
    options: Option<OpenOptions>,
) -> Result<JsDataset> {
    let OpenOptions {
        update,
        drivers,
        multidimensional,
    } = options.unwrap_or_default();
    let update = update.unwrap_or(false);
    let multidimensional = multidimensional.unwrap_or(false);
    match source {
        Either::A(path) => open_dataset_sync(&path, update, drivers.as_deref(), multidimensional),
        Either::B(bytes) => {
            let path = mem_file_name();
            let dataset =
                open_bytes_gdal(&path, &bytes, update, drivers.as_deref(), multidimensional)?;
            Ok(JsDataset::wrap_ref(
                DatasetRef::serialised_mem_file(dataset, path.clone()),
                path,
            ))
        }
    }
}

/// The `xxxAsync` halves of the read-only getters — see [`crate::async_getter`] for the
/// tasks, and for why the names carry the reference's `Async` suffix.
#[napi]
impl JsDataset {
    /// [`Self::raster_size`], off the event loop.
    #[napi(catch_unwind, getter, ts_return_type = "Promise<RasterSize>")]
    pub fn raster_size_async(&self) -> AsyncTask<DatasetPropertyTask<RasterSize>> {
        self.property(DatasetProperty::RasterSize)
    }

    /// [`Self::geo_transform`], off the event loop.
    #[napi(catch_unwind, getter, ts_return_type = "Promise<Array<number> | null>")]
    pub fn geo_transform_async(&self) -> AsyncTask<DatasetPropertyTask<Option<Vec<f64>>>> {
        self.property(DatasetProperty::GeoTransform)
    }

    /// [`Self::spatial_ref`], off the event loop.
    #[napi(catch_unwind, getter, ts_return_type = "Promise<JsSpatialRef | null>")]
    pub fn spatial_ref_async(&self) -> AsyncTask<SpatialRefTask> {
        self.spatial_ref_task()
    }
}

/// Open a path and wrap it, optionally restricted to named drivers. The `Driver`
/// object's `openSync` goes through here, and so does `open_sync`.
pub(crate) fn open_dataset_sync(
    path: &str,
    update: bool,
    drivers: Option<&[String]>,
    multidimensional: bool,
) -> Result<JsDataset> {
    Ok(JsDataset::wrap(
        open_gdal(path, update, drivers, multidimensional)?,
        path.to_string(),
    ))
}

/// Create a raster and wrap it. The `Driver` object's `createSync` and the module
/// `createSync` share this, so the two cannot drift.
pub(crate) fn create_dataset_sync(path: &str, options: &CreateOptions) -> Result<JsDataset> {
    Ok(JsDataset::wrap(
        create_gdal(path, options)?,
        path.to_string(),
    ))
}

/// Open a read-only raster that several worker threads can read at the same time.
///
/// This is the only way to get real GDAL parallelism out of this binding: with
/// `open()` every call is serialised behind one process-wide lock. The trade-offs
/// are in the README — most drivers end up reopening the file per thread, so a high
/// read concurrency costs file descriptors.
#[cfg(gd_thread_safe)]
#[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
pub fn open_thread_safe(path: String) -> AsyncTask<OpenTask> {
    AsyncTask::new(OpenTask {
        path,
        kind: OpenKind::ThreadSafe,
    })
}

#[cfg(gd_thread_safe)]
#[napi(catch_unwind)]
pub fn open_thread_safe_sync(path: String) -> Result<JsDataset> {
    Ok(JsDataset::wrap_ref(open_thread_safe_gdal(&path)?, path))
}

/// Create a raster dataset. `options.driver` must name a driver that supports
/// `Create` (GTiff, GPKG, MEM, ...); `band_count` defaults to 1 and
/// `data_type` to `Uint8`.
#[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
pub fn create(path: String, options: CreateOptions) -> AsyncTask<OpenTask> {
    AsyncTask::new(OpenTask {
        path,
        kind: OpenKind::CreateRaster(options),
    })
}

#[napi(catch_unwind)]
pub fn create_sync(path: String, options: CreateOptions) -> Result<JsDataset> {
    Ok(JsDataset::wrap(create_gdal(&path, &options)?, path))
}

/// Create an empty vector dataset. Add layers with `dataset.createLayer(...)`.
#[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
pub fn create_vector(path: String, driver: String) -> AsyncTask<OpenTask> {
    AsyncTask::new(OpenTask {
        path,
        kind: OpenKind::CreateVector { driver },
    })
}

#[napi(catch_unwind)]
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
#[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
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

#[napi(catch_unwind)]
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
#[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
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

#[napi(catch_unwind)]
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
#[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
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

#[napi(catch_unwind)]
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

/// `gdal_rasterize <args> source dest`, as one call: the geometries of a vector
/// `source` burned into a raster. `dest` may name a raster to create, and `args`
/// are gdal_rasterize's own — `-b`, `-burn`, `-a`, `-l`, `-tr`, `-te`, `-ts`,
/// `-init`, `-at`, `-of`, ...
#[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
pub fn rasterize(
    dest: String,
    source: String,
    args: Option<Vec<String>>,
    on_progress: Option<ThreadsafeFunction<ProgressUpdate, bool, ProgressUpdate, Status, false>>,
) -> AsyncTask<ProgramTask> {
    program_task_paths(
        programs::Program::Rasterize,
        dest,
        vec![source],
        args,
        on_progress.map(Arc::new),
    )
}

#[napi(catch_unwind)]
pub fn rasterize_sync(
    dest: String,
    source: String,
    args: Option<Vec<String>>,
) -> Result<JsDataset> {
    let args = args.unwrap_or_default();
    let dataset =
        programs::run_with_paths(programs::Program::Rasterize, &dest, &[source], &args, None)?;
    Ok(JsDataset::wrap(dataset, dest))
}

/// `gdalinfo`'s report for an open dataset — GDAL's own `GDALInfo`, the library
/// behind the tool. `args` are gdalinfo's command-line options (`['-json']`,
/// `['-stats']`, `['-nomd']`, ...); with none it prints the default report.
///
/// It reads the dataset and nothing else, so it takes the shared side of the lock.
#[napi(catch_unwind)]
pub fn gdalinfo(dataset: &JsDataset, args: Option<Vec<String>>) -> Result<String> {
    let args = args.unwrap_or_default();
    dataset.dataset().with(|dataset| {
        let options = programs::with_argv(&args, |argv| unsafe {
            gdal_sys::GDALInfoOptionsNew(argv, std::ptr::null_mut())
        })?;
        if options.is_null() {
            return Err(programs::rejected("gdalinfo", &args));
        }
        let text = unsafe { gdal_sys::GDALInfo(dataset.c_dataset(), options) };
        // The options object is ours whether or not the call worked.
        unsafe { gdal_sys::GDALInfoOptionsFree(options) };
        if text.is_null() {
            return Err(cpl_failure(
                "gdalinfo could not read the dataset".to_owned(),
            ));
        }
        let report = crate::runtime::c_string(text);
        unsafe { gdal_sys::VSIFree(text.cast()) };
        Ok(report)
    })
}

/// `gdalbuildvrt <args> sources... dest`, as one call.
///
/// One source is the "wrap this raster as a VRT without copying it" case; several
/// are merged into a single VRT. An empty `dest` builds it in memory, as
/// `translate` does.
#[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
pub fn build_vrt(
    dest: String,
    sources: Vec<String>,
    args: Option<Vec<String>>,
) -> AsyncTask<BuildVrtTask> {
    AsyncTask::new(BuildVrtTask {
        dest,
        sources,
        args: args.unwrap_or_default(),
    })
}

#[napi(catch_unwind)]
pub fn build_vrt_sync(
    dest: String,
    sources: Vec<String>,
    args: Option<Vec<String>>,
) -> Result<JsDataset> {
    let dataset = build_vrt_with_paths(&dest, &sources, &args.unwrap_or_default())?;
    Ok(JsDataset::wrap(dataset, dest))
}

/// Open the sources and build the VRT, holding the lock throughout — the shape
/// `dem_with_paths` has, and for the same reason: `GDALBuildVRT` takes datasets
/// rather than paths.
fn build_vrt_with_paths(dest: &str, sources: &[String], args: &[String]) -> Result<GdalDataset> {
    ensure_initialized();
    let _guard = lock_gdal();

    if sources.is_empty() {
        return Err(bad_argument("a VRT needs at least one source"));
    }
    let opened = sources
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

    let options = if args.is_empty() {
        None
    } else {
        let options = BuildVRTOptions::new(args.to_vec()).gdal_context("build_vrt_with_paths")?;
        // `BuildVRTOptions::new` hands back a null pointer for arguments GDAL does
        // not like — the same trap the options of the other programs have — and the
        // `gdal` crate does not check it. Passed on, the null reaches `GDALBuildVRT`
        // and crashes it; echoing the arguments back is what makes the failure usable.
        if unsafe { options.c_options() }.is_null() {
            return Err(programs::rejected("gdalbuildvrt", args));
        }
        Some(options)
    };
    // An empty destination means an in-memory VRT.
    let path = (!dest.is_empty()).then(|| Path::new(dest));
    gdal_build_vrt(path, &opened, options).gdal()
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
        js_thread: std::thread::current().id(),
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
        js_thread: std::thread::current().id(),
    })
}

/// `gdaldem <algorithm> source dest`, as one call. `colorFile` is read only by the
/// `color-relief` algorithm.
///
/// `onProgress` runs on the JS thread while the work happens on a worker, and
/// returning `false` from it cancels — see the progress section of the README.
#[napi(catch_unwind, ts_return_type = "Promise<Dataset>")]
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
        js_thread: std::thread::current().id(),
    }))
}

#[napi(catch_unwind)]
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

mod tasks;

#[cfg(test)]
mod tests;

pub(crate) use tasks::*;
