//! GDAL's virtual file system, as `gdal.fs.*`.
//!
//! These are the `VSI*` functions, the layer every GDAL path already goes through,
//! so the same calls work on `/vsimem/` (memory), `/vsizip/`, `/vsicurl/` and an
//! ordinary path on disk without this binding having to know which it is. The
//! `/vsimem/` corner is the interesting one: a dataset can be read back as bytes
//! with `fs.readFile(dataset.path)`, and bytes can be opened as a dataset with
//! `open(buffer)`.
//!
//! Everything here is synchronous, deliberately. Every call a program actually
//! makes is a memory copy or a local syscall. A `/vsicurl/` read is the exception —
//! it is a network round trip and it will block the event loop — so for that case
//! reach for `open(url)`, which runs on the thread pool, rather than reading the
//! bytes here first.
//!
//! A missing file is not an error: `exists` says `false` and `stat` says `null`,
//! which is what a filesystem API should do. Only a call that was asked to change
//! something — `writeFile`, `mkdir`, `unlink` — throws when it cannot.
//!
//! `/vsimem/` is not a real filesystem underneath: a path there is an opaque name,
//! so `writeFile('/vsimem/somewhere/nested.bin', bytes)` works without that
//! "directory" ever having been created, and `mkdir` is only for where something
//! insists on the shape of a tree.
//!
//! Not every operation means something on every file system: `/vsizip/`, `/vsitar/`
//! and `/vsigzip/` are read-only, and `/vsicurl/` is a read-only network source.
//! The support matrix, per operation and per file system, is in the README; the
//! operations here are the ones GDAL answers for a path, so what each one does on
//! a given `/vsi*/` prefix is GDAL's answer, not this binding's.

use std::ffi::{CString, c_char, c_int};

use napi::bindgen_prelude::{Buffer, Error};
use napi_derive::napi;

use crate::error::{GdalErrorCode, IntoGdalResult, Result, bad_argument, cpl_failure};
use crate::runtime::{c_string, ensure_initialized, lock_gdal, lock_gdal_shared};

/// GDAL's `VSI_ISDIR` and `VSI_ISREG`, which are the POSIX mode masks. The macros
/// themselves are not bindgen-visible, but the numbers are fixed.
const MODE_MASK: u32 = 0o170000;
const MODE_DIRECTORY: u32 = 0o040000;
const MODE_FILE: u32 = 0o100000;

/// The buffer `VSIStatL` fills in, and the reason it is not simply
/// `gdal_sys::VSIStatBufL` everywhere.
///
/// `VSIStatBufL` is not one C type. GDAL's `port/cpl_vsi.h` says
/// `typedef struct VSI_STAT64_T VSIStatBufL;`, and what `VSI_STAT64_T` is
/// depends on the platform, so the Rust type behind it differs per target:
///
/// | target | GDAL's `VSI_STAT64_T` | [`StatBuf`] |
/// |---|---|---|
/// | `x86_64-pc-windows-msvc` / `-gnu` | `_stat64` | `gdal_sys::VSIStatBufL` |
/// | `aarch64-apple-darwin` | `stat` — forced | `libc::stat` |
/// | `x86_64-unknown-linux-gnu` / `-musl` | `stat64` (large-file) | `libc::stat64` |
///
/// The Apple row is GDAL overriding itself. `port/cpl_vsil_unix_stdio_64.cpp`
/// sets `VSI_STAT64_T` to `stat64` when large-file support is on, and then
/// `port/cpl_config_extras.h`, inside `#if defined(__APPLE__)`, deliberately
/// takes it back:
///
/// ```c
/// #undef VSI_STAT64
/// #undef VSI_STAT64_T
/// #define VSI_STAT64 stat
/// #define VSI_STAT64_T stat
/// #endif  // APPLE
///
/// So macOS has no `stat64` at all — not in GDAL's typedef and not in `libc`,
/// which has `stat64` for Linux and no `stat64` anywhere under `unix/bsd`. A
/// `windows` / `not(windows)` split therefore cannot be right in either
/// direction: it sends macOS to a type that does not exist, and that is what
/// `error[E0425]: cannot find type 'stat64' in crate 'libc'` was.
///
/// On Unix the buffer is `libc`'s own struct rather than the typedef because
/// bindgen declares GDAL's `stat64` opaque there — `struct stat64 { _unused:
/// [u8; 0] }` in the prebuilt Linux binding — since GDAL's headers only typedef
/// the name and never dereference it where bindgen can see. There is nothing to
/// read in that type. Windows keeps `gdal_sys::VSIStatBufL` because bindgen
/// emitted the full `_stat64` there, and `libc` has no 64-bit-time `stat` to
/// substitute — its `libc::stat` is the 32-bit-time struct, a different one.
///
/// These must follow GDAL's typedef rather than "whichever libc type has the
/// field names I need": on Linux `libc::stat` also has `st_size`, `st_mode` and
/// `st_mtime`, so the compiler is perfectly happy with it while GDAL writes a
/// `stat64` into the buffer. Checking that mapping is the only thing standing
/// between this and a silent read of the wrong offsets.
#[cfg(windows)]
type StatBuf = gdal_sys::VSIStatBufL;
#[cfg(all(not(windows), target_vendor = "apple"))]
type StatBuf = libc::stat;
#[cfg(all(not(windows), not(target_vendor = "apple")))]
type StatBuf = libc::stat64;

