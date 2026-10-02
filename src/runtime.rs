//! Process-wide initialisation: the GDAL serialisation lock, the PROJ/GDAL data
//! directories, and one-time driver registration.

use std::cell::Cell;
use std::ffi::CStr;
use std::os::raw::c_char;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// Serialises the GDAL access that actually needs serialising.
///
/// The **write** side is for process-global state, and only for that:
///
/// * **Driver registration** and `configureDataPaths`, which writes the data-directory
///   variables and registers every driver. One-time, behind the `OnceLock` in
///   [`ensure_initialized`], which is what lets an open take the read side even on the
///   very first call.
/// * **`config.set`** — and `config.get` with it, because `CPLGetConfigOption` returns a
///   pointer *into* the map and drops the guard, so a concurrent `set` could free the
///   string before the copy happens.
/// * **Program runs that open their own datasets** — the module-level `translate` /
///   `warp` / `ogr2ogr` / `gdaldem` / `buildVrt`, which take paths and build the output
///   themselves; and `create` / `createVector`, which make a new dataset. They are the
///   calls whose output can be a file another thread is reading, so they exclude readers.
/// * **`with_two`**, which holds two datasets at once: the write side is what orders the
///   two per-dataset mutexes, so it cannot be the read side.
/// * **A thread-safe dataset's writes and `close()`**, since a plain read on that handle
///   deliberately overlaps.
///
/// Note what is **not** on this side, because the split is easy to misread. An operation
/// on an **already-open** dataset takes the read side even where it writes — `with_mut`,
/// and a program run over a dataset (`dataset.translateSync`, `createCopySync`,
/// `rasterizeSync`) — because that dataset's own mutex is what serialises it. And every
/// `gdal.fs` call takes the read side, **writes included** (`writeFile`, `mkdir`,
/// `unlink`, `rename`, `copyFile`); only `clearCurlCache` is on the write side. That is
/// safe for ordinary use — an `fs` write and a dataset read of a *different* path do not
/// interfere — but it is not a promise that a write racing a read of the same path is
/// ordered.
///
/// Everything else takes the **read** side, and therefore overlaps: an open, every
/// operation on an open dataset, the CRS, geometry and `fs` modules, and the
/// module-level introspection (`version` / `info` / `diagnostics` / `lastError` /
/// `epsgToWkt`, the `geometry*` helpers, the driver-registry reads `gdal.drivers()` /
/// `gdal.driver(name)`).
///
/// **One dataset is still one reader at a time**, and it is the per-handle mutex in
/// [`crate::dataset::SharedDataset`] that does it, not this lock: same handle from two
/// threads serialises — which is what GDAL is not thread-safe for — while two different
/// handles do not wait for each other. `openThreadSafe` is the opt-in for GDAL's own
/// `GDAL_OF_THREAD_SAFE`, which goes further and lets several threads read *one* handle
/// at once.
///
/// Three things that look global are not, in the GDAL this links (3.12), and the read
/// side rests on all three:
///
/// * the last-error state is **thread-local** — `CPLGetTLSEx(CTLS_ERRORCONTEXT, …)` —
///   so the `gdal` crate's read-and-reset after each call stays on the calling
///   thread's own context. `gdals_last_error_is_thread_local` pins that, because
///   `lastError()` depends on it;
/// * `OGRSpatialReference` takes its PROJ context from `OSRGetProjTLSContext()`, so
///   two threads transform through separate contexts;
/// * `OGRGeometry::createGEOSContext()` creates a GEOS context per call and frees it,
///   so predicates share no GEOS error state either.
///
/// The registry the driver reads walk is frozen the same way: `ensure_initialized`
/// registers every driver once, and nothing deregisters any of them.
///
/// **Never take a side from a closure that already holds one** — including
/// transitively: a dataset operation's closure, a CRS call, a geometry predicate.
/// `RwLock` is not reentrant, so that used to deadlock the process; `lock_gdal` /
/// `lock_gdal_shared` now panic on a nested acquisition instead (see [`Held`]), which
/// turns the hang into a diagnosis. The rule was already the one the thread-safe path
/// lived by; it now covers every dataset operation, and it is why the dataset closures
/// call nothing that locks.
static GDAL_LOCK: RwLock<()> = RwLock::new(());

/// Which side of [`GDAL_LOCK`], if either, the current thread is already inside.
///
/// `RwLock` is not reentrant, so a second acquisition on the same thread — a closure
/// that calls back into anything that locks — used to hang the process with no clue
/// why. This thread-local marker turns that from an unkillable hang into a panic.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Held {
    None,
    Shared,
    Exclusive,
}

