# Changelog

## Unreleased

First working cut — everything here is new.

### Binding

- `RasterBand` gains the writers that go with its metadata getters:
  `setScale`, `setOffset`, `setUnitType`, `setDescription` and
  `setCategoryNames`. `GDALSetRasterScale` and `GDALSetRasterOffset` take a number
  and nothing else, so unlike `setNoDataValue(null)` there is no way to unset
  them — `0` is a value like any other, and the docs say so rather than pretending
  a null means "clear". The three that take a string do clear on `null`.
- `band.defaultHistogram(force?)` and `band.setDefaultHistogram(histogram)` close
  the histogram gap in the other direction: `histogram()` computes one, these
  read and write the *stored* one, so a later reader gets it without a pass over
  the pixels. Same caveat as `setStatistics`: a read-only handle does not fail,
  because GDAL's PAM layer writes a `<file>.aux.xml` sidecar instead.
- `gdal.apiVersion` — the binding's own version, distinct from the GDAL version
  `version()` reports, so a feature can be probed without parsing anything.
- `gdal.features()` — what this binding can do, as a fixed set of booleans
  (`geos`, `threadSafe`, `multidimensional`, `streams`) that are always present.
  `info()` answers what GDAL was *compiled* with, where an absent key is the
  answer; this is the same question asked about the binding, and is the one to
  branch on in application code.
- `gdal.const` freezes the string vocabularies this binding already reads and
  writes: `DataType`, `FieldType`, `Justification`, `GeometryType`,
  `ColorInterpretation`, `Resampling`, `OverviewResampling` and `SqlDialect`. So
  `fieldType: gdal.const.FieldType.Integer64` is the same request as the literal,
  and a misspelling is a caught typo rather than a runtime surprise. The values
  are *strings*, not GDAL's numeric enum codes — this surface returns and accepts
  names (`band.dataType === 'Float32'`), so a numeric constant would be a
  vocabulary it neither returns nor accepts; the codes belong to the
  compatibility layer. Two resampling vocabularies exist because GDAL has two: a
  pixel read (and a warp) takes `Resampling`, where nearest is
  `nearestneighbour`, while building overviews takes `OverviewResampling`, where
  it is `nearest` and `rms` / `average_magphase` / `none` exist. `none` is not a
  kernel — it is how a pyramid is deleted. A constant table needs nothing from
  GDAL, so it lives in `index.js` rather than crossing the FFI boundary, and
  `__test__/const.test.mjs` checks each value against the runtime so the two
  cannot drift.
- A failed `open` / `openSync` now carries GDAL's own explanation — "No such file
  or directory", "not recognized as being in a supported file format" — instead
  of the bare `GDALOpenEx: ` it used to be. The cause was a single missing flag:
  GDAL returns a null handle *in silence* unless the open asks for
  `GDAL_OF_VERBOSE_ERROR`, so its last-error store was empty by the time the
  `gdal` crate read it. Setting the flag is the whole fix; the message travels
  through the existing error path, and `lastError()` still answers `null` for it
  (a thrown failure has been read and reset, as documented).
- `Driver.createCopy` / `createCopySync` copies another dataset through this
  driver — GDAL's `CreateCopy`, the road to drivers (COG, JPEG) that implement it
  and not `Create`. It is `source.createCopySync(path, name, options)` with the
  driver already named, so it cannot be passed the wrong one, and the async form
  runs on the thread pool.
- `dataset.setProjection` takes a `SpatialRef` as well as a WKT string, so the
  object `dataset.spatialRef` hands back can go straight back in. An overload
  rather than a new `setSrs()`, as the stability rules call for.
- `layer.getFeature(fid)` returns a feature as an **object** rather than the
  copied-out record `feature(fid)` hands back: `fid`, `geometry` (GeoJSON,
  replaceable with `setGeometry`), `defn`, `toObject()`, and a `fields` object with
  `get` / `has` / `set` / `names` / `count` / `toObject` / `toArray`. Every read
  and write goes *through the layer* — `fields.set` writes immediately, the same
  write `updateFeature` makes — so there is no cached copy to keep in sync and no
  `save()` to forget. An id that is not there is `null`.