/// `VSIStatL` wants a `*mut VSIStatBufL`; we may hold a [`StatBuf`].
///
/// # Safety
///
/// On Windows this is the identity. On Unix, [`StatBuf`] is the `libc` struct
/// for the platform and `VSIStatBufL` is bindgen's opaque stand-in for the same
/// C struct, so the cast preserves the layout GDAL writes into. The buffer must
/// be correctly aligned and at least `size_of::<VSIStatBufL>()` bytes; on Unix it
/// is a `StatBuf`, which is that struct.
#[cfg(not(windows))]
#[allow(clippy::ptr_as_ptr)]
unsafe fn as_vsi_stat_buf(stat: *mut StatBuf) -> *mut gdal_sys::VSIStatBufL {
    stat as *mut gdal_sys::VSIStatBufL
}

#[cfg(windows)]
#[allow(clippy::ptr_as_ptr, unused_variables)]
unsafe fn as_vsi_stat_buf(stat: *mut StatBuf) -> *mut gdal_sys::VSIStatBufL {
    stat
}

/// The mode bits of a [`StatBuf`], widened to `u32` so [`MODE_MASK`] and the
/// `MODE_*` constants can be compared against them.
///
/// The cast is load-bearing on some targets and redundant on others, which is
/// the one thing about this line that is not obvious:
///
/// | target | `st_mode` is | so the cast is |
/// |---|---|---|
/// | `x86_64-pc-windows-msvc` / `-gnu` | `c_ushort` | needed — `u16` to `u32` |
/// | `aarch64-apple-darwin` | `u16` (`mode_t`) | needed — `u16` to `u32` |
/// | `x86_64-unknown-linux-gnu` / `-musl` | `u32` (`mode_t`) | **redundant**, and clippy says so |
///
/// `#![deny(clippy::all)]` turns that last row into a build failure
/// (`unnecessary_cast`), so the cast cannot simply be dropped — and `u32::from`
/// is no escape either, since that trips `useless_conversion` on the same
/// target. The allow lives here, on the single line that has to be conditional,
/// rather than on the `#[napi]` function where it would also suppress it for
/// every other cast in the body.
#[allow(clippy::unnecessary_cast)]
fn mode_of(stat: &StatBuf) -> u32 {
    stat.st_mode as u32
}

/// `SEEK_END` and `SEEK_SET`, which `VSIFSeekL` takes as plain ints.
const SEEK_SET: c_int = 0;
const SEEK_END: c_int = 2;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct FileStat {
    /// Size in bytes.
    pub size: f64,
    /// `true` for a directory.
    pub is_directory: bool,
    /// `true` for a regular file.
    pub is_file: bool,
    /// Last modification time, in milliseconds since the Unix epoch.
    pub modified_ms: f64,
}

