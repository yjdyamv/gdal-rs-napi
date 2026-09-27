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
  `setGeoTransform`, `setProjection`, `buildOverviews` / `buildOverviewsSync`,
  `flush` / `flushSync`, `close`, plus a `threadSafe` getter.
- `RasterBand`: `readPixels` / `readAs` (async and sync), `writePixels`,
  `statistics` / `statisticsSync`, `histogram` / `histogramSync`,
  `noDataValue`, `setNoDataValue`, `size`, `blockSize`, `colorInterpretation`,
  `metadata`, `overviewCount`.
- `Layer`: `featuresSync`, `feature`, `openCursor`, `setAttributeFilter`,
  `setSpatialFilterRect`, `clearSpatialFilter`, `createFeature`, `updateFeature`,
  `deleteFeature`, `fields`, `extent`, `spatialRefWkt`, `spatialRef`.
- `createLayer` takes `fields` — `FieldDefinition` objects with a name, a type from
  the same vocabulary `fields` reports, and optional width and precision. A declared
  type beats inference (`count: 5` no longer becomes an `Integer64`), and a declared
  `StringList` is how to get a real list column. Undeclared properties are still
  inferred alongside them.
- `FeatureCursor`: `read` (async) / `readSync`, `batchSize`, `finished`, `close`.
  It pages a layer, so a large one costs a batch of memory instead of all of it,
  and each batch holds exactly what `featuresSync` would have returned for those
  rows. Note that GDAL keeps the reading position on the *layer*, not in the
  cursor: that is what lets batches resume, and it also means one reader per layer
  at a time, read in order.
- `Dataset`: `demProcess` / `demProcessSync` for `gdaldem`'s hillshade, slope,
  aspect, color-relief, tri, tpi and roughness (with `gdal.demProcess` by path);
  `deleteLayer(name)`, by name because deleting shifts every later index; and
  `removeOverviews` / `removeOverviewsSync`, the counterpart of building a
  pyramid — the same call with the "NONE" resampling GDAL reads as "delete them".
- `SpatialRef`: `fromEpsg` / `fromWkt` / `fromProj4` / `fromDefinition`, plus
  `wkt`, `prettyWkt`, `proj4`, `projJson`, `name`, `authName`, `authCode`,
  `authority`, `axisMapping`, `linearUnit`, `angularUnit`, `isGeographic`,
  `isProjected`, `isCompound`, `isVertical`, `areaOfUse`, `equals` and
  `withAxisMapping`. `dataset.spatialRef` and `layer.spatialRef` hand one back for
  something already open, and `createLayer` takes `wkt` as well as `epsg`.
- `CoordinateTransform` turns coordinates between two `SpatialRef`s:
  `transformPoint`, `transformPoints` (a flat `Float64Array` in and out),
  `transformGeometry` (GeoJSON in, GeoJSON out — GDAL walks the geometry, so
  polygons, rings and collections are handled and a straight line stops being
  straight where it should) and `transformBounds`, which densifies the edges
  because transforming four corners is wrong for any non-linear projection.
  `identifyEpsg(wkt)` resolves a CRS description to an authority code, on the
  thread pool because it searches the database.
- `vectorTranslate` takes `-overwrite`, which is ogr2ogr's flag rather than GDAL's:
  `GDALVectorTranslate` replaces an existing layer on its own, and `-append` asks
  for the other thing, so the wrapper implements the flag by dropping the
  destination *file* — every layer in it goes too, which is worth knowing before
  asking for it.
- Coordinates are **longitude,latitude** throughout. GDAL reads `EPSG:4326` the
  other way round, under which `[13.4, 52.5]` is a valid coordinate in the Gulf of
  Aden rather than Berlin — so every `SpatialRef` built here asks for the
  `traditional` order explicitly, `axisMapping` reports which is in force, and
  `withAxisMapping('authority')` opts into GDAL's reading.
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
- The async methods carry `ts_return_type` annotations, so the generated
  `binding.d.ts` names what they resolve to — `Promise<Dataset>`,
  `Promise<Buffer>`, `Promise<BandStatistics | null>` — instead of the
  `Promise<unknown>` napi produces when it cannot work out a `Task`'s `JsValue`. A
  test reads the generated file so the annotations cannot quietly disappear.
