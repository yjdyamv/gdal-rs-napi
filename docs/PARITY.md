# Capability boundary and roadmap, against `gdal-async`

This is the answer to "how far are we from `gdal-async`, and what are we *not*
going to build". The reference is **`node-gdal-async` 3.13** (<https://mmomtchev.github.io/node-gdal-async/>),
read item by item against its own API listing.

Two things frame everything below:

- **Our conventions are not its conventions.** Indexing is 0-based, the blocking
  form is `xxxSync()` and the async one is `xxx()` (never an `Async` suffix),
  setters are `setX()` rather than assignment, enumerations are *strings*, and
  every async entry point returns a `Promise` (no node-style callbacks). Those are
  frozen in [`API-STABILITY.md`](./API-STABILITY.md); the `gdal-rs-napi/compat`
  layer is where `gdal-async`'s shapes live, not here.
- **The core is at parity.** Raster read/write (windows, samples, overviews,
  statistics, checksum, fill, sieve, palette, mask), vector CRUD (layers, fields,
  cursors, filters, transactions, SQL), CRS (`SpatialReference`, `CoordinateTransform`,
  `identifyEpsg`), the OGR geometry model with GEOS predicates and set algebra,
  `gdal_translate`/`gdalwarp`/`ogr2ogr`/`gdaldem` with progress and cancellation,
  and `openThreadSafe()` for genuinely parallel reads are all here. What is left is a
  **short list of additive gaps** and a **set of capabilities we deliberately do not
  build**.

Legend: **parity** — we have it, under our own names; **gap** — missing and worth
closing; **non-goal** — decided against, with the reason.

---

## 1. Additive gaps (we do not have it, and it is worth having)

Ordered by tier. Tier 1 is what this batch ships.

### Tier 1 — shipped in this cut

| `gdal-async` | here | note |
|---|---|---|
| `dataset.getGCPs` / `setGCPs` / `getGCPProjection` | **parity** | `dataset.getGCPs()` / `setGCPs(gcps, projection?)` / `gcpProjection` / `gcpCount` — the GCP georeferencing path beside `geoTransform` |
| `layer.getSpatialFilter` | **parity** | returns a `Geometry`, or `null` |
| `band.hasArbitraryOverviews` | **parity** | same name |
| `geometry.makeValid` / `boundary` / `simplifyPreserveTopology` / `isRing` | **parity** | same names (GEOS-gated where the reference is) |
| `geometry.toGML` / `toKML` | **parity** | `toGML()` / `toKML(altitudeMode?)` |
| `geometry.pointOnSurface` / `unaryUnion` / `concaveHull` / `normalize` / `setPrecision` | **parity** | same names, GEOS-gated (`OGR_G_RemoveRepeatedPoints` is not bound) |
| `gdal.bundled` | **parity** | one boolean |
| `SpatialReference.isGeocentric` / `isLocal` / `isSameGeogCS` / `isSameVertCS` / `getAttrValue` / `autoIdentifyEPSG` | **parity** | same names |
| `band.flush` / `layer.flush` | **parity** | `flush()` / `flushSync()` on each, beside the dataset's |

### Tier 2 — done

The `SpatialReference` extras: `fromESRI`, `morphToESRI` / `morphFromESRI`, `toXML`,
`validate`, `cloneGeogCS`, `setWellKnownGeogCS`, `epsgTreatsAsLatLong`. And
`Driver.rename` / `Driver.copyFiles` (`GDALRenameDataset` / `GDALCopyDatasetFiles`),
plus `gdal.fs.clearCurlCache()`.

Three of the reference's items need nothing of their own, and are recorded here rather
than filled with a second door:

- **`fromURN` / `fromUserInput`** — `SpatialRef.fromDefinition` already routes through
  `OSRSetFromUserInput`, which takes a URN, an `AUTH:CODE`, WKT and PROJJSON alike.
- **`wrapVRT`** — was `translate(dest, ['-of', 'VRT'])`, and that equivalence held only
  as long as there was no way to *derive* a band: `gdal_translate` cannot apply a
  JavaScript pixel function. It is built for real now (see Tier 3), and the `translate`
  program remains the door for a plain VRT.
- **`fs.vsimem.set` / `release`** — `fs.writeFile('/vsimem/…', bytes)` and `fs.unlink`
  express both. What the reference's `set` adds is a zero-copy wrap of the caller's
  buffer, which a napi `Buffer` cannot offer — it is not memory GDAL may take
  ownership of — so a copy is the price, and `writeFile` already pays it.

