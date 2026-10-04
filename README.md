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

**Not on npm yet.** Each release attaches one self-contained tarball per platform
to the GitHub Release, and installing from it needs no registry and no GDAL on the
host:

```sh
npm install https://github.com/yjdyamv/gdal-rs-napi/releases/download/v0.1.0/gdal-rs-napi-0.1.0-linux-x64-gnu.tgz
```

The tarball names its `os` / `cpu` / `libc`, so npm refuses one built for a
different machine. Publishing to npm is planned — the packing already exists
(`npm run pack:npm`, and Phase 0 of `ROADMAP.md`) — but the package stays
`private` until the surface is settled.

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
// feature that was not is a *missing key* rather than a "NO".
gdal.info()
// { releaseName: '3.12.1', releaseDate: '20251212', versionNum: '3120100',
//   build: { OGR_ENABLED: 'YES', PROJ_BUILD_VERSION: '9.6.2', ... }, driverCount: 148 }

// "What can this binding do" is a different question from "what was GDAL built
// with": `features()` always answers all of it, so nothing has to be probed by
// calling a method and catching the TypeError.
const features = gdal.features()
// { geos: true, threadSafe: true, multidimensional: true, streams: true }

gdal.apiVersion // '0.1.0' — the binding's version, not `version().gdal`
```

`index.js` calls `configureDataPaths()` for you, pointing PROJ and GDAL at the
packaged `assets/proj` and `assets/gdal`. Call it yourself only if you relocated
those files or want to use your own GDAL data. A `PROJ_DATA` / `GDAL_DATA`
already present in the environment is never overwritten.

Note that `diagnostics().projDefaultSearchPath` is PROJ's *compiled-in* default
and still names the machine the library was built on; it is not the path in use.
`crsDatabaseFound` and `projDataEnv` are the fields that mean something.

`diagnostics().geosAvailable` answers whether the OGR geometry predicates
(`ST_Intersects`, `ST_Buffer`, `-simplify`) are available. They are: GEOS is
fetched, compiled and statically linked by the build, the way GDAL itself is — see
[Geometries as objects](#geometries-as-objects) and `docs/GEOS.md`.

## Constants

`gdal.const` freezes the string vocabularies the rest of the surface already uses,
so a name can be referenced rather than retyped:

```js
gdal.const.FieldType.Integer64         // 'Integer64'
gdal.const.ColorInterpretation.RedBand // 'RedBand'
gdal.const.Resampling.Average          // 'average'
gdal.const.OverviewResampling.Rms      // 'rms'
gdal.const.SqlDialect.SQLITE           // 'SQLITE'
```

These are the strings the API returns and accepts, not GDAL's numeric enum codes:
`band.dataType` is `'Float32'`, `layer.fields[0].fieldType` is `'String'`. The
tables are frozen, and a test asserts every value is the spelling the runtime
actually uses, so the two cannot drift.

`Resampling` and `OverviewResampling` are two vocabularies because GDAL has two.
A pixel read — and `warp` / `reprojectImage` — takes `Resampling`, where nearest
is `nearestneighbour`; `buildOverviews({ resampling })` takes
`OverviewResampling`, where it is `nearest` and `rms` / `average_magphase` /
`none` exist. `none` is not a kernel — it is how a pyramid is deleted.

When a **number** is what is wanted — GDAL's own code — `gdal.toDataType(name)` and
`gdal.fromDataType(code)` convert:

```js
gdal.toDataType('Byte')                // 1
gdal.fromDataType(4)                   // 'Uint32', this binding's spelling
gdal.bytesPerSample('Float32')         // 4
```

`fromDataType` answers in *this* binding's spelling, so it matches `band.dataType`
(`1` is `'Uint8'` here where GDAL would say `'Byte'`) and the pair round-trips;
`toDataType` accepts either spelling.

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

`gdal.verbose()` and `gdal.quiet()` turn GDAL's own debug logging on and off — they set
`CPL_DEBUG` to `ON` / `OFF`, the switch `--debug` flips, which `config.get('CPL_DEBUG')`
reads straight back. Both are process-global, like `config.set`.

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

## Drivers

A driver is an object, not a name. `gdal.driver(name)` is the lookup that does not
walk the list, and answers `null` for a driver this build does not have:

```js
const gtiff = gdal.driver('GTiff')

gtiff.name                    // 'GTiff'
gtiff.longName                // 'GeoTIFF'
gtiff.fileExtensions()        // ['tif', 'tiff']
gtiff.metadata().DMD_MIMETYPE // 'image/tiff'

// "Can this build do it?" answered without trying it. An unknown name is false
// rather than a throw: the call is a question, and "no" is one of its answers.
gtiff.testCapability('DCAP_CREATE')     // true
gtiff.testCapability('DCAP_VECTOR')     // false — a raster-only driver

// The XML `gdalinfo --format GTiff` prints: every creation option, its type and
// its default. This is how an option name is learned rather than guessed.
gtiff.creationOptionList()
```

`gdal.drivers()` returns these objects (sorted by short name), so
`gdal.drivers().map((d) => d.name)` is unchanged from when it returned records.

`dataset.driver` is one of these too. `dataset.driver.name` is the short name, and
`String(dataset.driver)` / `` `${dataset.driver}` `` still read as that name:

```js
dataset.driver.name                     // 'GTiff'
dataset.driver.testCapability('DCAP_CREATE')
```

`open()` takes a **`drivers` whitelist**, so a file another driver would have
claimed fails instead of quietly loading as something else — and the failure names
the driver that was tried:

```js
gdal.openSync('features.geojson', { drivers: ['GeoJSON'] })  // ok
gdal.openSync('features.geojson', { drivers: ['GTiff'] })    // throws
gdal.driver('GeoJSON').openSync('features.geojson')          // same restriction
```

`Driver.open` / `Driver.openSync` and `Driver.create` / `Driver.createSync` are the
same calls with the driver already named, so it cannot be passed the wrong one.
`Driver.createCopy` / `createCopySync` is the same for `CreateCopy` — the road to
drivers like COG that implement it and not `Create`:

```js
gdal.driver('COG').createCopySync('out.tif', source, { COMPRESS: 'DEFLATE' })
```

`Driver.delete(path)`, `rename(newName, oldName)` and `copyFiles(newName, oldName)`
are the driver's own file operations: `delete` removes what GDAL considers the dataset
(several files for a shapefile, one for a GeoPackage), and `rename` / `copyFiles` move
them — **new name first**, as GDAL's C API spells it. GDAL's `rename` / `copyFiles`
open the source as a *raster*, so a vector-only dataset (a bare `.gpkg`) is not
recognized; that is GDAL's answer, not a restriction added here.

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

gdal.fs.mkdirRecursive('/vsimem/out/2024/09')   // mkdir -p
gdal.fs.glob('/vsimem/out/**/*.tif')            // one flat array of paths
gdal.fs.rename('/vsimem/a.tif', '/vsimem/b.tif')
gdal.fs.copyFile('/vsimem/b.tif', '/tmp/b.tif')
gdal.fs.rmdirRecursive('/vsimem/out')           // rm -rf
gdal.fs.isLocal('/vsicurl/https://host/a.tif')  // false
gdal.fs.clearCurlCache()                        // drop what /vsicurl/ has fetched
```

These are synchronous, and deliberately so: every call is a memory copy or a local
syscall. A `/vsicurl/` read is the exception — a network round trip that will block the
event loop — and for that case `open(url)` is the one that runs on the thread pool. A
missing file is not an error (`exists` is `false`, `stat` is `null`); a call that was
asked to change something throws instead. And `/vsimem/` is not a filesystem
underneath: a path there is an opaque name, so
`writeFile('/vsimem/anything/nested.bin', bytes)` works with no directory ever created.

**What each file system supports is GDAL's answer, not this binding's.** `gdal.fs`
adds no rules of its own, so this is the matrix for the three prefixes most code
reaches for:

| | plain path | `/vsimem/` | `/vsizip/` | `/vsicurl/` |
|---|---|---|---|---|
| `readFile`, `stat`, `exists`, `glob` | yes | yes | yes | yes — over the network |
| `writeFile`, a name that is not there yet | yes | yes | yes — it adds an entry | no |
| `writeFile`, a name that is | yes | yes | **no** — "already exists in ZIP file" | no |
| `mkdirRecursive` | yes | yes | yes — an entry | no |
| `unlink`, `rename`, `rmdirRecursive` | yes | yes | no | no |
| `readDir` | yes | yes | yes | only where the server lists |
| `isLocal` | `true` | `true` | `true` | `false` |
| `diskFreeSpace` | bytes | `0` | `0` | `0` |

`/vsizip/` is worth reading twice: it is not read-only — adding an entry works, and
the entry lands in the archive — but overwriting, deleting and renaming inside it do
not. `/vsicurl/` is the one row the test suite does not run (it wants a network), and
its `readDir` is the one that depends on the server rather than on GDAL.

**`open()` takes bytes as well as a path**, which is where data that never had a file
comes in:

```js
const dataset = gdal.openSync(bytes)   // or await gdal.open(bytes)
dataset.driver.name                    // 'GTiff' — sniffed from the content
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
dataset.driver.name                   // 'GTiff' — a Driver object, see Drivers
dataset.width                         // pixels
dataset.height
dataset.rasterSize                    // { width, height }, the same pair grouped
dataset.description                   // for a file, the file name
dataset.getFileList()                 // what has to ship with it, [] for MEM
dataset.getEnvelope()                 // { minX, minY, maxX, maxY } — raster corners
                                      // under the geotransform, or the layers' union
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
band.colorTable                       // [{ c1, c2, c3, c4 }, ...], or null
band.paletteInterpretation            // how to read those: 'Rgba', 'Cmyk', 'Hls', 'Gray'
band.maskFlags                        // { allValid, perDataset, alpha, noData }
band.mask                             // the validity mask, as a band

// A colour table is what a `PaletteIndex` band means: one entry per pixel value, and
// the components are 16-bit. `paletteInterpretation` is the table's own answer to
// what they stand for — red, green, blue and alpha on the default `'Rgba'` — and
// `setColorTable` takes back exactly what `colorTable` handed out. What survives a
// file is the format's answer: MEM and VRT keep all 16 bits, GTiff's TIFF colour map
// is 8 bits a channel and always 256 entries.
band.setColorTable([{ c1: 255, c2: 0, c3: 0, c4: 65535 }])
band.setColorTable([{ c1: 0, c2: 0, c3: 0, c4: 0 }], 'Cmyk')

// The mask is what separates a valid sample from the rest, and `band.mask` always
// answers something: a band with no mask of its own gets an implicit all-valid band
// reading 255 everywhere, which is what `maskFlags.allValid` reports. It is a full
// band, so the reads work on it, and `createMask()` is what turns it into one that
// takes a write.
band.mask.readPixelsSync()            // 255 where the sample counts
band.maskFlags                        // { allValid, perDataset, alpha, noData }
band.createMask(true)                 // one mask for the whole dataset
band.mask.setNoDataValue(0)           // then write the mask through the mask itself
band.mask.writePixelsSync(bytes)

// ... and each of them can be written back, so a format that carries band
// metadata is not read-only through this API.
band.setScale(2.5)
band.setOffset(10)
band.setUnitType('metre')
band.setDescription('elevation')
band.setCategoryNames(['water', 'land'])

// `null` clears what a string setter wrote; `[]` clears the categories. Scale and
// offset have no such form — GDAL's setters take a number, so `0` is a value like
// any other rather than a way back to `null`.
band.setUnitType(null)
band.setDescription(null)
band.setCategoryNames([])

band.fill(0)                          // write one value over the whole band

// Raw sample bytes in the band's own type, no conversion.
const raw = band.readPixelsSync({ x: 0, y: 0, width: 256, height: 256 })

// Or ask GDAL to convert while reading.
band.readAsSync('Uint8')

// A different thing: a *band* of another type, converted once into memory.
const asFloat = band.asType('Float32')

// And the elementwise arithmetic. Each operand is a band or a number, and each
// answers a new band; comparisons and logic answer a Uint8 mask of 0s and 1s.
const normalized = nir.sub(red).div(nir.add(red))
const water = normalized.gt(0.2)
const masked = water.ifThenElse(normalized, 0)

// Downsample. `resampling` is one of: nearest, bilinear, cubic, cubicspline,
// lanczos, average, mode, gauss.
band.readPixelsSync({ outWidth: 128, outHeight: 128, resampling: 'average' })

// Every reader has an async twin that runs on the libuv thread pool.
await band.readPixels()
await band.readAs('Uint8')

dataset.close()
```

`readAs` converts on the way out; `asType` converts once and hands back a band — an
in-memory copy, so it stands on its own after the source is closed. The arithmetic
(`add`, `sub`, `mul`, `div`, `pow`, `abs`, `sqrt`, `log`, `log10`, the comparisons,
the logical operators and `ifThenElse`) is eager in the same way: every result is one
in-memory band, independent of its operands, and the two bands have to be the same
size.

The readers hand back raw bytes, because one return type cannot be a
`Float32Array` for one band and a `Uint16Array` for the next. To view them:

```js
const bytes = band.readPixelsSync()
const copy = Uint8Array.from(bytes)   // copy makes alignment a non-issue
const values = new Float32Array(copy.buffer, 0, copy.length / gdal.bytesPerSample('Float32'))
```

A read can also fill a buffer you already own, which is what to do when the same tile
comes round again and again:

```js
const tile = Buffer.alloc(256 * 256)
band.readPixelsSync({ x: 0, y: 0, width: 256, height: 256, into: tile })

// `into` is the buffer; both come back filled.
await band.readPixels({ x: 0, y: 0, width: 256, height: 256, into: tile })
```

GDAL writes through that memory, so the read costs no allocation and no copy — and the
call hands the very same object back, on the promise as well as in the call. It has to
be exactly the size the read produces (`outWidth * outHeight * bytesPerSample`); a
mismatch is refused rather than half-filled. `into` is a *read* option: `writePixels`
takes its data as the first argument, and passing `into` there is an error rather than
a silent no-op.

The async read fills the buffer on a worker thread, so the buffer is **borrowed until
the promise settles**: don't read it, write it, or hand it to another read in the
meantime. A second read into a buffer that is still being filled is refused rather than
raced — both would write the same memory, and the corrupted samples would arrive with no
error to explain them.

And for the small questions, where an options object is a lot of ceremony:

```js
band.getPixel(3, 4)                  // one sample, as a number
band.setPixel(3, 4, 7)

// The window `readPixelsSync` takes, as four numbers instead of an object.
band.readValues(0, 0, 4, 4)
band.writeValues(0, 0, 4, 4, bytes)

// GDAL's own unit of I/O: the block holding that point, clipped to the band.
band.readBlock(300, 200)
band.writeBlock(300, 200, bytes)
```

A read off the edge of the band is an error naming the window, not a quiet zero.
`readBlock` gives the block's rectangle *clipped to the band* — along the right and
bottom edges that is smaller than `blockSize`, because GDAL's own block read pads
those, and a value that was never in the file is not worth handing to JS. Both of
these return bytes, for the reason above.

And to walk a band that does not fit in memory, one strip at a time:

```js
// Off the event loop: strips are handed to the callback from the JS thread, and
// the walk reads the next only once this one has come back.
const strips = await band.readChunks({ rows: 64 }, (chunk) => {
  consume(chunk.data, chunk.x, chunk.y, chunk.width, chunk.height)
  return true          // `false` stops the walk
})

// The same walk on the calling thread.
band.readChunksSync({ rows: 64 }, onChunk)
```

`rows` defaults to the band's block height, which is the strip GDAL reads anyway, and
every strip arrives whole. `readChunks` runs the walk on the thread pool, so a raster
larger than memory does not have to hold the event loop; the callback still runs on the
JS thread, and the GDAL lock is released between strips while the worker waits for the
answer — so, unlike `onProgress`, the callback may call back into this library.
`readChunksSync` reads
between callbacks on the calling thread, which is the right shape when the caller is
already a worker. Both take the same answer as backpressure. (A band is not
async-*iterable* — napi cannot put `Symbol.asyncIterator` on a generated class — which
is why this walk is a callback; a layer's cursor can be, because the shell adds it;
see *Reading in batches*.)

