# Concurrency and the GDAL lock

Every call into GDAL takes a side of one process-wide `RwLock` first. Which side
is a property of the **call**, not of the module it lives in. The authoritative
comment is on `GDAL_LOCK` in [`src/runtime.rs`](../src/runtime.rs); this document
is the reader's version, and the guardrails that keep the split honest.

## The two sides

**Shared** — work with no dataset and no process-global configuration in it:

- module-level introspection: `version`, `info`, `diagnostics`, `lastError`,
  `epsgToWkt`, `toDataType` / `fromDataType`, `decToDMS`, `features`;
- the CRS surface (`SpatialRef`, `CoordinateTransform`) and the geometry helpers;
- `gdal.fs` — writes included; only `clearCurlCache` is exclusive;
- driver-registry reads (`drivers()`, `driver(name)`, `testCapability`);
- a pixel read of a dataset opened through `openThreadSafe()`.

These genuinely overlap: two threads transforming coordinates do not wait for
each other. `scripts/bench-parallel.mjs` measures the ratio, and CI gates it at
`--min-speedup 1.5` (measured 3.0–3.6×).

**Exclusive** — datasets, programs, and anything process-global:

- driver registration and `configureDataPaths` (one-time, behind the
  `OnceLock` in `ensure_initialized`);
- `config.set` — and `config.get` with it, because `CPLGetConfigOption` returns
  a pointer *into* the map and drops the guard;
- module-level programs (`buildVrt`, and `create` / `createVector`), whose
  output can be a file another thread reads;
- `with_two`, which holds two datasets at once (the exclusive side is what
  orders the two per-handle mutexes);
- a thread-safe dataset's writes and `close()`.

An operation on an **already-open** dataset takes the shared side even where it
writes, because that dataset's own mutex serialises it.

## One dataset is one reader at a time

The global lock does not serialise datasets against each other. A
`SharedDataset` is `Arc<Mutex<DatasetHandle>>`: the same handle from two threads
serialises, two different handles do not wait. `openThreadSafe()` is the opt-in
for GDAL's own `GDAL_OF_THREAD_SAFE`, which goes further and lets several
threads read **one** handle at once. It is read-only and raster-only — that is
GDAL's restriction, not this binding's.

## Why the shared side is sound

Three things that look process-global in GDAL are not, in the 3.12 the bundled
build links:

1. last-error state is **thread-local** (`CPLGetTLSEx(CTLS_ERRORCONTEXT, …)`);
2. `OGRSpatialReference` takes its PROJ context from `OSRGetProjTLSContext()`;
3. `OGRGeometry::createGEOSContext()` creates a GEOS context per call.

The first is pinned by the Rust unit test `gdals_last_error_is_thread_local`,
which deliberately runs two threads inside GDAL at once. If a future GDAL moves
that state back to process-global, the test fails loudly rather than the lock
silently becoming wrong.

## Deadlocks are turned into diagnoses

`RwLock` is not reentrant. A second acquisition on the same thread — a dataset
closure that calls back into something that locks — used to hang the process
with nothing on stderr. Now:

- a nested acquisition panics with the two sides named
  (`reentrant_lock`), covered by `a_second_exclusive_lock_panics_instead_of_deadlocking`
  and `the_shared_lock_under_the_exclusive_one_panics`;
- a worker blocked on an `onProgress` callback while holding the lock is
  detected when the JS thread asks for that lock
  (`diagnose_progress_deadlock`), again a panic rather than a hang.

The rule this enforces: **a closure running under the lock must not call
anything that locks**, including transitively. A poisoned lock is recovered
from on purpose, so one panic does not brick the addon.

## Guardrails for a change to this area

- Keep the lock premise test passing; it is the reason the shared side exists.
- Keep the benchmark gate. It measures a **ratio** on one runner, so it is safe
  on a slow machine: about 3× while dataset-free work is on the shared side,
  about 1× if it ever moves back to the exclusive side.
- When adding an entry point, decide its side from what it touches, not from the
  file it lives in; an operation on an open dataset is shared, a
  process-global write is exclusive.
- Do not add a call under the shared side that takes the exclusive side or the
  shared lock again.