/// Read a whole file into a `Buffer`.
///
/// ```js
/// const bytes = gdal.fs.readFile('/vsimem/data.tif')
/// const { size, isFile } = gdal.fs.stat('/vsimem/data.tif')
/// ```
#[napi(namespace = "fs")]
pub fn read_file(path: String) -> Result<Buffer> {
    ensure_initialized();
    let _guard = lock_gdal_shared();

    let path = c_path(&path)?;
    let handle = open_handle(&path, b"rb")?;
    // The size comes from the handle rather than from a stat, so this works the
    // same on `/vsicurl/` as on a local file.
    let size = unsafe {
        if gdal_sys::VSIFSeekL(handle, 0, SEEK_END) != 0 {
            let error = vsi_failure("VSIFSeekL");
            gdal_sys::VSIFCloseL(handle);
            return Err(error);
        }
        gdal_sys::VSIFTellL(handle)
    } as usize;

    let mut bytes = vec![0u8; size];
    let read = unsafe {
        // The seek that measured the file left the handle at its end, where a read
        // returns nothing — so knowing how long the file is has to be followed by
        // going back to the start of it.
        if gdal_sys::VSIFSeekL(handle, 0, SEEK_SET) != 0 {
            let error = vsi_failure("VSIFSeekL");
            gdal_sys::VSIFCloseL(handle);
            return Err(error);
        }
        if size == 0 {
            0
        } else {
            gdal_sys::VSIFReadL(bytes.as_mut_ptr().cast(), 1, size, handle)
        }
    };
    unsafe { gdal_sys::VSIFCloseL(handle) };

    if read != size {
        // A short read means the file shrank or the read failed; handing back what
        // did arrive would hide that behind a truncated buffer.
        return Err(vsi_failure("VSIFReadL"));
    }
    Ok(bytes.into())
}

/// Write a `Buffer` to a file, replacing whatever was there.
///
/// ```js
/// gdal.fs.writeFile('/vsimem/data.tif', bytes)
/// gdal.fs.writeFile('/tmp/note.txt', Buffer.from('hello'))
/// ```
#[napi(namespace = "fs")]
pub fn write_file(path: String, data: Buffer) -> Result<()> {
    ensure_initialized();
    let _guard = lock_gdal_shared();

    let path = c_path(&path)?;
    let bytes: &[u8] = &data;
    let handle = open_handle(&path, b"wb")?;
    let written = if bytes.is_empty() {
        0
    } else {
        unsafe { gdal_sys::VSIFWriteL(bytes.as_ptr().cast(), 1, bytes.len(), handle) }
    };
    let closed = unsafe { gdal_sys::VSIFCloseL(handle) };

    if written != bytes.len() || closed != 0 {
        return Err(vsi_failure("VSIFWriteL"));
    }
    Ok(())
}

/// Whether anything is at this path.
#[napi(namespace = "fs")]
pub fn exists(path: String) -> bool {
    stat_of(&path).is_some()
}

/// What is at this path, or `null` when there is nothing there.
#[napi(namespace = "fs")]
pub fn stat(path: String) -> Option<FileStat> {
    let (_, stat) = stat_of(&path)?;
    let mode = mode_of(&stat);
    Some(FileStat {
        size: stat.st_size as f64,
        is_directory: mode & MODE_MASK == MODE_DIRECTORY,
        is_file: mode & MODE_MASK == MODE_FILE,
        modified_ms: stat.st_mtime as f64 * 1000.0,
    })
}

/// Create a directory. Like `mkdir(2)`, the parent has to be there already.
#[napi(namespace = "fs")]
pub fn mkdir(path: String) -> Result<()> {
    ensure_initialized();
    let _guard = lock_gdal_shared();

    let path = c_path(&path)?;
    let status = unsafe { gdal_sys::VSIMkdir(path.as_ptr(), 0o755) };
    vsi_status(status, "VSIMkdir")
}

/// Create a directory and every missing parent, like `mkdir -p`.
#[napi(namespace = "fs")]
pub fn mkdir_recursive(path: String) -> Result<()> {
    ensure_initialized();
    let _guard = lock_gdal_shared();

    let path = c_path(&path)?;
    let status = unsafe { gdal_sys::VSIMkdirRecursive(path.as_ptr(), 0o755) };
    vsi_status(status, "VSIMkdirRecursive")
}

