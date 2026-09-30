//! Process-wide initialisation: the GDAL serialisation lock, the PROJ/GDAL data
//! directories, and one-time driver registration.

use std::ffi::CStr;
use std::os::raw::c_char;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// Serialises the GDAL access that actually needs serialising.
///
/// Two things take the **write** side, and they are why this is a lock at all:
///
/// * **An open dataset.** GDAL is not thread-safe for one `GDALDataset` reached from
///   two threads, so every dataset operation takes the write lock (and the dataset's
///   own mutex). `openThreadSafe` is the opt-in for one GDAL has been asked to make
///   safe for concurrent reads.
/// * **Process-global configuration** — driver registration, `config.set`,
///   `configureDataPaths`, which writes the data-directory variables and registers
///   every driver, and the `programs` entry points, which build datasets of their own.
///
/// Everything that touches **neither a dataset nor global configuration** takes the
/// **read** side instead ([`lock_gdal_shared`]) and therefore runs genuinely in
/// parallel: the CRS and `CoordinateTransform` methods, the geometry/GEOS
/// operations, `gdal.fs`, and the module-level introspection — `gdal.version`,
/// `gdal.info`, `gdal.diagnostics`, `gdal.lastError`, `gdal.epsgToWkt`, the
/// `geometry*` helpers, and the driver-registry reads `gdal.drivers()` /
/// `gdal.driver(name)` (calling a method on the `Driver` they hand back reads the
/// registry too). Three things that look global are not, in the GDAL this links
/// (3.12):
///
/// * the last-error state is **thread-local** — `CPLGetTLSEx(CTLS_ERRORCONTEXT, …)` —
///   so the `gdal` crate's read-and-reset after each call stays on the calling
///   thread's own context. `gdals_last_error_is_thread_local` pins that, because the
///   read/write split depends on it — `lastError()` included;
/// * `OGRSpatialReference` takes its PROJ context from `OSRGetProjTLSContext()`, so
///   two threads transform through separate contexts;
/// * `OGRGeometry::createGEOSContext()` creates a GEOS context per call and frees it,
///   so predicates share no GEOS error state either.
///
/// The registry the driver reads walk is frozen the same way: `ensure_initialized`
/// registers every driver once, through a `OnceLock`, and nothing deregisters any
/// of them.
///
/// One read-only call is deliberately **not** on the read side: `config.get`. GDAL
/// guards its own config map, but `CPLGetConfigOption` returns a pointer *into* it
/// and drops the guard, so a concurrent `config.set` can free the string before the
/// copy happens — the two have to stay on the same side.
///
/// This was the "weaken the global lock" PoC's answer: the error state no longer has
/// to be protected, and the dataset-free surface can overlap (measured in
/// `scripts/bench-parallel.mjs`). Datasets still cannot — a second dataset handle is
/// the way to two concurrent readers there.
///
/// The consequence for the ordinary `open()` path is unchanged: the async APIs keep
/// the Node event loop free, but dataset work does **not** run in parallel. Only
/// `openThreadSafe()`, and work with no dataset in it, does.
static GDAL_LOCK: RwLock<()> = RwLock::new(());

/// Exclusive access: datasets, registers, and anything else process-global.
///
/// A poisoned lock is recovered from on purpose: a panic in one operation must not
/// brick the whole addon.
pub fn lock_gdal() -> RwLockWriteGuard<'static, ()> {
    GDAL_LOCK
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Shared access: work with no dataset and no global configuration in it, plus pixel
/// reads of a thread-safe dataset (see `DatasetRef::with`).
///
/// **A closure running under this lock must never call `lock_gdal()`**, and must not
/// take this lock again either: `RwLock` is not reentrant, so nesting either way
/// deadlocks the process. Everything reached from the CRS, geometry and `fs` modules,
/// from the module-level introspection (`version` / `info` / `diagnostics` /
/// `lastError` / `epsgToWkt` and the `geometry*` helpers) and from the
/// driver-registry reads is dataset-free, which is what makes them eligible.
pub fn lock_gdal_shared() -> RwLockReadGuard<'static, ()> {
    GDAL_LOCK
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Data directories handed over from JS via `configureDataPaths`.
#[derive(Debug, Default, Clone)]
pub struct DataPaths {
    pub proj: Option<String>,
    pub gdal: Option<String>,
}

static DATA_PATHS: Mutex<Option<DataPaths>> = Mutex::new(None);
static REGISTERED: OnceLock<()> = OnceLock::new();

/// Called from the JS shell (`index.js`) at require time so the packaged
/// `assets/{proj,gdal}` directories are found regardless of the CWD.
pub fn set_data_paths(paths: DataPaths) {
    if let Ok(mut slot) = DATA_PATHS.lock() {
        *slot = Some(paths.clone());
    } else {
        // Poisoned: still apply the paths, we do not need the stored copy.
    }
    apply(&paths);
    ensure_initialized();
}

