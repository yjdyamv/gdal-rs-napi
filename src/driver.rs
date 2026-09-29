//! `Driver` — a registered GDAL/OGR driver, as an object rather than a name.
//!
//! Only the short name is stored. A `GDALDriverH` is a process-wide singleton that
//! GDAL owns for the life of the process and this binding never frees, so
//! re-fetching it by name costs a hash lookup and removes every question about
//! lifetimes, ownership and `Send`. It also means a `Driver` object cannot dangle:
//! the worst a deregistered driver can do is make the lookup fail.
//!
//! This is where "can this build write a GeoPackage?" is answered —
//! `driver.testCapability('DCAP_CREATE')` — and where the creation options a driver
//! accepts are read from, instead of guessing at them.

use std::collections::HashMap;

use gdal::DriverManager;
use gdal::Metadata;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;

use crate::dataset::{
    CreateOptions, JsDataset, OpenKind, OpenOptions, OpenTask, create_dataset_sync,
};
use crate::dtype::DataType;
use crate::error::{IntoGdalResult, Result, bad_argument};
use crate::runtime::{ensure_initialized, lock_gdal};

/// GDAL stores a driver's capabilities as metadata items whose value is `YES` or
/// `NO`, and reads them back with `GDALDriver::GetMetadataItem`. There is no public
/// `TestCapability`, so this is the same lookup GDAL itself performs.
const CAPABILITY_YES: &str = "YES";

/// A registered GDAL/OGR driver.
///
/// Get one from `gdal.drivers()` or `gdal.driver(name)`, or from
/// `dataset.driver`. It is a handle to GDAL's own driver, not a copy: everything
/// here reads the driver as GDAL registered it.
#[napi(js_name = "Driver")]
pub struct JsDriver {
    name: String,
}

impl JsDriver {
    pub(crate) fn new(name: String) -> Self {
        Self { name }
    }

    /// Run `f` against GDAL's driver. Takes the process-wide lock, which is why the
    /// two methods that re-enter `dataset.rs` — `open` and `create` — do **not**
    /// come through here: the lock is not reentrant, so that would deadlock.
    fn with_driver<T>(&self, f: impl FnOnce(&gdal::Driver) -> Result<T>) -> Result<T> {
        ensure_initialized();
        let _guard = lock_gdal();
        let driver = DriverManager::get_driver_by_name(&self.name).gdal()?;
        f(&driver)
    }

    /// One `DMD_*` / `DCAP_*` item out of the driver's default metadata domain.
    fn driver_item(&self, key: &str) -> Result<Option<String>> {
        self.with_driver(|driver| Ok(driver.metadata_item(key, "")))
    }
}

#[napi]
impl JsDriver {
    /// The driver's short name — `GTiff`, `GPKG`, `COG`. This is the name every
    /// other call in this binding takes, and the name `gdalinfo --formats` prints.
    #[napi(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// The driver's long name, e.g. `GeoTIFF`.
    #[napi(getter)]
    pub fn long_name(&self) -> Result<String> {
        self.with_driver(|driver| Ok(driver.long_name()))
    }

    /// The driver's description — GDAL's own label, which is usually the long name
    /// but can differ. `GDALGetDescription` on the driver.
    #[napi(getter)]
    pub fn description(&self) -> Result<String> {
        self.with_driver(|driver| driver.description().gdal())
    }