/// Remove an empty directory.
#[napi(namespace = "fs")]
pub fn rmdir(path: String) -> Result<()> {
    ensure_initialized();
    let _guard = lock_gdal_shared();

    let path = c_path(&path)?;
    let status = unsafe { gdal_sys::VSIRmdir(path.as_ptr()) };
    vsi_status(status, "VSIRmdir")
}

/// Remove a directory and everything under it, like `rm -rf`.
#[napi(namespace = "fs")]
pub fn rmdir_recursive(path: String) -> Result<()> {
    ensure_initialized();
    let _guard = lock_gdal_shared();

    let path = c_path(&path)?;
    let status = unsafe { gdal_sys::VSIRmdirRecursive(path.as_ptr()) };
    vsi_status(status, "VSIRmdirRecursive")
}

/// Remove a file.
#[napi(namespace = "fs")]
pub fn unlink(path: String) -> Result<()> {
    ensure_initialized();
    let _guard = lock_gdal_shared();

    let path = c_path(&path)?;
    let status = unsafe { gdal_sys::VSIUnlink(path.as_ptr()) };
    vsi_status(status, "VSIUnlink")
}

/// Rename or move a file or directory.
///
/// A rename stays inside one file system: moving a file out of `/vsimem/` and onto
/// disk is a copy and a delete, which is `copyFile` / `unlink`, not this.
#[napi(namespace = "fs")]
pub fn rename(from: String, to: String) -> Result<()> {
    ensure_initialized();
    let _guard = lock_gdal_shared();

    let from = c_path(&from)?;
    let to = c_path(&to)?;
    let status = unsafe { gdal_sys::VSIRename(from.as_ptr(), to.as_ptr()) };
    vsi_status(status, "VSIRename")
}

/// Copy a file, replacing the target if it is already there.
///
/// Unlike `rename`, this crosses file systems — `/vsicurl/` to `/vsimem/`, say —
/// which is exactly what a copy is for.
#[napi(namespace = "fs")]
pub fn copy_file(from: String, to: String) -> Result<()> {
    ensure_initialized();
    let _guard = lock_gdal_shared();

    let from = c_path(&from)?;
    let to = c_path(&to)?;
    // No open source handle and no known size, so GDAL opens and stats the source
    // itself; `-1` as an unsigned size is GDAL's "we do not know how long it is".
    let status = unsafe {
        gdal_sys::VSICopyFile(
            from.as_ptr(),
            to.as_ptr(),
            std::ptr::null_mut(),
            u64::MAX,
            std::ptr::null(),
            None,
            std::ptr::null_mut(),
        )
    };
    vsi_status(status, "VSICopyFile")
}

/// The entries in a directory, or everything under it when `recursive`.
///
/// The `.` and `..` entries GDAL reports for a real directory are left out, the way
/// `fs.readdir` leaves them out, so an empty directory reads as `[]`.
#[napi(namespace = "fs")]
pub fn read_dir(path: String, recursive: Option<bool>) -> Result<Vec<String>> {
    ensure_initialized();
    let _guard = lock_gdal_shared();

    let entries = gdal::vsi::read_dir(&path, recursive.unwrap_or(false)).gdal()?;
    Ok(entries
        .iter()
        .map(|entry| entry.display().to_string())
        .filter(|entry| entry != "." && entry != "..")
        .collect())
}

/// Expand a glob pattern into the paths that match it.
///
/// `*` and `?` match within one path component and `**` descends through the tree,
/// so `/vsimem/out/**/*.tif` is a whole tree. The pattern names the file system,
/// which is the point: `/vsimem/part*.tif` and `/vsizip/archive.zip/*.tif` are the
/// same call here but not the same source. No matches is an empty array.
#[napi(namespace = "fs")]
pub fn glob(pattern: String) -> Result<Vec<String>> {
    ensure_initialized();
    let _guard = lock_gdal_shared();

    let pattern = c_path(&pattern)?;
    let list = unsafe {
        gdal_sys::VSIGlob(
            pattern.as_ptr(),
            std::ptr::null(),
            None,
            std::ptr::null_mut(),
        )
    };
    let matches = csl_to_vec(list);
    unsafe { gdal_sys::CSLDestroy(list) };
    Ok(matches)
}