One caveat GDAL hands down rather than us: `rename` / `copyFiles` open the source as a
**raster**, so a vector-only dataset (a bare `.gpkg`) is not recognized.

### Tier 3 — the algebra, the streams and the multidimensional model all shipped

The band algebra is in: `asType(type)` plus the elementwise operators — `add`, `sub`,
`mul`, `div`, `pow`; the unary `abs`, `sqrt`, `log`, `log10`; the comparisons `eq`,
`notEq`, `lt`, `lte`, `gt`, `gte`; the logical `and`, `or`, `not`; and `ifThenElse`,
each taking a band or a constant.

It is **eager**: every result is computed once into a new in-memory dataset. The
reference builds a lazy VRT with *pixel functions* instead, and that was not taken —
for a reason measured rather than assumed: a VRT keeps a shared handle on its source,
so reading the derived band after `close()`ing the source is a use-after-free (the
`asType` probe died with an access violation), and this binding's contract is a clear
error from a closed dataset, never a crash. Materialising, an explicit result sample
type, and a size check between the two bands are the price of that choice. The lazy
route is available now, deliberately rather than by default: `wrapVRT` with a pixel
function (below) makes a derived band, and its result *does* read through to its
sources.

Raster **Streams** are in too — `band.createReadStream()` / `band.createWriteStream()`,
object mode, yielding typed arrays of the band's own sample type a strip at a time.
They are built in the JavaScript shell (`index.js`) over the chunked reads and writes,
because napi cannot hand back a Node `Readable` / `Writable` from a `#[napi]` class —
the same reason a `FeatureCursor` gets its `for await` there. So are the two pieces
that sit on them: `RasterMuxStream` reads several streams in lockstep,
`RasterTransform` applies a function to every pixel, and `calcAsync` is the
`gdal_calc.py` shape over the two. `gdal.features().streams` is `true`.

`calcAsync` is where the *mechanism* differs from the reference rather than the shape:
theirs runs it through VRT pixel functions, so that GDAL calls the JS function from
inside its own raster loop; here the loop is JavaScript's — the streams feed it. The
pixel function itself is here too, so *both* mechanisms now exist, and they answer
different questions: `calcAsync` is eager and writes a real dataset, a derived VRT is
lazy. The callback option is spelled `onProgress`, this binding's name for it, where the
reference says `progress_cb`.

#### VRT pixel functions

`addPixelFunc` / `toPixelFunc` / `createPixelFunc` / `createPixelFuncWithArgs` are all
in, and so is `wrapVRT`, which is what produces the VRT that uses one. The shape is the
reference's, with two differences worth knowing:

- **A JavaScript pixel function is evaluated by a synchronous read only.** GDAL calls
  back from inside its raster loop, and it does so on whichever thread is reading. Only
  the JS thread can call into JavaScript, and handing the call to the event loop from a
  worker would deadlock against the lock that worker holds — so the thread-pool path
  refuses with an error naming the reason. `sync` was already this binding's rule for
  the blocking form; this is that rule reaching a place it has to.
- **`wrapVRT` answers XML text**, as the reference does, and GDAL opens a VRT from a
  string, so nothing touches the disk. The sample types are translated on the way in —
  GDAL's VRT vocabulary says `Byte` where this binding says `Uint8`.

Every Tier 3 entry is now built, or recorded as a non-goal below.

#### Async getters

Every read-only property of a `RasterBand` and of a `Dataset` has its `xxxAsync` twin:
`sizeAsync`, `blockSizeAsync`, `dataTypeAsync`, `colorInterpretationAsync`,
`descriptionAsync`, `unitTypeAsync`, `noDataValueAsync`, `scaleAsync`, `offsetAsync`,
`minimumAsync`, `maximumAsync`, `idAsync`, `readOnlyAsync`,
`hasArbitraryOverviewsAsync`, `categoryNamesAsync`, `colorTableAsync`, and
`rasterSizeAsync`, `geoTransformAsync`, `spatialRefAsync`.

They are worth having here for a different reason than in the reference, and the shape
is the reference's because of a gap in ours: the rule that the async form drops the
`Sync` suffix has nothing to apply to when there is no call — `band.dataType` is a
property, so `band.dataType()` cannot exist beside it. What they buy is the *wait*: a
getter takes the process-wide lock, and on an ordinary dataset that is the exclusive
side, so a getter read while an async read is in flight stops the event loop until that
read finishes. These do the reading on the thread pool and hand the answer back.

They report what the dataset already knows, so they are all cheap once the lock is
had — that, and not the reference's per-dataset I/O queue, is what they are for.

