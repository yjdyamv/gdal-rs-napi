//! GDAL's runtime configuration options, as `gdal.config.get` / `gdal.config.set`.
//!
//! These are GDAL's own `CPLGetConfigOption` / `CPLSetConfigOption` — the same
//! store the `GDAL_*` and `CPL_*` environment variables feed, and what the
//! command-line tools expose as `--config NAME=VALUE`. Anything you would pass to
//! `gdalwarp --config` can be set here instead, for the calls that never touch a
//! command line.
//!
//! Reads go through the C function rather than the `gdal` crate's wrapper because
//! the wrapper folds "not set" into the default value, and that distinction is
//! the whole point of the getter: `config.get('GDAL_NUM_THREADS')` has to be able
//! to answer `null`.

use std::ffi::CString;

use napi_derive::napi;

use crate::error::{IntoGdalResult, Result, bad_argument};
use crate::runtime::{c_string, ensure_initialized, lock_gdal};

/// Read a GDAL configuration option.
///
/// Returns `null` when the option is not set — unless `defaultValue` is given, in
/// which case that is what comes back instead. Note that GDAL treats an empty
/// value as "not set", so a key someone cleared reads as `null` too.
///
/// ```js
/// gdal.config.get('GDAL_NUM_THREADS')            // null until something sets it
/// gdal.config.get('GDAL_NUM_THREADS', 'ALL_CPUS') // 'ALL_CPUS'
/// ```
#[napi(catch_unwind, namespace = "config")]
pub fn get(key: String, default_value: Option<String>) -> Result<Option<String>> {
    ensure_initialized();
    // The exclusive side, and the one read-only call here that needs it. Not
    // because the store is unguarded — GDAL takes its own mutex around the global
    // map — but because `CPLGetConfigOption` hands back a pointer *into* that map
    // and releases the mutex on the way out; the string is only valid until the
    // next `set` with the same key frees it. Copying it while a concurrent `set`
    // could run is a use-after-free, so reads and writes stay on the same side.
    let _guard = lock_gdal();

    // `CPLGetConfigOption` reads GDAL's global + thread-local store, so it is
    // reached the same way any other GDAL call is: behind the lock.
    let key = CString::new(key)
        .map_err(|_| bad_argument("a configuration key cannot contain a NUL byte"))?;
    let default = match &default_value {
        Some(value) => Some(
            CString::new(value.as_str())
                .map_err(|_| bad_argument("a configuration default cannot contain a NUL byte"))?,
        ),
        None => None,
    };
    let default_ptr = default
        .as_ref()
        .map_or(std::ptr::null(), |value| value.as_ptr());

    let value = unsafe { gdal_sys::CPLGetConfigOption(key.as_ptr(), default_ptr) };
    if value.is_null() {
        return Ok(None);
    }
    Ok(Some(c_string(value)))
}

/// Set a GDAL configuration option, or clear it by passing `null`.
///
/// The value is process-wide and lives until it is cleared or the process exits;
/// it is *not* scoped to this call. Values set here override the environment
/// variables GDAL was started with.
///
/// ```js
/// gdal.config.set('GDAL_NUM_THREADS', 'ALL_CPUS')
/// gdal.config.set('CPL_CURL_VERBOSE', 'YES') // any curl-backed driver
/// gdal.config.set('MY_OPTION', null)         // clear it again
/// ```
#[napi(catch_unwind, namespace = "config")]
pub fn set(key: String, value: Option<String>) -> Result<()> {
    ensure_initialized();
    let _guard = lock_gdal();

    match value {
        Some(value) => gdal::config::set_config_option(&key, &value).gdal(),
        None => gdal::config::clear_config_option(&key).gdal(),
    }
}

#[cfg(test)]
mod tests {
    // The option store is process-global and shared with the rest of the crate,
    // so these only touch keys of their own.
    use super::*;

    #[test]
    fn a_missing_option_reads_as_none_and_a_present_one_reads_back() {
        assert_eq!(
            get("GDAL_RS_NAPI_TEST_ABSENT".to_string(), None).unwrap(),
            None
        );
        assert_eq!(
            get(
                "GDAL_RS_NAPI_TEST_ABSENT".to_string(),
                Some("fallback".to_string())
            )
            .unwrap(),
            Some("fallback".to_string())
        );

        set(
            "GDAL_RS_NAPI_TEST_VALUE".to_string(),
            Some("hello".to_string()),
        )
        .unwrap();
        assert_eq!(
            get("GDAL_RS_NAPI_TEST_VALUE".to_string(), None).unwrap(),
            Some("hello".to_string())
        );

        set("GDAL_RS_NAPI_TEST_VALUE".to_string(), None).unwrap();
        assert_eq!(
            get("GDAL_RS_NAPI_TEST_VALUE".to_string(), None).unwrap(),
            None
        );

        // A NUL byte cannot survive the trip into C, and is reported rather than
        // silently truncated.
        assert!(set("GDAL_RS_NAPI\0BAD".to_string(), Some("x".to_string())).is_err());
    }
}
