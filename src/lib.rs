//! Node.js bindings for GDAL.
//!
//! Layering: `index.js` (data-path injection) -> this napi module -> `gdal` /
//! `gdal-sys` -> a statically linked `libgdal` + `libproj`.
//!
//! Every operation that touches GDAL takes `runtime::lock_gdal()` first; see
//! the comment on that lock for why. The one exception is a pixel read of a
//! dataset opened through `openThreadSafe`, which takes the shared side of that
//! lock and therefore runs genuinely in parallel.

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
mod config;
mod dataset;
mod driver;
mod dtype;
mod error;
mod fs;
mod geometry;
mod json;
mod programs;
mod progress;
mod raster_io;
mod raster_tools;
mod runtime;
mod spatial_ref;
mod vector;

use std::collections::HashMap;

use gdal::spatial_ref::SpatialRef;
use napi_derive::napi;

use crate::error::IntoGdalResult;
use crate::runtime::lock_gdal;

/// WKT for an EPSG code, ready to hand to `Dataset.setProjection`.
///
/// Sugar for `SpatialRef.fromEpsg(code).wkt`, kept because it is the one-liner
/// people reach for — and because both `setProjection` and `createLayer` want WKT.
/// It needs the CRS database, so it fails if the packaged `assets/proj/proj.db`
/// is missing — see `diagnostics`.
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
pub struct GdalInfo {
    /// e.g. `3.12.1`
    pub release_name: String,
    /// e.g. `20251212`
    pub release_date: String,
    /// The same number as a single integer, e.g. `3120100`.
    pub version_num: String,
    /// GDAL's `BUILD_INFO`: `OGR_ENABLED`, `PROJ_BUILD_VERSION`, `COMPILER`,
    /// `CURL_ENABLED` and the rest. It is what the library was *compiled* with, and
    /// a feature that was compiled out is simply absent rather than reported as
    /// off — `GEOS_ENABLED` is here because the bundled build links GEOS, and a
    /// build without it would have no such key. `diagnostics` and `features` are
    /// where the yes/no answers live; this is the raw list.
    pub build: HashMap<String, String>,
    /// Registered drivers, the same number `drivers().length` reports. Here so
    /// one call answers "what am I running".
    pub driver_count: u32,
}

/// What the statically linked GDAL was built with, and how many drivers it
/// registered.
///
/// `version()` is the one-liner (`GDAL 3.12.1 …, PROJ 9.6.2`); this is the detail
/// behind it, straight from GDAL's `BUILD_INFO`. It answers "is capability X in
/// this build" — and answers it the way GDAL does, by listing only what was
/// compiled in, so the absence of a key is the answer.
#[napi]
pub fn info() -> GdalInfo {
    runtime::ensure_initialized();
    let _guard = runtime::lock_gdal();

    use gdal::version::VersionInfo;

    GdalInfo {
        release_name: VersionInfo::release_name(),
        release_date: VersionInfo::release_date(),
        version_num: VersionInfo::version_num(),
        build: VersionInfo::build_info(),
        driver_count: gdal::DriverManager::count() as u32,
    }
}

#[napi(object)]
pub struct LastError {
    /// The `CPLErr` class: 0 None, 1 Debug, 2 Warning, 3 Failure, 4 Fatal. It is
    /// the same number the sync error codes are named after — `GDAL_CPL_FAILURE`
    /// is class 3 — so a `lastError()` you catch can be matched to that list.
    pub class: i32,
    /// GDAL's `CPLErrorNum`, e.g. 4 for `CPLE_AppDefined`. The other half of the
    /// `[CPLErr=3 #4]` prefix the thrown messages carry.
    pub number: i32,
    pub message: String,
}

/// GDAL's most recent error, or `null` when there has not been one.
///
/// A sync call that fails also throws, with `err.code` set — so this is for the
/// errors that never became an exception: a warning a driver logged and carried
/// on past, or the last state left behind by a call whose return value was not a
/// failure. It is the same store GDAL's own tools read.
///
/// Every GDAL operation in this binding is serialised, so what you read here was
/// not overwritten by another thread in the meantime.
#[napi]
pub fn last_error() -> Option<LastError> {
    runtime::ensure_initialized();
    let _guard = runtime::lock_gdal();

    // 0 is CE_None: either nothing has gone wrong, or the last thing that did has
    // been reset since. `CPLGetLastErrorMsg` can still hold a stale message at
    // that point, which is why the class gates the whole result rather than the
    // message alone.
    let class = unsafe { gdal_sys::CPLGetLastErrorType() } as i32;
    if class == 0 {
        return None;
    }

    Some(LastError {
        class,
        number: unsafe { gdal_sys::CPLGetLastErrorNo() },
        message: runtime::c_string(unsafe { gdal_sys::CPLGetLastErrorMsg() }),
    })
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
    /// Whether GDAL was built with GEOS. The bundled build is — GEOS is vendored
    /// and compiled by the build, the way GDAL itself is — so the OGR predicates
    /// it implements (`ST_Intersects`, `ST_Buffer`, `-simplify`) are available. A
    /// lean build without it answers `false` here, which is the same answer
    /// `features().geos` gives. See `docs/GEOS.md` for the licensing note.
    pub geos_available: bool,
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
        geos_available: gdal::version::VersionInfo::has_geos(),
    }
}

/// The **binding's own** API version — `package.json`'s version, which is not
/// the GDAL version `version()` reports.
///
/// It exists so a feature can be probed without parsing anything: read this once
/// at startup and branch, rather than calling a method and catching the
/// `TypeError` when it is not there yet.
#[allow(non_upper_case_globals)]
#[napi]
pub const apiVersion: &str = env!("CARGO_PKG_VERSION");

/// Which optional capabilities this build actually has.
///
/// `info()` answers "what was GDAL compiled with" by listing GDAL's `BUILD_INFO`,
/// where a missing key is the answer. This is the same question asked about *this
/// binding*: a stable set of booleans, always present, so `if (gdal.features().geos)`
/// reads the same way whatever the build turned out to be. The two flags that are
/// `false` here are the capabilities deliberately left out rather than
/// unavailable — see `CHANGELOG.md`.
#[napi(object)]
pub struct FeatureSupport {
    /// Whether OGR's geometry predicates (`ST_Intersects`, `ST_Buffer`,
    /// `-simplify`) are compiled in. GDAL implements them through GEOS, which is
    /// LGPL-2.1; the bundled build vendors and statically links it, so this is
    /// `true` there and `false` in a build without it — see `docs/GEOS.md`.
    pub geos: bool,
    /// Whether `openThreadSafe` is compiled in. It needs GDAL ≥ 3.10, and
    /// `build.rs` switches it on from the version `gdal-sys` reports.
    pub thread_safe: bool,
    /// The multidimensional data model (`MDArray`, `Group`, `Attribute`,
    /// `Dimension`). Not implemented, so always `false`.
    pub multidimensional: bool,
    /// Node.js `Stream`s over raster data. Not implemented, so always `false`.
    pub streams: bool,
}

/// What this binding can do — the feature-probe counterpart of `info()`.
#[napi]
pub fn features() -> FeatureSupport {
    FeatureSupport {
        geos: gdal::version::VersionInfo::has_geos(),
        thread_safe: cfg!(gd_thread_safe),
        multidimensional: false,
        streams: false,
    }
}
