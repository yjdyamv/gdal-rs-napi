//! Process-wide initialisation: the GDAL serialisation lock, the PROJ/GDAL data
//! directories, and one-time driver registration.

use std::ffi::CStr;
use std::os::raw::c_char;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// Serialises access to GDAL.
///
/// GDAL keeps its "last error" in process-global state, and the `gdal` crate
/// reads + resets it right after each FFI call — so two threads inside GDAL at
/// once can observe each other's error. Several drivers are not thread-safe
/// either. Holding this for the duration of each operation keeps those races
/// out.
///
/// It is a reader/writer lock rather than a plain mutex so that pixel reads of a
/// thread-safe dataset (see `DatasetRef::Concurrent`) can run genuinely in
/// parallel. Everything else takes the write lock and therefore excludes them,
/// which is what keeps the error-state race described above out of the picture.
///
/// The consequence for the ordinary `open()` path is unchanged: the async APIs
/// keep the Node event loop free, but they do **not** make GDAL work run in
/// parallel. Only `openThreadSafe()` does.
static GDAL_LOCK: RwLock<()> = RwLock::new(());

/// Exclusive access. Everything except a thread-safe dataset's pixel reads takes
/// this. A poisoned lock is recovered from on purpose: a panic in one operation
/// must not brick the whole addon.
pub fn lock_gdal() -> RwLockWriteGuard<'static, ()> {
    GDAL_LOCK
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Shared access, for pixel reads of a thread-safe dataset only.
///
/// **A closure running under this lock must never call `lock_gdal()`**: `RwLock`
/// is not reentrant, so taking the write lock while holding the read lock
/// deadlocks the process. See `DatasetRef::with`.
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

fn c_string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned()
}