The same walk is also a pair of **Node streams**, built by the shell over those reads:

```js
for await (const strip of band.createReadStream({ rows: 64 })) {
  // strip is a typed array of the band's own sample type, one strip at a time
}

band.createWriteStream({ rows: 64 }).end(allTheValues)
```

`band.createReadStream(options)` is an object-mode `Readable` whose chunks are typed
arrays of the band's own sample type — `Float64Array` for a `Float64` band — one strip
at a time; `band.createWriteStream(options)` is a `Writable` that consumes them the
same way and refuses a write it cannot place (half a row, or more than its window
holds). Both take the same window as `readChunksSync` — `x`, `y`, `width`, `height`,
and `rows` — and `gdal.features().streams` says they are there. They are shells over
the blocking reads, so a strip costs a synchronous read on the calling thread; the
thread-pool form of a long walk is still `readChunks`.

Two more options, both about the missing value: `type` reads and writes as another
sample type (`Float64Array`, or `'Float64'`), and `convertNoData` turns the band's
missing value into `NaN` on the way out and `NaN` back into it on the way in — which
needs a float type to have somewhere to put it:

```js
for await (const strip of band.createReadStream({ type: 'Float64', convertNoData: true })) {
  // missing samples are NaN, so the arithmetic below works on them
}
```

### Pixel-wise calc — `calcAsync`

Those streams are what `gdal.calcAsync` is made of: several bands in, one band out,
with a JS function applied to every pixel. It is `gdal_calc.py` with a callback in
place of an expression string.

```js
const temperature = (await gdal.open('T2m.tif')).band(0)
const dewpoint = (await gdal.open('D2m.tif')).band(0)
const output = gdal.createSync('cloudbase.tif', {
  driver: 'GTiff', width, height, bandCount: 1, dataType: 'Float64',
})

await gdal.calcAsync(
  { t: temperature, td: dewpoint },
  output.band(0),
  (t, td) => 125 * (t - td),        // Espy's estimate of the cloud base height
  { convertNoData: true, onProgress: (fraction) => console.log(fraction) },
)
```

Every band has to be the output's size, and `fn` takes one argument per input, in the
order given. The bands are read as the output's sample type, so `convertInput` decides
whether the *inputs* are converted to it first — which is what an integer output needs
before `convertNoData` has anywhere to put a `NaN`. `fn` runs on the JS thread, once
per pixel: that is the bottleneck and nothing here can change it. The reading and the
writing are what goes through the streams.

Underneath it are the two pieces it is built from, both usable on their own:

```js
const mux = new gdal.RasterMuxStream({
  t: temperature.createReadStream(),
  td: dewpoint.createReadStream(),
})                                    // chunks are { t: Float64Array, td: Float64Array }
const transform = new gdal.RasterTransform({ fn: (t, td) => 125 * (t - td), type: 'Float64' })

mux.pipe(transform).pipe(output.band(0).createWriteStream())
```

A `RasterMuxStream` reads its inputs in lockstep and publishes the largest amount all
of them have ready, so the pixels stay lined up however the strips fall; inputs that
end at different lengths destroy the stream with an error rather than answering short.
A `RasterTransform` is the elementwise half, and `new Transform({ objectMode: true,
transform })` is the way to do anything beyond arithmetic.

### Derived bands — VRT pixel functions

`calcAsync` is the **eager** way to combine bands: it computes everything once and
writes a real dataset. The other way is GDAL's own: a *derived* VRT band, which computes
its pixels as it is read, through a function GDAL calls.

```js
gdal.addPixelFunc('espy', gdal.createPixelFunc((t, td) => 125 * (t - td)))

const vrt = gdal.wrapVRT({
  bands: [{ sources: [temperature, dewpoint], pixelFunc: 'espy' }],
})
const cloudBase = gdal.openSync(vrt)          // nothing is written to disk
cloudBase.band(0).readPixelsSync()
```

`wrapVRT` answers the VRT as **XML text**, which is a dataset name GDAL understands, so
the whole thing stays in memory. Its descriptor is gdal-async's —
`{ bands: [{ sources, pixelFunc?, pixelFuncArgs?, dataType?, sourceTransferType?,
description? }] }` — and a band with no `pixelFunc` is a plain copy of its source, which
makes `wrapVRT` the general "bands into one VRT" call too.

Three ways to give `addPixelFunc` a function:

- `gdal.createPixelFunc((a, b) => a + b)` — a function of **one pixel**, called with one
  argument per source band, in the order the bands were given.
- `gdal.createPixelFuncWithArgs((args, a, b) => Number(args.k) + a + b)` — the same, with
  the VRT's `pixelFuncArgs` passed first. GDAL hands those over as strings.
- `gdal.toPixelFunc(fn)` — GDAL's own shape, `(sources, buffer, args)`, for when one pixel
  at a time is the wrong grain. `sources` is one typed array per source band, read as the
  band's own sample type; write into `buffer` and that is the band's answer.

`pixelFunc` may also name a function GDAL itself has — `inv`, `sum`, `diff`, `mul`,
`mean`, `min`, `max` and the rest — which needs no registration at all.

What it costs, and what it will not do:

- **The function runs on the JS thread**, because that is the only thread that can call
  back into JavaScript. GDAL calls it from inside its own raster loop, once per chunk.
- **A thread-pool read is refused.** `readPixelsSync()` and the rest of the blocking
  surface work; `readPixels()` on a derived band throws, naming the reason. The
  alternative is handing the call to an event loop that may be blocked on the lock the
  worker holds — a deadlock rather than an error.
- **Do not call back into this binding from inside one.** The read holds the process-wide
  lock while it waits for your answer, exactly as it does for `onProgress`.
- **A source band has to be readable by path**, since the VRT names the file. A band of a
  dataset that is still open for update in this process reads back as zeros through a
  VRT — GDAL's own built-in pixel functions included — so close a writer before using it
  as a source.
- **GDAL cannot unregister a pixel function.** A name and its slot last for the life of
  the process, and there are 32 of them.

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

`flushSync()` / `await flush()` exist at all three scopes GDAL writes at: the
**dataset** (`GDALFlushCache`), a **band** (`GDALFlushRasterCache`) and a **layer**
(`OGR_L_SyncToDisk`). `close()` flushes too, so they matter when writing for a long
time without closing — a bulk insert into one layer wants `layer.flush()`.

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

Georeferencing does not have to be affine. A raster registered from known points
carries **ground control points** instead:

```js
out.setGCPs(
  [{ id: '1', info: 'SW', pixel: 0, line: 0, x: 500000, y: 4600000, z: 0 } /* … */],
  gdal.epsgToWkt(32633),
)
out.gcpCount      // 3
out.getGCPs()[0]  // { id: '1', info: 'SW', pixel: 0, line: 0, x: 500000, y: 4600000, z: 0 }
out.gcpProjection // the WKT above — the CRS the points are in, not the raster's own
```

That is the path `gdalwarp -tps` uses, and the one a source with GCPs and no
`geoTransform` offers. What a format keeps is the format's answer: GTiff stores a
point's id and coordinates but not its `info`.

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

`setProjection` also takes a `SpatialRef` directly, so a CRS you already hold does
not have to go back through its WKT: `dest.setProjection(gdal.SpatialRef.fromEpsg(3857))`.

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

**`band.overviews`** is the pyramid a band already has: one entry per level, with
`index`, `size` and `dataType`, and `readSync()` / `read()` for that level's own
pixels. The getter asks GDAL each time, so a level built after the band object came
into being still shows up.

```js
dataset.buildOverviewsSync({ levels: [2, 4] })

const [first] = band.overviews
first.size          // [8, 8] for a 16x16 band
first.readSync()    // the stored decimation, at its own size
```

That is not the same as `readPixels({ outWidth, outHeight })`, which makes GDAL *pick*
a level and resample through it — reading the level itself gives the decimation that
was actually recorded.

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

