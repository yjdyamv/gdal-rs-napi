//! Wrappers around GDAL's command-line programs: `gdal_translate`, `gdalwarp`
//! and `ogr2ogr` (`GDALVectorTranslate`).
//!
//! The argument lists are GDAL's own command-line arguments, so anything in GDAL's
//! documentation can be pasted straight in and we do not have to invent a mapping
//! for several hundred options.
//!
//! This module deliberately knows nothing about `napi`: it is the pure GDAL half,
//! which keeps it unit-testable.

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};

use gdal::Dataset as GdalDataset;
use gdal::{DatasetOptions, GdalOpenFlags};
use gdal_sys::GDALDatasetH;
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

/// Where a program's progress goes.
///
/// This module deliberately knows nothing about `napi`, so the binding supplies the
/// implementation that hops to the JS thread. `report` is called from whichever
/// thread GDAL runs on — the libuv worker, for the async entry points — once per
/// chunk of work, so a slow implementation slows the program down.
pub(crate) trait ProgressSink: Send + Sync {
    /// `complete` runs from 0.0 to 1.0. `message` is GDAL's own, and often absent.
    ///
    /// Returning `false` cancels. GDAL's progress callback is the only way to stop
    /// a program that has already started.
    fn report(&self, complete: f64, message: Option<&str>) -> bool;
}

/// The sink, plus the answer to "did it cancel?" — which is what the caller needs
/// once the program has returned.
struct ProgressBridge<'a> {
    sink: &'a dyn ProgressSink,
    cancelled: AtomicBool,
}

impl ProgressBridge<'_> {
    /// Hand GDAL a pointer to this and it will call back into `sink`.
    fn as_arg(&self) -> *mut c_void {
        std::ptr::from_ref(self).cast_mut().cast()
    }

    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// GDAL's progress callback. Being a C function pointer it cannot capture
/// anything, so the sink arrives through `pProgressArg` as a [`ProgressBridge`].
///
/// # Safety
/// `arg` must point at a live `ProgressBridge` that outlives every call, which the
/// `*_with_progress` functions below guarantee by keeping it on their stack.
unsafe extern "C" fn progress_trampoline(
    complete: f64,
    message: *const c_char,
    arg: *mut c_void,
) -> c_int {
    // A panic must not unwind into GDAL, which would be undefined behaviour. A
    // panicking sink counts as a cancel: the program stops, and the caller gets an
    // error through the ordinary path rather than a corrupted stack.
    let keep_going = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: the caller keeps the bridge alive for the whole program call, and
        // it is only ever read back here.
        let bridge = unsafe { &*arg.cast::<ProgressBridge<'_>>() };
        let message = if message.is_null() {
            None
        } else {
            // SAFETY: GDAL passes either null or a NUL-terminated string that lives
            // for the duration of the call.
            Some(
                unsafe { CStr::from_ptr(message) }
                    .to_string_lossy()
                    .into_owned(),
            )
        };

        let keep_going = bridge.sink.report(complete, message.as_deref());
        if !keep_going {
            bridge.cancelled.store(true, Ordering::SeqCst);
        }
        keep_going
    }));

    match keep_going {
        Ok(true) => 1,
        _ => 0,
    }
}

/// Attach the bridge to one of the options objects, for the programs that have a
/// progress callback at all.
macro_rules! attach_progress {
    ($options:expr, $bridge:expr) => {
        if let Some(bridge) = $bridge {
            // The bridge lives on the caller's stack for the whole program call,
            // which is the only thing able to use this pointer.
            $options.set_progress(Some(progress_trampoline), bridge.as_arg());
        }
    };
}

/// The error a cancelled program reports, so a caller can tell "I stopped it" from
/// "it failed".
fn cancelled(program: &str) -> Error<GdalErrorCode> {
    Error::new(
        GdalErrorCode::Cancelled,
        format!("{program} was cancelled by the progress callback"),
    )
}