- `Geometry` — an OGR geometry as an object, the other half of the GeoJSON plain
  objects this binding has always exchanged. `Geometry.fromWkt` / `fromWkb` /
  `fromJson` build one, and `toWkt()` / `toWkb()` / `toJson()` (`toObject()`) take
  it back out — `toJson()` produces exactly what a feature's `geometry` carries,
  so the two worlds meet in one call. Reads that need no GEOS: `type`, `isEmpty`,
  `pointCount`, `area()`, `length()`, `envelope()`. Transforms that **return a new
  geometry** rather than mutating this one: `flattenTo2D()`,
  `segmentize(maxLength)`, `swapXY()`, `transform(from, to)`. `clone()` exists only
  for a second independent handle. `transform` names both CRSes because a bare OGR
  geometry carries none of its own.
- `Geometry` gains the shape-specific accessors — `x` / `y` / `z` (a `Point`, `z`
  only when the coordinates carry one), `points()` (a `Point` or `LineString`),
  `rings()` / `exteriorRing` / `interiorRings` (a `Polygon`) and `children()` (a
  `Multi*` or `GeometryCollection`, each part copied out so it stands on its own).
  Each answers for its own shape and is `null` for the others, so any of them can
  be read without checking `type` first; `coordinates` is the GeoJSON nesting, and
  `null` for a collection, whose parts are geometries rather than coordinates.
  There is deliberately **no** `Point` / `Polygon` / … subclass family: napi-rs
  cannot express inheritance, and the generated `binding.d.ts` owns the factories'
  return types, so subclass accessors could not be typed — the `gdal-async` class
  shape belongs to the compatibility layer. See `PHASE1.md`.
- The GEOS-backed operations are on `Geometry` too: the predicates `intersects`,
  `contains`, `within`, `crosses`, `touches`, `overlaps`, `disjoint` and `equals`;
  `distance`; `isValid` and `isSimple`; and the set algebra `buffer`, `centroid`,
  `convexHull`, `simplify`, `union`, `intersection`, `difference` and
  `symDifference`, the last four returning a new `Geometry`. GDAL implements them
  through GEOS, so a build without it keeps the **same surface** and answers each
  with "this build has no GEOS" rather than a `false` that looks like an answer —
  `gdal.features().geos` is the probe. GEOS is now built from source and linked
  statically, the way GDAL and PROJ are, so the shipped package has it and stays a
  single self-contained artifact; see `docs/GEOS.md` for why static rather than a
  shared library, and for the LGPL-2.1 §6 material a release owes.
- `THIRD-PARTY.md` lists what is compiled into the package and under which
  licences, and spells out the one that is not permissive: GEOS is LGPL-2.1 and
  statically linked, so §6 applies. A release meets it with `npm run lgpl`, which
  gathers the exact GEOS source the build compiled, the static archives it
  produced and a `RELINK.md`, into a per-platform tarball beside the package one.
  That step is wired into CI; the file ships inside the package so a consumer sees
  it without going looking.
- Every writer that takes a geometry now takes a `Geometry` **or** the GeoJSON
  plain object: `createFeature`, `updateFeature`, `setSpatialFilter`,
  `Feature.setGeometry`, `rasterize` (a mixed list is fine) and
  `CoordinateTransform.transformGeometry`. An overload, not a second name — the
  GeoJSON form is unchanged and still what `featuresSync()` returns. The object
  form is resolved before any lock is taken, since its `toJson()` takes that lock
  itself. (napi's `Either` cannot pair with a `serde_json::Value`, so the JSON arm
  arrives as `Unknown` and is cast back — which is why the parameter is a union
  rather than the `Value` it used to be.)
