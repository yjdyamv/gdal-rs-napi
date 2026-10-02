//! Catching a panic that would otherwise cross napi's `extern "C"` worker entry.
//!
//! `napi` runs `Task::compute` on a libuv worker from an `extern "C"` function with
//! no unwind protection (see `napi::async_work::execute`). A panic that reaches that
//! boundary aborts the whole process — and that includes the reentrancy panic in
//! [`crate::runtime::reentrant_lock`], which exists to *diagnose* a nested lock
//! rather than to kill the process. Wrapping the body turns that abort into a
//! rejected promise, so the synchronous and asynchronous halves of the API fail the
//! same way.

use std::panic::AssertUnwindSafe;

use napi::{Error, Result, Status};

/// Run `body`, turning a panic into a rejected promise instead of a process abort.
///
/// The body is the whole of a `Task::compute`; `AssertUnwindSafe` is right here
/// because whatever state the panic left behind is not handed on — the task is
/// dropped once the promise rejects.
pub(crate) fn catch<T>(body: impl FnOnce() -> Result<T>) -> Result<T> {
    match std::panic::catch_unwind(AssertUnwindSafe(body)) {
        Ok(result) => result,
        Err(payload) => Err(Error::new(
            Status::GenericFailure,
            format!(
                "[GDAL_CPL_FAILURE] the worker thread panicked: {}",
                panic_message(payload)
            ),
        )),
    }
}

/// The text a panic payload carries, whether it came from `panic!("…")` or
/// `unwrap`/`expect`.
fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_becomes_a_rejected_result() {
        let result: Result<()> = catch(|| panic!("the worker blew up"));
        let error = result.unwrap_err();
        assert!(
            error.reason.contains("worker thread panicked"),
            "{}",
            error.reason
        );
        assert!(
            error.reason.contains("the worker blew up"),
            "{}",
            error.reason
        );
    }

    #[test]
    fn a_normal_result_passes_through() {
        assert_eq!(catch(|| Ok::<i32, Error>(7)).unwrap(), 7);
    }
}
