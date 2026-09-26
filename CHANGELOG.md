# Changelog

## Unreleased

First working cut — everything here is new.

### Binding

- Module functions: `version`, `drivers`, `diagnostics`, `configureDataPaths`,
  `epsgToWkt`, `bytesPerSample`, `geometryTypeOf`, `geometryToWkt`,
  `geometryToWkb`, `geometryFromWkt`, `geometryFromWkb`.
- `Dataset`: `open` / `openSync`, `create` / `createSync`, `createVector` /
  `createVectorSync`, `createCopy` / `createCopySync`, `band`, `bands`, `layer`,
  `layerByName`, `layers`, `createLayer`, `metadata`, `setMetadataItem`,
  `setGeoTransform`, `setProjection`, `flush` / `flushSync`, `close`.
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

### Known gaps

- No `gdalwarp` / `gdal_translate` wrappers, so no VRT/warp-based reprojection.
- No `SpatialRef` class; constructing a CRS is limited to `epsgToWkt`.
- No `statistics()` or `buildOverviews()`.
- Reading a layer materialises every feature; there is no streaming iterator, and
  no async feature iteration.
- Array-valued properties are written as comma-joined text rather than list fields.
- Intel macOS and 32-bit targets are not built.