#### `eventLoopWarning`

Also in, and for the same underlying reason: a `*Sync` call holds the JS thread for as
long as it takes, and for a server that is the event loop stopped. The blocking methods
of the classes that reach a dataset time themselves and go out through
`process.emitWarning` as a `GdalEventLoopWarning` when they run long. The reference's
switch is a boolean; here it also takes a number, which is the threshold in
milliseconds — the default is 50 ms.

Note the shape of the difference from the reference's reason: theirs warns about a
per-dataset I/O queue holding things up, and there is no such queue here. Ours warns
about the thread itself, which is what a synchronous call costs in any binding.

#### The multidimensional model

The whole subsystem is in, on GDAL's own C API: `Dataset.root` opens the door
(`multidimensional: true` on `open()`, which is the `GDAL_OF_MULTIDIM_RASTER` flag —
without it GDAL builds no root group at all), and `Group` / `MDArray` / `Attribute` /
`Dimension` hang off it with their structure, attributes, CRS, `read`, `getView`,
`getMask` and `asDataset`. `gdal.features().multidimensional` is `true`.

Two things are shaped differently from the reference, both for reasons this binding
already holds to:

- **`read()` returns bytes in the array's own type**, like `readPixels`, rather than a
  typed array in the JS type of the moment. A `String` or `Compound` array is refused.
- **`asDataset()` takes `{ xDim, yDim }`** for the files that leave their axes
  untagged; the default stays GDAL's own `HORIZONTAL_X` / `HORIZONTAL_Y` answer, then
  the last two dimensions.

One behaviour is GDAL's rather than this binding's, and worth knowing: a `Group` or
`MDArray` handle holds its own reference to the file, so it keeps working — and on
Windows keeps the file locked — after `close()`.

---

## 2. Deliberate non-goals (with the reason)

These are **decisions, not omissions**.

- **Native collection classes** — the shape, not the capability, and it is in *both*
  entries now. This binding spells a container as a call that returns an array;
  gdal-async spells it as an object with `get` / `count` / `getNames` and iterators; a
  JavaScript function is an object, so the call carries the collection surface and the
  two spellings are one thing (`dataset.bands()` and `dataset.bands.get(1)`). What is
  *not* here is the typing of that on a member the generated declarations already own —
  see `index.d.ts`, and `compat`, whose classes are its own and are typed freely.
- **The geometry subclass family** — `Point` / `Polygon` / `MultiPolygon` / … . napi
  cannot express inheritance, and the generated declarations own the factories'
  return types, so subclass accessors could not be typed. One `Geometry` with
  shape-specific accessors covers the same ground; the family (and `instanceof`)
  lives in `compat`.
- **`toDataType` / `fromDataType` (numeric codes)** — this surface's vocabulary is
  *strings* (`band.dataType === 'Float32'`), so a numeric-code converter would hand
  back a vocabulary it neither returns nor accepts. The codes belong to `compat`.

---

## 3. Conventions map (so a port knows what to change)

| concern | `gdal-async` | here |
|---|---|---|
| band / layer / field index | 1-based | **0-based** (`band.id` is the one 1-based value, as GDAL reports it) |
| blocking call | `xxx()` | `xxxSync()` |
| async call | `xxxAsync()`, or `xxx()` + callback | `xxx()` returning a `Promise` |
| async getter | `band.dataTypeAsync` | the same, and for the same reason — see below |
| setter | `band.noDataValue = x` | `band.setNoDataValue(x)` |
| enum value | numeric `GDT_*` / `GCI_*` / `OFT_*` | string (`'Float32'`, `'RedBand'`) via `gdal.const` |
| feature | `Feature` object with `fields` / `geometry` | `FeatureRecord` plain object, plus `layer.getFeature(fid)` for the object form |
| geometry | class family | one `Geometry`, shape-specific accessors |

## 4. Roadmap

1. **Shipped:** Tier 1, Tier 2, and all of Tier 3 — the algebra, the streams, the
   multidimensional model, the pixel functions, `calcAsync`, the async getters and
   `eventLoopWarning`.
2. **Remaining:** nothing on the parity side — everything else is a recorded non-goal
   above (the native collection classes and the geometry subclass family, both of which
   `compat` carries as shapes). The `compat` layer reshapes the multidimensional model
   too, which closed the last edge there.
3. **Publishing** stays *deliberately deferred* — see `ROADMAP.md` Phase 0 and
   `CHANGELOG.md`; nothing here changes that.
