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
| `gdal.bundled` | **parity** | one boolean |

### Tier 2 — next batch (medium cost, medium value)

| `gdal-async` | plan |
|---|---|
| `SpatialReference` extras: `fromURN`, `fromUserInput`, `fromESRI` + `morphToESRI`/`morphFromESRI`, `toXML`, `validate`, `cloneGeogCS`, `setWellKnownGeogCS`, `EPSGTreatsAsLatLong` | prefer the `gdal` crate's existing methods; fall back to `OSR_*` only where it has none |
| `gdal.fs`: `vsimem.set` / `release` / `copy` (`VSIFileFromMemBuffer` family), `clearCurlCache` | additive to the existing `gdal.fs`; `open(buffer)` already uses the C API internally |
| `wrapVRT` | wraps a source as an in-memory VRT; `buildVrt` covers the file case today |
| `Driver.copyFiles` / `rename` | the two `Driver` file operations we lack (`delete` exists) |

### Tier 3 — needs a decision first (shape forks)

| `gdal-async` | why it is not a straight port |
|---|---|
| band algebra (`RasterBand.add`/`sub`/`mul`/… and `gdal.algebra`) and `band.asType()` | two possible implementations — VRT pixel functions, or `GDALRasterIO`'s type conversion — with different shapes. Write a short design before committing. |
| Node `Stream`s (`pixels.createReadStream` / `createWriteStream`, `RasterReadStream`…) | overlaps `readChunks` / `readChunksSync`; the value is ecosystem compatibility, the cost is a second streaming model. |
| the multidimensional model (`Group` / `MDArray` / `Attribute` / `Dimension`) | a whole subsystem; nothing in the current use surface needs it. |

---

## 2. Deliberate non-goals (with the reason)

These are **decisions, not omissions**. `gdal.features()` reports the two that have a
runtime probe (`multidimensional`, `streams`).

- **The multidimensional model** — `Group`, `MDArray`, `Attribute`, `Dimension` and
  their collections. A subsystem of its own, far past what this binding is used for.
  `gdal.features().multidimensional === false`.
- **Node `Stream`s** — `features().streams === false`. `readChunks` / `readChunksSync`
  are the streaming reads (see the README's *Resources* section).
- **Band algebra and pixel functions** — `RasterBand.add`/`…`, `addPixelFunc`,
  `createPixelFunc`, `toPixelFunc`, `calcAsync`. They rest on VRT pixel functions;
  see Tier 3 for the shape question.
- **Async getters** — the `xxxAsync` form of every getter. It conflicts with the
  naming rule (sync is `xxxSync()`, async is `xxx()`; no `Async` suffix), and its
  purpose in the reference — not blocking behind a per-dataset I/O queue — does not
  arise here, where a getter just waits on the shared lock. Recorded in PHASE1 WS-4.
- **Native collection classes** — `dataset.bands.get()` / `.count()` / `.map()` /
  iterators, `layer.fields`, `layer.features`, `driver` collections. Our arrays
  already have `for…of`, `forEach` and `map`, and the singular accessors
  (`band(i)`, `layer(i)`, `field(name)`) are the `.get()`. Wrapping them would either
  change the array returns (a break) or put the shape in JavaScript — where the
  generated `binding.d.ts` cannot type it. This shape lives in `compat`.
- **The geometry subclass family** — `Point` / `Polygon` / `MultiPolygon` / … . napi
  cannot express inheritance, and the generated declarations own the factories'
  return types, so subclass accessors could not be typed. One `Geometry` with
  shape-specific accessors covers the same ground; the family (and `instanceof`)
  lives in `compat`.
- **`toDataType` / `fromDataType` (numeric codes)** — this surface's vocabulary is
  *strings* (`band.dataType === 'Float32'`), so a numeric-code converter would hand
  back a vocabulary it neither returns nor accepts. The codes belong to `compat`.
- **`eventLoopWarning`** — a diagnostic for the reference's per-dataset I/O queue.
  Nothing here has that queue to warn about. Left out until someone asks.

---

## 3. Conventions map (so a port knows what to change)

| concern | `gdal-async` | here |
|---|---|---|
| band / layer / field index | 1-based | **0-based** (`band.id` is the one 1-based value, as GDAL reports it) |
| blocking call | `xxx()` | `xxxSync()` |
| async call | `xxxAsync()`, or `xxx()` + callback | `xxx()` returning a `Promise` |
| setter | `band.noDataValue = x` | `band.setNoDataValue(x)` |
| enum value | numeric `GDT_*` / `GCI_*` / `OFT_*` | string (`'Float32'`, `'RedBand'`) via `gdal.const` |
| feature | `Feature` object with `fields` / `geometry` | `FeatureRecord` plain object, plus `layer.getFeature(fid)` for the object form |
| geometry | class family | one `Geometry`, shape-specific accessors |

## 4. Roadmap

1. **Now (this cut):** Tier 1 above.
2. **Next:** Tier 2 above, one commit per group.
3. **Then:** a design for band algebra / `asType` (Tier 3), and decide Streams and the
   multidimensional model on demand rather than by default.
4. **Publishing** stays *deliberately deferred* — see `ROADMAP.md` Phase 0 and
   `CHANGELOG.md`; nothing here changes that.