/// Free space in bytes on the file system holding this path.
///
/// `0` when GDAL cannot say — a virtual file system with no size, a `/vsicurl/` URL.
#[napi(namespace = "fs")]
pub fn disk_free_space(path: String) -> Result<f64> {
    ensure_initialized();
    let _guard = lock_gdal_shared();

    let path = c_path(&path)?;
    Ok(unsafe { gdal_sys::VSIGetDiskFreeSpace(path.as_ptr()) } as f64)
}

/// Whether this path is on the local file system.
///
/// `false` for the remote ones — `/vsicurl/`, `/vsis3/` — which is what a caller
/// wants to know before treating a read as cheap. Local here includes `/vsimem/`,
/// whose bytes do live in this process.
#[napi(namespace = "fs")]
pub fn is_local(path: String) -> Result<bool> {
    ensure_initialized();
    let _guard = lock_gdal_shared();

    let path = c_path(&path)?;
    Ok(unsafe { gdal_sys::VSIIsLocal(path.as_ptr()) })
}

/// Drop GDAL's curl cache — the memory it keeps of what it has already fetched from
/// `/vsicurl/`, `/vsiaz/` and the rest. A no-op when nothing was fetched.
///
/// It clears process-global state, so it takes the exclusive side of the lock.
#[napi(namespace = "fs")]
pub fn clear_curl_cache() {
    let _guard = lock_gdal();
    unsafe { gdal_sys::VSICurlClearCache() };
}

/// A path GDAL can be handed.
fn c_path(path: &str) -> Result<CString> {
    CString::new(path).map_err(|_| bad_argument("a path cannot contain a NUL byte"))
}

/// Open a `VSI*` handle, or report what GDAL said about it.
fn open_handle(path: &CString, mode: &[u8]) -> Result<*mut gdal_sys::VSILFILE> {
    // GDAL wants the mode as a C string; the literals here are passed without their
    // terminator so adding one is not forgotten.
    let mut mode = mode.to_vec();
    mode.push(0);

    let handle = unsafe { gdal_sys::VSIFOpenL(path.as_ptr(), mode.as_ptr().cast()) };
    if handle.is_null() {
        return Err(vsi_failure("VSIFOpenL"));
    }
    Ok(handle)
}

/// Copy a `CSL` string list — GDAL's null-terminated `char**` — into owned strings.
///
/// The terminator is a null *entry*, so the walk is over the array itself. Asking
/// GDAL instead (`CSLGetField`) is a trap: past the end — and for a null list — it
/// answers with an empty string rather than null, which never ends a loop. The list
/// belongs to the `VSI*` caller; freeing stays with it, so this only reads.
fn csl_to_vec(list: *mut *mut c_char) -> Vec<String> {
    let mut names = Vec::new();
    if list.is_null() {
        return names;
    }
    let mut entry = list;
    loop {
        let item = unsafe { *entry };
        if item.is_null() {
            break;
        }
        names.push(c_string(item));
        entry = unsafe { entry.add(1) };
    }
    names
}

/// A `VSI*` call that answers with a status code: non-zero is a failure, and the
/// reason is in GDAL's error state.
fn vsi_status(status: c_int, method_name: &'static str) -> Result<()> {
    if status == 0 {
        return Ok(());
    }
    Err(vsi_failure(method_name))
}

/// The error behind a failed `VSI*` call. A call that failed for an ordinary reason —
/// a missing directory, say — may leave nothing behind, so the method name stands in.
fn vsi_failure(method_name: &'static str) -> Error<GdalErrorCode> {
    cpl_failure(format!("{method_name} failed"))
}

