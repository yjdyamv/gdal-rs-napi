//! Wrappers around GDAL's command-line programs: `gdal_translate`, `gdalwarp`
//! and `ogr2ogr` (`GDALVectorTranslate`).
//!
//! The argument lists are GDAL's own command-line arguments, so anything in GDAL's
//! documentation can be pasted straight in and we do not have to invent a mapping
//! for several hundred options.
//!
//! This module deliberately knows nothing about `napi`: it is the pure GDAL half,
//! which keeps it unit-testable.

use std::ffi::{CString, c_char, c_int};
use std::ptr::null_mut;

use gdal::Dataset as GdalDataset;
use gdal::{DatasetOptions, GdalOpenFlags};
use napi::Error;

use crate::error::{GdalErrorCode, IntoGdalResult, Result, bad_argument};
use crate::runtime::{ensure_initialized, lock_gdal};

/// Which program to run. One enum keeps the three wrappers on a single code path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Program {
    Translate,
    Warp,
    VectorTranslate,
}

impl Program {
    /// The name GDAL's own CLI uses, for error messages.
    pub fn name(self) -> &'static str {
        match self {
            Self::Translate => "gdal_translate",
            Self::Warp => "gdalwarp",
            Self::VectorTranslate => "ogr2ogr",
        }
    }

    /// The flags its *sources* have to be opened with.
    fn source_flags(self) -> GdalOpenFlags {
        match self {
            Self::VectorTranslate => GdalOpenFlags::GDAL_OF_VECTOR,
            Self::Translate | Self::Warp => GdalOpenFlags::GDAL_OF_RASTER,
        }
    }
}

/// GDAL returns a null options pointer when it does not like the arguments (which
/// is how its usage errors surface).
///
/// `gdal`'s own `BuildVRTOptions` skips this check and then hands the null pointer
/// to the program, so a typo in an argument list crashes instead of reporting.
/// Echoing the arguments back is what makes the failure actionable.
fn rejected(program: &str, args: &[String]) -> Error<GdalErrorCode> {
    let rendered = if args.is_empty() {
        "(no arguments)".to_string()
    } else {
        args.join(" ")
    };
    bad_argument(format!("{program} rejected these arguments: {rendered}"))
}

/// Build the null-terminated `char**` GDAL wants and run `f` with it.
///
/// The strings are only read — GDAL's parser is simply not `const`-correct — but
/// they have to outlive the call, which the closure form guarantees.
fn with_argv<T>(args: &[String], f: impl FnOnce(*mut *mut c_char) -> T) -> Result<T> {
    let strings = args
        .iter()
        .map(|arg| {
            CString::new(arg.as_str())
                .map_err(|_| bad_argument(format!("argument {arg:?} contains a NUL byte")))
        })
        .collect::<Result<Vec<_>>>()?;

    let mut pointers: Vec<*mut c_char> = strings
        .iter()
        .map(|arg| arg.as_ptr() as *mut c_char)
        .chain(std::iter::once(null_mut()))
        .collect();

    Ok(f(pointers.as_mut_ptr()))
}