- A refused feature write is now an error. GDAL's `OGR_L_CreateFeature` /
  `OGR_L_SetFeature` return a status, but the `gdal` crate's `Feature::create` and
  `Layer::set_feature` discard it and return `Ok(())` — so writing to a read-only
  datasource *reported success* while GDAL's warning went to stderr and nothing was
  written. `createFeature` and `updateFeature` now make those two calls directly and
  keep the status, relaying GDAL's own explanation ("unsupported operation on a
  read-only datasource"), the way `deleteFeature` already did.
- `gdal-rs-napi/compat` — the `gdal-async`-shaped adapter, so a port is an import
  change rather than a rewrite. Pure JavaScript over the same native binding: it
  adds no capability, and the native API keeps its own conventions. It translates
  the three that are load-bearing — **1-based** indexing for bands, layers and
  fields; `xxx()` blocking with `xxxAsync()` (or a node-style callback) beside it;
  and assignment for setters (`band.noDataValue = x`, `dataset.geoTransform =
  [...]`, `dataset.srs = srs`) — and provides the object shapes a port expects:
  `Driver` and the driver / layer / band collections, `Feature` with
  `fields.toObject()` / `toArray()` and an assignable `geometry`,
  `SpatialReference`, and the `Point` / `LineString` / `Polygon` / `Multi*` /
  `GeometryCollection` class family with `toWKT()` / `toJSON()` and the `get*`
  spellings. The family lands *here* because this layer's types are hand-written —
  exactly what a prototype-swapped subclass needs and what the generated
  declarations cannot give it. Streams, MDArray, `calcAsync` and pixel functions
  are not covered; see `PHASE1.md` (WS-7).
- `layer.defn` groups a layer's schema into one object: `name`, `geometryType`,
  `geometryColumn`, `fidColumn`, `fieldCount` and `fields`. `Feature.defn` returns
  the same object, so the two cannot describe one layer differently. `FieldInfo`
  already carries a field's whole definition, so it *is* the `FieldDefn`; a
  separate wrapper would only rename it.
- `docs/API-STABILITY.md` writes down the rules the surface was already following
  — naming (`xxxSync()` / `xxx()`), 0-based indexing with `band.id` as the single
  exception, `null` rather than `undefined`, `err.code` on the sync surface and
  its prefix on the async one, additive-only growth, and the deprecation window.
- `Driver` — a registered GDAL/OGR driver as an object rather than a name. Get one
  from `gdal.driver(name)` (or `null` when this build has no such driver),
  `gdal.drivers()`, or `dataset.driver`. `name`, `longName`, `description`;
  `testCapability('DCAP_...')`; `metadata(domain)`; `fileExtensions()`;
  `creationOptionList()` / `openOptionList()` (the XML `gdalinfo --format`
  prints); `delete(path)`; and `open` / `openSync`, `create` / `createSync` with
  the driver already named so it cannot be passed the wrong one. Only the short
  name is stored — a `GDALDriverH` is a process-wide singleton, so the object
  re-looks it up and cannot dangle.
- **`dataset.driver` is now a `Driver` object, not a string.** `dataset.driver.name`
  is the short name it used to return, and `String(dataset.driver)` /
  `` `${dataset.driver}` `` keep reading the same way. The rest of the object —
  `longName`, `testCapability`, the metadata — is what a string could never carry.
- `gdal.drivers()` hands back those objects too, sorted by short name. The array
  is otherwise unchanged, so `gdal.drivers().map((d) => d.name)` still works;
  `gdal.driver(name)` is the lookup that does not walk it.
- `open` / `openSync` take a `drivers` option — a whitelist, so a file another
  driver would have claimed fails instead of quietly loading as something else.
  `Driver.open` / `Driver.openSync` are the same restriction with the driver
  already named.
- `Dataset` gains `description` (for a file, the file name), `rasterSize` (the
  `{ width, height }` pair that `width` / `height` already report separately), and
  `getFileList()` — the counterpart of `gdalinfo`'s `Files:`, and the answer to
  "what has to ship alongside this?". A `MEM` dataset reports no files; a
  `/vsimem/` one reports its `/vsimem/` name, which is real.