`band.hasArbitraryOverviews` is what a source with no `overviews` answers `true` to:
it can compute a reduced resolution on demand — a network dataset, typically —
where a file has fixed levels or none.

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
- **The histogram has the same pair.** `histogram()` computes one; `defaultHistogram()`
  reads the stored one and `setDefaultHistogram()` writes it, so
  `band.setDefaultHistogram(await band.histogram({ min, max, buckets }))` is the
  whole round trip and a later reader pays nothing for it. `defaultHistogram(true)`
  asks GDAL to compute one when nothing is stored — which reads the band, hence the
  default of `false`.
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
toMercator.transformPointsSync(new Float64Array([13.4, 52.5, 2.35, 48.85]))
await toMercator.transformPoints(hugeArray) // the same, on the thread pool
toMercator.transformGeometry(polygon) // GeoJSON in, GeoJSON out
toMercator.transformBounds([13.0, 52.0, 13.8, 53.0])
```

`gdal.decToDMS(angle, axis, precision?)` renders a decimal degree the way `gdalinfo`
prints one — `decToDMS(45.5, 'Lat')` is `45d30' 0.00"N`; the axis label picks the
hemisphere letter and `precision` is the decimal places on the seconds (default 2).

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
- **A CRS has more than one spelling.** `fromESRI` reads ESRI's `.prj` dialect,
  `toXML()` is a third serialization beside `wkt` and `projJson`, `validate()` says
  whether the definition hangs together, `cloneGeogCS()` is the WGS 84 (or NAD27, …)
  underneath a projected CRS, `morphToESRI()` / `morphFromESRI()` convert it to and
  from ESRI's dialect in place, and `setWellKnownGeogCS(name)` resets its geographic
  component. `epsgTreatsAsLatLong` is the order the *EPSG authority* reads it in —
  separate from `axisMapping`, which is the order in force here.
  `isGeocentric` / `isLocal` classify it, `isSameGeogCS(other)` compares just the
  geographic basis rather than the whole definition, `getAttrValue('PROJCS')` reaches
  a WKT node by name, and `autoIdentifyEPSG()` fills in the code where GDAL can place
  the CRS (and leaves it alone where it cannot).
- **`equals` compares the definitions, not the spelling**: two differently written
  WKTs for WGS 84 are equal.
- **`identifyEpsg` returns a promise** because it searches the CRS database. A
  description that cannot be parsed throws; one that parses but matches nothing
  gives `null`.
- **`dataset.spatialRef` and `layer.spatialRef`** hand back the CRS of something
  you opened, and are `null` when it has none. `createLayer` now takes `wkt` as
  well as `epsg`, so a CRS that did not come from a code is no longer unusable
  there.
- **A point array has a threaded twin.** `transformPoints` is the same call as
  `transformPointsSync`, on the libuv pool, so a million coordinates is one call
  rather than a chunking loop you write to keep the event loop free. It rebuilds the
  transform where it runs — the two CRSes as WKT *and* their axis order travel with
  it — so it answers exactly what the sync form answers, `withAxisMapping('authority')`
  included.
- **Transformations are 2D**, and `transformGeometry` is synchronous: a geometry is
  one object rather than bulk data, and it hands back GDAL's own GeoJSON, which a
  threaded return cannot name a type for. The bulk case is the array.

### Choosing the transformation

`new CoordinateTransform(from, to)` lets GDAL pick the best operation it can find,
which is usually the right answer. When it is not — you want a specific pipeline, a
floor on accuracy, or a refusal to guess — pass options:

```js
// Use this operation instead of the computed one. A PROJ string, a WKT2
// coordinate operation, or an `urn:ogc:def:coordinateOperation:EPSG::XXXX` URN.
new gdal.CoordinateTransform(from, to, { pipeline: '+proj=pipeline …' })

// Only operations at least this good (in metres); 0 means "conversions only".
new gdal.CoordinateTransform(from, to, { accuracy: 1 })

// Refuse a "ballpark" fallback, so "there is no proper transformation" becomes a
// failure instead of a silently approximate answer.
new gdal.CoordinateTransform(from, to, { ballpark: false })

// Where you are, when several operations exist for one pair of CRSes.
new gdal.CoordinateTransform(from, to, { areaOfInterest: [12, 50, 14, 52] })
```

**A `pipeline` sees swapped coordinates.** GDAL hands a named operation the
coordinates in the source CRS's **authority** order — latitude, longitude for
`EPSG:4326` — *not* the longitude,latitude order every other call here speaks. So a
hand-written pipeline that assumes this API's order has to say so:

```js
new gdal.CoordinateTransform(wgs84, utm33, {
  pipeline: '+proj=pipeline +step +proj=axisswap +order=2,1 +step …',
})
```

It is the same trap as above, moved one level down: the pipeline is written in
PROJ's own terms, and PROJ's terms are the CRS's, not this binding's.

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
layer.fields                            // each field's whole definition, see below
layer.field('population')               // one by name, or null
layer.extent                            // [minX, minY, maxX, maxY] or null
layer.spatialRefWkt                     // WKT, or null

layer.featuresSync()                    // every feature, materialised
await layer.features()                  // the same read, off the event loop
layer.feature(3)                        // one by feature id, or null

layer.setAttributeFilter('population > 1000')   // OGR SQL WHERE; null clears it
layer.setSpatialFilterRect(minX, minY, maxX, maxY)
layer.setSpatialFilter({ type: 'Polygon', coordinates: [ring] })  // any geometry
layer.getSpatialFilter()                // the filter as a Geometry, or null
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

### Features as objects

`feature(fid)` and `featuresSync()` hand back plain data. When you would rather
have methods, `getFeature(fid)` is the same feature as an object:

```js
const feature = layer.getFeature(3)     // or null
feature.fid                             // 3
feature.geometry                        // GeoJSON, or null
feature.fields.get('population')        // 4500
feature.fields.has('nope')              // false
feature.fields.set('population', 4600)  // written straight through
feature.fields.toObject()               // { name: 'beta', population: 4600 }
feature.toObject()                      // the plain record feature(3) returns
```

Every read and write goes back to the layer, so there is no cached copy to keep in
sync and no `save()` to remember — `fields.set` is the same write
`updateFeature(fid, null, { population: 4600 })` makes.

`layer.defn` is a layer's schema in one object — `name`, `geometryType`,
`geometryColumn`, `fidColumn`, `fieldCount` and `fields` — and `feature.defn` is
the same object.

Geometry helpers take and return GeoJSON objects:

```js
gdal.geometryTypeOf({ type: 'Point', coordinates: [10, 20] })  // 'Point'
gdal.geometryToWkt(point)                                      // 'POINT (10 20)'
gdal.geometryToWkb(point)                                      // Buffer
gdal.geometryFromWkt('POINT (10 20)')                          // GeoJSON object
gdal.geometryFromWkb(buffer)                                   // GeoJSON object
```

Those are the plain-data helpers. `gdal.Geometry` is the same geometry as an
object, for when you want to measure or move it without going back through JSON:

```js
const { Geometry } = gdal

const square = Geometry.fromWkt('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))')
square.type        // 'Polygon'
square.area()      // 100
square.length()    // 40
square.envelope()  // { minX: 0, minY: 0, maxX: 10, maxY: 10 }
square.toJson()    // what a feature's `geometry` would have carried

// Build from any of the three encodings — including the GeoJSON a feature has.
Geometry.fromJson(record.geometry)
Geometry.fromWkb(gdal.geometryToWkb(point))

// Transforms return a *new* geometry; the one you hold never changes.
Geometry.fromWkt('POINT (1 2 3)').flattenTo2D().toWkt()   // 'POINT (1 2)'
Geometry.fromWkt('LINESTRING (0 0, 0 10)').segmentize(1)  // ...pointCount 11
Geometry.fromJson(point).transform(gdal.SpatialRef.fromEpsg(4326), gdal.SpatialRef.fromEpsg(3857))
```

The shape-specific accessors answer for their own shape and are `null` for the
others, so any of them can be read without asking `type` first:

```js
Geometry.fromWkt('POINT (3 4)').x                     // 3
Geometry.fromWkt('POINT (3 4)').z                     // null — a 2D point has no z
Geometry.fromWkt('LINESTRING (0 0, 1 1)').points()    // [[0, 0], [1, 1]]
Geometry.fromWkt('POLYGON ((…), (…))').exteriorRing   // the outer ring
Geometry.fromWkt('POLYGON ((0 0, 1 0, 1 1, 0 0))').interiorRings  // [] — no holes
Geometry.fromWkt('MULTIPOINT ((0 0), (1 1))').children().map((p) => p.x)  // [0, 1]
```

`children()` hands back `Geometry` objects — copies, so each part is usable on its
own. There is no `Point` / `Polygon` subclass: our geometry is one class whose
accessors are per-shape, and `type` says which shape it is.

A geometry carries no CRS of its own, so `transform` names both ends — the
layer's `spatialRefWkt` is the `from` for a feature you read.

And every writer that takes a geometry takes **either** shape, so the two never
have to be converted by hand:

```js
layer.createFeature(Geometry.fromWkt('POINT (1 2)'), { name: 'a' })
layer.createFeature({ type: 'Point', coordinates: [3, 4] }, { name: 'b' })
layer.setSpatialFilter(Geometry.fromWkt('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))'))
layer.updateFeature(fid, Geometry.fromWkt('POINT (5 6)'))
feature.setGeometry(Geometry.fromWkt('POINT (7 8)'))
raster.rasterizeSync([Geometry.fromWkt(box), geojsonBox], { burnValues: [1, 2] })
```

### GEOS: predicates and set algebra

`Geometry` also carries the operations GDAL implements through GEOS — the
predicates (`intersects`, `contains`, `within`, `crosses`, `touches`, `overlaps`,
`disjoint`, `equals`), `distance`, `isValid` / `isSimple`, and the set algebra
`buffer`, `centroid`, `convexHull`, `simplify`, `simplifyPreserveTopology`,
`union`, `intersection`, `difference` and `symDifference`; the repair and reshape
`makeValid`, `boundary`, `pointOnSurface`, `unaryUnion`, `concaveHull`, `normalize`
and `setPrecision`:

```js
if (gdal.features().geos) {
  const hits = plot.intersects(roads)
  const ring = plot.buffer(100, 16)     // 100 units out, 16 segments per quadrant
  const merged = plot.union(neighbour)  // a new Geometry
  const fixed = broken.makeValid()      // GEOS's repair for a bad polygon
}
```

`isRing()`, `toGML()` and `toKML()` round out the geometry surface and need no GEOS
— they are plain OGR.

GEOS is fetched, compiled and statically linked by the build, the way GDAL and
PROJ are, so this all works out of the box and the package stays one
self-contained artifact. `docs/GEOS.md` records that decision (and why a shared
GEOS would be worse here), plus the LGPL-2.1 §6 material a release owes.

A build *without* GEOS keeps the same surface: each of these answers with "this
build has no GEOS" rather than a `false` that looks like an answer, and
`gdal.features().geos` is the probe that keeps you off that path.

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
- **An array becomes a `String` holding comma-joined text**, not a list field — and
  that is the portable answer rather than a shortcut. Whether a list column exists
  is the driver's business, and these drivers disagree: **GeoJSON** and **SQLite**
  store a real list and hand the array back; **GPKG** accepts the declaration,
  warns that the type "is not handled natively. Falling back to String.", and
  creates a scalar column — so a list value written there lands as GDAL's internal
  `(2:a,b)` text, which is neither the value nor usable as one; **FlatGeobuf**
  accepts the *field* and then refuses the feature write. Joined text is the one
  form that survives all of them. Fields that are *already* list-typed (read from
  GeoJSON, say) are still written as real lists, and declaring `StringList`
  explicitly is how you ask for one — `ts-test/native/vector-write.spec.ts` pins all
  four behaviours.

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

`dataset.copyLayer(sourceLayer, name, options?)` copies a whole layer — schema and
features both — into **this** dataset under a new name: GDAL's `GDALDatasetCopyLayer`,
the way a layer moves between two datasets without re-reading it feature by feature. The
source has to be a *different* dataset; a self-copy is refused rather than deadlocking,
because both handles would have to be held at once and GDAL's per-dataset mutex is not
reentrant.

```js
const source = gdal.openSync('places.geojson')
const target = gdal.createVectorSync('places.gpkg', 'GPKG')
target.copyLayer(source.layer(0), 'places')  // features, fields and all
```

A layer's CRS is set where the layer is made — `createLayer({ epsg })` or `{ wkt }` —
and can also be changed afterwards:

```js
layer.setSpatialRef('EPSG:3857')                       // or a SpatialRef
layer.setSpatialRef(gdal.SpatialRef.fromEpsg(32633))
```

Which formats allow that is the format's business, and it is worth knowing before
reaching for it. GDAL's C API has no `OGR_L_SetSpatialRef`; a layer's CRS is its
geometry field's, so this goes through `OGR_L_AlterGeomFieldDefn`, which asks the
*driver* to rewrite the definition — writing through the definition object itself does
not work, because it is sealed once the layer exists. **GPKG and Shapefile take it**
and persist it (the `.prj` is rewritten); **GeoJSON, SQLite and FlatGeobuf do not**,
and the call fails naming the driver rather than silently doing nothing. The dataset's
own CRS is separately writable with `setProjection`.

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

