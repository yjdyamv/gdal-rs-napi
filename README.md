# gdal-rs-napi

Node.js bindings for [GDAL](https://gdal.org), built on the Rust
[`gdal`](https://crates.io/crates/gdal) + [`gdal-sys`](https://crates.io/crates/gdal-sys)
crates and exposed through [napi-rs](https://napi.rs).

GDAL and PROJ are compiled **statically** into the addon, and the PROJ/GDAL data
files travel with the npm package, so an installed package needs no GDAL on the
host system.

> **Status: early.** Raster and vector reading and writing all work. The
> `gdalwarp` / `gdal_translate` style utilities and the packaging story land next
> — see `~/.commandcode/plans/gdal-rs-napi.md` for the phased plan.

## Install

```sh
npm install gdal-rs-napi
```

## Usage

```js
const gdal = require('gdal-rs-napi')

gdal.version()
// { gdal: 'GDAL 3.12.1 "Chicoutimi", released 2025/12/12', proj: '9.6.2' }

gdal.drivers().length // 131

// Which drivers do I actually have?
const names = new Set(gdal.drivers().map((d) => d.name))
names.has('GTiff') // true

// Something CRS-related misbehaving? This says whether the CRS database was
// found, and where PROJ was pointed.
gdal.diagnostics()
// { epsg4326Resolves: true, crsDatabaseFound: true, projDataEnv: '.../assets/proj', ... }
```

`index.js` calls `configureDataPaths()` for you, pointing PROJ and GDAL at the
packaged `assets/proj` and `assets/gdal`. Call it yourself only if you relocated
those files or want to use your own GDAL data. A `PROJ_DATA` / `GDAL_DATA`
already present in the environment is never overwritten.

Note that `diagnostics().projDefaultSearchPath` is PROJ's *compiled-in* default
and still names the machine the library was built on; it is not the path in use.
`crsDatabaseFound` and `projDataEnv` are the fields that mean something.

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

Two things that save confusion: `width` / `height` come straight from GDAL and
are only meaningful when there are bands, so check `bandCount` before trusting
them on a vector dataset; and `IMAGE_STRUCTURE` lives on the **dataset**, not on
the band, so read it as `dataset.metadata('IMAGE_STRUCTURE')`.

Closing a dataset is idempotent, and afterwards every object derived from it
(`band`, `dataset.bandCount`, ...) throws instead of touching freed memory.

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
"leave it alone".

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
- **`ogr2ogr` has no `-overwrite` here.** That flag is a command-line feature, not
  part of `GDALVectorTranslate`: an existing destination is updated rather than
  replaced, so delete it first if that is what you want.

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
- **The musl legs are marked `experimental`** (`continue-on-error`). They
  cross-link a static C++ GDAL through napi's zig-based toolchain, which is the
  least settled part of the picture; a failure there is reported but does not
  fail the run. Treat them as a work in progress.

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
| Drivers | `internal_drivers` + `driver_sqlite` + `driver_gpkg` + `driver_vfk` |
| GEOS | **not linked** — it is LGPL, and static linking would relicense the artifact |

Because `gdal-src` disables every driver unless it is named explicitly, the
Cargo `bundled` feature list *is* the shipped driver set. Add drivers there.

The build registers **131 drivers** — `drivers()` is the authoritative list.
Among them: GTiff, COG, PNG, JPEG, GIF, BMP, PNM, TGA, VRT, MEM, MRF, HFA, GRIB,
XYZ, AAIGrid, DTED, SRTMHGT, USGSDEM, ESRI Shapefile, GeoJSON, GeoJSONSeq,
TopoJSON, ESRIJSON, FlatGeobuf, GPKG, SQLite, OpenFileGDB, MapInfo File, DXF,
DGN, CAD, S57, VDV, VFK, CSV, GTFS, Selafin, KMLSUPEROVERLAY, STACIT/STACTA,
PGDUMP, on top of the internal libtiff / libgeotiff / libjpeg / libpng stack that
backs GTiff and COG.

**Not** included: KML, GML and GPX (they need libexpat), LIBKML, HDF5, NetCDF,
PostgreSQL, and the network drivers (WMS/WMTS/OGCAPI — they need curl). Enabling
any of them means editing the `bundled` feature list and rebuilding.

`openThreadSafe()` needs GDAL ≥ 3.10, which the bundled build satisfies. Linking a
system GDAL older than that (`--no-default-features`) still compiles — the method
is simply absent, because `build.rs` reads the version `gdal-sys` reports and only
switches it on where `gdal::ThreadSafeDataset` exists.

### Targets

CI builds six targets, the ones in the table under "Prebuilt binaries":
`win32-x64-msvc`, `darwin-arm64`, `linux-x64-gnu`, `linux-arm64-gnu`, and the two
musl ones. The musl legs are `continue-on-error` — static C++ GDAL cross-linked
under musl through napi's `--cross-compile` plus zig is the least certain link in
the chain — so a release can ship without them. 32-bit targets are not built.

Those two legs run their test suite in a `node:24-alpine` container rather than on
the runner, because napi's cross toolchain links musl dynamically and the runner's
glibc Node cannot load such an addon at all — one process, two libcs. The
container is the honest place for it: the generated loader resolves to musl there,
so the suite exercises the real artifact.

## Licence

MIT. GDAL and PROJ are MIT/X11; see `LICENSE`.