- A layer's schema can be changed, not only declared up front:
  `layer.field(name)` looks one up or answers `null`, `layer.addField(definition)`
  grows the schema, `layer.deleteField(name)` drops a column by name (by name, not
  index, because dropping shifts the rest), and `layer.reorderFields(names)` is a
  permutation that has to name every field exactly once. `FieldDefinition` is the
  same shape `createLayer` takes, so both paths build one field definition through
  one builder and cannot drift; the driver decides what it can do, and
  `testCapability('CreateField')` is the question to ask first. GPKG, being SQLite,
  refuses to drop a column a `UNIQUE` index depends on — and that reason is passed
  through rather than swallowed.
- `FieldInfo` reports the whole definition, not just name and type: `nullable`,
  `unique`, `defaultValue` (as text, GDAL's own representation, `null` when there
  is none) and `justification` (`Undefined` / `Left` / `Right`). `FieldDefinition`
  accepts the same four on the way in.
- `layer.features()` is `featuresSync()` on the thread pool — the same read by the
  same body, so the two cannot disagree; the difference is that a large layer does
  not hold the event loop while it materialises. `openCursor` is still the one that
  streams.
- `layer.setSpatialFilter(geometry)` restricts a layer to features intersecting an
  arbitrary GeoJSON geometry, where `setSpatialFilterRect` is the bounding-box
  form; `null` clears it, as `clearSpatialFilter()` does.
- Module functions: `version`, `info`, `drivers`, `diagnostics`,
  `configureDataPaths`, `lastError`, `epsgToWkt`, `bytesPerSample`,
  `openThreadSafe` / `openThreadSafeSync`, `geometryTypeOf`, `geometryToWkt`,
  `geometryToWkb`, `geometryFromWkt`, `geometryFromWkb`, and the `config`
  namespace's `get` / `set`.
- `gdal.config.get(key, defaultValue?)` / `gdal.config.set(key, value)` read and
  write GDAL's own configuration store — `GDAL_NUM_THREADS`, the curl drivers'
  `CPL_CURL_*`, anything a tool would take as `--config`. `get` answers `null` for
  an option nobody set (or the default you pass), which is why it goes through the
  C function rather than a wrapper that folds "unset" into a value; `set(key,
  null)` clears one. The option is process-wide and overrides the environment GDAL
  was started with.
- `gdal.info()` reports what the static build actually is: `releaseName`,
  `releaseDate`, `versionNum`, GDAL's `BUILD_INFO` map and the registered driver
  count. It answers capability questions the way GDAL does — a feature that was
  compiled out is a *missing key*, not a "NO". `diagnostics()` and `features()`
  are the places with the yes/no answers.
- `gdal.lastError()` returns GDAL's most recent error (`class`, `number`, `message`)
  or `null`. It is for the errors that never became an exception — a warning GDAL
  logged and carried on past. A failure that *is* thrown has already been read and
  reset by the `gdal` crate by the time JS sees it, so this is `null` for those;
  the thrown error's `code` and message are their record.
- `diagnostics()` gains `geosAvailable` — whether GDAL was built with GEOS, and so
  whether the OGR predicates it implements (`ST_Intersects`, `ST_Buffer`,
  `-simplify`) are available. The same answer as `features().geos`.
- `RasterBand` gains GDAL's band metadata: `id` (GDAL's 1-based band number, where
  `index` is this API's 0-based one), `description`, `readOnly`, `scale`, `offset`,
  `unitType`, `minimum`, `maximum` and `categoryNames`, plus `fill(value)` to write
  one value over the whole band. `minimum` / `maximum` are GDAL's *cache* — `null`
  until `statistics()` computes them, or the format stored them — and `readOnly`
  follows how the dataset was opened, since a band has no access mode of its own.
  Reading `scale` / `offset` is what keeps a DEM or reflectance raster from being
  treated as its raw integers.