macro_rules! options_wrapper {
    ($(#[$doc:meta])* $name:ident, $c_ty:ident, $new:ident, $free:ident, $progress:ident, $program:literal) => {
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

            /// Hand GDAL the callback it should report progress to.
            ///
            /// Safe on purpose: the only caller is `attach_progress!`, which always
            /// passes a bridge that outlives the program call, so there is no way
            /// for a caller to get the pointer's lifetime wrong.
            pub fn set_progress(
                &self,
                callback: gdal_sys::GDALProgressFunc,
                data: *mut c_void,
            ) {
                // SAFETY: GDAL stores both values and calls `callback` with `data`
                // only while the options object is being used by a program call.
                unsafe { gdal_sys::$progress(self.c_options, callback, data) };
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
    GDALTranslateOptionsSetProgress,
    "gdal_translate"
);

options_wrapper!(
    /// Wraps a `GDALWarpAppOptions` object.
    WarpOptions,
    GDALWarpAppOptions,
    GDALWarpAppOptionsNew,
    GDALWarpAppOptionsFree,
    GDALWarpAppOptionsSetProgress,
    "gdalwarp"
);

options_wrapper!(
    /// Wraps a `GDALVectorTranslateOptions` object.
    VectorTranslateOptions,
    GDALVectorTranslateOptions,
    GDALVectorTranslateOptionsNew,
    GDALVectorTranslateOptionsFree,
    GDALVectorTranslateOptionsSetProgress,
    "ogr2ogr"
);

options_wrapper!(
    /// Wraps a `GDALDEMProcessingOptions` object.
    DemOptions,
    GDALDEMProcessingOptions,
    GDALDEMProcessingOptionsNew,
    GDALDEMProcessingOptionsFree,
    GDALDEMProcessingOptionsSetProgress,
    "gdaldem"
);

/// The terrain algorithms `gdaldem` offers, which is also the vocabulary
/// `GDALDEMProcessing` takes as its third argument.
pub const DEM_ALGORITHMS: [&str; 7] = [
    "hillshade",
    "color-relief",
    "slope",
    "aspect",
    "tri",
    "tpi",
    "roughness",
];

/// Validate a terrain algorithm name.
///
/// Checked here so a typo reads as
/// `unknown terrain algorithm "slop"; expected one of …`, rather than whatever
/// GDAL prints before failing.
pub fn dem_algorithm(name: &str) -> Result<&'static str> {
    let lowered = name.to_ascii_lowercase();
    DEM_ALGORITHMS
        .iter()
        .copied()
        .find(|candidate| *candidate == lowered)
        .ok_or_else(|| {
            bad_argument(format!(
                "unknown terrain algorithm {name:?}; expected one of {}",
                DEM_ALGORITHMS.join(", ")
            ))
        })
}

/// Take the dataset GDAL handed back, or explain why there is none.
///
/// A null handle means the program failed; `usage_error` distinguishes "your
/// arguments were wrong" from everything else, which is the most useful thing to
/// say about it.
fn take_result(program: &str, handle: GDALDatasetH, usage_error: c_int) -> Result<GdalDataset> {
    if handle.is_null() {
        let hint = if usage_error == 0 {
            String::new()
        } else {
            " (it reported the arguments as invalid)".to_string()
        };
        return Err(bad_argument(format!(
            "{program} did not produce a dataset{hint}"
        )));
    }

    // SAFETY: GDAL just handed us a dataset it created. `Dataset` takes ownership
    // and closes it when it is dropped or `close()`d.
    Ok(unsafe { GdalDataset::from_c_dataset(handle) })
}

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
    run_with_progress(program, dest, sources, args, None)
}

/// Run one of the programs, reporting progress to `sink`.
///
/// There is deliberately no sync form: a sync call holds the JS thread, so a
/// callback that has to run *on* that thread could never run at all.
pub(crate) fn run_with_progress(
    program: Program,
    dest: &str,
    sources: &[&GdalDataset],
    args: &[String],
    progress: Option<&dyn ProgressSink>,
) -> Result<GdalDataset> {
    let bridge = progress.map(|sink| ProgressBridge {
        sink,
        cancelled: AtomicBool::new(false),
    });

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

    // ogr2ogr implements -overwrite in its own command-line front end, not in
    // GDALVectorTranslate, so we do the same: take the flag out and remove the
    // destination before the call.
    let (args, overwrite) = match program {
        Program::VectorTranslate => split_overwrite(args),
        _ => (args.to_vec(), false),
    };
    if overwrite {
        // SAFETY: VSIUnlink takes a path and reports failure through its return
        // value; a destination that was not there is not worth reporting.
        unsafe { gdal_sys::VSIUnlink(c_dest.as_ptr()) };
    }

    let handle = unsafe {
        match program {
            Program::Translate => {
                let options = TranslateOptions::new(&args)?;
                attach_progress!(options, &bridge);
                gdal_sys::GDALTranslate(
                    c_dest.as_ptr(),
                    sources[0].c_dataset(),
                    options.c_options,
                    &mut usage_error,
                )
            }
            Program::Warp => {
                let options = WarpOptions::new(&args)?;
                attach_progress!(options, &bridge);
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
                let options = VectorTranslateOptions::new(&args)?;
                attach_progress!(options, &bridge);
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

    if bridge.as_ref().is_some_and(ProgressBridge::cancelled) {
        // GDAL stops the moment the callback says no, and whatever it leaves behind
        // is incomplete by definition, so report the cancellation rather than hand
        // back a half-written dataset. Dropping the handle still closes it.
        drop(take_result(program.name(), handle, usage_error));
        return Err(cancelled(program.name()));
    }

    take_result(program.name(), handle, usage_error)
}

/// Pull `-overwrite` out of an argument list.
///
/// The flag belongs to ogr2ogr, and ogr2ogr itself honours it by deleting the
/// destination before it calls into the library — `GDALVectorTranslate` has no idea
/// what it means. Doing the same in this wrapper keeps the flag working where the
/// tool's own documentation puts it.
fn split_overwrite(args: &[String]) -> (Vec<String>, bool) {
    let overwrite = args.iter().any(|arg| arg == "-overwrite");
    let kept = args
        .iter()
        .filter(|arg| *arg != "-overwrite")
        .cloned()
        .collect();
    (kept, overwrite)
}

/// Run the terrain tools — `gdaldem`'s hillshade, slope, aspect and friends.
///
/// `algorithm` comes from [`DEM_ALGORITHMS`], `color_file` only means anything for
/// `color-relief`, and `args` are the tool's own command-line arguments. The
/// caller must already hold the global lock.
pub(crate) fn dem_process(
    dest: &str,
    algorithm: &str,
    color_file: Option<&str>,
    source: &GdalDataset,
    args: &[String],
) -> Result<GdalDataset> {
    dem_process_with_progress(dest, algorithm, color_file, source, args, None)
}

/// Run a terrain tool, reporting progress to `sink`.
///
/// No sync form, for the reason given on [`run_with_progress`].
pub(crate) fn dem_process_with_progress(
    dest: &str,
    algorithm: &str,
    color_file: Option<&str>,
    source: &GdalDataset,
    args: &[String],
    progress: Option<&dyn ProgressSink>,
) -> Result<GdalDataset> {
    let bridge = progress.map(|sink| ProgressBridge {
        sink,
        cancelled: AtomicBool::new(false),
    });

    let c_dest =
        CString::new(dest).map_err(|_| bad_argument("the destination path contains a NUL byte"))?;
    let c_algorithm = CString::new(algorithm)
        .map_err(|_| bad_argument("the algorithm name contains a NUL byte"))?;
    let c_color = match color_file {
        Some(path) => Some(
            CString::new(path)
                .map_err(|_| bad_argument("the colour file path contains a NUL byte"))?,
        ),
        None => None,
    };

    let mut usage_error: c_int = 0;
    let handle = unsafe {
        let options = DemOptions::new(args)?;
        attach_progress!(options, &bridge);
        gdal_sys::GDALDEMProcessing(
            c_dest.as_ptr(),
            source.c_dataset(),
            c_algorithm.as_ptr(),
            c_color.as_ref().map_or(null(), |path| path.as_ptr()),
            options.c_options,
            &mut usage_error,
        )
    };

    if bridge.as_ref().is_some_and(ProgressBridge::cancelled) {
        drop(take_result("gdaldem", handle, usage_error));
        return Err(cancelled("gdaldem"));
    }

    take_result("gdaldem", handle, usage_error)
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
    fn terrain_algorithms_are_the_gdaldem_ones() {
        assert_eq!(dem_algorithm("hillshade").unwrap(), "hillshade");
        assert_eq!(dem_algorithm("Color-Relief").unwrap(), "color-relief");
        assert_eq!(dem_algorithm("TPI").unwrap(), "tpi");

        let err = dem_algorithm("slop").unwrap_err();
        assert!(
            err.reason.contains("unknown terrain algorithm"),
            "{}",
            err.reason
        );
        // The alternatives come back with the complaint.
        assert!(err.reason.contains("roughness"), "{}", err.reason);
    }

    /// The same trap the other programs have: a bad argument list must be reported
    /// rather than handed to GDAL as a null options pointer.
    #[test]
    fn a_bad_terrain_argument_is_a_readable_error() {
        let _guard = lock_gdal();
        let args = vec!["-definitely-not-an-option".to_string()];
        let err = match DemOptions::new(&args) {
            Ok(_) => panic!("an unknown option should have been rejected"),
            Err(err) => err,
        };
        assert!(err.reason.contains("gdaldem rejected"), "{}", err.reason);
    }

    /// A sink that records what it was told, and can say stop on demand.
    struct FakeSink {
        calls: std::sync::Mutex<Vec<(f64, Option<String>)>>,
        cancel_at: Option<usize>,
    }

    impl ProgressSink for FakeSink {
        fn report(&self, complete: f64, message: Option<&str>) -> bool {
            let mut calls = self.calls.lock().unwrap();
            calls.push((complete, message.map(str::to_string)));
            match self.cancel_at {
                Some(index) => calls.len() != index,
                None => true,
            }
        }
    }

    #[test]
    fn the_progress_trampoline_forwards_and_cancels() {
        let sink = FakeSink {
            calls: std::sync::Mutex::new(Vec::new()),
            cancel_at: Some(3),
        };
        let bridge = ProgressBridge {
            sink: &sink,
            cancelled: AtomicBool::new(false),
        };

        let message = CString::new("warping").unwrap();
        let answers: Vec<c_int> = (1..=3)
            .map(|step| {
                // SAFETY: `bridge` is alive for all three calls, which is exactly
                // what the trampoline's contract asks for.
                unsafe { progress_trampoline(step as f64 / 4.0, message.as_ptr(), bridge.as_arg()) }
            })
            .collect();

        // GDAL reads anything non-zero as "keep going", so the third call is where
        // it is told to stop — and the bridge remembers that it was asked to.
        assert_eq!(answers, vec![1, 1, 0]);
        assert!(bridge.cancelled());

        let calls = sink.calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, 0.25);
        assert_eq!(calls[0].1.as_deref(), Some("warping"));
    }

    #[test]
    fn a_null_progress_message_is_not_a_message() {
        let sink = FakeSink {
            calls: std::sync::Mutex::new(Vec::new()),
            cancel_at: None,
        };
        let bridge = ProgressBridge {
            sink: &sink,
            cancelled: AtomicBool::new(false),
        };

        // SAFETY: as above.
        let answer = unsafe { progress_trampoline(1.0, null(), bridge.as_arg()) };

        assert_eq!(answer, 1);
        assert!(!bridge.cancelled());
        assert_eq!(sink.calls.lock().unwrap()[0].1, None);
    }

    #[test]
    fn overwrite_is_pulled_out_of_the_arguments() {
        let args = vec![
            "-f".to_string(),
            "-overwrite".to_string(),
            "GPKG".to_string(),
        ];
        let (kept, overwrite) = split_overwrite(&args);
        assert!(overwrite);
        // GDAL never sees the flag; it only ever saw the destination disappearing.
        assert_eq!(kept, vec!["-f".to_string(), "GPKG".to_string()]);

        let (untouched, overwrite) = split_overwrite(&["-f".to_string()]);
        assert!(!overwrite);
        assert_eq!(untouched, vec!["-f".to_string()]);
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
