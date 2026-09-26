//! Node.js bindings for GDAL.
//!
//! Layering: `index.js` (data-path injection) -> this napi module -> `gdal` /
//! `gdal-sys` -> a statically linked `libgdal` + `libproj`.
//!
//! Every operation that touches GDAL takes `runtime::lock_gdal()` first; see
//! the comment on that lock for why.

#![deny(clippy::all)]
// Statically linking PROJ into GDAL makes MSVC emit a batch of LNK4217
// ("symbol imported by ...") warnings at link time. They are benign — the
// symbol resolves to the same static PROJ — but rustc relays every one of them.
#![allow(linker_messages)]
// When the crate is compiled as a test harness rather than as the cdylib, the
// module registration that makes the `#[napi]` entry points reachable is not
// part of the build, so every one of them looks unused. Only the test build is
// affected; the shipped cdylib is warning-free.
#![cfg_attr(test, allow(dead_code))]

mod band;
mod dataset;
mod dtype;
mod error;
mod json;
mod raster_io;
mod runtime;
mod vector;

use gdal::spatial_ref::SpatialRef;
use napi_derive::napi;

use crate::error::IntoGdalResult;
use crate::runtime::lock_gdal;

/// WKT for an EPSG code, ready to hand to `Dataset.setProjection`.
///
/// There is no `SpatialRef` class yet, so this is the whole of the CRS
/// construction API for writing. It needs the CRS database, so it fails if the
/// packaged `assets/proj/proj.db` is missing — see `diagnostics`.
#[napi]
pub fn epsg_to_wkt(code: u32) -> crate::error::Result<String> {
    runtime::ensure_initialized();
    let _guard = lock_gdal();
    SpatialRef::from_epsg(code).gdal()?.to_wkt().gdal()
}

#[napi(object)]
pub struct Versions {
    /// e.g. `GDAL 3.12.1 "Chicoutimi", released 2025/12/12`
    pub gdal: String,
    /// e.g. `9.6.2`
    pub proj: String,
}

/// Versions of the statically linked libraries. There is no `node` field on
/// purpose — `process.versions.node` is already available in JS.
#[napi]
pub fn version() -> Versions {
    runtime::ensure_initialized();
    let _guard = runtime::lock_gdal();
    Versions {
        gdal: runtime::gdal_version(),
        proj: runtime::proj_version(),
    }
}

#[napi(object)]
pub struct DriverInfo {
    pub name: String,
    pub long_name: String,
}

/// Every registered GDAL/OGR driver, sorted by short name. Call this first when
/// something fails to open: it is the quickest way to tell "the format is not
/// compiled in" apart from "the file is bad".
#[napi]
pub fn drivers() -> Vec<DriverInfo> {
    runtime::ensure_initialized();
    let _guard = runtime::lock_gdal();

    let mut out = Vec::new();
    for index in 0..gdal::DriverManager::count() {
        let Ok(driver) = gdal::DriverManager::get_driver(index) else {
            continue;
        };
        out.push(DriverInfo {
            name: driver.short_name(),
            long_name: driver.long_name(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[napi(object)]
pub struct DataPathsOptions {
    pub proj: Option<String>,
    pub gdal: Option<String>,
}

/// Point PROJ/GDAL at their data directories. `index.js` calls this
/// automatically with the packaged `assets/{proj,gdal}`; call it yourself only
/// if you relocated those files or want to use your own GDAL data.
///
/// Values already present in `PROJ_DATA` / `GDAL_DATA` are never overwritten.
#[napi]
pub fn configure_data_paths(options: DataPathsOptions) {
    runtime::set_data_paths(runtime::DataPaths {
        proj: options.proj,
        gdal: options.gdal,
    });
}

#[napi(object)]
pub struct Diagnostics {
    /// Whether GDAL could resolve `EPSG:4326`. A static PROJ still needs its
    /// `proj.db` at run time, and `EPSG:4326` is the cheapest way to prove the
    /// CRS database was found — everything CRS-related depends on it.
    pub epsg_4326_resolves: bool,
    pub error: Option<String>,
    /// Whether `proj.db` was actually found in one of the `PROJ_DATA` /
    /// `PROJ_LIB` directories. Distinct from `projDefaultSearchPath`, and the
    /// claim worth asserting on in a smoke test.
    pub crs_database_found: bool,
    pub proj_data_env: Option<String>,
    pub gdal_data_env: Option<String>,
    /// PROJ's *compiled-in* default search path. Still names the machine the
    /// library was built on even when `PROJ_DATA` takes precedence, so treat it
    /// as trivia rather than as the path in use.
    pub proj_default_search_path: String,
}

/// First stop when something CRS-related fails: reports whether the CRS
/// database is actually reachable and where PROJ was pointed.
#[napi]
pub fn diagnostics() -> Diagnostics {
    runtime::ensure_initialized();
    let _guard = runtime::lock_gdal();

    let (resolves, error) = match gdal::spatial_ref::SpatialRef::from_epsg(4326) {
        Ok(_) => (true, None),
        Err(err) => (false, Some(err.to_string())),
    };

    Diagnostics {
        epsg_4326_resolves: resolves,
        error,
        crs_database_found: runtime::proj_database_found(),
        proj_data_env: std::env::var("PROJ_DATA").ok(),
        gdal_data_env: std::env::var("GDAL_DATA").ok(),
        proj_default_search_path: runtime::proj_default_search_path(),
    }
}