- `RasterBand` gains three of GDAL's raster algorithms, the ones that are neither
  I/O nor a program: `checksum()` / `checksumSync()` — the 16-bit fingerprint
  `gdalinfo` prints, with `resampling` / `outWidth` / `outHeight` refused rather
  than quietly resampled into; `fillNoData()` / `fillNoDataSync()` —
  `GDALFillNodata`, in place, and it says so when the band has no no-data value to
  fill from; and `sieveFilter()` / `sieveFilterSync()` — `GDALSieveFilter`, in
  place, with a threshold in pixels and 4- or 8-connectedness. Each async form runs
  on the thread pool, like the readers and statistics do.
- `Dataset.rasterize()` / `rasterizeSync()` burns GeoJSON geometry into the
  dataset's bands — `GDALRasterizeGeometries`, the algorithm behind
  `gdal_rasterize`. `burnValues` is one value per geometry, positionally; `bands`
  picks them by **0-based** index (default: the first); every other entry in
  `options` is GDAL's own and is passed through as written (`ALL_TOUCHED`,
  `MERGE_ALG`, `INIT_DEST`, ...). It does not reproject, so the geometry has to be
  in the raster's coordinate system already — `warp` is the tool that moves things.
- `RasterBand.polygonize()` / `polygonizeSync()` writes this band's values out as
  polygons in an OGR layer — `GDALPolygonize`, or `GDALFPolygonize` for a float
  band, which is the pair `gdal_polygonize.py` chooses between. The values land in
  a field named by `fieldName` (default `DN`), created with `Real` for a float band
  and `Integer` otherwise when the layer does not have it; `connectedness` is 4 or
  8. The layer is usually in a *different* dataset from the band, and both are
  reached under one lock — a `with_two` helper that exists because the process-wide
  GDAL lock is not reentrant, so two datasets cannot be opened through two
  `with_exclusive` calls.
- `RasterBand.contourGenerate()` / `contourGenerateSync()` draws contour lines into
  a layer — `GDALContourGenerateEx`, the call behind `gdal_contour`. Give `levels`
  or an `interval` (with an optional `base`), not both; the elevations land in
  `elevField` (default `ELEV`) and `idField` names a field for a per-line id when one
  is wanted, both created when the layer does not have them. One detail worth
  recording because it is not guessable: `ELEV_FIELD` and `ID_FIELD` are field
  *indexes* rather than names — GDAL parses them with `atoi`, and `gdal_contour`
  passes an index too — so the names are resolved against the layer here and the
  indexes are what GDAL sees.
- `Dataset.suggestedWarpOutput()` / `suggestedWarpOutputSync()` answers what
  `gdalwarp` would make of a dataset — `geoTransform`, `width`, `height` and
  `extent` — without doing the warp. `dstWkt` names the CRS to warp to; with none it
  reports the grid the dataset already has. It is how a destination gets sized for
  `reprojectImage()`, which is `GDALReprojectImage` on two datasets that are already
  open: `srcWkt`/`dstWkt` supply or override the two CRSes, and `resampling` takes
  the readers' names except `gauss`, which is a `RasterIO` kernel and not one
  `GDALReprojectImage` has.
- `gdal.buildVrt()` / `buildVrtSync()` is `gdalbuildvrt`: one source wraps a raster
  as a VRT, several merge, and the tool's own arguments are passed through as
  written. An empty destination builds it in memory, as `translate` does. Worth
  knowing: `GDALBuildVRT` skips inputs that carry no georeferencing at all, and with
  nothing left to reference it fails — which is what a raw test raster looks like.
- `cpl_result` — the error path behind every raw `GDAL*` call in `raster_tools` —
  now resets GDAL's error state after reading it, the way the `gdal` crate does. That
  keeps the promise `lastError` documents: a failure that became an exception is gone
  from there, and what remains is the errors that never did.
