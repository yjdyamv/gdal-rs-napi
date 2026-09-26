# Changelog

## Unreleased

First working cut — everything here is new.

### Binding

- Module functions: `version`, `drivers`, `diagnostics`, `configureDataPaths`,
  `epsgToWkt`, `bytesPerSample`, `openThreadSafe` / `openThreadSafeSync`,
  `geometryTypeOf`, `geometryToWkt`, `geometryToWkb`, `geometryFromWkt`,
  `geometryFromWkb`.
- Programs: `translate` / `translateSync`, `warp` / `warpSync`, `vectorTranslate` /
  `vectorTranslateSync` — `gdal_translate`, `gdalwarp` and `ogr2ogr`, each taking
  that tool's own command-line arguments. `warp` and `vectorTranslate` take a list
  of sources; all three run on the thread pool, and all three are also methods on
  an open `Dataset`.
- `Dataset`: `open` / `openSync`, `create` / `createSync`, `createVector` /
  `createVectorSync`, `createCopy` / `createCopySync`, `band`, `bands`, `layer`,
  `layerByName`, `layers`, `createLayer`, `metadata`, `setMetadataItem`,
  `setGeoTransform`, `setProjection`, `flush` / `flushSync`, `close`, plus a
  `threadSafe` getter.
- `RasterBand`: `readPixels` / `readAs` (async and sync), `writePixels`,
  `noDataValue`, `setNoDataValue`, `size`, `blockSize`, `colorInterpretation`,
  `metadata`.
- `Layer`: `featuresSync`, `feature`, `setAttributeFilter`,
  `setSpatialFilterRect`, `clearSpatialFilter`, `createFeature`, `updateFeature`,
  `fields`, `extent`, `spatialRefWkt`.
- Index convention: raster bands and layers are **0-based** in JS, unlike GDAL.
- Every GDAL call is serialised behind one process-wide lock, because GDAL keeps
  its last-error state in process-global variables. The async methods keep the
  Node event loop free; they do not make GDAL work run in parallel.
- `openThreadSafe()` is the exception. It wraps GDAL 3.10's
  `GDALGetThreadSafeDataset`, whose pixel reads take the *shared* side of that lock
  and therefore really do overlap — a measured 2.6x on four concurrent reads where
  the serialised path showed no gain at all from issuing them together. Such a
  dataset is read-only and raster-only: writes and layer access throw
  `GDAL_BAD_ARGUMENT`, and everything other than a pixel read still takes the
  exclusive side so the error-state race above stays excluded. Most drivers reopen
  the file per thread, so concurrency costs file descriptors; GTiff/COG do not.
- Errors carry a stable `err.code` (`GDAL_CPL_FAILURE`, `GDAL_BAD_ARGUMENT`, …) on
  the sync surface. `napi::Task` fixes its error type, so async methods throw the
  same token at the front of the message instead.

### Build

- GDAL 3.12.1 and PROJ 9.6.x are compiled from source and linked statically, so an
  installed package needs no GDAL on the host. The PROJ and GDAL data files travel
  inside the package (~12 MB) and are wired up automatically by `index.js`.
- Driver set is `internal_drivers` + sqlite/gpkg/vfk: 131 drivers. GEOS is
  deliberately absent — it is LGPL, and static linking would relicense the artifact.
- Requires Ninja (`CMAKE_GENERATOR`) and a `sqlite3` CLI from outside MSYS2. MSYS2
  must stay off `PATH` or GDAL's configure aborts; see the README for why.
- CI builds six targets on native runners and attaches one self-contained tarball
  per platform to a GitHub Release. **Nothing is published to npm.**
- The two musl legs are marked experimental (`continue-on-error`): cross-linking a
  static C++ GDAL is the least settled part of the matrix.
- `build.rs` reads the GDAL version that `gdal-sys` reports and switches
  `openThreadSafe` on only for GDAL ≥ 3.10, so linking an older system GDAL still
  compiles instead of failing on a missing type.

### Testing

- `scripts/bench-parallel.mjs` measures the thread-safe path against the serialised
  one: the same concurrent workload, on real data, with the numbers and their
  spread printed. It is a benchmark, not a test, and asserts nothing.

### Known gaps

- No `SpatialRef` class; constructing a CRS is limited to `epsgToWkt`.
- No `statistics()` or `buildOverviews()`.
- The programs have no progress callbacks (GDAL's `*OptionsSetProgress` is not
  wired up), and `vectorTranslate` has no `-overwrite`, which is a command-line
  feature rather than part of `GDALVectorTranslate`.
- No `GDALDEMProcessing` (hillshade and friends).
- Reading a layer materialises every feature; there is no streaming iterator, and
  no async feature iteration.
- Array-valued properties are written as comma-joined text rather than list fields.
- Generated `.d.ts` types the async methods as `Promise<unknown>`, because `napi`
  cannot resolve `Task::JsValue`. The sync signatures are exact and the values
  returned at runtime are right; only the annotation is lost.
- Intel macOS and 32-bit targets are not built.