macro_rules! options_wrapper {
    ($(#[$doc:meta])* $name:ident, $c_ty:ident, $new:ident, $free:ident, $program:literal) => {
        $(#[$doc])*
        pub struct $name {
            c_options: *mut gdal_sys::$c_ty,
        }

        impl $name {
            pub fn new(args: &[String]) -> Result<Self> {
                let c_options = with_argv(args, |argv| unsafe {
                    gdal_sys::$new(argv, null_mut())
                })?;
                if c_options.is_null() {
                    return Err(rejected($program, args));
                }
                Ok(Self { c_options })
            }
        }

        impl Drop for $name {
            fn drop(&mut self) {
                unsafe { gdal_sys::$free(self.c_options) };
            }
        }
    };
}

options_wrapper!(
    /// Wraps a `GDALTranslateOptions` object.
    TranslateOptions,
    GDALTranslateOptions,
    GDALTranslateOptionsNew,
    GDALTranslateOptionsFree,
    "gdal_translate"
);

options_wrapper!(
    /// Wraps a `GDALWarpAppOptions` object.
    WarpOptions,
    GDALWarpAppOptions,
    GDALWarpAppOptionsNew,
    GDALWarpAppOptionsFree,
    "gdalwarp"
);

options_wrapper!(
    /// Wraps a `GDALVectorTranslateOptions` object.
    VectorTranslateOptions,
    GDALVectorTranslateOptions,
    GDALVectorTranslateOptionsNew,
    GDALVectorTranslateOptionsFree,
    "ogr2ogr"
);

/// Run one of the programs on already-open sources.
///
/// The caller must already hold the global GDAL lock, and the sources must stay
/// alive for the duration of the call.
pub(crate) fn run(
    program: Program,
    dest: &str,
    sources: &[&GdalDataset],
    args: &[String],
) -> Result<GdalDataset> {
    if sources.is_empty() {
        return Err(bad_argument(format!(
            "{} needs at least one source dataset",
            program.name()
        )));
    }
    if program == Program::Translate && sources.len() != 1 {
        return Err(bad_argument(
            "gdal_translate takes exactly one source dataset",
        ));
    }

    // An empty destination is meaningful: with `-of MEM` GDAL hands back an
    // in-memory dataset instead of writing a file.
    let c_dest =
        CString::new(dest).map_err(|_| bad_argument("the destination path contains a NUL byte"))?;
    let mut usage_error: c_int = 0;

    let handle = unsafe {
        match program {
            Program::Translate => {
                let options = TranslateOptions::new(args)?;
                gdal_sys::GDALTranslate(
                    c_dest.as_ptr(),
                    sources[0].c_dataset(),
                    options.c_options,
                    &mut usage_error,
                )
            }
            Program::Warp => {
                let options = WarpOptions::new(args)?;
                let mut handles: Vec<_> = sources.iter().map(|source| source.c_dataset()).collect();
                gdal_sys::GDALWarp(
                    c_dest.as_ptr(),
                    null_mut(),
                    handles.len() as c_int,
                    handles.as_mut_ptr(),
                    options.c_options,
                    &mut usage_error,
                )
            }
            Program::VectorTranslate => {
                let options = VectorTranslateOptions::new(args)?;
                let mut handles: Vec<_> = sources.iter().map(|source| source.c_dataset()).collect();
                gdal_sys::GDALVectorTranslate(
                    c_dest.as_ptr(),
                    null_mut(),
                    handles.len() as c_int,
                    handles.as_mut_ptr(),
                    options.c_options,
                    &mut usage_error,
                )
            }
        }
    };

    if handle.is_null() {
        let hint = if usage_error == 0 {
            String::new()
        } else {
            " (it reported the arguments as invalid)".to_string()
        };
        return Err(bad_argument(format!(
            "{} did not produce a dataset{hint}",
            program.name()
        )));
    }

    // SAFETY: GDAL just handed us a dataset it created. `Dataset` takes ownership
    // and closes it when it is dropped or `close()`d.
    Ok(unsafe { GdalDataset::from_c_dataset(handle) })
}

/// Open `paths` and run `program` on them, holding the global lock throughout.
///
/// This is how the module-level API works: it takes paths rather than handles, so
/// the sources are opened, used and closed inside one locked section.
pub fn run_with_paths(
    program: Program,
    dest: &str,
    paths: &[String],
    args: &[String],
) -> Result<GdalDataset> {
    ensure_initialized();
    let _guard = lock_gdal();

    let opened = paths
        .iter()
        .map(|path| {
            GdalDataset::open_ex(
                path,
                DatasetOptions {
                    open_flags: program.source_flags(),
                    ..DatasetOptions::default()
                },
            )
            .gdal()
        })
        .collect::<Result<Vec<_>>>()?;
    let sources: Vec<&GdalDataset> = opened.iter().collect();

    run(program, dest, &sources, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_null_terminated_argv() {
        let args = vec!["-of".to_string(), "COG".to_string()];
        with_argv(&args, |argv| {
            let first = unsafe { *argv };
            let second = unsafe { *argv.add(1) };
            assert_eq!(
                unsafe { std::ffi::CStr::from_ptr(first) }.to_str(),
                Ok("-of")
            );
            assert_eq!(
                unsafe { std::ffi::CStr::from_ptr(second) }.to_str(),
                Ok("COG")
            );
            // GDAL scans until a null pointer, so it has to be there.
            assert!(unsafe { *argv.add(2) }.is_null());
        })
        .unwrap();
    }

    #[test]
    fn keeps_arguments_containing_spaces_and_equals_intact() {
        let args = vec![
            "-co".to_string(),
            "COMPRESS=DEFLATE".to_string(),
            "an argument with spaces".to_string(),
        ];
        with_argv(&args, |argv| {
            let third = unsafe { *argv.add(2) };
            assert_eq!(
                unsafe { std::ffi::CStr::from_ptr(third) }.to_str(),
                Ok("an argument with spaces")
            );
        })
        .unwrap();
    }

    #[test]
    fn an_empty_list_is_just_the_terminator() {
        with_argv(&[], |argv| assert!(unsafe { *argv }.is_null())).unwrap();
    }

    #[test]
    fn rejects_an_embedded_nul() {
        let err = to_argv_error("bad\0arg");
        assert!(err.reason.contains("NUL byte"), "{}", err.reason);
    }

    /// The regression test for the trap `gdal`'s own `BuildVRTOptions` falls into:
    /// a rejected argument list returns a null options pointer, and we have to
    /// report that rather than guess.
    ///
    /// GDAL writes the usage message through its error handler, so this test is
    /// noisy on stderr. That is the point: it is what a real typo produces.
    #[test]
    fn an_unknown_option_is_a_readable_error_not_a_crash() {
        let _guard = lock_gdal();
        let args = vec!["-definitely-not-an-option".to_string()];
        // Matched rather than `unwrap_err`, which would need the options wrapper
        // to be `Debug` — and it holds a raw pointer, so it is not.
        let err = match TranslateOptions::new(&args) {
            Ok(_) => panic!("an unknown option should have been rejected"),
            Err(err) => err,
        };
        assert!(
            err.reason.contains("gdal_translate rejected"),
            "{}",
            err.reason
        );
        // The offending arguments come back, so the user can see what went in.
        assert!(
            err.reason.contains("-definitely-not-an-option"),
            "{}",
            err.reason
        );
    }

    fn to_argv_error(arg: &str) -> Error<GdalErrorCode> {
        with_argv(&[arg.to_string()], |_| ()).unwrap_err()
    }

    #[test]
    fn refuses_an_empty_source_list() {
        let err = run(Program::Warp, "out.tif", &[], &[]).unwrap_err();
        assert!(err.reason.contains("at least one source"), "{}", err.reason);
    }

    #[test]
    fn requires_exactly_one_source_for_translate() {
        ensure_initialized();
        let _guard = lock_gdal();

        let mem = gdal::DriverManager::get_driver_by_name("MEM").unwrap();
        let first = mem.create_with_band_type::<u8, _>("", 2, 2, 1).unwrap();
        let second = mem
            .create_with_band_type::<u8, _>("second", 2, 2, 1)
            .unwrap();

        let err = run(Program::Translate, "", &[&first, &second], &[]).unwrap_err();
        assert!(err.reason.contains("exactly one source"), "{}", err.reason);
    }

    /// An empty destination plus `-of MEM` is the documented way to get the
    /// result back in memory instead of on disk.
    #[test]
    fn an_empty_destination_yields_an_in_memory_dataset() {
        ensure_initialized();
        let _guard = lock_gdal();

        let mem = gdal::DriverManager::get_driver_by_name("MEM").unwrap();
        let source = mem
            .create_with_band_type::<u8, _>("source", 4, 3, 1)
            .unwrap();

        let args = vec!["-of".to_string(), "MEM".to_string()];
        let out = run(Program::Translate, "", &[&source], &args).unwrap();

        assert_eq!(out.driver().short_name(), "MEM");
        assert_eq!(out.raster_size(), (4, 3));
        assert_eq!(out.raster_count(), 1);
    }
}