- Band pixel accessors, for when a window in an options object is more ceremony than
  the question deserves: `getPixel(x, y)` / `setPixel(x, y, value)` for one sample,
  `readValues(x, y, width, height)` / `writeValues(x, y, width, height, data)` for a
  window, and `readBlock(x, y)` / `writeBlock(x, y, data)` for GDAL's own unit of I/O.
  The window is checked against the band before GDAL sees it, so a read off the edge is
  an error naming the window rather than a quiet zero. A block is that block's
  rectangle *clipped to the band*: GDAL's own block read pads the right and bottom
  edges with whatever it likes, and a value that was never in the file is not worth
  handing to JS.
- `readValues` and `readBlock` return bytes rather than the typed array they were meant
  to. napi's typed arrays in its prelude are owned and have no constructor from Rust
  data, while the ones that do have `from_data(&env, values)` borrow the environment —
  which does not survive this binding's generated return types — and `BigInt64Array` is
  not in the prelude at all. So the view stays where this binding has always put it, one
  line on the JS side: `new Float32Array(bytes.buffer, bytes.byteOffset,
  bytes.byteLength / 4)`.
- `band.overviews` lists the pyramids a band already has: one entry per level, each
  with `index` (0-based), `size`, `dataType`, and `readSync()` / `read()` for the whole
  level in its own sample type. This is the query GDAL offers and the binding did not:
  `readPixels({ outWidth, outHeight })` makes GDAL *pick* a level and resample through
  it, while a level read this way is the decimation that was actually stored. The
  getter asks GDAL every time, so a level built after the band object was created shows
  up. Levels are read with raw `GDALRasterIO`: the `gdal` crate's readers start from a
  dataset and a band number, and an overview hangs off a band with no number of its own.
- Transactions on a layer: `startTransaction()`, `commitTransaction()` and
  `rollbackTransaction()`, so a group of writes can be one unit instead of one write at
  a time. Whether the driver has them is `testCapability('Transactions')` — a driver
  without support warns and carries on as if there were no transaction, which is worth
  knowing before relying on the grouping. They go through `with_mut`, so a read-only
  dataset refuses them like any other write, and a failure carries the OGR status in
  its message (there is no `CPLErr` behind that call for a code to name). One thing the
  tests turned up: GPKG creates its table lazily, on the first write — so a table whose
  `CREATE TABLE` happens *inside* a transaction is rolled back with the features, and
  every write after that fails with `no such table`. Write once outside the transaction
  first.
- `layer.fidColumn`, `layer.geomColumn` and `layer.testCapability(name)` — what GDAL
  says about where a layer keeps its feature ids and its geometry, and what the driver
  can actually do. The capability names are GDAL's own (`FastFeatureCount`,
  `RandomRead`, `SequentialWrite`, `DeleteFeature`, `Transactions`, `CreateField`, ...),
  and a name it does not know answers `false` rather than throwing: the call is a
  question, and "no" is one of its answers. A layer with no FID column, or none with
  geometry, reports an empty string; those become `null` here, as elsewhere.
- `band.readChunksSync(options, onChunk)` walks a band in horizontal strips, handing
  each one to a callback and reading the next only once that call has come back. The
  answer is the backpressure: `false` ends the walk, which is the contract `onProgress`
  already has, and the return value says how many strips were handed out. `rows`
  defaults to the band's block height — the strip GDAL reads anyway — so a raster
  larger than memory can be processed a strip at a time, each strip whole. It is
  synchronous on purpose: the alternative was napi's `AsyncGenerator`, the only way to
  give a class a real `Symbol.asyncIterator`, and it cannot be reached from here — the
  trait lives in the private `bindgen_runtime` module, its prelude re-export does not
  exist in napi 3.13, and turning on the `experimental` feature changes neither. For a
  long walk, run it in a worker.
- `open()` / `openSync()` take a `Buffer` as well as a path, which is where the
  in-memory pipeline starts. The bytes go to a `/vsimem/` file, that file becomes the
  dataset's `path`, and closing the dataset unlinks it — so bytes written to in place
  come back out with `gdal.fs.readFile(dataset.path)`, after `flushSync()`, since GDAL
  holds dirty blocks exactly as it does for a file on disk. Bytes have no filename, so
  GDAL sniffs the content: GTiff, PNG, JPEG, VRT, GeoJSON and GPKG identify themselves,
  and a format a driver only knows by its extension does not.