    /// Whether the driver can do `capability` — a `DCAP_*` name: `DCAP_CREATE`,
    /// `DCAP_CREATECOPY`, `DCAP_VIRTUALIO`, `DCAP_RASTER`, `DCAP_VECTOR`,
    /// `DCAP_OPEN`, `DCAP_DELETE`, ...
    ///
    /// This is how "can I write a Cloud-Optimized GeoTIFF with this build?" is
    /// answered without trying it. An unknown name answers `false` rather than
    /// throwing, the same way `Layer.testCapability` does: the call is a question,
    /// and "no" is one of its answers.
    ///
    /// ```js
    /// gdal.driver('COG').testCapability('DCAP_CREATECOPY')  // true
    /// gdal.driver('GTiff').testCapability('DCAP_VECTOR')    // false
    /// ```
    #[napi]
    pub fn test_capability(&self, capability: String) -> Result<bool> {
        // A capability is stored as a metadata item with the value "YES" or "NO",
        // and an unrecognised one is simply absent. Both "absent" and "NO" mean no.
        Ok(self
            .driver_item(&capability)?
            .is_some_and(|value| value.eq_ignore_ascii_case(CAPABILITY_YES)))
    }

    /// The driver's metadata, filtered to `domain` (default: the plain-string
    /// domain). This is where the whole `DMD_*` family lives — the creation option
    /// list, the supported extensions, the MIME type, the help topic.
    ///
    /// ```js
    /// gdal.driver('GTiff').metadata()['DMD_MIMETYPE']  // 'image/tiff'
    /// ```
    #[napi]
    pub fn metadata(&self, domain: Option<String>) -> Result<HashMap<String, String>> {
        let domain = domain.unwrap_or_default();
        self.with_driver(|driver| {
            let mut out = HashMap::new();
            for entry in driver.metadata() {
                if entry.domain == domain {
                    out.insert(entry.key, entry.value);
                }
            }
            Ok(out)
        })
    }

    /// The file extensions the driver claims, without the dot: `['tif', 'tiff']`.
    ///
    /// `DMD_EXTENSIONS` is the modern, space-separated item; older registrations
    /// only carry the singular `DMD_EXTENSION`, which may itself hold several. Both
    /// are read, because which one is present depends on the driver.
    #[napi]
    pub fn file_extensions(&self) -> Result<Vec<String>> {
        let plural = self.driver_item("DMD_EXTENSIONS")?;
        let text = match plural {
            Some(text) => text,
            None => self.driver_item("DMD_EXTENSION")?.unwrap_or_default(),
        };
        Ok(text
            .split_whitespace()
            .filter(|extension| !extension.is_empty())
            .map(str::to_string)
            .collect())
    }

    /// The XML `DMD_CREATIONOPTIONLIST` — every creation option the driver accepts,
    /// with its type, allowed values and default. `gdalinfo --format <name>` prints
    /// the same document, pretty-printed.
    ///
    /// `null` for a driver that creates nothing, or that declares no options.
    #[napi]
    pub fn creation_option_list(&self) -> Result<Option<String>> {
        self.driver_item("DMD_CREATIONOPTIONLIST")
    }

    /// The XML `DMD_OPENOPTIONLIST` — the options `open()` takes for this driver,
    /// the counterpart of `creationOptionList`.
    #[napi]
    pub fn open_option_list(&self) -> Result<Option<String>> {
        self.driver_item("DMD_OPENOPTIONLIST")
    }

    /// Delete a dataset this driver created — GDAL's `GDALDeleteDataset`, the call
    /// behind `gdal.GetDriverByName(name).Delete(path)`.
    ///
    /// Not every driver can, and `testCapability('DCAP_DELETE')` is the question to
    /// ask first. Note that this is the *dataset*, not a file: GDAL removes what it
    /// considers part of the dataset, which for a shapefile is several files and for
    /// a GeoPackage is one.
    #[napi]
    pub fn delete(&self, path: String) -> Result<()> {
        ensure_initialized();
        let _guard = lock_gdal();
        let driver = DriverManager::get_driver_by_name(&self.name).gdal()?;
        driver.delete(&path).gdal()
    }

    /// Open a dataset **with this driver only**, so a file another driver would
    /// have claimed fails instead of quietly loading as something else.
    ///
    /// The blocking form. For the thread-pool one, `gdal.open(path, { drivers: [...] })`
    /// is the same restriction with the async surface.
    #[napi]
    pub fn open_sync(&self, path: String, options: Option<OpenOptions>) -> Result<JsDataset> {
        let update = options
            .as_ref()
            .and_then(|options| options.update)
            .unwrap_or(false);
        let drivers = [self.name.clone()];
        crate::dataset::open_dataset_sync(&path, update, Some(&drivers))
    }

