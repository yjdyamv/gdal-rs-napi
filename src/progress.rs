//! Progress reporting, from a worker thread back to the JS thread.
//!
//! GDAL reports progress by calling a C function pointer, which cannot capture
//! anything, and it calls it from whatever thread is running the program — for the
//! async entry points, a libuv worker. The JS callback lives on the main thread, so
//! this module is the hop between the two.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use napi::Status;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use crate::programs::ProgressSink;

/// What a progress callback is told.
#[napi(object)]
pub struct ProgressUpdate {
    /// How much of the work is done, from 0.0 to 1.0. It rises, but GDAL does not
    /// promise even steps.
    pub complete: f64,
    /// GDAL's own message, when it has one to give.
    pub message: Option<String>,
}

/// The callback the JS API takes: one `ProgressUpdate` per call, and a return value
/// read as "carry on?".
///
/// The parameters are spelled out because the defaults pick the *callee-handled*
/// form of `ThreadsafeFunction`, in which JS hands the callback an extra
/// `(err, value)` argument — not what a progress callback should look like.
/// `ProgressUpdate` appears twice because it is both the value and the argument
/// list, and `false` is `CalleeHandled`.
pub type ProgressCallback = ThreadsafeFunction<ProgressUpdate, bool, ProgressUpdate, Status, false>;

/// A progress callback that runs on the JS thread.
///
/// The callback is called in *blocking* mode, so the worker waits for it. That is
/// what lets a `false` return stop the program: GDAL needs the answer before it can
/// decide whether to carry on. The cost is that a slow callback slows the program
/// down, which is worth remembering if the callback does real work.
pub struct JsProgressSink {
    /// An `Arc` because `ThreadsafeFunction` is not `Clone`, and the task that owns
    /// one is only borrowed while it runs.
    callback: Arc<ProgressCallback>,
    /// Set when a callback has answered `false`, and sticky on purpose: once GDAL
    /// has been told to stop there is nothing to be gained by asking again.
    cancelled: AtomicBool,
    /// The answer to the current call, shared with the closure that receives it.
    /// A field rather than a local so that a progress callback, which can fire
    /// thousands of times, does not allocate every time.
    answered: Arc<AtomicBool>,
}

impl JsProgressSink {
    pub fn new(callback: Arc<ProgressCallback>) -> Self {
        Self {
            callback,
            cancelled: AtomicBool::new(false),
            answered: Arc::new(AtomicBool::new(true)),
        }
    }
}

impl ProgressSink for JsProgressSink {
    fn report(&self, complete: f64, message: Option<&str>) -> bool {
        if self.cancelled.load(Ordering::SeqCst) {
            return false;
        }

        self.answered.store(true, Ordering::SeqCst);
        let answered = Arc::clone(&self.answered);

        let status = self.callback.call_with_return_value(
            ProgressUpdate {
                complete,
                message: message.map(str::to_owned),
            },
            ThreadsafeFunctionCallMode::Blocking,
            move |result, _env| {
                // Only an explicit `false` cancels. A callback that returns nothing —
                // the common shape, and what a callback that just logs looks like —
                // means carry on, so it cannot stop the job by accident.
                if matches!(result, Ok(false)) {
                    answered.store(false, Ordering::SeqCst);
                }
                Ok(())
            },
        );

        // A callback that has been closed, or a queue that refused the call, reads as
        // "carry on": a program is not the place to report a problem with its own
        // reporter, and stopping the work would be the surprising answer.
        let keep_going = matches!(status, Status::Ok) && self.answered.load(Ordering::SeqCst);
        if !keep_going {
            self.cancelled.store(true, Ordering::SeqCst);
        }

        keep_going
    }
}
