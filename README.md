# gdal-rs-napi

Node.js bindings for [GDAL](https://gdal.org), built on the Rust
[`gdal`](https://crates.io/crates/gdal) + [`gdal-sys`](https://crates.io/crates/gdal-sys)
crates and exposed through [napi-rs](https://napi.rs).

GDAL and PROJ are compiled **statically** into the addon, and the PROJ/GDAL data
files travel with the npm package, so an installed package needs no GDAL on the
host system.

> **Status: pre-1.0.** Raster and vector reading and writing, the
> `gdal_translate` / `gdalwarp` / `ogr2ogr` / `gdaldem` wrappers, overviews, CRS
> transforms and genuinely parallel reads all work. `CHANGELOG.md` lists the API
> surface and the known gaps.

## Install

```sh
npm install gdal-rs-napi
```

## Usage

```js
const gdal = require('gdal-rs-napi')

gdal.version()
// { gdal: 'GDAL 3.12.1 "Chicoutimi", released 2025/12/12', proj: '9.6.2' }

gdal.drivers().length // 148

// Which drivers do I actually have?
const names = new Set(gdal.drivers().map((d) => d.name))
names.has('GTiff') // true

// Something CRS-related misbehaving? This says whether the CRS database was
// found, and where PROJ was pointed.
gdal.diagnostics()
// { epsg4326Resolves: true, crsDatabaseFound: true, projDataEnv: '.../assets/proj', ... }

// What is this build exactly? BUILD_INFO lists what was compiled in, and a
// feature that was not is a missing key — there is no `GEOS_ENABLED` here.
gdal.info()
// { releaseName: '3.12.1', releaseDate: '20251212', versionNum: '3120100',
//   build: { OGR_ENABLED: 'YES', PROJ_BUILD_VERSION: '9.6.2', ... }, driverCount: 148 }
```

`index.js` calls `configureDataPaths()` for you, pointing PROJ and GDAL at the
packaged `assets/proj` and `assets/gdal`. Call it yourself only if you relocated
those files or want to use your own GDAL data. A `PROJ_DATA` / `GDAL_DATA`
already present in the environment is never overwritten.

Note that `diagnostics().projDefaultSearchPath` is PROJ's *compiled-in* default
and still names the machine the library was built on; it is not the path in use.
`crsDatabaseFound` and `projDataEnv` are the fields that mean something.

`diagnostics().geosAvailable` answers whether the OGR geometry predicates
(`ST_Intersects`, `ST_Buffer`, `-simplify`) are available. They are not: GEOS is
LGPL, and statically linking it would relicense this whole artifact, so it is left
out on purpose — see the licence note at the end.

## Configuration and GDAL's last error

`gdal.config` is GDAL's own option store — the same one `--config NAME=VALUE` and the
`GDAL_*` / `CPL_*` environment variables feed:

```js
gdal.config.set('GDAL_NUM_THREADS', 'ALL_CPUS') // e.g. parallelise buildOverviews
gdal.config.set('CPL_CURL_VERBOSE', 'YES')      // and the curl-backed drivers
gdal.config.get('GDAL_NUM_THREADS')             // 'ALL_CPUS'
gdal.config.get('NOT_SET_ANYWHERE')             // null
gdal.config.get('NOT_SET_ANYWHERE', 'fallback') // 'fallback'
gdal.config.set('GDAL_NUM_THREADS', null)       // clear it again
```

Worth knowing:

- **It is process-wide and outlives the call.** A value set here overrides what the
  environment had, until it is cleared or the process exits.
- **`get` tells "unset" apart from "empty".** GDAL has no option value that means
  "empty", so a key nobody set reads as `null` — or as the default you hand it. That
  distinction is why this reads the C function rather than the crate's wrapper, which
  folds the two together.

`gdal.lastError()` reports GDAL's most recent error — `class`, `number`, `message` —
or `null`:

```js
const dataset = gdal.createSync('out.tif', {
  driver: 'GTiff', width: 4, height: 4, bandCount: 1,
  options: { NOT_A_REAL_OPTION: 'x' },  // GTiff warns, then carries on
})
gdal.lastError()
// { class: 2, number: 6,
//   message: 'driver GTiff does not support creation option NOT_A_REAL_OPTION' }
```

Two things to know:

- **It is for the errors that never became an exception.** A warning a driver logs
  and carries on past is the case it exists for; a thrown message would not mention it.
- **A thrown failure is already gone from here.** The Rust `gdal` crate reads *and
  resets* GDAL's error state as it builds the error, so `lastError()` is `null` after
  one you caught — `err.code` and `err.message` are that error's record, and its code
  names the same `CPLErr` class this reports (`GDAL_CPL_FAILURE` is class 3).

## Files — memory, and the virtual file system

Every GDAL path already goes through a virtual file system, and `gdal.fs` is the
`VSI*` calls that reach it: the same code reads a plain path, `/vsimem/` (memory),
`/vsizip/` (inside an archive) and `/vsicurl/` (HTTP) without being told which.

```js
gdal.fs.writeFile('/vsimem/data.tif', bytes)
gdal.fs.exists('/vsimem/data.tif')   // true
gdal.fs.stat('/vsimem/data.tif')     // { size, isFile, isDirectory, modifiedMs }
const bytes = gdal.fs.readFile('/vsimem/data.tif')

gdal.fs.mkdir('/tmp/scratch')
gdal.fs.readDir('/tmp/scratch')      // ['a.txt', 'b.txt'] — no '.' or '..'
gdal.fs.unlink('/vsimem/data.tif')
gdal.fs.rmdir('/tmp/scratch')
```

These are synchronous, and deliberately so: every call is a memory copy or a local
syscall. A `/vsicurl/` read is the exception — a network round trip that will block the
event loop — and for that case `open(url)` is the one that runs on the thread pool. A
missing file is not an error (`exists` is `false`, `stat` is `null`); a call that was
asked to change something throws instead. And `/vsimem/` is not a filesystem
underneath: a path there is an opaque name, so
`writeFile('/vsimem/anything/nested.bin', bytes)` works with no directory ever created.

**`open()` takes bytes as well as a path**, which is where data that never had a file
comes in:

```js
const dataset = gdal.openSync(bytes)   // or await gdal.open(bytes)
dataset.driver                         // 'GTiff' — sniffed from the content
dataset.path                           // '/vsimem/gdal-rs-napi-1234-0.bin'
```

The bytes go to a `/vsimem/` file, and that file *is* the dataset's `path` — which is
how an edit made in memory gets back out, before the dataset is closed:

```js
const dataset = gdal.openSync(bytes, { update: true })
dataset.band(0).fill(9)
dataset.flushSync()                     // GDAL holds dirty blocks until then
const edited = gdal.fs.readFile(dataset.path)
dataset.close()                         // and this unlinks that file
```

Bytes have no filename, so GDAL identifies them by content: GTiff, PNG, JPEG, VRT,
GeoJSON and GPKG all say what they are. A format a driver only knows by its extension
does not — which is what `gdal.fs.writeFile('/vsimem/data.tif', bytes)` followed by
`open('/vsimem/data.tif')` is for.

## Raster

```js
const dataset = gdal.openSync('dem.tif')
dataset.driver                        // 'GTiff'
dataset.width                         // pixels
dataset.height
dataset.bandCount
dataset.geoTransform                  // [x0, dx, rx, y0, ry, dy] or null
dataset.projection                    // WKT, or null
dataset.metadata().AREA_OR_POINT      // { ... } for the default domain
dataset.metadata('IMAGE_STRUCTURE')

const band = dataset.band(0)          // 0-based, unlike GDAL itself
band.dataType                         // 'Float32'
band.noDataValue                      // -9999 or null
band.size                             // [width, height]
band.blockSize                        // the driver's native block
band.colorInterpretation              // e.g. 'GrayIndex'

// Band metadata a format can carry. `id` is GDAL's 1-based band number, where
// `index` above is this API's 0-based one.
band.id                               // 1
band.description                      // free text, or null
band.unitType                         // e.g. 'metre', or null
band.scale                            // raw * scale + offset is the real value
band.offset                           //   ... null when a format carries neither
band.readOnly                         // follows how the dataset was opened
band.minimum                          // GDAL's cache: null until statistics() runs
band.maximum
band.categoryNames                    // labels indexed by pixel value, [] when none

band.fill(0)                          // write one value over the whole band

// Raw sample bytes in the band's own type, no conversion.
const raw = band.readPixelsSync({ x: 0, y: 0, width: 256, height: 256 })

// Or ask GDAL to convert while reading.
band.readAsSync('Uint8')

// Downsample. `resampling` is one of: nearest, bilinear, cubic, cubicspline,
// lanczos, average, mode, gauss.
band.readPixelsSync({ outWidth: 128, outHeight: 128, resampling: 'average' })

// Every reader has an async twin that runs on the libuv thread pool.
await band.readPixels()
await band.readAs('Uint8')

dataset.close()
```

The readers hand back raw bytes, because one return type cannot be a
`Float32Array` for one band and a `Uint16Array` for the next. To view them:

```js
const bytes = band.readPixelsSync()
const copy = Uint8Array.from(bytes)   // copy makes alignment a non-issue
const values = new Float32Array(copy.buffer, 0, copy.length / gdal.bytesPerSample('Float32'))
```

Writing and creating:

```js
const out = gdal.createSync('out.tif', {
  driver: 'GTiff',
  width: 4,
  height: 4,
  bandCount: 1,
  dataType: 'Float32',
})
out.band(0).writePixelsSync(Buffer.from(new Float32Array(16).buffer))
out.band(0).setNoDataValue(-9999)
out.setMetadataItem('AREA_OR_POINT', 'Area')
out.close()
```

`driver: 'MEM'` with an empty path gives an in-memory dataset, which is handy in
tests. A write must supply at least `width * height` samples of the band's own
type — a short buffer is rejected rather than silently zero-filled.

Georeferencing and creation options:

```js
const out = gdal.createSync('dem.tif', {
  driver: 'GTiff',
  width: 64,
  height: 64,
  bandCount: 1,
  dataType: 'Float32',
  // Driver creation options, passed straight through to GDAL.
  options: { TILED: true, BLOCKXSIZE: 32, BLOCKYSIZE: 32, COMPRESS: 'DEFLATE' },
})
out.setGeoTransform([500000, 30, 0, 4600000, 0, -30])
out.setProjection(gdal.epsgToWkt(32633))
```

Option names are GDAL's own and differ per driver — GTiff tiles want
`BLOCKXSIZE` / `BLOCKYSIZE`, while COG takes `BLOCKSIZE`. GDAL logs a warning and
ignores anything it does not recognise.

Some drivers implement `CreateCopy` but not `Create`, so a dataset cannot be made
from scratch with them. COG is the one people ask for, and this is the way in:

```js
const source = gdal.openSync('dem.tif')
const cog = await source.createCopy('dem-cog.tif', 'COG', {
  COMPRESS: 'DEFLATE',
  BLOCKSIZE: 512,
})
cog.close()
source.close()
// IMAGE_STRUCTURE then confirms what came out:
// { INTERLEAVE: 'BAND', COMPRESSION: 'DEFLATE', LAYOUT: 'COG' }
```

`scale` and `offset` are what make a band's samples mean something —
`raw * scale + offset` is the physical value — so read them before computing anything
from a DEM or a reflectance raster, which otherwise read as plain integers.
`minimum` / `maximum` are GDAL's *cache* rather than a computation: they are `null`
until `statistics()` has run, or a format that stores them is opened. `readOnly`
follows the dataset's access mode, because a band has none of its own.

Three of GDAL's raster algorithms work straight on a band:

```js
band.checksumSync()                    // the 16-bit fingerprint gdalinfo prints
band.checksumSync({ x: 0, y: 0, width: 256, height: 256 })  // or a window of it
await band.fillNoData()                // fill no-data pixels from their neighbours
await band.sieveFilter({ threshold: 10 })  // drop regions under 10 pixels
```

Each has a `Sync` twin. **`fillNoData` and `sieveFilter` work in place**, so the
dataset has to be writable — `fillNoData` also needs the band to have a no-data
value, and says so rather than guessing which pixels are holes. **`checksum`
refuses `resampling` / `outWidth` / `outHeight`**: it is a fingerprint of the
samples as they are, and resampling into it would only change the number.

A fourth burns geometry into a dataset:

```js
const square = { type: 'Polygon', coordinates: [[[2, 2], [6, 2], [6, 6], [2, 6], [2, 2]]] }
dataset.rasterizeSync([square], { burnValues: [1] })
await dataset.rasterize([square], { burnValues: [1], options: { ALL_TOUCHED: true } })
```

`burnValues` is one value per geometry, positionally, and `bands` picks the bands by
0-based index (default: the first). Everything else in `options` is GDAL's own —
`ALL_TOUCHED`, `MERGE_ALG`, `INIT_DEST` — passed through as written. **It does not
reproject**: the geometry has to already be in the raster's coordinate system, and
`warp` is the tool when it is not.

And a fifth goes the other way, writing a band's values out as polygons:

```js
raster.band(0).polygonizeSync(layer)   // 4-connected, into the field `DN`
await raster.band(0).polygonize(layer, { connectedness: 8, fieldName: 'value' })
```

One polygon per connected region of equal value, in a field called `fieldName`
(default `DN`) that is created when the layer does not have it — `Real` for a float
band, `Integer` otherwise, because the field has to match the samples. The layer
will usually belong to a **different** dataset from the band, which is fine: both are
held under one lock, and the layer's dataset has to be writable.

And a sixth draws contour lines from a raster surface — the `gdal_contour` case:

```js
band.contourGenerateSync(layer, { levels: [0, 100, 200, 300] })
await band.contourGenerate(layer, { interval: 50, base: 0, idField: 'id' })
```

Give `levels` or an `interval` (with an optional `base`), not both. The elevations go
into `elevField` (default `ELEV`), and `idField` names a field to put a per-line id in
if you want one; both are created when the layer does not have them. The band wants a
geotransform, and the **layer** carries the CRS, so the lines come out in the layer's
coordinate system.

And when the warp itself is the point, rather than a tool to shell into — ask what it
would produce, then produce it:

```js
const { geoTransform, width, height } = raster.suggestedWarpOutputSync({
  dstWkt: gdal.epsgToWkt(3857),
})

const dest = gdal.createSync('warped.tif', {
  driver: 'GTiff', width, height, bandCount: raster.bandCount, dataType: 'Float32',
})
dest.setGeoTransform(geoTransform)
dest.setProjection(gdal.epsgToWkt(3857))

await raster.reprojectImage(dest, { dstWkt: gdal.epsgToWkt(3857) })
```

`suggestedWarpOutput` is the arithmetic `gdalwarp` does before any pixel moves — size,
geotransform and `extent` — so it is also the answer to "how big would my output be".
`reprojectImage` is `GDALReprojectImage`, which warps one open dataset into another
that has to exist already; that is the pair. `srcWkt` / `dstWkt` on either call supply
or override the two CRSes, so a dataset with no projection is still usable, and
`resampling` takes `nearest` (the default, as in `gdalwarp`), `bilinear`, `cubic`,
`cubicspline`, `lanczos`, `average`, `mode` — there is no `gauss`, which is a
`RasterIO` kernel and not one reprojection has.

Two things that save confusion: `width` / `height` come straight from GDAL and
are only meaningful when there are bands, so check `bandCount` before trusting
them on a vector dataset; and `IMAGE_STRUCTURE` lives on the **dataset**, not on
the band, so read it as `dataset.metadata('IMAGE_STRUCTURE')`.

Closing a dataset is idempotent, and afterwards every object derived from it
(`band`, `dataset.bandCount`, ...) throws instead of touching freed memory.

## Statistics and overviews

```js
const band = gdal.openSync('dem.tif').band(0)

// min / max / mean / stdDev. `force: false` only reads what GDAL has already
// cached and gives back null when there is nothing.
const stats = await band.statistics()

// Counts per bucket over a range, for a contrast stretch or similar.
const histogram = await band.histogram({ min: stats.min, max: stats.max, buckets: 256 })

// A pyramid, so reduced-resolution reads stop touching every pixel.
const dataset = gdal.openSync('dem.tif', { update: true })
dataset.band(0).overviewCount // 0
await dataset.buildOverviews()
dataset.band(0).overviewCount // 3, for a 1024x1024 raster
```

Worth knowing:

- **`statistics()` computes by default.** On a large raster that is a full read of
  the band — hence the async form, and `approx: true`, which lets GDAL lean on
  overviews instead of every pixel. `{ force: false }` is the cheap one: it
  reports the cache, or `null`.
- **`setStatistics()` stores the numbers**, so the next reader gets them from
  `{ force: false }` instead of a full pass. An update-mode dataset keeps them in
  the file where the format can; a **read-only** handle does not fail — GDAL's PAM
  layer writes a `<file>.aux.xml` beside the raster, so a call you thought was
  read-only can still leave a file behind.
- **`buildOverviews()` is the slowest call in this binding.** Setting
  `GDAL_NUM_THREADS=ALL_CPUS` has GDAL compute the levels in parallel, which is
  worth doing for anything sizeable.
- **Levels default to what `gdaladdo` would choose**: powers of two until the
  smallest overview is below 256 pixels on its longer side. Pass `levels` to be
  explicit. Building is *additive*, exactly as in `gdaladdo` — levels that already
  exist are recomputed in place and the others are left alone.
- **Where they land follows how you opened the dataset.** `{ update: true }` puts
  them inside the file; a read-only dataset gets an external `.ovr` beside it. That
  is the same split as `gdaladdo` versus `gdaladdo -ro`.
- **`resampling` takes `gdaladdo`'s names** — `nearest` (the default), `average`,
  `rms`, `gauss`, `bilinear`, `cubic`, `cubicspline`, `lanczos`,
  `average_magphase`, `mode`. A typo is rejected with that list rather than handed
  to GDAL.
- **GTiff builds overviews for every band at once**, so `bands` is passed through
  for the drivers that accept a subset.
- **`removeOverviews()` deletes the pyramid**, the exact counterpart of building
  it — `gdaladdo -clean`, as one call.

## Coordinate reference systems

```js
const wgs84 = gdal.SpatialRef.fromEpsg(4326)
const webMercator = gdal.SpatialRef.fromEpsg(3857)

wgs84.authority         // 'EPSG:4326'
wgs84.isGeographic      // true
webMercator.linearUnit  // { name: 'metre', factor: 1 }

// Build the transform once and reuse it: working out the pipeline is the
// expensive part.
const toMercator = new gdal.CoordinateTransform(wgs84, webMercator)
toMercator.transformPoint(13.4, 52.5) // Berlin, in metres
toMercator.transformPoints(new Float64Array([13.4, 52.5, 2.35, 48.85]))
toMercator.transformGeometry(polygon) // GeoJSON in, GeoJSON out
toMercator.transformBounds([13.0, 52.0, 13.8, 53.0])
```

**Coordinates are longitude,latitude here. Read this before passing any.**

GDAL 3 reads `EPSG:4326` as *latitude,longitude*, and nothing about the call makes
it visible: under that order `transformPoint(13.4, 52.5)` returns a perfectly
plausible coordinate for 13.4°N 52.5°E — the Gulf of Aden, not Berlin. GeoJSON, WKT
and every other corner of this binding are longitude,latitude, so every
`SpatialRef` built here uses that order (`axisMapping` reports `traditional`), and
`withAxisMapping('authority')` is there for when you want GDAL's reading instead.

Worth knowing:

- **`fromDefinition` takes anything** `gdalinfo` would accept as a CRS:
  `EPSG:4326`, a WKT string, PROJJSON, or a PROJ string. `fromEpsg`, `fromWkt` and
  `fromProj4` are the specific doors.
- **`equals` compares the definitions, not the spelling**: two differently written
  WKTs for WGS 84 are equal.
- **`identifyEpsg` returns a promise** because it searches the CRS database. A
  description that cannot be parsed throws; one that parses but matches nothing
  gives `null`.
- **`dataset.spatialRef` and `layer.spatialRef`** hand back the CRS of something
  you opened, and are `null` when it has none. `createLayer` now takes `wkt` as
  well as `epsg`, so a CRS that did not come from a code is no longer unusable
  there.
- **Transformations are 2D and synchronous** — chunk a million points yourself
  rather than blocking the loop on one call.

## Vector

```js
const dataset = gdal.openSync('roads.gpkg')
dataset.layerCount
dataset.layers().map((layer) => layer.name)

const layer = dataset.layer(0)          // 0-based
dataset.layerByName('roads')

layer.name
layer.geometryType                      // 'LineString', 'MultiPolygon', ...
layer.featureCount                      // number, or null when the driver cannot
                                        // answer without a full scan
layer.fields                            // [{ name, fieldType, width, precision }]
layer.extent                            // [minX, minY, maxX, maxY] or null
layer.spatialRefWkt                     // WKT, or null

layer.featuresSync()                    // every feature, materialised
layer.feature(3)                        // one by feature id, or null

layer.setAttributeFilter('population > 1000')   // OGR SQL WHERE; null clears it
layer.setSpatialFilterRect(minX, minY, maxX, maxY)
layer.clearSpatialFilter()
```

`featuresSync()` returns plain objects, not GDAL wrappers:

```js
const [first] = layer.featuresSync()
first.fid          // 0, or null when the driver has no feature ids
first.properties   // { name: 'alpha', population: 120 } — a NULL field is null
first.geometry     // { type: 'Point', coordinates: [10, 20] }, or null
```

Because features are **copied out** rather than wrapped, the values stay valid
after the layer or the dataset is closed. `fieldType` uses GDAL's own vocabulary
(`String`, `Integer`, `Integer64`, `Real`, `Date`, `StringList`, ...).

Geometry helpers take and return GeoJSON objects:

```js
gdal.geometryTypeOf({ type: 'Point', coordinates: [10, 20] })  // 'Point'
gdal.geometryToWkt(point)                                      // 'POINT (10 20)'
gdal.geometryToWkb(point)                                      // Buffer
gdal.geometryFromWkt('POINT (10 20)')                          // GeoJSON object
gdal.geometryFromWkb(buffer)                                   // GeoJSON object
```

### Writing

```js
const dataset = gdal.createVectorSync('out.gpkg', 'GPKG')
const layer = dataset.createLayer({ name: 'places', geometryType: 'Point', epsg: 4326 })

layer.createFeature(
  { type: 'Point', coordinates: [10, 20] },
  { name: 'alpha', population: 120, height: 1.5, tags: ['a', 'b'] },
)
layer.createFeature(null, { name: 'gamma', population: null })  // no geometry, and a NULL

await dataset.flush()   // or flushSync()
dataset.close()
```

`createFeature` adds any field the properties name. The type comes from the
value — a string becomes `String`, an integer `Integer64`, a number `Real`, a
boolean `Integer` — with two deliberate choices:

- **A `null` or a nested object creates no field.** Inventing a column for a
  value we cannot represent is worse than leaving it out.
- **An array becomes a `String` holding comma-joined text**, not a list field. A
  driver with no list columns (GPKG, for one) *accepts* a list field request,
  creates a scalar column, and then still reports the list type from its
  definition — so a list setter afterwards stores GDAL's internal `(2:a,b)` form
  instead of the value. Fields that are *already* list-typed (read from GeoJSON,
  say) are still written as real lists.

Values are written with the setter for the **field's** declared type rather than
the JS value's, so a `Date` field takes a date string, a `String` field takes
joined text, and an array aimed at an integer column is a clear error instead of
silent nonsense.

`updateFeature(fid, geometry, properties)` changes only what you name, errors on
an unknown property rather than adding a column, and treats a `null` geometry as
"leave it alone". `deleteFeature(fid)` removes one feature, and
`deleteLayer(name)` a whole layer *by name* — deleting shifts every later index, so
a name is the safe handle. Not every driver can do either: GeoPackage can, an ESRI
Shapefile cannot, and GDAL says so.

### Declaring the schema

Inference is a convenience, not the only way. Pass `fields` to `createLayer` and
the schema exists before any feature does, with each type chosen rather than
guessed:

```js
dataset.createLayer({
  name: 'places',
  geometryType: 'Point',
  epsg: 4326,
  fields: [
    { name: 'label', fieldType: 'String', width: 64 },
    { name: 'count', fieldType: 'Integer' },
    { name: 'tags', fieldType: 'StringList' },
  ],
})
```

A declared type always wins over inference: `count: 5` would otherwise become an
`Integer64`, and a declared `StringList` is how you get a real list column rather
than the comma-joined text inference writes. `width` and `precision` are handed to
the driver, which may keep them or not — GeoPackage keeps the width and drops the
precision, because SQLite has no fixed-point numbers. Properties still get inferred
fields alongside the declared ones.

### Reading in batches

`featuresSync()` materialises the whole layer. `openCursor()` reads it a batch at a
time instead, so what a layer costs is one batch rather than all of it:

```js
const cursor = layer.openCursor({ batchSize: 1000 })
for (;;) {
  const batch = await cursor.read() // on the thread pool
  if (batch.length === 0) break
  consume(batch) // { fid, properties, geometry }, as everywhere else
}
```

Every batch holds exactly what `featuresSync()` would have returned for those rows,
so a loop like this is a drop-in replacement for the materialising call.

Two things to know, both of them GDAL's shape rather than this API's:

- **One reader per layer at a time.** GDAL keeps the reading position *on the
  layer*, which is what lets a batch resume where the last one stopped — and what
  makes a second cursor, or a `featuresSync()` call, rewind the first. Read the
  batches in order and do not mix the two ways of reading one layer.
- **`close()` does not touch GDAL.** Anything else reading that layer rewinds it
  anyway, so leaving the position where it stopped costs nothing.

On a feature, `fid` and `geometry` are `null` when absent — matching
`properties`, where a SQL `NULL` is also `null`.

## Programs — `gdal_translate`, `gdalwarp` and `ogr2ogr`

Three of GDAL's command-line tools are available as one call each. `args` are that
tool's **own command-line arguments**, so anything in GDAL's documentation can be
pasted straight in and there is no second vocabulary to learn.

```js
// gdal_translate -of COG -co COMPRESS=DEFLATE in.tif out.tif
await gdal.translate('out.tif', 'in.tif', ['-of', 'COG', '-co', 'COMPRESS=DEFLATE'])

// gdalwarp -t_srs EPSG:3857 -r cubic in.tif out.tif
await gdal.warp('out-3857.tif', ['in.tif'], ['-t_srs', 'EPSG:3857', '-r', 'cubic'])

// ogr2ogr -f GPKG out.gpkg in.geojson -nln places
await gdal.vectorTranslate('out.gpkg', ['in.geojson'], ['-f', 'GPKG', '-nln', 'places'])
```

Each also comes with a `Sync` suffix, and as a method on an already-open dataset
when there is a single source. The module-level `warp` and `vectorTranslate` take
a list, and `gdalwarp` merges what it is given:

```js
const dataset = gdal.openSync('in.tif')
dataset.warpSync('out-3857.tif', ['-t_srs', 'EPSG:3857', '-r', 'cubic'])
```

Worth knowing:

- **You get a `Dataset` back.** It is the dataset GDAL created, so read it as
  usual; `close()` writes it out.
- **An empty destination means memory.** `translateSync('', source, ['-of',
  'MEM'])` returns an in-memory dataset instead of touching the filesystem.
- **`LAYOUT=COG` shows up on reopen, not on the returned handle.** GDAL hands back
  the dataset it just wrote, and the driver reports `LAYOUT` when it opens a
  finished COG — so reopen the file if that is what you are asserting.
- **A bad argument is reported with the arguments in it** —
  `gdal_translate rejected these arguments: -not-a-real-option` — rather than the
  crash `gdal`'s own `BuildVRTOptions` wrapper walks into, which never checks
  whether GDAL returned a null options pointer.
- **`ogr2ogr` replaces the destination layer by default, and `-append` adds to it
  instead.** Point `GDALVectorTranslate` at a destination whose layer already
  exists and that layer is replaced — no flag needed. `-overwrite` is ogr2ogr's own
  flag rather than GDAL's, so this wrapper implements it by dropping the destination
  *file* first, which takes every layer in that file with it. Reach for it when that
  is what you mean, and `-append` when you want to add rather than replace.
- **`gdaldem` is here as well**, through `demProcess` / `demProcessSync` on a
  dataset or `gdal.demProcess` by path: `hillshade`, `slope`, `aspect`,
  `color-relief`, `tri`, `tpi` and `roughness`. They want a geotransform, and the
  ones that measure slope want a CRS in metres.
- **`gdalbuildvrt` is as well**, as `buildVrt` / `buildVrtSync`:

  ```js
  gdal.buildVrtSync('merged.vrt', ['a.tif', 'b.tif'], ['-separate'])
  const inMemory = await gdal.buildVrt('', ['a.tif'])   // an empty destination
  ```

  One source is the "wrap this raster as a VRT without copying it" case, several are
  merged, and `args` are `gdalbuildvrt`'s own — `-separate`, `-resolution`, `-te`.
  What comes back is a `Dataset` like any other. One thing to know: **`GDALBuildVRT`
  refuses inputs with no georeferencing at all**, and with every input skipped the
  call fails.

### Progress and cancelling

Every program call takes an optional `onProgress`. It runs on the JS thread while the
work runs on a worker, and is handed `{ complete, message }`:

```js
await gdal.warp('out.tif', ['big.tif'], ['-t_srs', 'EPSG:3857'], (progress) => {
  process.stdout.write(`\r${Math.round(progress.complete * 100)}%`)
})
```

Returning `false` cancels the run — GDAL's only way of being stopped once it has
started — and the rejection says so rather than looking like a failure:

```js
try {
  await gdal.warp(dest, sources, args, (progress) => progress.complete < 0.5)
} catch (error) {
  if (error.message.includes('[GDAL_CANCELLED]')) console.log('stopped early')
}
```

Three things worth knowing:

- **Only an explicit `false` cancels.** A callback that returns nothing — the common
  shape, and what one that only logs looks like — keeps going.
- **The callback is synchronous as far as GDAL is concerned**, so a slow one slows
  the conversion down. Count what you need in there; do not do work in there.
- **Do not call back into this library from a progress callback.** The worker holds
  the process-wide GDAL lock while it waits for your answer, so a call from inside
  deadlocks. Report progress; do not read a raster.

There is no `onProgress` on the `Sync` entry points on purpose: a sync call holds the
JS thread, and the callback has to run on that thread, so it could never be called.

## Async semantics — read this before relying on it

Every operation that touches GDAL takes a **process-wide lock**, because GDAL
keeps its last-error state globally and the `gdal` crate reads and resets it
right after each FFI call; concurrent calls can observe each other's errors.

The async APIs therefore keep the Node **event loop** free — by themselves they do
not make GDAL work run in parallel. Ten concurrent `readPixels()` calls on a
dataset from `open()` take as long as ten sequential ones.

### Real parallelism: `openThreadSafe()`

GDAL ≥ 3.10 has `GDALGetThreadSafeDataset`, and this binding wires it up:

```js
const dataset = await gdal.openThreadSafe('big.tif')
const band = dataset.band(0)

// These genuinely overlap instead of queueing on the lock.
const tiles = await Promise.all(windows.map((window) => band.readPixels(window)))
```

A pixel read of such a dataset takes the **shared** side of the lock rather than
the exclusive side. Everything else still takes the exclusive side, so the global
error-state race described above stays out of the picture.

```sh
node scripts/bench-parallel.mjs big.tif --concurrency 4
```

What it costs, and what it does not do:

- **Read-only, raster-only.** GDAL's thread-safe datasets exclude vector layers
  and the multidimensional API. `writePixels`, `setProjection`, `setGeoTransform`,
  `setMetadataItem`, `flush` and every layer accessor throw `GDAL_BAD_ARGUMENT` on
  one — use `open()` for those. `createCopy` and the `translate`/`warp` family do
  work, because they read the source and write somewhere else.
- **`threadSafe` tells you which kind you have.** `open()` datasets report
  `false`, `openThreadSafe()` ones `true`. A driver that cannot do it at all fails
  the open with a message naming it, rather than quietly handing back a dataset
  that serialises.
- **Concurrency is capped by the worker pool.** Node's is four threads by default,
  so only four reads overlap unless you raise `UV_THREADPOOL_SIZE` before starting
  Node.
- **File descriptors.** Most drivers are not natively thread-safe, and GDAL
  reopens the file per thread for those, so raising the concurrency costs file
  descriptors — raise `ulimit -n` too. GTiff and COG (libtiff) are the exception,
  and the cheap case.
- **A warm block cache is free.** If GDAL can serve a read from its block cache
  then the lock was never the bottleneck and there is nothing to win.
  `openThreadSafe()` pays off when reads are expensive: cold I/O, or
  decompression.

`close()` behaves as it does everywhere else: later reads fail, and a read already
in flight finishes against a handle that is still alive.

### Error codes

A sync failure sets `err.code` to a stable token — `GDAL_CPL_FAILURE`,
`GDAL_CPL_WARNING`, `GDAL_BAD_ARGUMENT`, `GDAL_MISSING_PROJ_DATA`, ... — and puts
GDAL's own class and number in the message: `[CPLErr=3 #4] ...`.

`napi::Task` pins its error type to `napi::Error<Status>`, so the **async**
methods cannot set that code. They throw with the same token prefixed to the
message instead — `[GDAL_CPL_FAILURE] ...`. Prefer the sync methods when you need
to branch on `err.code`.

## Examples

`examples/` holds three runnable scripts. Run them from the repository root (they
load the package through `..`, so nothing needs publishing first).

```sh
node examples/gdalinfo.mjs path/to/anything.tif
node examples/to-cog.mjs in.tif out.tif COMPRESS=ZSTD
node examples/convert-vector.mjs roads.geojson roads.gpkg roads
```

They are also wired up as `npm run gdalinfo -- <file>`, `npm run to-cog -- …` and
`npm run to-vector -- …`.

- **`gdalinfo.mjs`** — a miniature `gdalinfo` that handles rasters *and* vectors,
  so it exercises the whole read path.
- **`to-cog.mjs`** — re-write any raster as a Cloud-Optimized GeoTIFF through
  `createCopy`, then reopen it and show the `IMAGE_STRUCTURE` that proves it.
- **`convert-vector.mjs`** — copy every feature of one vector file into another,
  letting `createFeature` build the schema from the properties it sees.

## Prebuilt binaries

CI builds one self-contained tarball per platform and attaches them to a GitHub
Release when a `v*` tag is pushed. **Nothing is published to npm** — install a
release asset directly:

```sh
npm install https://github.com/yjdyamv/gdal-rs-napi/releases/download/v0.1.0/gdal-rs-napi-0.1.0-darwin-arm64.tgz
```

Each tarball carries the loader, the packaged GDAL/PROJ data and its own `.node`,
and declares `os` / `cpu` / `libc`, so npm refuses one built for a different
machine.

| Rust target | Runner | Tarball |
|---|---|---|
| `x86_64-pc-windows-msvc` | `windows-latest` | `win32-x64-msvc` |
| `aarch64-apple-darwin` | `macos-latest` (arm64) | `darwin-arm64` |
| `x86_64-unknown-linux-gnu` | `ubuntu-latest` | `linux-x64-gnu` |
| `aarch64-unknown-linux-gnu` | `ubuntu-24.04-arm` | `linux-arm64-gnu` |
| `x86_64-unknown-linux-musl` | `ubuntu-latest` | `linux-x64-musl` |
| `aarch64-unknown-linux-musl` | `ubuntu-24.04-arm` | `linux-arm64-musl` |

Two things worth knowing about that matrix:

- **Every glibc/Windows/macOS leg is built on a native runner of the matching
  architecture.** Cross-compiling a statically linked GDAL is not worth the
  trouble, so the arm64 Linux leg uses GitHub's arm64 runner rather than a cross
  toolchain.
- **The musl legs are marked `experimental`** (`continue-on-error`). They build
  inside a musl-native Alpine container (`docker/musl.Dockerfile`) on a runner of
  their own architecture, so the container's own toolchain already targets the musl
  triple cargo is asked for and the whole build is native — no cross toolchain, no
  sysroot, no emulation. What makes them the least settled part of the matrix is
  the vendored C libraries `all_drivers` pulls in (HDF5, netCDF, curl, libpq) and
  their CMake and configure steps, so a failure there is reported but does not fail
  the run. The suite runs in the same image, where musl is the native libc.

Intel macOS is not built. If you need it, add a `macos-13` leg — the build itself
needs no changes.

## Building from source

### Prerequisites

| Need | Notes |
|---|---|
| Rust | ≥ 1.98 (MSRV pinned in `Cargo.toml`) |
| Node.js | ≥ 20.17 |
| CMake | ≥ 3.12; 4.x needs `CMAKE_POLICY_VERSION_MINIMUM=3.5`, already set in `.cargo/config.toml` |
| Ninja | **required** — see below |
| `sqlite3` CLI | **required** — PROJ shells out to it to generate `proj.db` |
| C/C++ toolchain | MSVC (VS 2022+), or clang/gcc on macOS/Linux |

```sh
# Windows
winget install SQLite.SQLite          # or: choco install sqlite
winget install Ninja-build.Ninja
# macOS
brew install sqlite ninja cmake
# Debian/Ubuntu
sudo apt-get install sqlite3 ninja-build cmake g++
```

Then:

```sh
npm install --include=dev   # --include=dev matters if NODE_ENV=production is set
npm run build               # release build + asset staging
node -e "console.log(require('.').version())"
```

### Three things that will bite you

**1. Keep MSYS2 / Cygwin / MinGW off `PATH`.**

CMake derives candidate prefixes from `PATH`. MSYS2's UCRT64 tree ships an
`ArrowConfig.cmake` that **overwrites `CMAKE_MODULE_PATH` without restoring it**,
which makes GDAL's own `include(GdalDriverHelper)` fail and aborts the whole
configure with:

```
CMake Error at frmts/zlib/contrib/infback9/CMakeLists.txt:13 (include):
  include could not find requested file: GdalDriverHelper
```

`scripts/build.mjs` drops those directories from `PATH` for you (and prints what
it dropped). Note that entering a VS Developer Shell does **not** fix this — it
only prepends Visual Studio paths, leaving MSYS2 in place.

This is also why `sqlite3` has to come from somewhere other than MSYS2: that
prefix has to stay off `PATH`, and MSYS2's `sqlite3.exe` lives inside it.

**2. The generator must be Ninja** (already set in `.cargo/config.toml`).

`cmake-rs` passes `--parallel N`, but under the Visual Studio generator that only
becomes MSBuild's `/m:N`, which parallelises *between projects*. PROJ and GDAL
are each a **single** enormous `.vcxproj` (GDAL's `proj.vcxproj` alone holds 217
`ClCompile` items) and the generated projects contain no `/MP`, so `cl` compiles
one translation unit at a time — an observed **single `cl.exe`** on a 16-thread
machine. Ninja parallelises per translation unit.

**3. Only ever build `--release`, and never with a bare `cargo`.**

- A debug build is a *completely separate* `target/` tree, so one accidental
  `cargo build` recompiles all of PROJ and GDAL from scratch.
- `napi build --platform` passes `--target <host-triple>`, so its artifacts live
  in `target/<host-triple>/release`, **not** `target/release`. If you want a
  standalone `cargo check` that reuses them, pass the same `--target`:

  ```sh
  cargo check --release --target x86_64-pc-windows-msvc        # host triple
  cargo test  --release --target x86_64-pc-windows-msvc --lib  # Rust unit tests
  ```

- `rust-analyzer` runs `cargo check`, which runs the `gdal-src` build script too.
  That is a third full PROJ/GDAL compile; let the first build finish before
  trusting editor diagnostics.

### What actually gets compiled

| Component | Setting |
|---|---|
| GDAL | 3.12.1, static, `GDAL_USE_INTERNAL_LIBS=ON`, `GDAL_USE_EXTERNAL_LIBS=OFF` |
| PROJ | 9.6.x, `bundled_proj`, static |
| Drivers | `gdal-src/all_drivers` — 148 of them, see below |
| GEOS | **not linked** — it is LGPL, and static linking would relicense the artifact |

Because `gdal-src` turns every driver off unless it is named, the Cargo `bundled`
feature list *is* the shipped driver set — and it names `gdal-src/all_drivers`, so
the package carries everything that crate can build.

The build registers **148 drivers** — `drivers()` is the authoritative list. On
top of the internal libtiff / libgeotiff / libjpeg / libpng stack that backs GTiff
and COG, that includes HDF5 and netCDF (with the HDF5 they need, all statically
linked), the curl-backed network drivers — WMS, WMTS, WCS, OGCAPI, PLMOSAIC,
Carto, Elasticsearch, NGW, AmigoCloud — PostgreSQL and PostGIS, GRIB,
STACIT/STACTA, FlatGeobuf, GeoJSON / GeoJSONSeq / TopoJSON / ESRIJSON, GPKG,
SQLite, OpenFileGDB, ESRI Shapefile, MapInfo, DXF, DGN, CAD, S57, VDV, VFK, CSV,
GTFS, Selafin, KMLSUPEROVERLAY, PGDUMP, and the long tail of national and
scientific raster formats.

What is deliberately *not* there:

- **GEOS**, and with it the OGR geometry predicates it implements — `ST_Intersects`,
  `ST_Buffer`, `-simplify` and the rest. GEOS is LGPL, and linking it statically
  would relicense this whole artifact. It is a separate `gdal-src` feature if you
  want to change that, but then what you ship is no longer MIT alone.
- **Formats needing an XML library this build does not link** — KML, GML, GPX,
  GMLAS, LIBKML, XLSX/XLS and DWG among them — plus the ones behind a vendor SDK
  (FileGDB, Oracle, MySQL) and the JPEG2000 / WebP / HEIF / AVIF family.
- **`PDS`**, the one driver this package cannot offer at all: `gdal-src`'s
  published crate does not ship `frmts/pds/data`, so switching it on fails GDAL's
  configure step. That is why `all_drivers` leaves it out.

All of it is statically linked, so an installed package still needs nothing on the
host. The price is size — the `.node` is about 35 MB (a 131-driver build was 28 MB)
and a tarball about 15 MB compressed (12.7 MB), plus a few minutes of extra build
time. To trim it, swap `gdal-src/all_drivers` for the individual
`gdal-src/driver_*` features you actually want.

`openThreadSafe()` needs GDAL ≥ 3.10, which the bundled build satisfies. Linking a
system GDAL older than that (`--no-default-features`) still compiles — the method
is simply absent, because `build.rs` reads the version `gdal-sys` reports and only
switches it on where `gdal::ThreadSafeDataset` exists.

### Targets

CI builds six targets, the ones in the table under "Prebuilt binaries":
`win32-x64-msvc`, `darwin-arm64`, `linux-x64-gnu`, `linux-arm64-gnu`, and the two
musl ones. The musl legs are `continue-on-error` — they build in a musl-native
Alpine container, which is the least certain link in the chain — so a release can
ship without them. 32-bit targets are not built.

Those two legs run their test suite in that same container rather than on the
runner, because napi links musl dynamically (it adds
`-C target-feature=-crt-static`) and the runner's glibc Node cannot load such an
addon at all — one process, two libcs. The container is the honest place for it:
the generated loader resolves to musl there, so the suite exercises the real
artifact.

## Licence

MIT. GDAL and PROJ are MIT/X11; see `LICENSE`.