    /// The same, on the libuv thread pool.
    #[napi(ts_return_type = "Promise<Dataset>")]
    pub fn open(&self, path: String, options: Option<OpenOptions>) -> AsyncTask<OpenTask> {
        let update = options
            .as_ref()
            .and_then(|options| options.update)
            .unwrap_or(false);
        AsyncTask::new(OpenTask {
            path,
            kind: OpenKind::Open {
                update,
                drivers: Some(vec![self.name.clone()]),
            },
        })
    }

    /// Create a raster dataset with this driver — `gdal.create(path, { driver, ... })`
    /// with the driver already named, so it cannot be passed the wrong one.
    #[napi]
    pub fn create_sync(&self, path: String, options: DriverCreateOptions) -> Result<JsDataset> {
        create_dataset_sync(&path, &options.into_create_options(self.name.clone()))
    }

    /// The same, on the libuv thread pool.
    #[napi(ts_return_type = "Promise<Dataset>")]
    pub fn create(&self, path: String, options: DriverCreateOptions) -> AsyncTask<OpenTask> {
        AsyncTask::new(OpenTask {
            path,
            kind: OpenKind::CreateRaster(options.into_create_options(self.name.clone())),
        })
    }

    /// The short name. Defined so that `` `${dataset.driver}` `` and
    /// `String(dataset.driver)` keep reading the way they did when `dataset.driver`
    /// was a string, and so a driver logs usefully.
    #[napi(js_name = "toString")]
    pub fn to_js_string(&self) -> String {
        self.name.clone()
    }
}

/// Creation options for `Driver.create` — `CreateOptions` without the driver, which
/// the `Driver` object already is.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct DriverCreateOptions {
    pub width: u32,
    pub height: u32,
    /// Default 1.
    pub band_count: Option<u32>,
    /// Default `Uint8`.
    pub data_type: Option<DataType>,
    /// Driver creation options, e.g. `{ TILED: true, COMPRESS: 'DEFLATE' }`.
    pub options: Option<Value>,
}

impl DriverCreateOptions {
    fn into_create_options(self, driver: String) -> CreateOptions {
        CreateOptions {
            driver,
            width: self.width,
            height: self.height,
            band_count: self.band_count,
            data_type: self.data_type,
            options: self.options,
        }
    }
}

/// Every registered GDAL/OGR driver, sorted by short name. Call this first when
/// something fails to open: it is the quickest way to tell "the format is not
/// compiled in" apart from "the file is bad".
#[napi]
pub fn drivers() -> Vec<JsDriver> {
    ensure_initialized();
    let _guard = lock_gdal();

    let mut out = Vec::new();
    for index in 0..DriverManager::count() {
        let Ok(driver) = DriverManager::get_driver(index) else {
            continue;
        };
        out.push(JsDriver::new(driver.short_name()));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// One driver by short name, or `null` when this build has no such driver.
///
/// The lookup `gdal.drivers()` exists to make possible, without walking the array:
/// `gdal.driver('GTiff')?.testCapability('DCAP_CREATE') ?? false`.
#[napi]
pub fn driver(name: String) -> Result<Option<JsDriver>> {
    ensure_initialized();
    let _guard = lock_gdal();
    match DriverManager::get_driver_by_name(&name) {
        Ok(_) => Ok(Some(JsDriver::new(name))),
        // `get_driver_by_name` reports every failure the same way — an invalid name
        // is a bad argument to GDAL, but for a lookup, "not registered" is an
        // answer rather than an error. A NUL byte is not, so it is refused first.
        Err(_) if name.contains('\0') => {
            Err(bad_argument("a driver name cannot contain a NUL byte"))
        }
        Err(_) => Ok(None),
    }
}
