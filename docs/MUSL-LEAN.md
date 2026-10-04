# The lean driver set (`bundled-lean`)

The default `bundled` build names `gdal-src/all_drivers`, so it links HDF5,
netCDF, the whole curl-backed network family and PostgreSQL/PostGIS. Those are
the fragile part of the build on musl (they vendor C libraries with their own
configure steps) and a large part of the ~40 MB `.node`. This document records
the evaluation and the opt-in feature that trims them.

## Decision

Add a **`bundled-lean`** Cargo feature. It is not the default; the default build
is unchanged. It selects a curated driver set instead of `all_drivers` and keeps
everything else — static GDAL/PROJ/GEOS, the shipped data files, the whole Rust
and JavaScript surface.

```sh
# default: all 148 drivers
npm run build

# lean: the curated set below
node scripts/build.mjs --platform --release --js binding.js --dts binding.d.ts \
  --no-default-features --features bundled-lean
```

`napi build` accepts `--no-default-features` and `--features`, so this needs no
new script.

## What it keeps

`bundled-lean` = `gdal-src/internal_drivers` + `driver_sqlite` + `driver_gpkg` +
`driver_vfk` + `geos`. In driver terms:

| Kept | Why |
|---|---|
| GTiff, COG, VRT, MEM, PNG, JPEG and the internal raster family | the raster core and the test fixtures |
| GeoJSON / GeoJSONSeq / TopoJSON / ESRIJSON, ESRI Shapefile, FlatGeobuf, KMLSUPEROVERLAY, MapInfo, DXF, DGN, CAD, CSV, GTFS, GRIB, … | the internal vector formats, all dependency-free |
| SQLite, GPKG, VFK | the one extra C dependency worth keeping (bundled SQLite) |
| GEOS | the OGR predicates (`intersects`, `buffer`, `simplify`); a build-time fetch, not a musl fragility |

## What it drops

| Dropped | Consequence |
|---|---|
| HDF5, netCDF | no HDF5/netCDF/GRIB-via-netcdf datasets; removes two vendored builds |
| WMS, WMTS, WCS, OGCAPI, PLMOSAIC, Carto, Elasticsearch, NGW, AmigoCloud, DAAS, EEDA | the curl-backed network drivers; `/vsicurl/` itself still works (VSI curl is separate from the *drivers*) |
| PostgreSQL / PostGIS | no PG/PostGIS read or write |

The rest of `all_drivers` is unchanged; only these are left out.

## Trade-offs

- **Smaller and faster.** Fewer C libraries compile and link, so the `.node`,
  the tarball and the cold build all shrink. The exact numbers are not claimed
  here — measure on the target before quoting them — but the direction is not in
  doubt.
- **The musl legs get simpler.** The two vendored builds most likely to break
  under musl are gone. This is the main motivation.
- **It is a build variant, not a second package.** The promise is one
  self-contained artifact; `bundled-lean` changes what that artifact contains,
  not how it is shipped.
- **Capability is a runtime fact.** `driver('netCDF')` returns `null` in a lean
  build, and `info().driverCount` is lower. `gdal.features()` is unaffected
  (none of the dropped drivers is a feature flag there).
- **The default suite is not the right suite.** Some tests exercise HDF5,
  netCDF or PG; a lean build should run a reduced `ts-test` set rather than the
  full 436. No selection file exists yet — that is the follow-up if the lean
  variant becomes something CI builds.

## Why not other options

- **Ship a shared GDAL/PROJ/GEOS instead of static** — rejected for the reason
  in [`GEOS.md`](./GEOS.md): it breaks the "nothing on the host" promise and
  needs per-platform loader plumbing.
- **Drop GEOS too** — would remove the geometry predicates, which is a real
  capability, and GEOS builds cleanly under musl. Not worth it.
- **A separate lean package on npm** — no. The variant is a build knob; two
  packages would double the release surface for a size optimisation.

## Tooling

The variant is runnable and measurable:

- `npm run build:lean` builds it (`--no-default-features --features bundled-lean`).
- `npm run lean` builds, prints `scripts/lean-report.mjs` — `.node` size, driver
  count, and which of the dropped library-backed drivers are actually absent —
  and runs the reduced suite.
- `vitest.lean.config.mts` is that suite. The driver-agnostic tests gate
  themselves on `hasDriver` (see `ts-test/helpers.ts`), so a test that needs
  netCDF or HDF5 skips on a build that never had it; the three multidimensional
  files are netCDF through and through, so they are excluded rather than made
  conditional. On a full build the same config runs 46 files / 422 tests, which
  is how it was checked before there was a lean build to run it against.
- `.github/workflows/lean.yml` is a **manual** job (`workflow_dispatch`) that
  builds the variant, writes the report into the run summary, runs the lean
  suite and uploads the `.node` + SBOM. It is not a push gate: a lean build
  recompiles GDAL with a different feature set, and the default build remains
  the one CI checks on every push.

## Status

The feature, the reduced suite, the report and the manual workflow are in place.
What is still **not** done is the comparison those exist for: the real size and
build-time numbers for a lean build versus the default, which the manual
workflow produces on demand. `bundled-lean` is not a shipped variant and no
release builds it — the default `bundled` set stays what is released.
