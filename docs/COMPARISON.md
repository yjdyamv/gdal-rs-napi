# Where this binding stands against `gdal-async`

The reference is **`node-gdal-async` 3.13** (<https://mmomtchev.github.io/node-gdal-async/>),
an N-API addon over the GDAL C++ API. This is the synthesis: what is the same, where the
two still differ, and — the part `PARITY.md` deliberately leaves out — which one is the
better tool for what.

[`PARITY.md`](./PARITY.md) is the item-by-item accounting and the capability boundary;
this file is the judgement on top of it. Both are written against a build that has no
host GDAL: everything, including GEOS, is compiled in.

## 1. What is at parity

Not "close" — the same capability, under a different spelling, and covered by tests:

- **Raster**: windows, samples, resampling, overviews (build / remove / read a level),
  statistics and histograms (compute, cache, write back), checksum, fill, fill-no-data,
  sieve, palettes, masks, per-band metadata, geotransform/GCPs, colour tables, band
  arithmetic (`add`…`ifThenElse`, `asType`), raster streams, `calcAsync` with
  `RasterMuxStream` / `RasterTransform`.
- **Vector**: layers and fields (create, alter, reorder, drop), features (read, write,
  update, delete, cursor paging, attribute and spatial filters), transactions, SQL with
  both dialects, FID and geometry columns, capabilities, `copyLayer`.
- **Geometry**: the OGR model with the class family, the GEOS predicates and set algebra
  (`buffer`, `intersection`, `union`, `simplify`, `centroid`…), WKT/WKB/GeoJSON/GML/KML,
  transforms.
- **CRS**: `SpatialRef` in full (WKT, PROJJSON, proj4, ESRI dialect, validation, axis
  order), `CoordinateTransform` on points, arrays, bounds and geometries, `identifyEpsg`.
- **Programs**: `translate` / `warp` / `ogr2ogr` / `gdaldem` / `buildVrt` / `reprojectImage`,
  with `onProgress` and cancellation.
- **Multidimensional**: `root` → `Group` / `MDArray` / `Attribute` / `Dimension`, reads,
  views, masks, `asDataset`, `band.asMDArray()`.
- **VRT pixel functions**: `addPixelFunc` / `toPixelFunc` / `createPixelFunc` /
  `createPixelFuncWithArgs` / `wrapVRT`.
- **Containers**: `get` / `count` / `getNames` / iterators on both entries, plus the
  pixel object and the geometry classes — the shapes this binding once listed as
  "not here" are here.

## 2. Where we still differ, and why

Each of these is a decision with a reason, not a leftover.

| difference | reference | here | why |
|---|---|---|---|
| **Index base** | 1-based | **0-based** (`band.id` is the exception) | 0-based is what a JS caller expects of an array-like; the reference's 1-based indices are GDAL's C API leaking through. The cost is real: a port changes every index. |
| **Async spelling** | `xxx()` + `xxxAsync()` + node callbacks | `xxxSync()` / `xxx(): Promise` | One form per operation and no `Async` suffix, so "which one blocks" is answered by the signature. The two exceptions are a getter (no call to rename) and `infoAsync`. |
| **Setters** | assignment (`band.noDataValue = x`) | `setX(x)` | An assignment that runs GDAL code is invisible in a stack trace; a call is not. |
| **Enums** | numeric `GDT_*` / `OGC_*` | string `'Float32'`, `'RedBand'` | The properties already report strings. Two vocabularies for one value is the bug the reference's own users file. |
| **Feature geometry** | a `Geometry` instance | **GeoJSON plain object** (plus `Geometry.fromJson` / `layer.getFeature`) | A `FeatureRecord` is copied-out plain data, so a plain object survives `structuredClone` and JSON without a class to lose. The class is one call away, `instanceof` and all. |
| **`feature.geometry` getter on `Feature`** | same class | same (GeoJSON), as above | One design, not two. |
| **Band algebra** | lazy VRT with pixel functions | **eager** into a new MEM dataset | A lazy VRT keeps its sources open: reading after `close()` is a use-after-free (measured: access violation). The lazy route exists, deliberately — `wrapVRT` with a pixel function — but it is not the default. |
| **`pixelFunc` reads** | any thread | **synchronous reads only** | GDAL calls back on whichever thread is reading; only the JS thread can enter JavaScript, and handing the call to the event loop from a worker would deadlock against the lock that worker holds. |
| **`MDArray.read()`** | typed array in the JS type of the moment | bytes in the array's own type | The same rule as `readPixels`; a `String`/`Compound` array is refused rather than guessed. |
| **Typed returns on the new shapes** | n/a | `dataset.bands.get(1)` is `Array<RasterBand>` to TypeScript | A class member's type comes from the generated declarations and cannot be widened from the hand-written half. Runtime is right; TypeScript has to say what it means. `instanceof` narrows, so the geometry family needs no cast at all. |
| **Threading** | per-dataset mutex + libuv queue | **one global `RwLock`'s read side for all dataset work + one mutex per handle** | See §3: this is the one place where the two are architecturally different rather than cosmetically. |

## 3. Concurrency: the real architectural difference

Both bindings free the event loop with the thread pool. They differ in **how much of
GDAL runs at once**:

- **`gdal-async`** plugs a per-dataset mutex into libuv's queue, so two datasets are two
  independent queues; its thread-safety story is GDAL's own, per dataset.
- **This binding** had a process-wide `RwLock` in which dataset work took the write
  side — deliberate, conservative, and *serial*: ten async reads on ten datasets queued
  behind each other. That is now **one global lock whose write side is process-global
  state only** (registration, `config`, the programs, module-level `create`), with
  dataset work on the read side and a **mutex per open handle** doing the exclusion.
  Same handle: serialised (GDAL's rule). Different handles: overlap.
  `openThreadSafe()` goes further and lets *one* handle be read by several threads
  (`GDAL_OF_THREAD_SAFE`).

Measured with `scripts/bench-parallel.mjs` on a 2048×2048 DEFLATE GTiff, 4 threads:

| workload | result |
|---|---|
| 4 reads, one handle | 7.5 ms — the handle mutex, by design |
| **4 reads, two handles** | **4.4 ms → 1.70x** (before: 7.5 ms, no overlap at all) |
| 4 reads, one `openThreadSafe` handle | 3.4 ms → 2.16x |
| 4 coordinate transforms (no dataset) | 3.18x |
| module surface during those transforms | 1.02–1.22x (it answers *during* them) |

**Where the reference is still better here**: its per-dataset queue also *schedules*
(the `libuv` pool decides), whereas ours is a lock — a long read on one handle blocks
only that handle, but nothing reorders work, and the pool size is the real ceiling
(`UV_THREADPOOL_SIZE`, four by default). Its thread-safe story is opt-in per dataset in
both bindings; the reference's is `open(path, 'rt')`, ours is `openThreadSafe()`.

**Where ours is better**: the guarantee is written down and tested. Two rules, both
enforced by tests and by the benchmark's floors — "no closure holding the read side
takes the write side" and "two handles must beat one" — are the kind of invariant a
per-dataset queue leaves implicit.

## 4. Strengths, honestly

- **Nothing external is required.** GDAL, PROJ and GEOS are compiled into one `.node`
  and the CRS database ships as an asset. `gdal-async` links the host's GDAL (or builds
  it), so its users meet `PROJ_LIB`, `GDAL_DATA`, DLL search paths and version skew.
  This is the single biggest difference in practice, and it is the reason to pick this
  binding at all.
- **Everything is tested against the real library.** A Node suite against the native
  binding, a **typed TypeScript suite for `compat`** (Vitest, type-checked against
  `compat/index.d.ts`, with a coverage floor that fails the run when it drops), Rust unit
  tests, an `err.code` on both the sync and async paths, and a generated-declaration test
  that fails when the runtime and the types drift apart.
- **Failure is an error, not a crash.** Closed datasets, out-of-range windows, missing
  drivers, refused thread-safe writes, reentrant callbacks: a clear message with a
  stable `code`. The cases found while building this — an over-eager `free` of a
  driver-owned list, a stale band handle — are now pinned by tests.
- **The reference's shapes are available twice over.** `gdal-rs-napi/compat` is a JS
  adapter for a port that wants `gdal-async`'s spelling, and the main entry point now
  takes the reference's containers and geometry classes as well. A migration can be one
  `require` change, or a slow one-file-at-a-time rewrite, and both land on the same
  native implementation. How much of the reference the adapter answers is **counted**
  rather than claimed: `scripts/compat-coverage.mjs` reads gdal-async's own ~60 test
  files and reports every `gdal.<name>` they use — **136 of 136** module-level names as
  of the last run, plus 194 of 200 member names, the six misses being extraction noise
  rather than capabilities ([`PARITY.md`](./PARITY.md) lists them). Reading their suite
  is also what turned up the biggest single usage pattern, `assert.instanceOf(dataset,
  gdal.Dataset)` (262 times), which is the kind of thing documentation does not tell you.

## 5. Weaknesses, honestly

- **Index base and spelling diverge from the reference.** A port touches every index
  and every `xxx()` call. `compat` absorbs it, but a project that only uses the modern
  entry point will feel it.
- **Typing holes on the widened shapes.** `dataset.bands.get(1)` and a `Point`-typed
  return need the caller's help; the generated declarations own those types.
- **A lock, not a scheduler.** No work stealing, no per-dataset queues; the thread pool
  size is the ceiling and a hot dataset is a strict serial line.
- **One writer per dataset is not a fine-grained story.** Two handles to the *same*
  file are two handles: writing through one while reading the other is the user's
  problem, exactly as it is in two processes. The programs are serialised against all
  dataset work precisely because they rewrite files.
- **No TypeScript-first API.** The shell and the geometry family are plain JavaScript
  with hand-written declarations; there is no `.ts` source to read for the parts the
  generator does not cover.
- **Younger than the reference.** No CMake/vcpkg/conda ecosystem, no Electron/Node
  matrix history, no long tail of StackOverflow answers.

## 6. Choosing

- **Take this one** if you want a self-contained dependency, one artifact per platform,
  string-typed errors you can read, and do not want to manage GDAL's environment. Take
  it especially if you are starting fresh.
- **Take `gdal-async`** if you must share the host's GDAL (a system install, a GDAL
  plugin, a driver we do not build), need its ecosystem, or depend on a specific GDAL
  build's drivers.
- **Porting**: start with `require('gdal-rs-napi/compat')`. Move to the main entry point
  when you want the 0-based/`Sync` spelling, and expect the container and geometry
  shapes to be there when you do.