thread_local! {
    static HELD: Cell<Held> = const { Cell::new(Held::None) };
}

/// Refuse a nested acquisition in place of the deadlock it would otherwise be.
#[cold]
fn reentrant_lock(side: &str) -> ! {
    let held = HELD.with(Cell::get);
    panic!(
        "the GDAL lock is not reentrant: this thread already holds the {held:?} side and \
         is trying to take the {side} side. A closure running under the lock must not \
         call back into anything that locks — see the rules on `GDAL_LOCK`."
    );
}

/// The write guard. Clearing the thread-local marker is why this is a wrapper rather
/// than the bare `RwLockWriteGuard`.
pub struct GdalWriteGuard(RwLockWriteGuard<'static, ()>);

/// The read guard, with the same marker-clearing as [`GdalWriteGuard`].
pub struct GdalReadGuard(RwLockReadGuard<'static, ()>);

impl Drop for GdalWriteGuard {
    fn drop(&mut self) {
        HELD.with(|held| held.set(Held::None));
    }
}

impl Drop for GdalReadGuard {
    fn drop(&mut self) {
        HELD.with(|held| held.set(Held::None));
    }
}

impl std::ops::Deref for GdalWriteGuard {
    type Target = ();
    fn deref(&self) -> &() {
        &self.0
    }
}

impl std::ops::DerefMut for GdalWriteGuard {
    fn deref_mut(&mut self) -> &mut () {
        &mut self.0
    }
}

impl std::ops::Deref for GdalReadGuard {
    type Target = ();
    fn deref(&self) -> &() {
        &self.0
    }
}

/// Exclusive access: datasets, registers, and anything else process-global.
///
/// A poisoned lock is recovered from on purpose: a panic in one operation must not
/// brick the whole addon. Taking either side again from the same thread panics rather
/// than deadlocks — see [`Held`] and [`reentrant_lock`].
pub fn lock_gdal() -> GdalWriteGuard {
    HELD.with(|held| {
        if held.get() != Held::None {
            reentrant_lock("exclusive");
        }
        held.set(Held::Exclusive);
    });
    GdalWriteGuard(
        GDAL_LOCK
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    )
}

/// Shared access: work with no dataset and no global configuration in it, plus pixel
/// reads of a thread-safe dataset (see `DatasetRef::with`).
///
/// **A closure running under this lock must never call `lock_gdal()`**, and must not
/// take this lock again either: `RwLock` is not reentrant, so nesting either way
/// deadlocks the process. Everything reached from the CRS, geometry and `fs` modules,
/// from the module-level introspection (`version` / `info` / `diagnostics` /
/// `lastError` / `epsgToWkt` and the `geometry*` helpers) and from the
/// driver-registry reads is dataset-free, which is what makes them eligible. The panic
/// in [`reentrant_lock`] is what makes a violation of that rule a diagnosis rather than
/// a hang.
pub fn lock_gdal_shared() -> GdalReadGuard {
    HELD.with(|held| {
        if held.get() != Held::None {
            reentrant_lock("shared");
        }
        held.set(Held::Shared);
    });
    GdalReadGuard(
        GDAL_LOCK
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    )
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

    /// The guard exists because `RwLock` is not reentrant: nesting the same side used
    /// to hang the whole process with nothing on stderr. A panic is the diagnosis
    /// instead of the hang.
    #[test]
    #[should_panic(expected = "not reentrant")]
    fn a_second_exclusive_lock_panics_instead_of_deadlocking() {
        let _outer = lock_gdal();
        let _inner = lock_gdal();
    }

    /// The shape the `srs()` bug had: the write side held, then the shared side taken
    /// from inside it.
    #[test]
    #[should_panic(expected = "not reentrant")]
    fn the_shared_lock_under_the_exclusive_one_panics() {
        let _outer = lock_gdal();
        let _inner = lock_gdal_shared();
    }

    /// The marker is cleared when the guard drops, including while a panic unwinds, so
    /// a refused acquisition leaves the lock usable rather than poisoned by the guard.
    #[test]
    fn the_lock_is_reusable_after_a_reentrant_panic() {
        let caught = std::panic::catch_unwind(|| {
            let _outer = lock_gdal();
            let _inner = lock_gdal();
        });
        assert!(caught.is_err());
        // Would deadlock here if the panic had left the marker — or the lock — held.
        let _again = lock_gdal();
    }
}