- `gdal.fs` — GDAL's virtual file system: `readFile`, `writeFile`, `exists`, `stat`,
  `mkdir`, `rmdir`, `unlink`, `readDir`. These are the `VSI*` functions, so the same
  call takes `/vsimem/`, `/vsizip/`, `/vsicurl/` or a plain path. They are synchronous
  deliberately: each one is a memory copy or a local syscall, and a `/vsicurl/` read is
  the exception — `open(url)` is the version of that which runs on the pool. A missing
  file answers `false` / `null` rather than throwing, while a call that was asked to
  change something throws. `readDir` drops the `.` and `..` GDAL reports for a real
  directory, and `/vsimem/` has no directories underneath at all: a name there is
  opaque, so writing into a "directory" that was never created works.
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
- `gdal.translate`, `gdal.warp`, `gdal.vectorTranslate` and `gdal.demProcess` take
  an `onProgress` callback: it runs on the JS thread while the work happens on a
  worker, and is handed `{ complete, message }`. Returning `false` cancels, which is
  reported as `GDAL_CANCELLED` — in the message on the async surface, where
  `napi::Task` pins the error type. A callback that returns nothing keeps going, so
  one that only logs cannot stop the job by accident. A callback must not call back
  into this library: the worker holds the process-wide GDAL lock while it waits for
  the answer, so that deadlocks. Every async entry point takes it — the four
  module-level functions and the four methods on an open dataset. The `Sync` forms
  cannot: a sync call holds the JS thread the callback would have to run on.
- `RasterBand::setStatistics` writes min/max/mean/stdDev back, so a later reader
  gets them from `statistics({ force: false })` instead of computing them. An
  update-mode dataset stores them in the file; a read-only one gets a
  `<file>.aux.xml` sidecar, because that is what GDAL's PAM layer does.
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
- The two musl legs are marked experimental (`continue-on-error`). They build —
  and test — inside a musl-native Alpine container (`docker/musl.Dockerfile`) on a
  runner of their own architecture, so the container's own toolchain already
  targets the musl triple cargo is asked for: an ordinary native build, with no
  cross toolchain, no sysroot and no emulation. The suite has to run in there
  because napi links musl dynamically, so the runner's glibc Node cannot load the
  addon at all — one process, two libcs.
- Getting there took three attempts, and the container is the first that holds.
  The vendored C libraries `all_drivers` pulls in (HDF5, netCDF, curl, libpq) never
  configured under napi's zig-based `--cross-compile`; napi's cross-rs
  `--use-cross` resolves its toolchain to an x86_64 host triple whatever machine it
  is on (cross-rs #1649), so on an arm64 runner it died two seconds in; and cross's
  images ship `make` but not `ninja`, which `.cargo/config.toml` pins for MSVC. A
  container we control has all of it, and being musl-native removes the crossover
  entirely.
- That container also builds OpenSSL from source, linked statically
  (curl-sys's `static-ssl`), because under musl there is no system OpenSSL to link
  — while the four native legs go on using theirs.
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
- Histograms can be read and written (`histogram()`, `defaultHistogram()`,
  `setDefaultHistogram()`), so the pair now matches `statistics()` /
  `setStatistics()`.
- `buildOverviews({ bands })` is passed through, but GTiff — the only writable
  overview driver compiled in — refuses anything short of every band.
- No terrain algorithms beyond the ones `gdaldem` itself offers.
- Reading a layer in batches is a cursor rather than a JS async iterator, and GDAL
  keeps the reading position on the layer, so one reader per layer at a time.
- Array-valued properties are written as comma-joined text rather than list fields,
  unless the field is declared as a list one — see `FieldDefinition`.
- Intel macOS and 32-bit targets are not built.
