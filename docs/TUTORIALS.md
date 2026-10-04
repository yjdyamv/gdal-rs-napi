# Tutorials

Four runnable flows. Each is a script under [`examples/`](../examples) that loads
the package through `..`, so it works from a checkout with no install and no
sample data beyond what it makes itself.

Build first — `npm run build` or `npm run build:debug` — then run any of these
from the repository root.

| Tutorial | Command | Shows |
|---|---|---|
| Inspect a dataset | `node examples/gdalinfo.mjs <dataset>` | opening, raster + vector introspection, per-band metadata |
| Make a COG | `node examples/to-cog.mjs in.tif out.tif [KEY=VALUE …]` | `CreateCopy`, the copy-only driver path, creation options |
| Convert vectors | `node examples/convert-vector.mjs in.geojson out.gpkg [layer]` | schema inference, feature copy, flushing |
| Parallel tiles | `node examples/parallel-tiles.mjs [size] [tile]` | `openThreadSafe`, async reads, the thread pool |

---

## 1. Inspect a dataset — `gdalinfo.mjs`

The smallest useful program: open one path and print what GDAL knows. Raster and
vector live in the same file, guarded by `bandCount` / `layerCount`, because a
vector-only GeoPackage still reports a raster size that means nothing.

```sh
node examples/gdalinfo.mjs dem.tif
node examples/gdalinfo.mjs roads.gpkg
```

What to notice: `dataset.driver` is an object (`String()` gives the short name),
`dataset.geoTransform` is `null` for an ungeoreferenced raster, and a band's
`blockSize` is the driver's native strip or tile — the unit `readBlock` returns.

## 2. Make a Cloud-Optimized GeoTIFF — `to-cog.mjs`

COG implements `CreateCopy` but not `Create`, so it cannot be made from scratch.
This walks the road that copy-only drivers need, then reopens the result and
reads its `IMAGE_STRUCTURE` to confirm what came out.

```sh
node examples/to-cog.mjs dem.tif dem-cog.tif COMPRESS=DEFLATE BLOCKSIZE=512
```

What to notice: `source.createCopy(output, 'COG', options)` is the driver-scoped
form, so the driver cannot be got wrong; the reopened dataset reports
`{ INTERLEAVE, COMPRESSION, LAYOUT }`, and `LAYOUT=COG` is the proof, not the
file extension.

## 3. Convert vectors — `convert-vector.mjs`

Copy every feature from one vector file to another, letting `createFeature`
infer the schema from the values. The output driver comes from the extension.

```sh
node examples/convert-vector.mjs roads.geojson roads.gpkg
node examples/convert-vector.mjs roads.geojson roads.fgb roads
```

What to notice: a feature with no geometry is written attribute-only by passing
`null`; `flushSync()` before `close()` is what the bulk-insert case wants; and
the printed field list is the *inferred* schema, so it tells you which types GDAL
chose.

## 4. Read tiles in parallel — `parallel-tiles.mjs`

The concurrency story, measured. The script builds a tiled raster, then reads the
same tiles twice: once awaited in turn, once all at once on a thread-safe handle.

```sh
node examples/parallel-tiles.mjs
node examples/parallel-tiles.mjs 8192 1024
UV_THREADPOOL_SIZE=8 node examples/parallel-tiles.mjs
```

What to notice: `openThreadSafeSync` (GDAL ≥ 3.10) is what makes several threads
on **one** handle safe; `gdal.features().threadSafe` tells you whether the build
has it. The speedup tracks `UV_THREADPOOL_SIZE` until the disk saturates. This is
the same path `scripts/bench-parallel.mjs` gates in CI, in miniature.

---

## Where the pitfalls are

- **Coordinates are longitude, latitude.** GDAL 3 reads `EPSG:4326` as latitude,
  longitude, and a wrongly-ordered transform returns a plausible coordinate for
  the wrong place. Every `SpatialRef` built here uses longitude, latitude; see
  the *Coordinate reference systems* section of the [README](../README.md) before
  passing any.
- **A write must fill the band.** A short buffer is refused rather than
  zero-filled, and a read off the edge is an error naming the window.
- **GDAL's error state is not yours.** `lastError()` is for the warnings that
  never became exceptions; a thrown failure is already gone from it. `err.code`
  is the stable token (`GDAL_CPL_FAILURE`, `GDAL_BAD_ARGUMENT`, …).
- **`readOnly` follows the dataset.** A band has no access mode of its own, so
  open with `{ update: true }` before writing band metadata.