/// Applies the data directories and registers every GDAL driver, at most once
/// per process. Every public entry point calls this first.
pub fn ensure_initialized() {
    REGISTERED.get_or_init(|| {
        let stored = DATA_PATHS.lock().ok().and_then(|slot| slot.clone());
        if let Some(paths) = stored {
            apply(&paths);
        }
        // Development convenience: a build from the repo can use the assets
        // staged next to Cargo.toml. In an installed npm package this path does
        // not exist, which is why `configureDataPaths` is the real mechanism.
        apply(&DataPaths {
            proj: dev_dir("proj"),
            gdal: dev_dir("gdal"),
        });

        gdal::DriverManager::register_all();
    });
}

/// An explicitly set `PROJ_DATA` / `GDAL_DATA` always wins: a user pointing at
/// their own GDAL or PROJ install should not be silently overridden.
fn apply(paths: &DataPaths) {
    if std::env::var_os("PROJ_DATA").is_none()
        && let Some(dir) = &paths.proj
    {
        set_env("PROJ_DATA", dir);
    }
    if std::env::var_os("GDAL_DATA").is_none()
        && let Some(dir) = &paths.gdal
    {
        set_env("GDAL_DATA", dir);
    }
}

fn dev_dir(name: &str) -> Option<String> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("assets")
        .join(name);
    dir.is_dir().then(|| dir.to_string_lossy().into_owned())
}

fn set_env(key: &str, value: &str) {
    // `set_var` is unsafe in edition 2024: it can race with concurrent reads of
    // the environment. This only runs during one-time initialisation, before
    // any GDAL work has started.
    unsafe { std::env::set_var(key, value) }
}

/// e.g. `GDAL 3.12.1 "Chicoutimi", released 2025/12/12`.
pub fn gdal_version() -> String {
    c_string(unsafe { gdal_sys::GDALVersionInfo(c"GDAL_RELEASE_NAME".as_ptr()) })
}

/// e.g. `9.6.2`.
pub fn proj_version() -> String {
    let info = unsafe { proj_sys::proj_info() };
    format!("{}.{}.{}", info.major, info.minor, info.patch)
}

/// Where PROJ is *compiled* to look for its data files.
///
/// Note this is PROJ's built-in default, not the effective runtime search path:
/// it still prints the directory the library was built in even when `PROJ_DATA`
/// takes precedence. Use [`proj_database_found`] to answer the question that
/// actually matters.
pub fn proj_default_search_path() -> String {
    c_string(unsafe { proj_sys::proj_info() }.searchpath)
}

/// Whether a directory named by `PROJ_DATA` / `PROJ_LIB` really holds `proj.db`.
///
/// This is the check that matters after packaging. A statically linked PROJ
/// keeps pointing at its build directory, so "the environment variable is set"
/// and "the CRS database was found" are two different claims.
pub fn proj_database_found() -> bool {
    let separator = if cfg!(windows) { ';' } else { ':' };
    for key in ["PROJ_DATA", "PROJ_LIB"] {
        let Ok(value) = std::env::var(key) else {
            continue;
        };
        for dir in value.split(separator).filter(|dir| !dir.is_empty()) {
            if PathBuf::from(dir).join("proj.db").is_file() {
                return true;
            }
        }
    }
    false
}

/// Copy a C string, mapping a null pointer to an empty string.
pub(crate) fn c_string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::sync::{Arc, Barrier};

    /// The lock's original reason was that GDAL kept its last error in process-global
    /// state, so two threads inside GDAL could read each other's. That stopped being
    /// true in GDAL 3.10, and the read/write split above rests on it — this fails
    /// loudly if a future GDAL puts the state back where it was.
    ///
    /// The threads deliberately do not take the lock: the point is to run inside GDAL
    /// at the same time and see whether their error states are the same one.
    #[test]
    fn gdals_last_error_is_thread_local() {
        ensure_initialized();

        let barrier = Arc::new(Barrier::new(2));
        let provoke = |message: &'static str| {
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let message = CString::new(message).unwrap();
                unsafe {
                    gdal_sys::CPLErrorSetState(gdal_sys::CPLErr::CE_Failure, 1, message.as_ptr())
                };
                // Both threads have written their own message by the time either reads,
                // which is the interleaving one process-wide slot could not survive.
                barrier.wait();
                c_string(unsafe { gdal_sys::CPLGetLastErrorMsg() })
            })
        };

        // Both have to be running before either is joined: the barrier wants two
        // arrivals, so joining the first would wait for one that never comes.
        let one = provoke("the error from one");
        let two = provoke("the error from two");

        let one = one.join().unwrap();
        let two = two.join().unwrap();

        assert!(one.contains("from one"), "read back {one:?}");
        assert!(two.contains("from two"), "read back {two:?}");
    }
}