- Errors carry a stable `err.code` (`GDAL_CPL_FAILURE`, `GDAL_BAD_ARGUMENT`, …) on
  the sync surface. `napi::Task` fixes its error type, so async methods throw the
  same token at the front of the message instead.

### Build

- GDAL 3.12.1 and PROJ 9.6.x are compiled from source and linked statically, so an
  installed package needs no GDAL on the host. The PROJ and GDAL data files travel
  inside the package (~12 MB) and are wired up automatically by `index.js`.
- The driver set is `gdal-src/all_drivers`: **148 drivers** instead of 131.
  HDF5, netCDF, the curl-backed network drivers (WMS, WMTS, WCS, OGCAPI, PLMOSAIC,
  Carto, Elasticsearch, NGW, AmigoCloud), PostgreSQL/PostGIS and GRIB are in.
  Their libraries — HDF5, netCDF, curl, libpq — are compiled in statically, so an
  installed package still needs nothing on the host.
- What that costs: the `.node` grew from 28 MB to 35 MB and a tarball from 12.7 MB
  to 15.2 MB compressed, with a few minutes more build time and the C surface of
  four more libraries. Trim it by swapping `all_drivers` for individual
  `gdal-src/driver_*` features.
- GEOS stays out, so the OGR geometry predicates it implements (`ST_Intersects`,
  `ST_Buffer`, `-simplify`) are still unavailable — a licence decision, not an
  oversight. `PDS` is the one driver that cannot be built at all: gdal-src's
  published crate omits `frmts/pds/data`, so switching it on fails the configure
  step, which is why `all_drivers` leaves it out.
- Requires Ninja (`CMAKE_GENERATOR`) and a `sqlite3` CLI from outside MSYS2. MSYS2
  must stay off `PATH` or GDAL's configure aborts; see the README for why.
- CI builds six targets on native runners and attaches one self-contained tarball
  per platform to a GitHub Release. **Nothing is published to npm.**
- The two musl legs are marked experimental (`continue-on-error`), and they run
  their tests inside a `node:24-alpine` container rather than on the runner:
  napi's cross toolchain links musl dynamically, so the runner's glibc Node
  cannot load the addon at all. The container is also the honest place for it —
  the generated loader resolves to musl there, so the suite exercises the real
  artifact instead of a host build wearing a musl label.
- Every leg asserts its own platform label, and the release job refuses duplicate
  tarball names. The v0.1.0 release shipped four assets instead of six because the
  two musl legs were building for their host: `npm run build -- --target <triple>`
  appends its arguments to the end of the script string, and the script was
  `build.mjs … && stage-assets.mjs`, so the target went to the wrong process.
  Those three failures — the swallowed argument, the unchecked label, and the
  merged duplicates — now each fail loudly.
- `build.rs` reads the GDAL version that `gdal-sys` reports and switches
  `openThreadSafe` on only for GDAL ≥ 3.10, so linking an older system GDAL still
  compiles instead of failing on a missing type.

### Testing

- `scripts/bench-parallel.mjs` measures the thread-safe path against the serialised
  one: the same concurrent workload, on real data, with the numbers and their
  spread printed. It is a benchmark, not a test, and asserts nothing.

### Known gaps

- CRS handling stops at points and bounding boxes: geometries are not transformed,
  `CoordTransformOptions` (a specific pipeline, an accuracy target) is not exposed,
  and the transformation is synchronous, so a million points has to be chunked by
  the caller.
- Statistics and histograms can be read but not written back into a dataset.
- `buildOverviews({ bands })` is passed through, but GTiff — the only writable
  overview driver compiled in — refuses anything short of every band.
- The programs have no progress callbacks (GDAL's `*OptionsSetProgress` is not
  wired up).
- No terrain algorithms beyond the ones `gdaldem` itself offers.
- Reading a layer in batches is a cursor rather than a JS async iterator, and GDAL
  keeps the reading position on the layer, so one reader per layer at a time.
- Array-valued properties are written as comma-joined text rather than list fields,
  unless the field is declared as a list one — see `FieldDefinition`.
- Intel macOS and 32-bit targets are not built.
