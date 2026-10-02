//! JavaScript-backed pixel functions for derived VRT bands.
//!
//! GDAL's derived-band mechanism lets a VRT band compute its pixels from its sources
//! through a C function. This module hands that function to JavaScript: the sources
//! arrive as typed arrays, and whatever the function writes into the output array is
//! what the derived band reads back.
//!
//! Two constraints shape the design, and both come from GDAL:
//!
//! * **GDAL calls back with a bare function pointer and no name.** One trampoline
//!   therefore cannot serve several registered functions — each registration takes its
//!   own slot in a fixed pool of trampolines, generated below with a macro. The slot
//!   is what the trampoline passes to JavaScript, which is where the functions live.
//! * **It calls back on whichever thread is reading.** A synchronous read runs on the
//!   JS thread, where calling into JS is fine and re-entrant. A thread-pool read runs
//!   on a worker, where it is not: the call would have to be handed to the event loop,
//!   which may be blocked waiting for the very lock that worker is holding. Those are
//!   refused with an error rather than risking a deadlock.

use std::ffi::{CString, c_char, c_int, c_void};
use std::ptr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::thread::ThreadId;

use napi::Env;
use napi::sys;
use napi_derive::napi;

use crate::error::{Result, bad_argument};
use crate::runtime::{ensure_initialized, lock_gdal};

/// How many pixel functions can be registered in a process. GDAL has no way to
/// unregister one, so each registration takes a trampoline for good.
const SLOTS: usize = 32;

/// The name of the global function the trampolines call. `index.js` installs it.
const DISPATCHER: &str = "__gdalRsNapiPixelFunc";

/// A GDAL derived pixel function — `GDALDerivedPixelFuncWithArgs`, the form that also
/// carries the VRT's `<PixelFunctionArguments>`.
type Trampoline = unsafe extern "C" fn(
    papo_sources: *mut *mut c_void,
    n_sources: c_int,
    data: *mut c_void,
    buf_x: c_int,
    buf_y: c_int,
    source_type: gdal_sys::GDALDataType::Type,
    buffer_type: gdal_sys::GDALDataType::Type,
    pixel_space: c_int,
    line_space: c_int,
    args: gdal_sys::CSLConstList,
) -> gdal_sys::CPLErr::Type;

// `gdal-sys` does not bind this pair, so they are declared here. The symbols are in the
// GDAL this binding links, statically or not.
unsafe extern "C" {
    fn GDALAddDerivedBandPixelFuncWithArgs(
        name: *const c_char,
        function: Trampoline,
        metadata: *const c_char,
    ) -> c_int;
    fn CPLError(e_class: c_int, error: c_int, format: *const c_char, ...);
}

/// `CPLE_AppDefined`, from `cpl_error.h`. `gdal-sys` binds `CPLErr` but not the error
/// numbers, and this is the one that says "the application's own failure".
const CPLE_APP_DEFINED: c_int = 1;

/// What a slot holds. The JS function itself is kept in JavaScript, keyed by slot.
struct Registration {
    name: String,
    /// The thread that registered it, and so the only one that may call into JS.
    js_thread: ThreadId,
}

static REGISTRY: Mutex<Vec<Option<Registration>>> = Mutex::new(Vec::new());

/// The JS environment, captured when the first function is registered. Every call
/// comes from the registering thread, so this is the environment to use.
static ENV: AtomicPtr<sys::napi_env__> = AtomicPtr::new(ptr::null_mut());

