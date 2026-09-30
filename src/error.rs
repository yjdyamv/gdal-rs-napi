//! Mapping from `gdal::errors::GdalError` to a JS error whose `code` property is
//! a stable, machine-checkable string.
//!
//! `napi` writes the `AsRef<str>` of the error's status into `err.code`, so the
//! type below is what JS sees as `err.code`.

use napi::bindgen_prelude::{Error, Status};

/// `err.code` values. Kept coarse on purpose — the raw GDAL error number goes
/// into the message rather than into the code, so user code can switch on a
/// small, stable set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GdalErrorCode {
    /// `CPLErr::CE_None`
    CplNone,
    /// `CPLErr::CE_Debug`
    CplDebug,
    /// `CPLErr::CE_Warning`
    CplWarning,
    /// `CPLErr::CE_Failure`
    CplFailure,
    /// `CPLErr::CE_Fatal`
    CplFatal,
    /// Anything that is not a GDAL CPL error: bad arguments, invalid field
    /// indexes/names, null pointers from the FFI layer, ...
    BadArgument,
    /// The caller's progress callback returned `false` and the program stopped.
    Cancelled,
    /// Reported when an operation needs a CRS database but PROJ data files
    /// could not be located.
    MissingProjData,
}

impl AsRef<str> for GdalErrorCode {
    fn as_ref(&self) -> &str {
        match self {
            Self::CplNone => "GDAL_CPL_NONE",
            Self::CplDebug => "GDAL_CPL_DEBUG",
            Self::CplWarning => "GDAL_CPL_WARNING",
            Self::CplFailure => "GDAL_CPL_FAILURE",
            Self::CplFatal => "GDAL_CPL_FATAL",
            Self::BadArgument => "GDAL_BAD_ARGUMENT",
            Self::Cancelled => "GDAL_CANCELLED",
            Self::MissingProjData => "GDAL_MISSING_PROJ_DATA",
        }
    }
}

/// Every fallible binding returns this.
///
/// The name has to be exactly `Result`: `napi-derive` decides whether a return
/// type is fallible by looking at the last path segment, so an alias called
/// anything else is seen as a plain value type and fails to compile with a
/// confusing `ToNapiValue is not satisfied` error.
///
/// `napi` renders the status type's `AsRef<str>` as `err.code`, so
/// `GdalErrorCode` is what JS sees when a GDAL call fails.
pub type Result<T, S = GdalErrorCode> = std::result::Result<T, Error<S>>;

/// A plain function rather than a `From` impl: both `Error` and `GdalError` are
/// foreign types, and `Error<GdalErrorCode>` does not count as a local type for
/// the orphan rule.
pub fn gdal_error(err: gdal::errors::GdalError) -> Error<GdalErrorCode> {
    {
        use gdal::errors::GdalError;

        let (code, message) = match &err {
            GdalError::CplError { class, number, msg } => {
                // CPLErr: 0 = None, 1 = Debug, 2 = Warning, 3 = Failure, 4 = Fatal
                let code = match *class as i32 {
                    0 => GdalErrorCode::CplNone,
                    1 => GdalErrorCode::CplDebug,
                    2 => GdalErrorCode::CplWarning,
                    4 => GdalErrorCode::CplFatal,
                    _ => GdalErrorCode::CplFailure,
                };
                (
                    code,
                    format!("[CPLErr={} #{}] {}", *class as i32, number, msg),
                )
            }
            GdalError::BadArgument(msg) => (GdalErrorCode::BadArgument, msg.clone()),
            GdalError::InvalidFieldName {
                field_name,
                method_name,
            } => (
                GdalErrorCode::BadArgument,
                format!("invalid field name {field_name:?} in {method_name}"),
            ),
            GdalError::InvalidFieldIndex { index, method_name } => (
                GdalErrorCode::BadArgument,
                format!("invalid field index {index} in {method_name}"),
            ),
            GdalError::NullPointer { method_name, msg } => {
                (GdalErrorCode::BadArgument, format!("{method_name}: {msg}"))
            }
            other => (GdalErrorCode::BadArgument, other.to_string()),
        };

        Error::new(code, message)
    }
}

/// The error behind a GDAL call that answers with a `CPLErr`: last error message and
/// number, with `fallback` standing in when the call failed leaving nothing behind —
/// a missing directory, say. Resets GDAL's error state afterwards, which is what every
/// caller here wants next.
pub(crate) fn cpl_failure(fallback: String) -> Error<GdalErrorCode> {
    let message = crate::runtime::c_string(unsafe { gdal_sys::CPLGetLastErrorMsg() });
    let error = gdal_error(gdal::errors::GdalError::CplError {
        class: gdal_sys::CPLErr::CE_Failure,
        number: unsafe { gdal_sys::CPLGetLastErrorNo() },
        msg: if message.is_empty() {
            fallback
        } else {
            message
        },
    });
    unsafe { gdal_sys::CPLErrorReset() };
    error
}

/// Shorthand so call sites read `.gdal()?` instead of a nested `map_err`.
pub trait IntoGdalResult<T> {
    fn gdal(self) -> Result<T>;
}

impl<T> IntoGdalResult<T> for std::result::Result<T, gdal::errors::GdalError> {
    fn gdal(self) -> Result<T> {
        self.map_err(gdal_error)
    }
}

/// A plain `String` failure that is not a GDAL error (e.g. "index out of range"
/// from our own argument validation).
pub fn bad_argument<T: std::fmt::Display>(msg: T) -> Error<GdalErrorCode> {
    Error::new(GdalErrorCode::BadArgument, msg.to_string())
}

/// A failure carried across `Task::compute`, which must be `Send`.
pub type GdalFailure = (GdalErrorCode, String);

/// Take a `GdalResult` error apart for transport to the JS thread.
pub fn split(err: Error<GdalErrorCode>) -> GdalFailure {
    (err.status, err.reason)
}

/// Rebuild an error on the JS thread.
///
/// `napi::Task` fixes its error type to `napi::Error<Status>`, so an async
/// operation cannot set the custom `err.code` that the sync surface gets. Fold
/// the code into the message instead, keeping one stable token to match on.
pub fn into_status_error(code: GdalErrorCode, reason: String) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("[{}] {}", code.as_ref(), reason),
    )
}
