//! Progress reporting, from a worker thread back to the JS thread.
//!
//! GDAL reports progress by calling a C function pointer, which cannot capture
//! anything, and it calls it from whatever thread is running the program — for the
//! async entry points, a libuv worker. The JS callback lives on the main thread, so
//! this module is the hop between the two.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

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
///
/// One warning that follows from the same place: the worker is holding this
/// binding's process-wide GDAL lock while it waits, so a callback that calls back
/// into the library deadlocks. Report progress; do not read a raster from in there.
pub struct JsProgressSink {
    /// An `Arc` because `ThreadsafeFunction` is not `Clone`, and the task that owns
    /// one is only borrowed while it runs.
    callback: Arc<ProgressCallback>,
    /// Set when a callback has answered `false`, and sticky on purpose: once GDAL
    /// has been told to stop there is nothing to be gained by asking again.
    cancelled: AtomicBool,
    /// Where the callback's answer lands, and what to wait on for it. See `report`.
    answer: Arc<(Mutex<Option<bool>>, Condvar)>,
}

impl JsProgressSink {
    pub fn new(callback: Arc<ProgressCallback>) -> Self {
        Self {
            callback,
            cancelled: AtomicBool::new(false),
            answer: Arc::new((Mutex::new(None), Condvar::new())),
        }
    }
}

impl ProgressSink for JsProgressSink {
    fn report(&self, complete: f64, message: Option<&str>) -> bool {
        if self.cancelled.load(Ordering::SeqCst) {
            return false;
        }

        *self.answer.0.lock().unwrap() = None;
        let answer = Arc::clone(&self.answer);

        let status = self.callback.call_with_return_value(
            ProgressUpdate {
                complete,
                message: message.map(str::to_owned),
            },
            ThreadsafeFunctionCallMode::Blocking,
            move |result, _env| {
                // Only an explicit `false` cancels. Anything else — and a callback
                // that returns nothing is the common shape — means carry on, so a
                // callback that only logs cannot stop the job by accident.
                let keep_going = !matches!(result, Ok(false));
                *answer.0.lock().unwrap() = Some(keep_going);
                answer.1.notify_all();
                Ok(())
            },
        );

        if !matches!(status, Status::Ok) {
            // The call never reached the JS thread, so nothing will ever fill the
            // slot. Carry on: a program is not the place to complain about its own
            // reporter, and stopping would be the surprising answer.
            return true;
        }

        // Blocking mode waits for the JS turn to *start*, not to finish: measured
        // directly, the return value of call N arrives after call N+1 has begun, so
        // reading it without waiting reports the previous answer. GDAL's callback is
        // synchronous, so wait for this call's answer.
        let (slot, signal) = &*self.answer;
        let mut answer = slot.lock().unwrap();
        while answer.is_none() {
            answer = signal.wait(answer).unwrap();
        }
        let keep_going = answer.unwrap_or(true);

        if !keep_going {
            self.cancelled.store(true, Ordering::SeqCst);
        }

        keep_going
    }
}
