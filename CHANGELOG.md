# Changelog

## Unreleased

First working cut — everything here is new.

### Binding

- **The `compat` layer's per-class surface now matches what a port reaches for.**
  The gaps the union-based coverage count could not see are closed, class by class:
  `RasterBand` carries the band algebra (`add`…`ifThenElse`, `asType`) and the whole
  set of `xxxAsync` getters, plus `ds` and `setStatistics`; `Dataset` gains `getGCPs` /
  `setGCPs`, `rasterSizeAsync` and `geoTransformAsync`; `DatasetBands` gains
  `create` / `createAsync` (the new native `Dataset.createBand`, GDAL's `GDALAddBand`),
  `getEnvelope` and `ds`; every collection answers `countAsync` / `getAsync` and the
  async iterator; the pixel view gains `band`, `getAsync`, `setAsync` and
  `clampBlock` / `clampBlockAsync`; `Geometry` gains the async predicate twins
  (`intersectsAsync` and the rest), `wkbSize`, `coordinateDimension`, `dimension`,
  `fromGeoJson` / `fromGeoJsonBuffer` (+Async), the static `create` / `getName`, and
  `transform(CoordinateTransformation)`; `Feature` gains `equals` / `clone` /
  `destroy` / `setFrom`; `FeatureFields` gains `feature`, `indexOf`, `map`, `toJSON`
  and `reset`; `LayerFeatures` gains `previous` / `last` / `firstAsync` / `nextAsync` /
  `map`; `FieldCollection` gains the static `fromJSON` / `fromObject`; `FeatureDefn`
  gains `clone` and the `featureDefn` back-link; `ColorTable` gains `forEach` / `map`
  and `band`; `SpatialReference` gains the reference's capitalised
  `EPSGTreatsAsLatLong` / `EPSGTreatsAsNorthingEasting`; and the module gains
  `setPROJSearchPaths()`. `transformTo` refuses with an explanation rather than
  guessing: a geometry here carries no source CRS.
  `ts-test/compat-reachability.spec.ts` pins the whole list per class.
- `Dataset.createBand(dataType, options?)` is the native `GDALAddBand`: add a band to
  an existing dataset, returning the new `RasterBand`. It is what
  `dataset.bands.create()` is made of.
- `SpatialRef.epsgTreatsAsNorthingEasting` answers the authority's projected
  north/east order — `OSREPSGTreatsAsNorthingEasting`, the counterpart of the
  existing `epsgTreatsAsLatLong`.
- **The geometry model is mutable now.** `Geometry` gains the write side it never
  had — `addPoint(x, y, z?)`, `setPoint(index, x, y, z?)`, `resizePoints(count)`,
  `addGeometry(other)`, `removeGeometry(index)`, `closeRings()`,
  `addSubLineString(line, start?, end?)` and `empty()`, plus a typed factory
  `Geometry.create(typeName)` for a shape WKT cannot spell (`create('LinearRing')` —
  there is no `LINEARRING` literal, and `Polygon.rings.add` needs a real
  `wkbLinearRing`). They change the geometry in place; the value operations and their
  semantics are untouched. `addSubLineString` is built on `OGR_G_AddPoint` because
  `gdal_sys` does not bind `OGR_G_AddSubLineString`, and `empty()` replaces the value
  with a fresh empty geometry of the same type because `OGR_G_empty` is not bound.
- **The reference's classes are constructible and its collections are editable.**
  `new gdal.Point(1, 2)`, `new gdal.LineString()`, `new gdal.CircularString()`,
  `new gdal.CompoundCurve()`, `new gdal.Polygon()`, `new gdal.MultiPolygon()` and the
  rest build a native empty (or single-point) geometry and hand back a re-tagged
  object. `points`, `rings`, `children` and `curves` are then the reference's
  collections — `add` / `get` / `count` / `set` / `resize` / `reverse` / `remove` /
  `forEach` / `map` / `toArray` and an iterator, live over the geometry. Each is a
  **callable collection**, so `line.points()` (this binding's spelling) still answers
  the array while `line.points.add(1, 2)` (the reference's) edits it;
  `instanceof gdal.LineStringPoints` / `PolygonRings` /
  `GeometryCollectionChildren` / `CompoundCurveCurves` is answered by a brand, so the
  callable and the class both work. `CompoundCurve` joins the collection kind, so its
  `curves` read its parts. GDAL still enforces what each parent accepts — a
  non-contiguous curve is refused with its `contiguous` message.
- Both remaining member-level names are in: `SpatialReference.fromXML` (over
  `OSRImportFromXML`, which `gdal` does not wrap) and `fs.statAsync` /
  `fs.readDirAsync` (the one namespace that has to be wrapped rather than
  re-exported, since the reference's `async` pair has nowhere to live on this
  binding's synchronous `fs`). `Feature.getStyleString` / `setStyleString` round out
  the vector surface. `scripts/compat-coverage.mjs` now reports **194 members
  answered, 6 missing**, and none of the 6 is a capability: `t00z`, `f000` and `WY`
  are fixture strings the extractor reads as member accesses (`gfs.t00z.…`,
  `US.WY.PARK`), `throw` is chai's `assert.throw`, `isVectical` is a typo in the
  reference's own test for `isVertical`, and `gdal.algebra.mulAsync` is a
  sub-namespace the extractor deliberately skips.

- **`compat` answers every `gdal.*` name the reference's own tests use.** The
  measurement that drove the earlier rounds — `scripts/compat-coverage.mjs` reading
  `gdal-async`'s ~60 TypeScript test files — now reports **136 answered, 0 missing**
  (was 64 answered, 72 missing). The last families, all supplied by the adapter's own
  table because GDAL spells them as C macros that never reach `gdal-sys`: the layer
  capabilities (`OLCRandomRead`, `OLCCreateField`, …), the datasource and driver ones
  (`ODsCCreateLayer`, `ODrCCreateDataSource`, `DCAP_CREATE`, …), the multidimensional
  dimension types and directions (`DIM_TEMPORAL`, `DIR_NORTH`, …), the CPL error
  numbers (`CPLE_AppDefined`, …), the extended-data-type strings (`GEDTC_String`), and
  `wkb25DBit` with the whole `wkb*25D` family. They are the *strings* `testCapability`
  already accepts, or GDAL's ABI numbers, and `src/constants.rs` keeps to its rule:
  it reads out of the linked headers what it can, and the adapter fills the macros.
- **The curve geometries report their own names now.** `CircularString`,
  `CompoundCurve`, `CurvePolygon`, `MultiCurve`, `MultiSurface`, `Curve`, `Surface`,
  `PolyhedralSurface`, `TIN` and `Triangle` were read back as `Unknown` by
  `Geometry.type` (and by a layer's `geometryType`), and `createLayer` refused to
  *declare* one — `geometry_type_name` / `geometry_type_from_name` now cover them, and
  the round trip is a Rust test. `compat` re-tags those types onto the reference's
  classes (`SimpleCurve` as the base of the line-like shapes, `CircularString`,
  `CompoundCurve`, `MultiCurve`), and adds the reference's `Geometry.getConstructor`
  and class- and instance-level `wkbType`. What stays out of reach is the reference's
  **mutable builder** (`points.add`, `curves.add`, `closeRings`, `addSubLineString`) —
  a geometry is a value here — and `docs/PARITY.md` records that rather than faking it.
- **`compat` grows `ColorTable`.** A band's palette is now the reference's object —
  `count` / `get` / `set` / `interpretation` / `clone` / `isSame` / `ramp` and an
  iterator — over this binding's `band.colorTable` array and `setColorTable`. A table
  read from a band is read-only (a write goes back through the band); one built with
  `new gdal.ColorTable(...)` is writable. Clearing it takes `band.colorTable = null`,
  which is a new native `RasterBand.clearColorTable()`: `setColorTable([])` writes an
  *empty* table, not no table, and GDAL keeps answering the former.
- **`compat` names the raster streams and runs the two algorithm wrappers.** The
  streams `band.createReadStream()` / `createWriteStream()` build are now named
  classes (`gdal.RasterReadStream` / `RasterWriteStream`), so the reference's
  `instanceof` holds; `gdal.contourGenerate(...)` and `gdal.polygonize(...)` take the
  reference's object form, resolving its **field indexes** to this binding's names.
- **`Dataset.testCapability(name)`** answers GDAL's datasource and driver capability
  questions (`CreateLayer`, `DeleteLayer`, `CreateDataSource`, …), the dataset-side
  counterpart of `Layer.testCapability`. An unknown name is `false`, not a throw.
- **`compat` fills in the reference's `…Async` twins** for the geometry operations,
  band and dataset metadata, and the feature and field collections, plus the
  `FeatureDefnFields`, `Dimensions` and `GeometryCollectionChildren` class aliases.
  They are shape, not concurrency — the native call still runs on the JS thread, as
  the rest of the adapter's `xxxAsync` pairs do.

- **`compat` grew the names `gdal-async`'s own test suite reaches for**, and the list is
  derived rather than guessed: `scripts/compat-coverage.mjs` reads the reference's ~60
  TypeScript test files and reports every `gdal.<name>` they use that the adapter does
  not answer. The largest item it found was not a name but a *usage* —
  `assert.instanceOf(dataset, gdal.Dataset)` appears 262 times, and an object that is an
  instance of nothing *named* fails every one of them — so the classes `compat` was
  already building objects from are now exported under the reference's names
  (`Dataset`, `RasterBand`, `Layer`, `Feature`, `FeatureFields`, `LayerFeatures`,
  `LayerFields`, `DatasetBands`, `DatasetLayers`, `RasterBandPixels`,
  `RasterBandOverviews`, `GDALDrivers`, `Driver`), beside the re-exports whose shape was
  never in doubt (`config`, `fs`, `info` / `infoAsync`, `toDataType` / `fromDataType`,
  the pixel functions, `calcAsync`, `RasterMuxStream` / `RasterTransform`, and
  `eventLoopWarning` in both directions).
  `CoordinateTransformation` is the one that is new rather than renamed, and its shapes
  were read off the reference's tests rather than assumed: `transformPoint` takes either
  an `{ x, y }` object or `x, y, z` arguments and answers `{ x, y, z }`, and
  `transformGeometry` answers a geometry object where the call it wraps answers GeoJSON.
  Module-level coverage of that suite: **35 → 64 names**, with the remaining 72
  categorized in `docs/PARITY.md` (numeric constant tables, `vsimem`, the programs as
  module functions, and the classes this binding does not have — curves included).
- **A dataset operation no longer holds up every other dataset.** The process-wide
  `RwLock` now takes its *write* side for **process-global state only** — driver
  registration and `configureDataPaths`, `config`, writes through `gdal.fs`, the
  programs (`translate` / `warp` / `ogr2ogr` / `gdaldem` / `buildVrt`), and
  `create` / `createCopy` — while an open and every operation on an open dataset take
  the *read* side. What keeps one dataset safe is then that **handle's own mutex**,
  which is exactly the pair GDAL's contract names: the same handle reached from two
  threads serialises, two different handles do not wait for each other.
  `openThreadSafe()` goes one step further and skips the handle mutex as well, so one
  handle can be read by several threads at once.
  Measured on the 2048×2048 DEFLATE GTiff the benchmark generates: the same four
  whole-band reads cost 7.5 ms on one handle and 4.4 ms split across two (1.70x) —
  while before this they were the *same number by construction*, because every dataset
  operation held the write side from the first byte to the last.
  `scripts/bench-parallel.mjs` measures that case now and gates it (a 1.10x floor,
  beside the dataset-free one), because the ratio cannot rise above 1.00x again unless
  a dataset operation goes back onto the write side.
  One rule comes with it, and it is the rule the thread-safe path already lived by:
  **a closure that holds the read side must not take the write side**, directly or
  transitively — `RwLock` is not reentrant. The dataset closures call nothing that
  writes; the lock's own documentation in `src/runtime.rs` now says so where the
  opposite used to be true.
- `gdal.infoAsync()` — `gdal.info()` on the thread pool. Nothing in it is slow; the
  point is the **wait**: `info()` takes the shared side of the lock, the shared side
  still waits for a dataset holding the exclusive one, and that wait was in the event
  loop. Same reason the asynchronous getters exist.
- Every container answers **both spellings**. This binding spells one as a call that
  returns an array — `dataset.bands()`, `layer.features()` — and gdal-async spells it as
  an object with `get` / `count` / `getNames` and iterators. Both are the same thing now:
  the call is untouched, and the collection surface hangs off the callable itself, so
  `dataset.bands()` and `dataset.bands.get(1)` work side by side and
  `for (const band of dataset.bands)` iterates — nothing that worked before changed.
  All of them: `gdal.drivers`, `dataset.bands`, `dataset.layers`, `layer.fields`,
  `layer.features` (with `count()` and `get(fid)`), `band.overviews` (with
  `getBySampleCount`), the multidimensional model's `group.arrays` / `group.groups` /
  `group.attributes` / `group.dimensions` and `mdarray.attributes` / `mdarray.dimensions`
  — and a new `band.pixels`, the reference's object of pixel reads and writes under its
  own names.
  Two things worth knowing. An index is **1-based** in a collection, as the reference
  counts, except `gdal.drivers.get(n)`, which is 0-based there and stays so. And a
  member the *generated* declarations already own (`dataset.bands`, `layer.features`,
  `band.overviews`) keeps their type — a class member's type cannot be widened from the
  hand-written half — so `dataset.bands.get(1)` is a runtime shape a TypeScript caller
  has to spell out, while the members that are new out of this (`band.pixels`,
  `group.arrays`, `group.groups`) are declared properly.
- The geometry **class family** is here: `gdal.Point` / `LineString` / `LinearRing` /
  `Polygon` / `MultiPoint` / `MultiLineString` / `MultiPolygon` / `GeometryCollection`,
  and `geometry instanceof gdal.Point` answers. napi cannot express inheritance and the
  generated declarations own what the factories return, so the shell re-tags what comes
  out of them — `Geometry.fromWkt` / `fromWkb` / `fromJson`, the operations that build a
  new geometry (`buffer`, `intersection`, `clone`, `simplify`, `children` and the rest),
  and `layer.getSpatialFilter()`. The three factories could not be wrapped in place
  (napi registers statics non-writable *and* non-configurable), so `gdal.Geometry` is
  now a **face over the native class with the same prototype object** — every geometry
  that ever existed is still an instance of it, adopted or not.
  The classes declare no members, because there are none to declare: every accessor
  lives on `Geometry`, where a shape-specific one answers `null` for the wrong shape.
  What the family buys is what a port asks of it — `instanceof` narrows in TypeScript
  too, since each subclass is a declaration of its own; the one thing still out of
  reach is a `Point`-*typed* return, which the generated half owns. `LinearRing` exists
  and is never handed out: rings come back as coordinates here, not as geometries.
  The members that answer **GeoJSON** by design are untouched — the free factories
  (`geometryFromWkt`), `CoordinateTransform.transformGeometry` and
  `FeatureRecord.geometry` — because re-tagging a plain object is how a native method
  ends up called with the wrong receiver.
- `Layer.setSpatialRef(crs)` changes a layer's CRS after the layer exists, taking a WKT
  string or a `SpatialRef`. The C API has no `OGR_L_SetSpatialRef` — a layer's CRS is
  its geometry field's — so this goes through `OGR_L_AlterGeomFieldDefn`, which asks the
  **driver** to rewrite the definition rather than writing through the definition
  object, which is sealed once the layer exists. **Which formats accept it is the
  format's**: GPKG and Shapefile do, and persist it (the `.prj` is rewritten), while
  GeoJSON, SQLite and FlatGeobuf answer `AlterGeomFieldDefn() not supported by this
  layer` and the call fails naming the driver. A CRS GDAL cannot read is refused before
  anything is touched, and the layer keeps the one it had. This was previously recorded
  as impossible; it is not — the earlier attempt went through the sealed definition
  instead of the driver.
- The `gdal-rs-napi/compat` layer now reshapes the **multidimensional model** as well:
  `dataset.root` is a `Group`, with the reference's `arrays` / `groups` / `attributes` /
  `dimensions` collections (`get`, `count`, `forEach`, `map`, `getNames`, both
  iterators), and its `MDArray` / `Attribute` / `Dimension` wrappers. An `MDArray` reads
  as a typed array, `asDataset()` hands back a compat `Dataset` again, and `getMask()` /
  `getView()` hand back further arrays. `getNames()` is the short name and `description`
  the full one, which is the pair the reference has.
- Three compat bugs that the tests above found, all of them places where the layer did
  not match the shape it exists to provide: `open(path)` with no driver list passed
  `{ drivers: undefined }`, which napi reads as an array and refuses; `drivers` may be a
  *string* as well as a list, and `open(path, 'w', …)` is the creation form
  (`x_size`, `y_size`, `band_count`, `data_type`), neither of which was handled; and a
  `GDT_*` name went to the native call as GDAL spells it, where this binding's four
  names differ (`GDT_Byte` is `Uint8` here).
- `gdal.eventLoopWarning` says so when a blocking call holds the JS thread too long.
  `false` turns the warning off, `true` turns it back on at the default threshold of
  50 ms, and a number sets that threshold in milliseconds (the last is this binding's).
  The blocking methods of the classes that reach a dataset are the ones timed —
  `Dataset`, `RasterBand`, `BandOverview`, `Layer`, `FeatureCursor` — because those are
  the calls whose length the caller cannot know, and the warning goes out through
  `process.emitWarning` as a `GdalEventLoopWarning`:
  ```
  GdalEventLoopWarning: RasterBand.readPixelsSync() held the event loop for 9.1 ms
  ```
- Every read-only property of a `RasterBand` and a `Dataset` now has an **`xxxAsync`
  twin** that answers the same thing off the thread pool: `sizeAsync`, `blockSizeAsync`,
  `dataTypeAsync`, `colorInterpretationAsync`, `descriptionAsync`, `unitTypeAsync`,
  `noDataValueAsync`, `scaleAsync`, `offsetAsync`, `minimumAsync`, `maximumAsync`,
  `idAsync`, `readOnlyAsync`, `hasArbitraryOverviewsAsync`, `categoryNamesAsync`,
  `colorTableAsync`, `rasterSizeAsync`, `geoTransformAsync` and `spatialRefAsync`. They
  exist for the *wait*, not for the work: a getter takes the process-wide lock, and on
  an ordinary dataset that is the exclusive side, so one read while an async read is in
  flight stops the event loop until that read finishes. The name keeps the reference's
  `Async` suffix, and that is the one deliberate exception to this binding's "the async
  form drops the `Sync` suffix" rule — `band.dataType` is a property, so a
  `band.dataType()` cannot exist beside it and there is no call to rename. They are
  getters, not methods: `await band.sizeAsync`, with no parentheses.
- **VRT pixel functions** — a derived VRT band whose pixels a JavaScript function
  computes. `gdal.addPixelFunc(name, fn)` registers one with GDAL, `wrapVRT` writes the
  VRT that uses it, and `toPixelFunc` / `createPixelFunc` / `createPixelFuncWithArgs`
  build one from a function of a single pixel:
  ```js
  gdal.addPixelFunc('espy', gdal.createPixelFunc((t, td) => 125 * (t - td)))
  const vrt = gdal.wrapVRT({ bands: [{ sources: [temperature, dewpoint], pixelFunc: 'espy' }] })
  gdal.openSync(vrt).band(0).readPixelsSync()
  ```
  The function has GDAL's own shape — `(sources, buffer, args)`, typed arrays in and
  the output array to fill — and runs on the JS thread, because that is the only thread
  that can call back into JavaScript. A **thread-pool read is refused with an error
  rather than risking a deadlock**: it would have to hand the call to an event loop that
  may be blocked on the lock the worker is holding. Not calling back into this binding
  from inside one is the rule `onProgress` already carries, for the same reason. GDAL
  cannot unregister a pixel function, so a name and its slot last for the life of the
  process, and there are 32 of them.
- `gdal.wrapVRT(descriptor)` builds a VRT dataset from bands — the `gdalbuildvrt` idea,
  with a pixel function per band — and answers it as **XML text**, which is a dataset
  name `gdal.open` takes directly, so nothing is written to disk. The descriptor is
  gdal-async's: `{ bands: [{ sources, pixelFunc?, pixelFuncArgs?, dataType?,
  sourceTransferType?, description? }] }`. A band with no `pixelFunc` is a plain copy of
  its source; one with more than one source needs a `pixelFunc` to combine them. A
  source band has to be readable **by path**, and GDAL spells the sample types
  differently inside a VRT (`Uint8` is `Byte` there) — which is translated for you.
- `RasterBand.dataset` is the dataset a band belongs to — gdal-async's `band.ds`. The
  same dataset rather than a copy, which is what `wrapVRT` needs to point a VRT back at
  its sources.
- The **multidimensional model** is in — GDAL's second data model, which is what NetCDF,
  HDF5 and Zarr look like through it. `Dataset.root` is a `Group`, reached with
  `open(path, { multidimensional: true })`; `Group` / `MDArray` / `Attribute` /
  `Dimension` follow with their structure, attributes, CRS, `read`, `getView`,
  `getMask` and `asDataset`, and `RasterBand.asMDArray()` goes the other way.
  `gdal.features().multidimensional` is `true` now.
- `open(path, { multidimensional: true })` is GDAL's `GDAL_OF_MULTIDIM_RASTER`, and it
  has to be asked for: without it GDAL builds no root group at all, so a NetCDF dataset
  has none. A file that *has* a multidimensional model is then handed over as that
  model — its band side is empty, so read it through `MDArray` — while a file that has
  none, a GeoTIFF say, opens as a plain raster exactly as before. Two shapes differ from
  the reference on purpose: `MDArray.read()` answers **raw bytes in the array's own
  type**, like `readPixels`, rather than a typed array in the JS type of the moment, and
  refuses a `String` or `Compound` array; and `asDataset()` takes `{ xDim, yDim }` for
  files that leave their axes untagged, its default being GDAL's own
  `HORIZONTAL_X` / `HORIZONTAL_Y` and then the last two dimensions. One behaviour is
  GDAL's rather than ours and worth knowing: a `Group` or `MDArray` handle holds its own
  reference to the file, so it keeps working — and on Windows keeps the file locked —
  after `close()`.
- `Dataset.getEnvelope()` is the dataset's bounding box as `{ minX, minY, maxX, maxY }`:
  a **raster's** four corners under its geotransform — so a rotated raster's box is
  larger than its own rectangle, which is the honest answer rather than a wrong small
  one — or, for a **vector** dataset, its layers' extents unioned. `null` when there is
  nothing to measure.
- `gdal.toDataType(name)` / `gdal.fromDataType(code)` are GDAL's numeric sample-type
  codes. `fromDataType` answers in **this** binding's spelling, not GDAL's — `1` is
  `'Uint8'` where GDAL says `'Byte'`, `4` is `'Uint32'` where GDAL says `'UInt32'` — so
  it matches `band.dataType` and the pair round-trips. `toDataType` takes either
  spelling (case is ignored, and `Uint8` is translated to GDAL's `Byte`), and a name
  GDAL does not know is refused rather than answered `Unknown`.
- `gdal.calcAsync(inputs, output, fn, options?)` computes one band from a pixel-wise
  function of several — `gdal_calc.py` with a JS callback in place of an expression
  string. Every band has to be the output's size, `fn` takes one argument per input in
  the order given, and the bands are read as the output's sample type. Two options are
  `gdal_calc.py`'s: `convertNoData` reads the missing value as `NaN` and writes `NaN`
  back as it, and `convertInput` converts the inputs to the output's type before `fn`
  sees them — which is what an integer output needs for the first to have anywhere to
  put a `NaN`. `fn` runs on the JS thread, once per pixel; the reading and the writing
  are what goes through the streams. (`onProgress` is this binding's own name for the
  callback; the reference calls it `progress_cb`.)
- `gdal.RasterMuxStream` and `gdal.RasterTransform` are the two pieces `calcAsync` is
  built from, usable on their own. A mux reads several read streams in lockstep and
  publishes the largest amount all of them have ready, so chunks stay aligned however
  the strips fall; inputs that end at different lengths destroy it with an error rather
  than answering short. A transform is the elementwise half — object chunks in, one
  typed array out — and `new Transform({ objectMode: true, transform })` remains the
  way to do anything beyond arithmetic. Both are the shell's, like the streams.
- `RasterBand.createReadStream(options?)` and `createWriteStream(options?)` are the
  raster **streams**: an object-mode Node `Readable` whose chunks are typed arrays of
  the band's own sample type, one strip at a time, and a `Writable` that consumes them
  the same way. Both take the window `readChunksSync` takes — `x`, `y`, `width`,
  `height` and `rows` — and the writer refuses what it cannot place: half a row, or
  more than its window holds. Both also take `type`, to read and write as another
  sample type (a constructor or a name), and `convertNoData`, to read the band's
  missing value as `NaN` and write `NaN` back as it. They live in the JavaScript shell
  (`index.js`) rather than in the Rust, because napi cannot hand back a Node
  `Readable` / `Writable` from a `#[napi]` class — the same reason a `FeatureCursor`
  gets its `for await` there — and `index.d.ts` declares them.
  `gdal.features().streams` is `true`.
- `RasterBand` gains the **band arithmetic**: `add`, `sub`, `mul`, `div`, `pow`; the
  unary `abs`, `sqrt`, `log`, `log10`; the comparisons `eq`, `notEq`, `lt`, `lte`,
  `gt`, `gte`; the logical `and`, `or`, `not`; and `ifThenElse`. Each takes another
  band or a plain number — `ifThenElse`, one per branch — and answers a **new band**.
  Arithmetic and `ifThenElse` come back as `Float64`; comparisons and logic as a
  `Uint8` mask of 0s and 1s, the way a GDAL mask is. Like `asType` it is **eager**:
  the result is computed once into a new in-memory dataset, so it is independent of its
  operands and survives their `close()`. That is deliberately *not* the reference's
  lazy VRT — see `docs/PARITY.md` — and two bands of different sizes are refused
  rather than one being resampled to the other.
- `RasterBand.asType(type)` converts a band to another sample type as a band of a new
  **in-memory dataset** — `gdal_translate -of MEM -ot <type>`. The conversion is
  materialised, so the result is independent of the source and stays readable after the
  source is closed. It is eager where `gdal-async`'s is a lazy VRT, and that is a
  deliberate trade: the VRT route was tried first and rejected, because a VRT keeps a
  shared handle on the source and reading it after `close()` is a use-after-free — our
  contract is a clear error from a closed dataset, never a crash. A mask band has no
  translated counterpart, so it is refused.
- `SpatialRef` gains the last of the parity checks and helpers: `isGeocentric`,
  `isLocal`, `isSameGeogCS(other)` / `isSameVertCS(other)`, `getAttrValue(name,
  child?)` and `autoIdentifyEPSG()`. The last is GDAL's own identification: it sets the
  code where GDAL can place the CRS and leaves it alone where it cannot — a
  hand-written WGS 84 GEOGCS is *not* identified here — rather than failing.
- `RasterBand.flush()` / `flushSync()` and `Layer.flush()` / `flushSync()` are the
  per-band and per-layer forms of the dataset's `flush()` — `GDALFlushRasterCache` and
  `OGR_L_SyncToDisk`. Both are writes, so the band one is refused on a read-only
  thread-safe dataset and the layer one wherever the dataset refuses a write.
- `Driver` gains `rename` and `copyFiles` — `GDALRenameDataset` and
  `GDALCopyDatasetFiles`, the driver's own multi-file operations (a shapefile is
  several files, a GeoPackage is one). Both take the **new** name first. One caveat
  GDAL hands down rather than us: its default implementation opens the source as a
  *raster*, so a vector-only dataset (a bare `.gpkg`) is not recognized.
- `gdal.fs.clearCurlCache()` drops the cache GDAL keeps of what it has already fetched
  from `/vsicurl/`, `/vsiaz/` and the rest — a no-op when nothing was fetched.
- `SpatialRef` gains the serializers and morphs `gdal-async` has: `fromESRI` (the
  `.prj` dialect ArcGIS writes), `morphToESRI()` / `morphFromESRI()`, `toXML()`,
  `validate()`, `cloneGeogCS()`, `setWellKnownGeogCS(name)` and the
  `epsgTreatsAsLatLong` getter. `fromURN` / `fromUserInput` need nothing of their own:
  `fromDefinition` already routes through `OSRSetFromUserInput`, which accepts a URN,
  an `AUTH:CODE`, WKT and PROJJSON alike. `cloneGeogCS` round-trips through WKT,
  because the `gdal` crate keeps `from_c_hsrs` private and hands back a raw handle.
- `Dataset` gains the **ground-control-point** path — the other way to georeference a
  raster, beside the affine `geoTransform`. `dataset.getGCPs()` returns
  `[{ id, info, pixel, line, x, y, z }]`, `setGCPs(gcps, projection?)` writes them
  back, and `gcpCount` / `gcpProjection` report how many there are and the CRS they
  are in. This is the georeferencing a warp falls back to for `-tps`, or when the
  source carries a GCP list and no transform. `setGCPs` is a write, so a read-only or
  thread-safe handle refuses it like any other.
- `Layer.getSpatialFilter()` is the read side of `setSpatialFilter`: the filter
  currently in force as a `Geometry`, or `null` when there is none. A rectangle set
  with `setSpatialFilterRect` comes back as a polygon, which is what GDAL stores.
- `RasterBand.hasArbitraryOverviews` says whether GDAL can compute overviews on
  demand for the band — some network sources can, and they generally have no fixed
  `overviews` at all. A read: nothing is built.
- `Geometry` gains the operations that round out the `gdal-async` set:
  `makeValid()` (GEOS's repair for a self-intersecting polygon), `boundary()`,
  `simplifyPreserveTopology(tolerance)` — `simplify`'s shape-preserving cousin —
  `isRing`, and the two XML encodings `toGML()` and `toKML(altitudeMode?)`. The
  first three are GEOS-gated and answer "this build has no GEOS" without it, as the
  rest do; `isRing`, `toGML` and `toKML` need no GEOS.
- `Geometry` gains five more of the GEOS operations: `pointOnSurface()` — a point
  guaranteed to lie *on* the shape, which `centroid` does not promise —
  `unaryUnion()` (the union of a collection's own parts, with no second operand),
  `concaveHull(ratio, allowHoles?)` (`convexHull`'s tighter cousin), `normalize()`
  (the canonical form, so two geometries can be compared as written) and
  `setPrecision(gridSize)` (snap to a grid). All GEOS-gated;
  `OGR_G_RemoveRepeatedPoints` is the one geometry call the bindings do not carry.
- `gdal.bundled` is the one-line answer to "is this self-contained": `true` for the
  bundled build that compiled GDAL and PROJ from source and linked them statically,
  `false` for one that linked a system GDAL. It is `gdal-async`'s `bundled`.
- `RasterBand.readChunks(options, onChunk)` is the async twin of `readChunksSync`:
  the same strip walk, run on the thread pool so a raster larger than memory does
  not hold the event loop either. Each strip is handed to `onChunk` from the JS
  thread, and the walk reads the next only once that call has come back — return
  `false` to stop, exactly as the sync form does — resolving to the number of strips
  handed out. The window is still checked before the first strip, which on this side
  is a rejection rather than a throw. The callback runs on the JS thread while the
  worker holds the process-wide GDAL lock, so, like `onProgress`, it must not call
  back into this library.
- `Dataset.copyLayer(sourceLayer, name, options?)` copies a whole layer — schema,
  features and all — into this dataset under a new name: GDAL's
  `GDALDatasetCopyLayer`, the way a layer moves between two datasets without
  re-reading it feature by feature. The source has to be a **different** dataset; a
  self-copy is refused with a message, because the two handles would have to be held
  at once and GDAL's per-dataset mutex is not reentrant. `options` are GDAL's own
  layer-creation options, as elsewhere.
- `gdal.decToDMS(angle, axis, precision?)` renders a decimal degree as
  degrees/minutes/seconds — `CPLDecToDMS`, the string `gdalinfo` prints. `axis` is
  GDAL's own label (`'Lat'` / `'Long'`) and drives the hemisphere letter;
  `precision` is the decimal places on the seconds, default 2.
- `gdal.verbose()` / `gdal.quiet()` turn GDAL's own debug logging on and off —
  `CPL_DEBUG=ON` / `OFF`, the switch `--debug` flips. They are process-global
  configuration, so they take the exclusive side of the lock, as `config.set` does.
- `RasterBand` gains the writers that go with its metadata getters:
  `setScale`, `setOffset`, `setUnitType`, `setDescription` and
  `setCategoryNames`. `GDALSetRasterScale` and `GDALSetRasterOffset` take a number
  and nothing else, so unlike `setNoDataValue(null)` there is no way to unset
  them — `0` is a value like any other, and the docs say so rather than pretending
  a null means "clear". The three that take a string do clear on `null`.
- `RasterBand` gains the palette, the last of the band-metadata pairings:
  `band.colorTable` reads a band's colour table as `[{ c1, c2, c3, c4 }, ...]` — one
  entry per pixel value, `null` when there is none — `band.paletteInterpretation`
  says what those components stand for (`Gray`, `Rgba`, `Cmyk`, `Hls`), and
  `setColorTable(entries, interpretation?)` writes the whole table back, defaulting
  to `Rgba`. That is the pair that makes a `PaletteIndex` band mean anything, and
  reading it touches nothing but the band, so it takes the shared side of the lock
  with the other accessors.
  **The components are unsigned 16-bit**, not the signed `short` GDAL's C struct
  declares: the `gdal` crate reads them as `i16`, so 65000 arrives as `-536` and
  writing 65000 through it would be an overflow. The two casts live in
  `ColorTableEntry`, with a Rust test that pins both ends of the range, and the
  signatures say `0..=65535` instead of leaving the surprise to the first palette
  that needs the top half. Keeping GDAL's own `c1`..`c4` names rather than renaming
  them per interpretation is deliberate — one table would otherwise have four
  shapes, and the interpretation is right there.
  **What a format keeps is the format's answer**, and the tests pin it rather than
  assume it: `MEM` and `VRT` hold all 16 bits (VRT writes them into its XML as
  signed shorts, so a palette survives a file exactly — read back, `-536` is 65000
  again), while GTiff's colour map is the TIFF tag, 8 bits a channel and always 256
  entries with no alpha, so a GTiff palette comes back quantised and padded rather
  than refusing the write. A read-only handle does not fail either: the change lands
  in GDAL's in-memory table and the PAM layer writes a `.aux.xml` sidecar, the same
  caveat `setStatistics` carries. An interpretation name nothing answers to is
  refused before GDAL sees it, and names the four that exist. It is one table that
  is written, not one entry, and it does not touch `colorInterpretation` — that is
  the band's own claim about its samples, a separate thing to be right about.
- `RasterBand` gains the mask band. `band.mask` is the validity mask as another
  `RasterBand`, `band.maskFlags` says where that mask comes from — `allValid`,
  `perDataset`, `alpha` and `noData`, four booleans because GDAL's flags are not
  exclusive — and `band.createMask(perDataset?)` builds one. **GDAL answers with a
  mask whether or not the file carries one**, so `band.mask` is never `null`: a band
  with no mask gets an implicit all-valid band that reads 255 everywhere, and
  `maskFlags.allValid` is how to tell that from a stored one.
  What comes back is a full band, not a decorator: `readPixels`, `statistics`,
  `checksum`, `overviews` and the rest all work on it, a write to it writes the mask,
  and reading it takes the shared side of the lock with the other reads — including
  on a thread-safe dataset. The implicit mask is **not writable**, and GDAL refuses
  rather than allocating one behind your back (`attempt to write to an all-valid
  implicit mask band`), which is what makes `createMask()` the step that turns a mask
  into a real one; asking twice is the driver's answer rather than a rule here, since
  GTiff rejects the second call ("already an internal mask band"), so
  `maskFlags.allValid` is how to ask instead. A mask can also be *derived* rather than
  stored — from an alpha channel, or from the band's no-data value — which is what
  `alpha` and `noData` report. The tests pin a stored mask surviving a file, a
  per-dataset mask being answered by every band, and a no-data one marking exactly the
  missing samples.
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
  There is a `Point` / `Polygon` / … class family as well — see the entry above. napi-rs
  cannot express inheritance, and the generated `binding.d.ts` owns the factories'
  return types, so the binding itself has one `Geometry` and the shell re-tags what
  comes out of it; a subclass-typed *return* is the part that stays out of reach.
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
- `new CoordinateTransform(from, to, options)` can be told how GDAL should choose
  the operation: a specific `pipeline` (a PROJ string, a WKT2 coordinate operation,
  or an `urn:ogc:def:coordinateOperation:EPSG::XXXX` URN) with an optional
  `reverse`, an `accuracy` floor in metres, `ballpark: false` to refuse a fallback
  transformation rather than quietly approximating, and an `areaOfInterest` to
  choose by. It is a pass-through of GDAL's `OGRCoordinateTransformationOptions`,
  and the trap a pipeline carries is now pinned by a test: GDAL hands a named
  operation the coordinates in the source CRS's **authority** order — latitude,
  longitude for `EPSG:4326` — *not* the longitude,latitude order every other call
  here speaks, so a pipeline written in this API's terms needs its own `axisswap`.
- What a list field actually does is the **driver's** business, and is now
  documented per driver rather than assumed: GeoJSON and SQLite store a real list
  and hand the array back; GPKG accepts the declaration, warns that the type "is
  not handled natively. Falling back to String.", and stores a scalar column — so a
  list value written there lands as GDAL's internal `(2:a,b)` text, neither the
  value nor usable as one; FlatGeobuf accepts the *field* and then refuses the
  feature write. That is why inference keeps writing comma-joined `String` text for
  an array: it is the portable form, and it is the value rather than a form of it.
  All four behaviours are pinned by a test.
- An async failure now carries `err.code` as well. napi pins a `Task`'s error type,
  so the stable token has always had to travel as a `[GDAL_…]` prefix on the
  message — and `err.code` was the useless `'GenericFailure'`. The JavaScript shell
  lifts that prefix back out, so `error.code === 'GDAL_CANCELLED'` works on the
  async surface exactly as it does on the sync one; the prefix stays in the message
  too, so nothing that matched on text breaks. `async-methods.js` is the list of
  what gets wrapped, and a test checks it against the generated declarations, so a
  new async method cannot quietly go uncovered.
- A `FeatureCursor` is async-iterable: `for await (const feature of
  layer.openCursor())` yields one feature per turn — not a batch — and stops when
  the layer runs out, with `break` stopping early without draining it. The iterator
  is the shell's, because napi cannot put `Symbol.asyncIterator` on a generated
  class, but it reads through the same `read()` a manual loop calls, so the two
  cannot disagree.
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
  declarations cannot give it. The adapter does not cover the raster streams
  (`band.pixels.…`), MDArray, `calcAsync` or the pixel functions; see `PHASE1.md`
  (WS-7).
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
  synchronous on purpose: the alternative is napi's `AsyncGenerator`, which cannot be
  reached from here — the trait lives in the private `bindgen_runtime` module, its
  prelude re-export does not exist in napi 3.13, and turning on the `experimental`
  feature changes neither, which is why a `FeatureCursor` gets its `for await` from
  the JavaScript shell instead. For a
  long walk, run it in a worker.
- `open()` / `openSync()` take a `Buffer` as well as a path, which is where the
  in-memory pipeline starts. The bytes go to a `/vsimem/` file, that file becomes the
  dataset's `path`, and closing the dataset unlinks it — so bytes written to in place
  come back out with `gdal.fs.readFile(dataset.path)`, after `flushSync()`, since GDAL
  holds dirty blocks exactly as it does for a file on disk. Bytes have no filename, so
  GDAL sniffs the content: GTiff, PNG, JPEG, VRT, GeoJSON and GPKG identify themselves,
  and a format a driver only knows by its extension does not.
- `gdal.fs` — GDAL's virtual file system: `readFile`, `writeFile`, `exists`, `stat`,
  `mkdir`, `rmdir`, `unlink`, `readDir`, plus the rest of the common surface —
  `rename`, `copyFile`, `glob`, `mkdirRecursive` / `rmdirRecursive` (`mkdir -p` and
  `rm -rf`), `isLocal` and `diskFreeSpace`. These are the `VSI*` functions, so the same
  call takes `/vsimem/`, `/vsizip/`, `/vsicurl/` or a plain path. They are synchronous
  deliberately: each one is a memory copy or a local syscall, and a `/vsicurl/` read is
  the exception — `open(url)` is the version of that which runs on the pool. A missing
  file answers `false` / `null` rather than throwing, while a call that was asked to
  change something throws. `readDir` drops the `.` and `..` GDAL reports for a real
  directory, and `/vsimem/` has no directories underneath at all: a name there is
  opaque, so writing into a "directory" that was never created works. `glob` walks
  GDAL's string list by the array, not by `CSLGetField`: that helper answers `""` past
  the end — and for an empty list — so a walk that stops on a null field never stops;
  the miss case (`glob('…/nothing*')` → `[]`) is a test. **What each operation does on
  a given file system is GDAL's answer, not a rule added here**, and the README carries
  the matrix for `/vsimem/`, `/vsizip/` and `/vsicurl/`: reading works everywhere,
  `/vsizip/` can *add* an entry but not overwrite, delete or rename one, and
  `/vsicurl/` refuses every write and needs the server (not GDAL) to list a directory.
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
- **A read can fill a buffer you already own**: `readPixels` / `readPixelsSync` and
  `readAs` / `readAsSync` take `options.into`, and GDAL writes through it — no
  allocation and no copy, which is what a tile read round after round wants. The buffer
  has to be exactly the size the read produces (`outWidth * outHeight *
  bytesPerSample`), a mismatch is refused rather than half-filled, and it comes back as
  the same object: a `Buffer` that arrived from JS resolves back to *that* object, so
  the return is an identity and not a fresh view of the same memory. GDAL is handed the
  raw pointer rather than a `&mut [T]`, and that is deliberate — a JS `Buffer` promises
  nothing about alignment, so the `gdal` crate's own `read_into_slice` could not be used
  soundly. `into` is a read option: `writePixels` takes its data as the first argument
  and refuses `into` rather than ignoring it.
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
  at a time, read in order. A second `open()` of the same source is the way to two
  independent readers, and `getFeature(fid)` is random access that does not disturb
  one — the README's *Reading in batches* has the measurements.
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
  `transformPoint`, `transformPointsSync` / `transformPoints` (a flat
  `Float64Array` in and out), `transformGeometry` (GeoJSON in, GeoJSON out — GDAL
  walks the geometry, so polygons, rings and collections are handled and a straight
  line stops being straight where it should) and `transformBounds`, which densifies
  the edges because transforming four corners is wrong for any non-linear
  projection. **The point array is the one with a threaded twin**: `transformPoints`
  moves the whole array on the pool, so a million coordinates is one call rather
  than a chunking loop the caller writes to keep the event loop free. `CoordTransform`
  is not `Send`, so the task carries the two CRSes as WKT *and the axis order in
  force* and rebuilds the transform where it runs — the axis order because a WKT
  round trip does not remember it, and losing it is the silent wrong-place answer
  this area is prone to. Both forms run one body, and a test compares the rebuilt
  transform against the live one under both orders. `transformGeometry` stays
  synchronous: a geometry is one object, and it returns GDAL's GeoJSON, which a
  threaded return cannot name a type for (`serde_json::Value` has no napi type
  name). `identifyEpsg(wkt)` resolves a CRS description to an authority code, on the
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
- **Concurrency is per thing, not global.** Work that touches an *open dataset* is
  serialised behind one process-wide lock: the async methods keep the Node event loop
  free, but they do not make dataset work run in parallel, because GDAL is not
  thread-safe for one dataset reached from two threads and some drivers are not
  thread-safe at all.
- `openThreadSafe()` is how a dataset joins in. It wraps GDAL 3.10's
  `GDALGetThreadSafeDataset`, whose reads take the *shared* side of that lock and
  therefore really do overlap — a measured 2.6x on four concurrent reads where the
  serialised path showed no gain at all from issuing them together. Such a dataset is
  read-only and raster-only: writes and layer access throw `GDAL_BAD_ARGUMENT`. Most
  drivers reopen the file per thread, so concurrency costs file descriptors; GTiff/COG
  do not.
- On such a dataset the shared side is no longer **only** the pixel read: so is every
  accessor that just looks at what the dataset already knows — the dataset's sizes,
  geotransform, projection, `spatialRef`, description, driver, metadata, file list and
  band lookup, and on a band `size`, `blockSize`, `id`, `noDataValue`, `scale`,
  `offset`, `unitType`, `colorInterpretation`, `minimum`, `maximum`,
  `categoryNames`, `overviewCount`, `overviews` and `metadata`, plus `checksum` and a
  whole overview level, which walk the samples without keeping them. The line is what a
  plain read is not: writes, the vector side, the programs (they build datasets of their
  own), and the three calls that make GDAL **store** what it computes — `statistics`,
  `histogram` and `defaultHistogram` — keep the exclusive side. `open()` is unchanged,
  since a serialised handle takes the write lock either way; this only shows on a
  thread-safe one. Measured by `scripts/bench-parallel.mjs`, which now asks a calibrated
  number of accessor rounds *while* a batch of reads is in flight: 39 rounds of 15
  getters on four concurrent reads of a 2048² DEFLATE GTiff came to **22.2 ms
  serialised vs 8.1 ms thread-safe (2.75x)**, and the accessor loop itself took 22.0 ms
  against 7.9 ms — the same calls, and the difference is how long each one waited for
  the read holding the lock.
- Work with **no dataset in it** takes the shared side too, so it overlaps as well:
  the CRS and `CoordinateTransform` methods, geometry/GEOS, `gdal.fs`, and the whole
  module-level surface — `version()`, `info()`, `diagnostics()`, `lastError()`,
  `epsgToWkt()`, the `geometry*` helpers, and the registry reads `drivers()` /
  `driver(name)`, whose `Driver` methods (`longName`, `metadata`, `testCapability`, the
  option lists) walk that same registry. The exclusive lock's original justification —
  GDAL keeping its last error in process-global variables — stopped being true in GDAL
  3.10. That state is thread-local now, `OGRSpatialReference` draws its PROJ context per
  thread (`OSRGetProjTLSContext()`), `OGRGeometry::createGEOSContext()` makes a GEOS
  context per call, and the driver registry is frozen once `ensure_initialized` has
  filled it through a `OnceLock`. `runtime.rs` records the evidence, the Rust test
  `gdals_last_error_is_thread_local` pins the part the split rests on, and
  `scripts/bench-parallel.mjs` measures the rest: four concurrent 400k-point transforms
  went from **1.03x to 2.93x**, a number near 1.00x being the lock serialising them,
  and the module surface now rides along with that workload rather than queueing behind
  it — 146 rounds came to **79.5 ms on an idle process vs 90.7 ms while the four
  transforms were in flight (1.14x, where queueing would have been 2.34x)**.
- `config.get` is the one *read* that cannot join it, and the reason is not that GDAL's
  config map is unguarded — it has its own mutex. `CPLGetConfigOption` hands back a
  pointer *into* the map and drops the guard on the way out, so a concurrent
  `config.set` can free the string before this binding copies it, and the two have to
  stay on the same side. `config.rs` says so where the next person will look.
- `configureDataPaths` takes the exclusive side as well. It writes `PROJ_DATA` /
  `GDAL_DATA` and can register every driver, so it is a configuration change like
  `config.set` — and it used to take *no* lock at all, which was a hole rather than a
  decision: `diagnostics()` reads those two variables and `drivers()` reads the
  registry that registration fills. `index.js` makes the call at require time, so in
  the ordinary case it is uncontended; the lock is for the case where it is not.
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
  both surfaces. `napi::Task` fixes its error type, so an async method's token
  still travels at the front of the message — the shell lifts it into `err.code`
  on the way out, and leaves it in the message.

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
- GEOS is fetched, compiled and statically linked (`geos-src`), like GDAL and PROJ, so
  the OGR geometry predicates it implements (`ST_Intersects`, `ST_Buffer`, `-simplify`)
  are available out of the box — it is LGPL-2.1, and the release carries the §6 relink
  material. `PDS` is the one driver that cannot be built at all: gdal-src's
  published crate omits `frmts/pds/data`, so switching it on fails the configure
  step, which is why `all_drivers` leaves it out.
- Requires Ninja (`CMAKE_GENERATOR`) and a `sqlite3` CLI from outside MSYS2. MSYS2
  must stay off `PATH` or GDAL's configure aborts; see the README for why.
- CI builds six targets on native runners and attaches one self-contained tarball
  per platform to a GitHub Release. **Nothing is published to npm** — the package
  is `private`, and installing is still from a release tarball.
- `npm run pack:npm` builds the npm-format artifacts — the root package plus one
  `gdal-rs-napi-<platform>` per binary, in the layout `binding.js` was generated
  for (it requires that name, and checks its version against the root's). It runs
  on every build so the packaging cannot rot, but nothing uploads it: publishing
  is **deliberately deferred** until the surface is settled. `ROADMAP.md` Phase 0
  lists what publishing will take.
- The two musl legs are ordinary legs, not experimental ones: a red one fails the run
  like any other. They build —
  and test — inside a musl-native Alpine container (`docker/musl.Dockerfile`) on a
  runner of their own architecture, so the container's own toolchain already
  targets the musl triple cargo is asked for: an ordinary native build, with no
  cross toolchain, no sysroot and no emulation. The suite has to run in there
  because napi links musl dynamically, so the runner's glibc Node cannot load the
  addon at all — one process, two libcs. What is fragile is the vendored C libraries
  rather than this crate. The
  README says so where a consumer will read it, and points at `docker/` for anyone
  who needs musl for certain.
- The workflow itself was tightened: `permissions: contents: read` at the top (only
  the release job asks for the `contents: write` it needs), and a `concurrency`
  group that cancels a superseded run on the same ref — a cold run compiles PROJ and
  GDAL from source, so a stale one is expensive. Tags are exempt, because a release
  build must not be cancelled by a later push that happens to share the ref.
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

- `ts-test/compat-reachability.spec.ts` is the **per-class** guard the union-based
  coverage count could not give: it builds real `compat` objects and exercises every
  documented member the review found missing — band algebra and async getters, the
  GCP surface, collection async twins, `clampBlock`, `DatasetBands.create`, geometry
  async twins, feature extras, the CRS aliases and `setPROJSearchPaths`. The coverage
  run stands at **98.7% statements, 99.5% functions, 99.3% lines, 85.6% branches**
  against the `98/98/99/84` floors.
- `event-loop-warning.spec.ts` drains queued warnings before each listening window and
  closes its datasets with the warning off. A `GdalEventLoopWarning` is delivered on
  the next tick, so a slow `close()` from the previous test could be recorded as if the
  next test's work had emitted it — which made the whole run red on a machine where
  closing an 18 MB `Float64` GeoTIFF crosses the 50 ms threshold.

- `ts-test/compat-coverage.spec.ts` reads the compatibility layer nearly end to end.
  It exercises the getters, error branches and node-callback forms the area suites do
  not reach — every geometry constructor and collection brand, the `ColorTable` reads
  and writes, a typed pixel read and a read into a caller's buffer, the overview
  picker, statistics through both spellings, the driver and layer `…Async` callback
  forms, the rejected `openAsync` callback, the multidimensional `Dimension` /
  `Attribute` / `MDArray` metadata and the collections' async iterators, and the two
  algorithm wrappers. A second batch covers the reachable defensive branches — the
  `wkbType` fallback, the null-geometry and plain-object feature paths, the feature
  collection's `…Async` callback forms, `executeSQLAsync` with a dialect and through a
  callback, the 3D envelope rules, and the algorithm wrappers with no optional fields.
  `compat/index.js` went from **91.5% / 92.6% / 69.8%** to **98.7% statements, 99.5%
  functions, 99.3% lines, 85.6% branches**, and the `test:coverage` thresholds are
  ratcheted up with it (from `90/90/90/68` to `98/98/99/84`). Two methods that were
  dead — a class-body `Geometry.getEnvelope` and `RasterBand.computeStatistics`, both
  shadowed by the `Object.assign` blocks below them — were removed rather than left as
  unreachable lines.

- `__test__/types.test.mjs` holds the generated `binding.d.ts` against the
  **runtime** rather than against a hand-copied list: module-level exports are
  compared both ways (a declaration nothing exports, or an export nothing declares,
  fails), every class member — instance and static — is checked to exist on both
  sides, each namespace's functions likewise, and the async members are compared per
  class against `async-methods.js`, so a promise method filed under the wrong class
  is caught where a flattened list would have missed it. `async-surface.test.mjs`
  keeps the runtime half (the `err.code` lift and the cursor's `for await`).
- `scripts/bench-parallel.mjs` measures the thread-safe path against the serialised
  one: the same concurrent workload, on real data, with the numbers and their
  spread printed. It measures a batch of reads with the read-only accessors asked
  *during* it — the round count is calibrated against the read time so the two
  workloads stay comparable on any machine — and a workload with **no dataset in it**,
  concurrent `transformPoints`, which is lock contention and nothing else and the
  sharpest reading of the split above. It is a benchmark, not a test, and asserts
  nothing beyond the two paths answering the same.
- …with one exception, which CI uses: `--min-speedup <x>` turns that dataset-free
  measurement into a gate, on the **ratio** between four transforms issued together
  and one at a time rather than on a wall time. That is what makes a floor safe to
  fail on — a slower runner moves both numbers together — and the floor is set well
  under what it measures (about 3x here, against a floor of 1.5x in CI), because what
  it is really watching for is structural: that work going back onto the exclusive
  side of the lock, which lands near 1x. The run is archived rather than only
  asserted on, since a number nobody keeps cannot show a trend: CI writes the whole
  output into the run summary and a `bench.log` artifact. Only the
  `x86_64-unknown-linux-gnu` leg runs it, for the same reason that leg is the one
  holding fmt, clippy and the Rust tests — a leg of its own would cost a second full
  GDAL build to say the same thing.
- `npm run smoke` installs the packed tarball into an **empty directory** and then
  uses it: the packaged CRS database resolves, the driver count is right, a GEOS
  predicate runs (so the statically linked GEOS works with nothing installed), and
  a raster round-trips. It is the check the "nothing on the host" claim stands on,
  and CI runs it on every platform — a runner being exactly the clean machine the
  claim is about.

### Engineering

- **The three largest Rust modules are directories now.** `dataset.rs`,
  `band.rs` and `vector.rs` became `dataset/`, `band/` and `vector/` modules:
  the napi surface stays in `mod.rs`, the `napi::Task` worker types moved to
  `tasks.rs` (and the field/feature helpers to `vector/fields.rs`), and the unit
  tests to `tests.rs`. The generated `binding.js` / `binding.d.ts` are
  byte-for-byte unchanged, so the split is invisible to consumers.
- **`SECURITY.md`, `CONTRIBUTING.md`, issue forms and a PR template** are in.
  Security reports go through GitHub's private advisories.
- **Supply chain**: `scripts/sbom.mjs` writes a CycloneDX inventory of the shipped
  crates and native libraries; `scripts/check-licenses.mjs` fails on a licence
  outside its allow-list. Both run in CI, and the SBOM is attached to a release.
- **`scripts/check-docs.mjs`** checks version parity, package contents, the
  CHANGELOG heading and the README's runtime claims (driver count, GDAL release,
  `apiVersion`, `features()` keys) against the built addon.
- **`bundled-lean`**: an opt-in Cargo feature that selects a curated driver set
  (internal + SQLite/GPKG/VFK + GEOS) instead of `all_drivers`, to shrink the
  `.node` and the musl build. See `docs/MUSL-LEAN.md`.
- **`docs/CONCURRENCY.md`** collects the lock model and its guardrails in one
  place; `ROADMAP.md`'s test description is corrected to the vitest suite that
  actually runs.
- **One error path.** `error.rs`'s `take_last_error` is now the only place that
  reads-and-resets GDAL's error state; `cpl_result`, `cpl_failure`, `null_pointer`,
  the OGR status path and `ExecuteSQL` all build their error from it instead of
  each reading `CPLGetLastError*` by hand.
- **The `bundled-lean` variant is measurable.** `npm run lean` builds it, prints
  the `.node` size and driver count (`scripts/lean-report.mjs`) and runs
  `vitest.lean.config.mts`, a suite whose driver-dependent tests gate on
  `hasDriver` and skip rather than fail. `.github/workflows/lean.yml` is a manual
  job that does the same in CI; it is not a push gate.
- **Tutorials.** `docs/TUTORIALS.md` indexes four runnable flows, and
  `examples/parallel-tiles.mjs` is the new one: it builds its own tiled fixture
  and measures serial vs `openThreadSafe` parallel reads.

### Known gaps

- The capabilities deliberately left out are listed with their reasons in
  [`docs/PARITY.md`](./docs/PARITY.md), the full boundary against `gdal-async`. That
  list is now short: the multidimensional model, the VRT pixel functions, the streams,
  the async getters, the pixel-wise `calcAsync`, the native collection **typing**, the
  geometry subclass family and the **mutable geometry builder** (`points.add`,
  `curves.add`, `closeRings`, `addSubLineString`, `GeometryCollectionChildren`) are all
  *in*; what is not is the one type asymmetry, that a member the generated declarations
  own keeps their return type. The additive gaps that remain are tiered there too.
- Transformations are 2D, and a *geometry* transform is synchronous. A coordinate
  array has a threaded form (`transformPointsSync` / `transformPoints`), which is the
  bulk entry; `Geometry.transform` and `transformGeometry` stay synchronous because a
  geometry is one object and comes back as GDAL's GeoJSON, which a threaded return
  cannot name a type for. An in-place `OGR_G_Transform` was weighed and not taken —
  `Geometry` is a value type and one clone is what every operation on it already
  costs; PHASE1 records the evaluation.
- GDAL's own error class and number reach a caller through `err.message`'s
  `[CPLErr=3 #1]` prefix and through `lastError()`, not as fields on the thrown
  error. They are deliberately not `err.gdalClass` / `err.gdalNumber`: napi's
  `Error` carries only `code` and `cause`, and only the async path goes through the
  shell at all, so fields on every synchronous error would mean wrapping the whole
  exported surface. `docs/API-STABILITY.md` states the rule.
- A layer's CRS can be changed after the layer exists — `layer.setSpatialRef(wkt)` or
  a `SpatialRef` — but **which formats allow it is the format's business**, and that is
  worth knowing before reaching for it. GDAL's C API has no `OGR_L_SetSpatialRef`: a
  layer's CRS is its geometry field's, and the way to change one afterwards is
  `OGR_L_AlterGeomFieldDefn`, which asks the *driver* to rewrite the definition. Going
  through the definition object directly does not work — it is sealed once the layer
  exists, and GPKG answers `OGRGeomFieldDefn::SetSpatialRef() not allowed on a sealed
  object`. So GPKG and Shapefile take it (and persist it — the `.prj` is rewritten),
  while GeoJSON, SQLite and FlatGeobuf answer `AlterGeomFieldDefn() not supported by
  this layer` and the call fails naming them. The CRS is still set where the layer is
  created — `createLayer({ epsg })` or `{ wkt }` — and the dataset's own CRS remains
  writable with `setProjection`.
- `buildOverviews({ bands })` is passed through, but GTiff — the only writable
  overview driver compiled in — refuses anything short of every band.
- No terrain algorithms beyond the ones `gdaldem` itself offers.
- GDAL keeps the reading position on the layer, so a layer takes one reader at a
  time — a second cursor, or a `featuresSync()`, rewinds the first. There is no
  per-cursor position to hand out, so two independent readers means two dataset
  handles (`open()` the same source again); `getFeature(fid)` is random access and
  does not move the position. `featuresSync()` / `features()` rewound first as of
  this cut, so they return the whole layer even with a cursor part-way through it
  rather than only the tail.
- A list field is only a list on drivers that have one, and the four here disagree
  — see the note under `### Binding`. Inference writes comma-joined text, which
  every driver keeps.
- Intel macOS and 32-bit targets are not built.