macro_rules! trampoline_pool {
    ($($name:ident = $slot:literal),* $(,)?) => {
        $(
            unsafe extern "C" fn $name(
                papo_sources: *mut *mut c_void,
                n_sources: c_int,
                data: *mut c_void,
                buf_x: c_int,
                buf_y: c_int,
                source_type: gdal_sys::GDALDataType::Type,
                buffer_type: gdal_sys::GDALDataType::Type,
                pixel_space: c_int,
                line_space: c_int,
                args: gdal_sys::CSLConstList,
            ) -> gdal_sys::CPLErr::Type {
                unsafe {
                    dispatch(
                        $slot,
                        papo_sources,
                        n_sources,
                        data,
                        buf_x,
                        buf_y,
                        source_type,
                        buffer_type,
                        pixel_space,
                        line_space,
                        args,
                    )
                }
            }
        )*

        const TRAMPOLINES: &[Trampoline] = &[$($name),*];
    };
}

trampoline_pool! {
    trampoline_00 = 0,
    trampoline_01 = 1,
    trampoline_02 = 2,
    trampoline_03 = 3,
    trampoline_04 = 4,
    trampoline_05 = 5,
    trampoline_06 = 6,
    trampoline_07 = 7,
    trampoline_08 = 8,
    trampoline_09 = 9,
    trampoline_10 = 10,
    trampoline_11 = 11,
    trampoline_12 = 12,
    trampoline_13 = 13,
    trampoline_14 = 14,
    trampoline_15 = 15,
    trampoline_16 = 16,
    trampoline_17 = 17,
    trampoline_18 = 18,
    trampoline_19 = 19,
    trampoline_20 = 20,
    trampoline_21 = 21,
    trampoline_22 = 22,
    trampoline_23 = 23,
    trampoline_24 = 24,
    trampoline_25 = 25,
    trampoline_26 = 26,
    trampoline_27 = 27,
    trampoline_28 = 28,
    trampoline_29 = 29,
    trampoline_30 = 30,
    trampoline_31 = 31,
}

/// Register a slot for a JavaScript pixel function and hand it to GDAL under `name`.
///
/// The shell owns this: `addPixelFunc` there keeps the function itself, and the
/// trampoline reaches it by slot through the global dispatcher. Not meant to be called
/// on its own.
#[napi(catch_unwind)]
pub fn register_pixel_func(env: Env, name: String) -> Result<u32> {
    ensure_initialized();
    let name_text = CString::new(name.clone())
        .map_err(|_| bad_argument("a pixel function name cannot contain a NUL byte"))?;

    let mut registry = REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let slot = registry
        .iter()
        .position(Option::is_none)
        .or_else(|| (registry.len() < SLOTS).then_some(registry.len()))
        .ok_or_else(|| {
            bad_argument(format!(
                "this binding has room for {SLOTS} pixel functions and they are all taken; \
                 GDAL has no way to unregister one"
            ))
        })?;

    let status = {
        let _guard = lock_gdal();
        unsafe {
            GDALAddDerivedBandPixelFuncWithArgs(name_text.as_ptr(), TRAMPOLINES[slot], ptr::null())
        }
    };
    if status as gdal_sys::CPLErr::Type != gdal_sys::CPLErr::CE_None {
        return Err(bad_argument(format!(
            "GDAL would not take a pixel function named {name:?}"
        )));
    }

    ENV.store(env.raw(), Ordering::SeqCst);
    let registration = Registration {
        name,
        js_thread: std::thread::current().id(),
    };
    if slot == registry.len() {
        registry.push(Some(registration));
    } else {
        registry[slot] = Some(registration);
    }
    Ok(slot as u32)
}

