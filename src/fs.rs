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

use std::ffi::{CString, c_int};

use gdal::errors::GdalError;
use napi::bindgen_prelude::{Buffer, Error};
use napi_derive::napi;

use crate::error::{GdalErrorCode, IntoGdalResult, Result, bad_argument, gdal_error};
use crate::runtime::{c_string, ensure_initialized, lock_gdal};

/// GDAL's `VSI_ISDIR` and `VSI_ISREG`, which are the POSIX mode masks. The macros
/// themselves are not bindgen-visible, but the numbers are fixed.
const MODE_MASK: u32 = 0o170000;
const MODE_DIRECTORY: u32 = 0o040000;
const MODE_FILE: u32 = 0o100000;

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
    let _guard = lock_gdal();

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
    let _guard = lock_gdal();

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
    Some(FileStat {
        size: stat.st_size as f64,
        is_directory: stat.st_mode as u32 & MODE_MASK == MODE_DIRECTORY,
        is_file: stat.st_mode as u32 & MODE_MASK == MODE_FILE,
        modified_ms: stat.st_mtime as f64 * 1000.0,
    })
}

/// Create a directory. Like `mkdir(2)`, the parent has to be there already.
#[napi(namespace = "fs")]
pub fn mkdir(path: String) -> Result<()> {
    ensure_initialized();
    let _guard = lock_gdal();

    let path = c_path(&path)?;
    let status = unsafe { gdal_sys::VSIMkdir(path.as_ptr(), 0o755) };
    vsi_status(status, "VSIMkdir")
}

/// Remove an empty directory.
#[napi(namespace = "fs")]
pub fn rmdir(path: String) -> Result<()> {
    ensure_initialized();
    let _guard = lock_gdal();

    let path = c_path(&path)?;
    let status = unsafe { gdal_sys::VSIRmdir(path.as_ptr()) };
    vsi_status(status, "VSIRmdir")
}

/// Remove a file.
#[napi(namespace = "fs")]
pub fn unlink(path: String) -> Result<()> {
    ensure_initialized();
    let _guard = lock_gdal();

    let path = c_path(&path)?;
    let status = unsafe { gdal_sys::VSIUnlink(path.as_ptr()) };
    vsi_status(status, "VSIUnlink")
}

/// The entries in a directory, or everything under it when `recursive`.
///
/// The `.` and `..` entries GDAL reports for a real directory are left out, the way
/// `fs.readdir` leaves them out, so an empty directory reads as `[]`.
#[napi(namespace = "fs")]
pub fn read_dir(path: String, recursive: Option<bool>) -> Result<Vec<String>> {
    ensure_initialized();
    let _guard = lock_gdal();

    let entries = gdal::vsi::read_dir(&path, recursive.unwrap_or(false)).gdal()?;
    Ok(entries
        .iter()
        .map(|entry| entry.display().to_string())
        .filter(|entry| entry != "." && entry != "..")
        .collect())
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

/// A `VSI*` call that answers with a status code: non-zero is a failure, and the
/// reason is in GDAL's error state.
fn vsi_status(status: c_int, method_name: &'static str) -> Result<()> {
    if status == 0 {
        return Ok(());
    }
    Err(vsi_failure(method_name))
}

/// The error behind a failed `VSI*` call — the same shape `raster_tools` builds for
/// a failed `CPLErr`, reset included, and for the same reason.
fn vsi_failure(method_name: &'static str) -> Error<GdalErrorCode> {
    let message = c_string(unsafe { gdal_sys::CPLGetLastErrorMsg() });
    let error = gdal_error(GdalError::CplError {
        class: gdal_sys::CPLErr::CE_Failure,
        number: unsafe { gdal_sys::CPLGetLastErrorNo() },
        // A `VSI*` call that failed for an ordinary reason — a missing directory,
        // say — may leave nothing behind, so the method name stands in.
        msg: if message.is_empty() {
            format!("{method_name} failed")
        } else {
            message
        },
    });
    unsafe { gdal_sys::CPLErrorReset() };
    error
}

/// Stat a path behind the lock. `None` means nothing is there.
fn stat_of(path: &str) -> Option<(CString, gdal_sys::VSIStatBufL)> {
    ensure_initialized();
    let _guard = lock_gdal();

    let path = c_path(path).ok()?;
    let mut stat: gdal_sys::VSIStatBufL = unsafe { std::mem::zeroed() };
    if unsafe { gdal_sys::VSIStatL(path.as_ptr(), &mut stat) } != 0 {
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
}