A `FieldDefinition` also takes `nullable`, `unique`, `defaultValue` (as text —
GDAL's own representation, so an integer default is the string `'0'`) and
`justification` (`'Undefined'`, `'Left'` or `'Right'`). `layer.fields` reports all
of them back, so a definition round-trips:

```js
layer.fields
// [{ name: 'label', fieldType: 'String', width: 64, precision: 0,
//    nullable: true, unique: false, defaultValue: null, justification: 'Undefined' }]
```

### Changing a schema

`createLayer` declares the schema; a layer that already exists can also be changed.
Every call is by **name**, not index, because a change shifts the ones after it:

```js
layer.addField({ name: 'area', fieldType: 'Real', defaultValue: '0' })
layer.deleteField('note')
layer.reorderFields(['area', 'label'])   // has to name every field, each once
```

`addField` takes the same `FieldDefinition` `createLayer` does, so a field declared
one way and added the other describe themselves identically. Not every driver can:
`layer.testCapability('CreateField')` is the question to ask first, and a driver
that refuses says so rather than half-doing it — GeoPackage, being SQLite, will not
drop a column a `UNIQUE` index depends on, and passes that reason through.

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

A cursor is also **async-iterable**, which is the same read with the batches left
implicit — one record per turn, and stopping when the layer runs out:

```js
for await (const feature of layer.openCursor({ batchSize: 1000 })) {
  consume(feature) // a feature, not a batch
}

// Breaking out stops early without draining the layer.
for await (const feature of layer.openCursor()) {
  if (enough(feature)) break
}
```

The iterator yields what `read()`'s batches contain, and stops on the empty batch
that ends them — so `for await` and the manual loop cannot disagree.

Three things to know, all of them GDAL's shape rather than this API's:

- **One reader per layer at a time.** GDAL keeps the reading position *on the
  layer*, which is what lets a batch resume where the last one stopped — and what
  makes a second cursor, or a `featuresSync()` call, rewind the first. Read the
  batches in order and do not mix the two ways of reading one layer.
- **Two independent readers means two dataset handles.** There is no per-cursor
  position to hand out: `open(path)` the same source a second time and read one
  layer from each. The two then page independently and each sees the whole layer —
  a test pins that, and pins the interleaving that happens without it.
  `layer.getFeature(fid)` is the other way in: it is random access, so it answers
  for its one feature without moving the position under a reader.
- **`close()` does not touch GDAL.** Anything else reading that layer rewinds it
  anyway, so leaving the position where it stopped costs nothing.

The whole-layer reads (`featuresSync()` / `features()`) rewind before they start, so
they return the whole layer even with a cursor part-way through it. They do still
leave the position at the end — there is only one position to leave it at — so a
cursor picks up from the beginning afterwards.

On a feature, `fid` and `geometry` are `null` when absent — matching
`properties`, where a SQL `NULL` is also `null`.

### SQL

`executeSql()` runs a query through GDAL's `GDALDatasetExecuteSQL` and hands back
the rows as plain records, the same shape `featuresSync()` returns:

```js
const rows = dataset.executeSql(
  'SELECT name, population FROM places WHERE population > 1000',
)
// [{ fid, properties: { name: 'beta', population: 4500 }, geometry: null }, ...]
```

A query gets records rather than a `Layer` on purpose: a result set has no layer
index — it can join layers, alias or aggregate fields — so there is no
`dataset.layer(i)` it belongs to. The second argument names GDAL's SQL dialect,
`'OGRSQL'` or `'SQLITE'`; leave it out for the driver's own default. A statement
with no result, an `ALTER TABLE` or `CREATE INDEX`, comes back as `[]`.

### Transactions

`startTransaction()`, `commitTransaction()` and `rollbackTransaction()` group
writes into one unit — GDAL's `OGR_L_StartTransaction` and friends:

```js
layer.startTransaction()
try {
  layer.createFeature(point, { name: 'a' })
  layer.createFeature(point, { name: 'b' })
  layer.commitTransaction()
} catch (error) {
  layer.rollbackTransaction()
  throw error
}
```

Not every driver has them: `layer.testCapability('Transactions')` is the answer
before you rely on the grouping. A driver without support warns and carries on as
though there were no transaction, so the grouping silently means nothing there.

One GeoPackage wrinkle: it creates the layer's table lazily, on the first write.
Make that first write *outside* the transaction. Inside one, the `CREATE TABLE` is
rolled back along with the features and every later write fails with `no such
table`.

### Feature ids, geometry columns and capabilities

```js
layer.fidColumn                           // 'fid', or null when GDAL generates ids
layer.geomColumn                          // 'geom', or null for a layer with no geometry
layer.testCapability('FastFeatureCount')  // true / false
layer.testCapability('Transactions')
```

`testCapability` takes GDAL's own names — `FastFeatureCount`, `FastGetExtent`,
`RandomRead`, `SequentialWrite`, `DeleteFeature`, `Transactions`, `CreateField`,
`CreateGeomField`, and the rest. A name GDAL does not know answers `false` rather
than throwing: the call is a question, and "no" is one of its answers.

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

## Multidimensional — `Group`, `MDArray`, `Attribute`, `Dimension`

GDAL's second data model, which is what NetCDF, HDF5 and Zarr look like through it:
arrays of any number of dimensions, each with attributes and its own CRS, arranged in
a tree of groups. It is reached through `Dataset.root`, and only for a dataset opened
with `multidimensional: true` — GDAL builds no root group otherwise.

```js
const dataset = await gdal.open('air.nc', { multidimensional: true })
const root = dataset.root              // null when the file has no such model
root.arrayNames()                      // ['temperature', 'pressure']
root.groupNames()                      // sub-groups, by name

const temperature = root.openArray('temperature')
temperature.shape                      // [12, 73, 144] — time, lat, lon
temperature.dataType                   // 'Int16'
temperature.dimensions()               // Dimension objects: name, size, typeName, direction
temperature.attributes()               // Attribute objects, in the file's order
temperature.openAttribute('units').value   // 'K'
temperature.srs                        // a SpatialRef, or null

// A hyperslab, as raw bytes in the array's own type.
const january = temperature.read({ start: [0, 0, 0], count: [1, 73, 144] })

// The bridge back to the raster side: a 2D view, so `readPixels` works on it.
const raster = temperature.asDataset()
raster.band(0).readPixels({ width: 144, height: 73 })
```

Four things about it:

- **Opening with the flag gives you the multidimensional dataset.** For a NetCDF file
  the band side is then empty (`bandCount` is 0) and `root` is the way in. Open the
  same path without the flag to get the bands instead. A file with no such model — a
  GeoTIFF — opens as an ordinary raster either way, with `root === null`.
- **`asDataset()` picks X and Y, or you do.** It uses the dimensions GDAL marks
  `HORIZONTAL_X` and `HORIZONTAL_Y`; failing that, the last two. A file that leaves its
  axes untagged lands on that fallback, so pass `{ xDim, yDim }` to say which is which.
- **`read()` answers bytes in the array's own type**, like `readPixels`, and only for
  numeric arrays — a `String` or `Compound` array is refused rather than coerced.
  `getView()` and `getMask()` hand back further `MDArray`s over the same data.
- **A handle keeps GDAL's own reference to the file.** Closing the dataset closes the
  raster side — later calls say so — but a `Group` or `MDArray` you are still holding
  keeps working, and on Windows keeps the file locked until it is let go.

Attributes come back as JavaScript values: a string, a number, or an array of either,
according to the attribute's type and how many elements it holds.

## Async semantics — read this before relying on it

GDAL work in this binding goes through a **process-wide `RwLock`**, taken on one of two
sides, and underneath it **one dataset is one reader at a time**. An `RwLock` rather than
a mutex because the two sides answer different hazards, and neither of them is GDAL's
last-error state any more: that became *thread-local* in GDAL 3.10, which is what makes
the split possible at all.

- **The exclusive (write) side** is process-global state, and only that: driver
  registration and `configureDataPaths()`, `config.set` — with `config.get`, which
  reads a pointer into the same map — writes through `gdal.fs`, and the `programs`
  (`translate`, `warp`, `ogr2ogr`, `gdaldem`, `buildVrt`) with the `create` / `createCopy`
  paths beside them. They build datasets of their own and write files, so no dataset
  operation may run while one is rewriting the file it is reading.
- **The shared (read) side** is everything else, and it really does run in parallel: an
  open, every operation on an open dataset, the CRS and `CoordinateTransform` methods,
  geometry/GEOS, `gdal.fs` reads, and the module-level introspection — `version()`,
  `info()`, `diagnostics()`, `lastError()`, `epsgToWkt()`, the `geometry*` helpers, and
  the registry reads `drivers()` / `driver(name)` (a method on the `Driver` they hand
  back reads the registry too).

What keeps a dataset safe is then **not** this lock but that handle's own mutex: the same
dataset reached from two threads serialises, and two *different* datasets do not wait for
each other. That is exactly the pair GDAL's own contract names — it is thread-safe as
long as no single handle is used from two threads at once.

The async APIs keep the Node **event loop** free either way — the work itself is not made
parallel by them. Ten concurrent `readPixels()` calls on *one* dataset take as long as ten
sequential ones (that is the handle mutex, and GDAL's own rule); ten on ten datasets do
not.

### Real parallelism: `openThreadSafe()`

GDAL ≥ 3.10 has `GDALGetThreadSafeDataset`, and this binding wires it up:

```js
const dataset = await gdal.openThreadSafe('big.tif')
const band = dataset.band(0)

// These genuinely overlap instead of queueing on the lock.
const tiles = await Promise.all(windows.map((window) => band.readPixels(window)))

// So does a question about the dataset that reads nothing new.
const [size, transform] = [band.size, dataset.geoTransform]
```

A **read** of such a dataset goes one step further than a read of an ordinary one: it
takes the shared side of the lock *and skips the handle's own mutex*, because GDAL has
been asked to make that one handle safe for concurrent readers. An ordinary read takes
the same shared side but does take the handle mutex — which is why several reads of one
ordinary dataset still queue, and one read each of several datasets do not. What is in it
is a pixel window, and the accessors that only look at what the dataset already knows — `width`, `height`,
`rasterSize`, `bandCount`, `geoTransform`, `projection`, `spatialRef`, `description`,
`driver`, `metadata`, `getFileList`, `band()`, and on a band `size`, `blockSize`, `id`,
`noDataValue`, `scale`, `offset`, `unitType`, `colorInterpretation`, `minimum`,
`maximum`, `categoryNames`, `overviewCount`, `overviews`, `metadata`. `checksum` and a
whole overview level are in it too: they walk the samples without keeping them, which is
a read. So asking for the size of a band no longer queues behind the pixel reads.

The rule for what is left on the handle's mutex: anything that writes, and anything that
makes GDAL *compute and keep* an answer. `writePixels`, `setProjection`,
`setGeoTransform`, `setMetadataItem`, `flush` and the vector side obviously; so do
`statistics()`, `histogram()` and `defaultHistogram()`, which store what they compute on
the dataset, and the programs, which build datasets of their own. `config.get` is the one
*read* that has to stay on the exclusive, process-wide side — not because the store is
unguarded, GDAL takes its own
mutex around it, but because `CPLGetConfigOption` returns a pointer into it and drops the
guard, so a concurrent `config.set` could free the string before this binding copies it.

```sh
node scripts/bench-parallel.mjs big.tif --concurrency 4 [--min-speedup 1.5]
```

It measures five workloads: whole-band reads on both paths, the same batch of reads split
across two ordinary handles, the same batch with the read-only accessors asked in the
middle of them, a dataset-free workload
(a coordinate transform) as the sharpest measurement of the lock itself, and the
module-level surface asked during that workload — the same rounds on an idle process and
then while the transforms are in flight, so the two numbers say whether the
introspection waited. The accessor and surface loops are calibrated against the work
they run during, so they are comparable on any machine and any raster.

It is a benchmark and not a test — nothing fails on the timings by default, because
they depend on the machine and on the storage. The exception is `--min-speedup`, which
CI passes, and it gates two ratios: the one between four dataset-free transforms issued
together and one at a time — lock contention and nothing else (about 3x while that work
is on the shared side, about 1x if it ever moves back) — and the one between the same
reads on two handles and on one, which cannot leave 1x at all unless a dataset operation
stopped taking the process-wide lock in write mode. A ratio between two measurements on
the same machine survives a slower machine where a wall time would not, and CI
**archives** the run rather than only asserting on it: the numbers land in the run
summary and in a `bench.log` artifact.

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

### Async getters

Every read-only property has a twin that answers the same thing off the thread pool:

```js
band.dataType        // 'Float64', now
await band.dataTypeAsync   // the same, without stopping the event loop to get it
```

They are **getters**, not methods — `await band.sizeAsync`, no parentheses. A band has
`sizeAsync`, `blockSizeAsync`, `dataTypeAsync`, `colorInterpretationAsync`,
`descriptionAsync`, `unitTypeAsync`, `noDataValueAsync`, `scaleAsync`, `offsetAsync`,
`minimumAsync`, `maximumAsync`, `idAsync`, `readOnlyAsync`,
`hasArbitraryOverviewsAsync`, `categoryNamesAsync` and `colorTableAsync`; a dataset has
`rasterSizeAsync`, `geoTransformAsync` and `spatialRefAsync`.

What they are for is the *wait*, not the work — a getter takes the process-wide lock on
the shared side *and* the dataset's own mutex. Read one while an async read of that same
dataset is in flight and the synchronous form stops the event loop until that read
finishes; this form leaves the waiting to the thread pool. (The reference's `Async`
suffix is kept
here, the one place this binding's "the async form drops the `Sync` suffix" rule has
nothing to apply to: `band.dataType` is a property, so a `band.dataType()` cannot exist
beside it. `gdal.infoAsync()` is the same exception in function form.)

### A warning when a blocking call stops the loop

A `*Sync` call holds the JS thread for as long as it takes, and for a server that is
the event loop stopped. `gdal.eventLoopWarning` says so when it runs long:

```
GdalEventLoopWarning: RasterBand.readPixelsSync() held the event loop for 9.1 ms
```

`false` turns it off, `true` turns it back on at the default threshold of 50 ms, and a
number sets that threshold in milliseconds. What is timed is the blocking methods of
the classes that reach a dataset — `Dataset`, `RasterBand`, `BandOverview`, `Layer`,
`FeatureCursor` — because those are the calls whose length the caller cannot know. The
warning goes through `process.emitWarning`, so it can be caught:

```js
process.on('warning', (warning) => {
  if (warning.name === 'GdalEventLoopWarning') log.warn(warning.message)
})
```

### Resources: handles, descriptors and streaming

Three things worth knowing together, because they are all about *how much* a process
holds open:

- **`close()` is the release.** It is idempotent, and it runs `GDALClose`; a `RasterBand`
  or `Layer` holds the dataset's handle rather than a GDAL pointer of its own, so closing
  the dataset invalidates every object derived from it — a later call throws instead of
  touching freed memory.
- **`openThreadSafe()` can cost file descriptors.** Most drivers are not natively
  thread-safe, so GDAL *reopens the file per thread* for those; GTiff and COG (libtiff)
  do not, and are the cheap case. Raise `UV_THREADPOOL_SIZE` for more overlap and
  `ulimit -n` with it. A plain `open()` dataset is one handle whatever the concurrency.
- **Streaming, when a raster is bigger than memory.** `readChunks` / `readChunksSync`
  hand over one strip at a time (see *Raster*), and `readPixels({ into })` writes into a
  buffer you already own — no allocation and no copy, which is what a tile loop wants.
  The ordinary window reader allocates the window and nothing more, so
  `readPixels({ window })` is already bounded by the window's size.

### Error codes

A sync failure sets `err.code` to a stable token — `GDAL_CPL_FAILURE`,
`GDAL_CPL_WARNING`, `GDAL_BAD_ARGUMENT`, `GDAL_MISSING_PROJ_DATA`, ... — and puts
GDAL's own class and number in the message: `[CPLErr=3 #4] ...`.

An async failure sets the **same** token, and *also* prefixes it to the message:

```js
try {
  await gdal.demProcess(dest, source, 'hillshade', [], undefined, () => false)
} catch (error) {
  error.code              // 'GDAL_CANCELLED'
  error.message           // '[GDAL_CANCELLED] cancelled by the progress callback'
}
```

Both hold because the token *has* to travel in the message: `napi::Task` pins its
error type to `napi::Error<Status>`, so the binding cannot attach a custom status
to a rejection — `err.code` would be the useless `'GenericFailure'`. The shell
lifts the prefix back out into `err.code` on the way to you, so a `catch` can
branch on the code on either surface, and a caller matching the message prefix
keeps working.

## Examples

`examples/` holds four runnable scripts. Run them from the repository root (they
load the package through `..`, so nothing needs publishing first).

```sh
node examples/gdalinfo.mjs path/to/anything.tif
node examples/to-cog.mjs in.tif out.tif COMPRESS=ZSTD
node examples/convert-vector.mjs roads.geojson roads.gpkg roads
node examples/parallel-tiles.mjs
```

They are also wired up as `npm run gdalinfo -- <file>`, `npm run to-cog -- …`,
`npm run to-vector -- …` and `npm run tutorial:parallel`.

- **`gdalinfo.mjs`** — a miniature `gdalinfo` that handles rasters *and* vectors,
  so it exercises the whole read path.
- **`to-cog.mjs`** — re-write any raster as a Cloud-Optimized GeoTIFF through
  `createCopy`, then reopen it and show the `IMAGE_STRUCTURE` that proves it.
- **`convert-vector.mjs`** — copy every feature of one vector file into another,
  letting `createFeature` build the schema from the properties it sees.
- **`parallel-tiles.mjs`** — build a tiled raster and read it both ways, serial
  and `openThreadSafe` parallel, to show the thread-safe read path and its
  speedup.

[`docs/TUTORIALS.md`](./docs/TUTORIALS.md) walks through all four.

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

- **Every leg runs the same steps.** A leg is just a `target` and a `runs-on`; the
  musl ones are not special-cased in the workflow. Where a command has to run in a
  different libc — a musl build, and its tests — `scripts/ci-run.mjs` re-enters the
  container, and every other leg runs the command as it stands. That script is the
  only place the container is mentioned.
- **Every glibc/Windows/macOS leg is built on a native runner of the matching
  architecture.** Cross-compiling a statically linked GDAL is not worth the
  trouble, so the arm64 Linux leg uses GitHub's arm64 runner rather than a cross
  toolchain.
- **The musl legs build and test inside a musl-native Alpine container**
  (`docker/musl.Dockerfile`) on a runner of their own architecture, so the
  container's own toolchain already targets the musl triple cargo is asked for and
  the whole build is native — no cross toolchain, no sysroot, no emulation. The
  suite runs in the same image, where musl is the native libc: napi links musl
  dynamically, so the runner's glibc Node could not load the addon at all.
- **They are ordinary legs, not `experimental` ones.** They build the same source as
  the glibc legs against a different libc, and a red musl leg fails the run like any
  other. If a vendored C library (`all_drivers` pulls in HDF5, netCDF, curl and
  libpq) breaks there, that is a real failure to fix rather than noise to ignore. If
  you need musl outside CI, build it with the container in `docker/`.

Every leg runs the Node suite and the packed-tarball smoke test. A separate `checks`
job carries the gates that need no GDAL — `cargo fmt --check`, the TypeScript
type-check of `compat/index.d.ts`, `scripts/check-docs.mjs --static` and
`scripts/check-licenses.mjs` — so a style, type, doc or licence slip fails in about
a minute rather than at the end of the source build. The `linux-x64-gnu` leg, whose
toolchain is already warm, carries the rest: clippy with `-D warnings`, the Rust
unit tests, the cross-target StatBuf type arms, the compatibility coverage floor,
the documentation check against the built addon, the SBOM, and the lock benchmark
— see *Async semantics* for what that gate is and why it can fail — whose numbers
are archived in the run summary and as an artifact.

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
| GEOS | fetched, compiled and **statically linked** (`geos-src`); LGPL-2.1, see the licence section |

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

**GEOS** is linked in as well — fetched, compiled and statically linked like the
rest — which is what makes `Geometry.intersects`, `buffer`, `simplify` and the
set algebra work.

What is deliberately *not* there:

- **Formats needing an XML library this build does not link** — KML, GML, GPX,
  GMLAS, LIBKML, XLSX/XLS and DWG among them — plus the ones behind a vendor SDK
  (FileGDB, Oracle, MySQL) and the JPEG2000 / WebP / HEIF / AVIF family.
- **`PDS`**, the one driver this package cannot offer at all: `gdal-src`'s
  published crate does not ship `frmts/pds/data`, so switching it on fails GDAL's
  configure step. That is why `all_drivers` leaves it out.

All of it is statically linked, so an installed package still needs nothing on the
host. The price is size — the `.node` is about 40 MB (a 131-driver build was 28 MB)
and a tarball about 17 MB compressed, plus a few minutes of extra build time. To trim it, swap `gdal-src/all_drivers` for the individual
`gdal-src/driver_*` features you actually want — or build the curated
`bundled-lean` set (`--no-default-features --features bundled-lean`), which drops
the vendored HDF5/netCDF/curl/PostgreSQL drivers and keeps the internal formats
plus SQLite/GPKG and GEOS. See [`docs/MUSL-LEAN.md`](./docs/MUSL-LEAN.md).

`openThreadSafe()` needs GDAL ≥ 3.10, which the bundled build satisfies. Linking a
system GDAL older than that (`--no-default-features`) still compiles — the method
is simply absent, because `build.rs` reads the version `gdal-sys` reports and only
switches it on where `gdal::ThreadSafeDataset` exists.

### Targets

CI builds six targets, the ones in the table under "Prebuilt binaries":
`win32-x64-msvc`, `darwin-arm64`, `linux-x64-gnu`, `linux-arm64-gnu`, and the two
musl ones. The musl legs are ordinary legs like the rest — a red one fails the run —
and they build in a musl-native Alpine container. 32-bit targets are not built.

Those two legs run their test suite in that same container rather than on the
runner, because napi links musl dynamically (it adds
`-C target-feature=-crt-static`) and the runner's glibc Node cannot load such an
addon at all — one process, two libcs. The container is the honest place for it:
the generated loader resolves to musl there, so the suite exercises the real
artifact.

## Coming from `gdal-async`

The main entry point is **not** a drop-in replacement — it is 0-based, spells the
blocking form `xxxSync()`, and sets through `setX()`. [`docs/PARITY.md`](./docs/PARITY.md)
is the full accounting of where the two stand: what is at parity, the additive gaps,
and the conventions map — and [`docs/COMPARISON.md`](./docs/COMPARISON.md) is the
synthesis beside it: the differences that remain, strengths and weaknesses on both
sides, and how to choose. Two of the reference's shapes are here as well, spelled the same
way. The **containers answer both spellings**: this binding spells one as a call that
returns an array, gdal-async as an object with `get` / `count` and iterators, and a
JavaScript function is an object — so the call carries the collection surface and
nothing that worked before changed:

```js
dataset.bands()                            // what it always was: the array
dataset.bands.get(1)                       // 1-based, as gdal-async counts
dataset.bands.count()                      //
for (const band of dataset.bands) { … }    // and `for await`, and `map` / `forEach`
band.pixels.get(0, 0)                      // the pixel accessors, under its names
group.arrays.get('temperature')            // the multidimensional model too
```

And the **geometry class family**: `Geometry.fromWkt('POINT (1 2)') instanceof
gdal.Point` is true, as are `Polygon` / `MultiPoint` / `GeometryCollection` and the
rest, because the shell re-tags what the factories and the operations answer. The
classes add no members — every accessor is on `Geometry`, where a shape-specific one
answers `null` for the wrong shape — so what they add is the one thing a port reaches
for: `instanceof`, which narrows in TypeScript too.

A second entry point is:

```js
const gdal = require('gdal-rs-napi/compat')
```

It is a JavaScript adapter over the same binding rather than a second
implementation, so nothing is reimplemented and nothing is lost:

```js
const dataset = gdal.open('dem.tif')
const band = dataset.bands.get(1)          // 1-based, as gdal-async counts
band.pixels.read(0, 0, 4, 4)               // a typed array of the band's own type
band.noDataValue = -9999                   // assignment, not setNoDataValue()
dataset.srs = new gdal.SpatialReference(wkt)

for (const feature of layer.features) {    // iterable, like a collection
  feature.fields.toObject()                // { … }
  feature.geometry instanceof gdal.Point   // the class family, instanceof and all
}

const root = dataset.root                   // the multidimensional model, reshaped
root.arrays.get('temperature').read()      // a typed array of the whole array
```

`feature.fields.set('population', 11)` writes straight through, and
`feature.geometry = gdal.fromWKT('POINT (9 9)')` replaces it. The blocking/async
pair is `xxx()` / `xxxAsync()`, and `xxxAsync` also takes a node-style callback.

What it does **not** reshape, so a port does not find out the hard way: the mask band
(`band.mask` is the main entry point's; the adapter's `getMaskBand()` /
`createMaskBand()` forward to the same native band), and `gdal.algebra`, whose eager
band methods live on the bands themselves (`band.add`, `band.mul`, … — the adapter
carries those too). Everything else the native API can do, the adapter can:
`calcAsync`, the VRT pixel functions, the command-line programs and their
`translate`/`warp` family, the multidimensional model, and the GEOS predicates, since
they are in the same build. Raster streams are on both — `band.pixels.createReadStream()`
and the main entry point's `band.createReadStream()`.
`PHASE1.md` (WS-7) is the full list.

## Licence

MIT. GDAL and PROJ are MIT/X11; see `LICENSE`, and `THIRD-PARTY.md` for everything
else that is compiled into the package.

GEOS is the exception there: it is LGPL-2.1, and it is linked **statically** into
the shipped `.node`. LGPL-2.1 §6 asks the distributor of a statically linked work
for the means to relink it against a modified GEOS, so each release carries
`…-lgpl-geos.tar.gz` beside the platform tarball — the GEOS source that built it,
the static archives, and a relink note (`npm run lgpl`). That is a condition on
what a release *publishes*, not a change to the licence of this code — see
`docs/GEOS.md`.

## Contributing and security

Contributions are welcome — [`CONTRIBUTING.md`](./CONTRIBUTING.md) covers the
build, test and API conventions. Runnable tutorials are in
[`docs/TUTORIALS.md`](./docs/TUTORIALS.md). Security problems go through
[`SECURITY.md`](./SECURITY.md) and GitHub's private advisories, not the public
issue tracker.