/// The trampoline body: everything here is GDAL calling us mid-read, on a thread we
/// have to check before it is safe to do anything.
#[allow(clippy::too_many_arguments)]
unsafe fn dispatch(
    slot: usize,
    papo_sources: *mut *mut c_void,
    n_sources: c_int,
    data: *mut c_void,
    buf_x: c_int,
    buf_y: c_int,
    source_type: gdal_sys::GDALDataType::Type,
    buffer_type: gdal_sys::GDALDataType::Type,
    pixel_space: c_int,
    line_space: c_int,
    args: gdal_sys::CSLConstList,
) -> gdal_sys::CPLErr::Type {
    // A panic must not unwind into GDAL, which would be undefined behaviour. This is
    // the same rule `programs::progress_trampoline` follows; here a panicking pixel
    // function counts as a failure and is reported through GDAL, like a returned
    // error.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        evaluate(
            slot,
            papo_sources,
            n_sources,
            data,
            buf_x,
            buf_y,
            source_type,
            buffer_type,
            pixel_space,
            line_space,
            args,
        )
    }));
    match outcome {
        Ok(Ok(())) => gdal_sys::CPLErr::CE_None,
        Ok(Err(message)) => {
            report(&message);
            gdal_sys::CPLErr::CE_Failure
        }
        Err(_) => {
            report("the pixel function panicked");
            gdal_sys::CPLErr::CE_Failure
        }
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn evaluate(
    slot: usize,
    papo_sources: *mut *mut c_void,
    n_sources: c_int,
    data: *mut c_void,
    buf_x: c_int,
    buf_y: c_int,
    source_type: gdal_sys::GDALDataType::Type,
    buffer_type: gdal_sys::GDALDataType::Type,
    pixel_space: c_int,
    line_space: c_int,
    args: gdal_sys::CSLConstList,
) -> std::result::Result<(), String> {
    let (name, js_thread) = {
        let registry = REGISTRY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match registry.get(slot).and_then(Option::as_ref) {
            Some(registration) => (registration.name.clone(), registration.js_thread),
            None => return Err("a pixel function ran from a slot with nothing in it".to_string()),
        }
    };

    if std::thread::current().id() != js_thread {
        return Err(format!(
            "the pixel function {name:?} was reached from a worker thread. A JavaScript pixel \
             function can only be evaluated by a synchronous read — readPixelsSync, readValues \
             and the rest of the blocking surface — because only the JS thread can call back \
             into JavaScript."
        ));
    }

    let env = ENV.load(Ordering::SeqCst);
    if env.is_null() {
        return Err("no JavaScript environment was ever captured".to_string());
    }

    let buf_x = buf_x.max(0) as usize;
    let buf_y = buf_y.max(0) as usize;
    let elements = buf_x.saturating_mul(buf_y);
    let buffer_sample = sample_size(buffer_type)?;
    let undefined = unsafe { value_undefined(env)? };

    unsafe {
        let mut global = ptr::null_mut();
        status(sys::napi_get_global(env, &mut global))?;
        let dispatcher_name = CString::new(DISPATCHER).expect("a literal has no NUL byte");
        let mut dispatcher = ptr::null_mut();
        status(sys::napi_get_named_property(
            env,
            global,
            dispatcher_name.as_ptr(),
            &mut dispatcher,
        ))?;

        // The sources, as typed arrays over GDAL's own buffers. They are dense: the
        // derived-band API passes them with no stride, and says so by giving none.
        let mut sources = ptr::null_mut();
        status(sys::napi_create_array_with_length(
            env,
            n_sources.max(0) as usize,
            &mut sources,
        ))?;
        for index in 0..n_sources.max(0) as usize {
            let source = *papo_sources.add(index);
            if source.is_null() {
                return Err("a source buffer was missing".to_string());
            }
            let view = typed_array(env, source, source_type, elements)?;
            status(sys::napi_set_element(env, sources, index as u32, view))?;
        }

        // The output goes through a dense copy of our own: GDAL's buffer is allowed to
        // be strided, and a typed array cannot be.
        let mut dense = vec![0u8; elements.saturating_mul(buffer_sample)];
        let output = typed_array(env, dense.as_mut_ptr().cast(), buffer_type, elements)?;

        let pixel_args = if args.is_null() {
            undefined
        } else {
            args_object(env, args)?
        };
        let slot_value = value_uint32(env, slot as u32)?;

        let argv = [slot_value, sources, output, pixel_args];
        let mut result = ptr::null_mut();
        let call = sys::napi_call_function(
            env,
            undefined,
            dispatcher,
            argv.len(),
            argv.as_ptr(),
            &mut result,
        );
        if call != sys::Status::napi_ok {
            // A throw inside the function is the caller's bug, not a binding failure:
            // it is cleared so it cannot leak into the next call, and reported to GDAL.
            let mut exception = ptr::null_mut();
            let _ = sys::napi_get_and_clear_last_exception(env, &mut exception);
            return Err(format!(
                "the pixel function {name:?} threw ({}); see the exception in the JS console",
                status_text(call),
            ));
        }

        // What the function left in the dense buffer, laid into the real one.
        scatter(
            data,
            &dense,
            buffer_sample,
            buf_x,
            buf_y,
            pixel_space,
            line_space,
        );
    }
    Ok(())
}

/// Lay a dense buffer into a possibly strided one, byte by byte — which is right for
/// every sample type without knowing anything else about it.
fn scatter(
    destination: *mut c_void,
    source: &[u8],
    sample: usize,
    buf_x: usize,
    buf_y: usize,
    pixel_space: i32,
    line_space: i32,
) {
    if destination.is_null() || sample == 0 {
        return;
    }
    let pixel_space = pixel_space.max(0) as usize;
    let line_space = line_space.max(0) as usize;
    unsafe {
        for y in 0..buf_y {
            for x in 0..buf_x {
                let from = source.as_ptr().add((y * buf_x + x) * sample);
                let to = (destination as *mut u8).add(y * line_space + x * pixel_space);
                ptr::copy_nonoverlapping(from, to, sample);
            }
        }
    }
}

/// A typed array over memory somebody else owns — GDAL's. The external array buffer has
/// no finalizer, so dropping the JS view leaves the memory alone, which is the point.
unsafe fn typed_array(
    env: sys::napi_env,
    data: *mut c_void,
    data_type: gdal_sys::GDALDataType::Type,
    length: usize,
) -> std::result::Result<sys::napi_value, String> {
    let element = element_type(data_type)?;
    let bytes = length.saturating_mul(sample_size(data_type)?);
    unsafe {
        let mut arraybuffer = ptr::null_mut();
        status(sys::napi_create_external_arraybuffer(
            env,
            data,
            bytes,
            None,
            ptr::null_mut(),
            &mut arraybuffer,
        ))?;
        let mut view = ptr::null_mut();
        status(sys::napi_create_typedarray(
            env,
            element,
            length,
            arraybuffer,
            0,
            &mut view,
        ))?;
        Ok(view)
    }
}

/// The VRT's `<PixelFunctionArguments>` as a plain JS object of strings — which is what
/// they are, since GDAL hands them over as a `key=value` list.
unsafe fn args_object(
    env: sys::napi_env,
    list: gdal_sys::CSLConstList,
) -> std::result::Result<sys::napi_value, String> {
    unsafe {
        let mut object = ptr::null_mut();
        status(sys::napi_create_object(env, &mut object))?;
        let mut index = 0;
        loop {
            let entry = *list.add(index);
            if entry.is_null() {
                break;
            }
            let text = crate::runtime::c_string(entry);
            if let Some((key, value)) = text.split_once('=') {
                let key = CString::new(key)
                    .map_err(|_| "a pixel function argument name cannot contain a NUL byte")?;
                let value = string_value(env, value)?;
                status(sys::napi_set_named_property(
                    env,
                    object,
                    key.as_ptr(),
                    value,
                ))?;
            }
            index += 1;
        }
        Ok(object)
    }
}

unsafe fn value_undefined(env: sys::napi_env) -> std::result::Result<sys::napi_value, String> {
    let mut value = ptr::null_mut();
    unsafe { status(sys::napi_get_undefined(env, &mut value))? };
    Ok(value)
}

unsafe fn value_uint32(
    env: sys::napi_env,
    number: u32,
) -> std::result::Result<sys::napi_value, String> {
    let mut value = ptr::null_mut();
    unsafe { status(sys::napi_create_uint32(env, number, &mut value))? };
    Ok(value)
}

unsafe fn string_value(
    env: sys::napi_env,
    text: &str,
) -> std::result::Result<sys::napi_value, String> {
    let text = CString::new(text).map_err(|_| "a string cannot contain a NUL byte")?;
    let mut value = ptr::null_mut();
    unsafe {
        status(sys::napi_create_string_utf8(
            env,
            text.as_ptr(),
            -1,
            &mut value,
        ))?
    };
    Ok(value)
}

/// A napi status is not an error unless it is not `napi_ok`, and the one worth naming is
/// a pending exception — which `evaluate` handles before calling this.
fn status(code: sys::napi_status) -> std::result::Result<(), String> {
    if code == sys::Status::napi_ok {
        Ok(())
    } else {
        Err(format!(
            "JavaScript refused the call: {}",
            status_text(code)
        ))
    }
}

fn status_text(code: sys::napi_status) -> String {
    format!("napi status {code}")
}

fn sample_size(data_type: gdal_sys::GDALDataType::Type) -> std::result::Result<usize, String> {
    Ok(match data_type {
        gdal_sys::GDALDataType::GDT_Byte | gdal_sys::GDALDataType::GDT_Int8 => 1,
        gdal_sys::GDALDataType::GDT_UInt16 | gdal_sys::GDALDataType::GDT_Int16 => 2,
        gdal_sys::GDALDataType::GDT_UInt32
        | gdal_sys::GDALDataType::GDT_Int32
        | gdal_sys::GDALDataType::GDT_Float32 => 4,
        gdal_sys::GDALDataType::GDT_UInt64
        | gdal_sys::GDALDataType::GDT_Int64
        | gdal_sys::GDALDataType::GDT_Float64 => 8,
        other => {
            return Err(format!(
                "sample type {other} has no typed array, so a pixel function cannot see it"
            ));
        }
    })
}

fn element_type(
    data_type: gdal_sys::GDALDataType::Type,
) -> std::result::Result<sys::napi_typedarray_type, String> {
    Ok(match data_type {
        gdal_sys::GDALDataType::GDT_Byte => sys::TypedarrayType::uint8_array,
        gdal_sys::GDALDataType::GDT_Int8 => sys::TypedarrayType::int8_array,
        gdal_sys::GDALDataType::GDT_UInt16 => sys::TypedarrayType::uint16_array,
        gdal_sys::GDALDataType::GDT_Int16 => sys::TypedarrayType::int16_array,
        gdal_sys::GDALDataType::GDT_UInt32 => sys::TypedarrayType::uint32_array,
        gdal_sys::GDALDataType::GDT_Int32 => sys::TypedarrayType::int32_array,
        // 9 and 10 are `napi_bigint64_array` / `napi_biguint64_array` from napi's own
        // header. `napi-sys` gates the two constants behind a `napi6` feature this crate
        // does not declare, but the values are ABI and the package already requires
        // Node ≥ 20, where both arrays exist.
        gdal_sys::GDALDataType::GDT_UInt64 => 10,
        gdal_sys::GDALDataType::GDT_Int64 => 9,
        gdal_sys::GDALDataType::GDT_Float32 => sys::TypedarrayType::float32_array,
        gdal_sys::GDALDataType::GDT_Float64 => sys::TypedarrayType::float64_array,
        other => {
            return Err(format!(
                "sample type {other} has no typed array, so a pixel function cannot see it"
            ));
        }
    })
}

/// Say why through GDAL, so it reaches the caller as the read's own error rather than
/// only as a line on stderr.
fn report(message: &str) {
    let text = CString::new(message.replace('\0', " ")).unwrap_or_default();
    let format = c"%s";
    unsafe {
        CPLError(
            gdal_sys::CPLErr::CE_Failure as c_int,
            CPLE_APP_DEFINED,
            format.as_ptr(),
            text.as_ptr(),
        );
    }
}