/// Stat a path behind the lock. `None` means nothing is there.
fn stat_of(path: &str) -> Option<(CString, StatBuf)> {
    ensure_initialized();
    let _guard = lock_gdal_shared();

    let path = c_path(path).ok()?;
    let mut stat: StatBuf = unsafe { std::mem::zeroed() };
    if unsafe { gdal_sys::VSIStatL(path.as_ptr(), as_vsi_stat_buf(&mut stat)) } != 0 {
        return None;
    }
    Some((path, stat))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mem_file_round_trips() {
        let path = "/vsimem/gdal-rs-napi-fs-test.bin".to_string();

        assert!(!exists(path.clone()));
        write_file(path.clone(), Buffer::from(vec![1_u8, 2, 3, 4])).unwrap();
        assert!(exists(path.clone()));

        let stat = stat(path.clone()).unwrap();
        assert_eq!(stat.size, 4.0);
        assert!(stat.is_file);
        assert!(!stat.is_directory);

        assert_eq!(
            read_file(path.clone()).unwrap().to_vec(),
            vec![1_u8, 2, 3, 4]
        );

        unlink(path.clone()).unwrap();
        assert!(!exists(path.clone()));
        // Reading what is not there is an error, unlike testing for it.
        assert!(read_file(path).is_err());
    }

    #[test]
    fn a_path_with_a_nul_byte_never_reaches_gdal() {
        assert!(write_file("/vsimem/bad\0name".to_string(), Buffer::from(vec![1_u8])).is_err());
        assert!(!exists("/vsimem/bad\0name".to_string()));
    }

    #[test]
    fn glob_finds_matching_mem_files_and_a_miss_is_empty() {
        let dir = "/vsimem/gdal-rs-napi-fs-glob";
        write_file(format!("{dir}/one.bin"), Buffer::from(vec![1_u8])).unwrap();
        write_file(format!("{dir}/two.bin"), Buffer::from(vec![2_u8])).unwrap();
        write_file(format!("{dir}/three.txt"), Buffer::from(vec![3_u8])).unwrap();

        // The regression this pins: GDAL's `CSLGetField` answers "" past the end of a
        // list — and for a null one — so a walk that stops on a null *field* never
        // stops. A miss has to come back as an empty array.
        assert!(glob(format!("{dir}/nothing*.bin")).unwrap().is_empty());

        let found = glob(format!("{dir}/*.bin")).unwrap();
        assert_eq!(found.len(), 2);
        assert!(found.iter().any(|path| path.ends_with("one.bin")));
        assert!(found.iter().any(|path| path.ends_with("two.bin")));

        for name in ["one.bin", "two.bin", "three.txt"] {
            unlink(format!("{dir}/{name}")).unwrap();
        }
    }

    #[test]
    fn rename_and_copy_move_bytes_between_mem_names() {
        let from = "/vsimem/gdal-rs-napi-fs-rename-from.bin".to_string();
        let to = "/vsimem/gdal-rs-napi-fs-rename-to.bin".to_string();
        let copied = "/vsimem/gdal-rs-napi-fs-copy.bin".to_string();

        write_file(from.clone(), Buffer::from(vec![1_u8, 2, 3])).unwrap();
        rename(from.clone(), to.clone()).unwrap();
        assert!(!exists(from));
        assert_eq!(read_file(to.clone()).unwrap().to_vec(), vec![1_u8, 2, 3]);

        copy_file(to.clone(), copied.clone()).unwrap();
        assert_eq!(
            read_file(copied.clone()).unwrap().to_vec(),
            vec![1_u8, 2, 3]
        );
        // A copy leaves the source where it was.
        assert!(exists(to.clone()));

        unlink(to).unwrap();
        unlink(copied).unwrap();
    }

    #[test]
    fn recursive_directories_come_and_go_in_one_call() {
        let root = std::env::temp_dir().join("gdal-rs-napi-fs-recursive");
        let nested = root.join("a").join("b");
        let root = root.to_string_lossy().into_owned();
        let nested = nested.to_string_lossy().into_owned();

        // `mkdir` would refuse the missing parent; `mkdir_recursive` makes the chain.
        let _ = rmdir_recursive(root.clone());
        mkdir_recursive(nested.clone()).unwrap();
        assert!(stat(nested.clone()).unwrap().is_directory);

        write_file(format!("{nested}/x.bin"), Buffer::from(vec![1_u8])).unwrap();
        // And removing the root takes the file and the parents with it.
        rmdir_recursive(root).unwrap();
        assert!(!exists(nested));
    }

    #[test]
    fn a_plain_path_is_local_and_has_free_space() {
        let dir = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(is_local(dir.clone()).unwrap());
        assert!(disk_free_space(dir).unwrap() > 0.0);
    }
}
