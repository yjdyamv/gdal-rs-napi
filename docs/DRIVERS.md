# Drivers the bundled build does not have

GDAL has every driver named here. The **bundled** build does not, and the reason is
one line in the dependency, not anything in this repository.

## The mechanism

`gdal-src` compiles GDAL from source with:

```rust
.define("GDAL_USE_INTERNAL_LIBS", "ON")
.define("GDAL_USE_EXTERNAL_LIBS", "OFF")
```

and then a fixed list of `handle_gdal_driver!` / `handle_ogr_driver!` calls. That is
what keeps the package reproducible and host-free — and it is also what switches off
every driver that needs a library GDAL does not carry inside its own tree. There is no
`driver_jpeg2000` / `driver_webp` / `driver_kml` feature to turn back on, and no way to
pass an arbitrary CMake define through `gdal-src`'s `build.rs`.

`gdal-async` does not add drivers — it builds GDAL with those libraries available
(system or bundled per its build machine), so its `GDALRegisterAll()` registers more.
The difference is a **build policy**, not an implementation: self-contained and
reproducible versus wide and host-dependent. This package chose the first.

`PDS` is the odd one out: it is pure GDAL with no external dependency, but `gdal-src`'s
published crate omits `frmts/pds/data`, so enabling it fails GDAL's configure on two
missing files. That is a packaging omission, not the policy.

## What is missing, and what it needs

| Driver | Needs | Route |
|---|---|---|
| `JP2OpenJPEG` | OpenJPEG | upstream `gdal-src` feature |
| `WEBP` | libwebp | upstream |
| `HEIF` / `AVIF` | libheif / libaom | upstream |
| `KML` / `GML` / `GPX` / `LIBKML` / `XLSX` | expat or libxml2 | upstream |
| `MBTiles` / `Rasterlite` | SQLite (already vendored here) | upstream, no new dependency |
| `FileGDB` (**write**) | Esri FileGDB SDK — not redistributable | host GDAL only |
| `MySQL` | MySQL client library | host GDAL only |
| `OCI` / Oracle | Oracle client library | host GDAL only |
| `DWG` | ODA SDK — not redistributable | host GDAL only |
| `PDS` | nothing | upstream packaging fix, or a local patch |

Reading FileGDB does **not** need any of this: `OpenFileGDB` is in the bundled set, so
a `.gdb` is readable. Only writing needs the Esri SDK.

## Route 1 — link a host GDAL (available today)

```sh
npm run build:system
```

`--no-default-features` drops the `bundled` feature, so `gdal-sys` stops depending on
`gdal-src` and links the **host's** `libgdal`/`libproj` instead (via pkg-config /
`GDAL_LIB_DIR`). That GDAL was built by its distributor with
`GDAL_USE_EXTERNAL_LIBS=ON`, so whatever it was built with — and it is the host build
that decides, not this package — arrives with it.

Prerequisites:

| OS | Install |
|---|---|
| Debian/Ubuntu | `sudo apt-get install libgdal-dev libproj-dev pkg-config` |
| macOS | `brew install gdal proj` |
| Windows | the hard one: you need GDAL headers + import libraries from a toolchain your compiler can link. OSGeo4W and conda-forge are the usual sources; a MinGW build cannot be linked by MSVC. |

Then verify what you got:

```sh
node -e "const g=require('./index.js'); console.log('bundled', g.bundled, 'drivers', g.drivers().length, 'JP2', !!g.driver('JP2OpenJPEG'))"
```

What changes at run time:

- **`bundled` is `false`**, and `info().build` is the host GDAL's own `BUILD_INFO`.
- **The host's version decides the surface.** A host GDAL older than 3.10 has no
  `openThreadSafe`; `features().threadSafe` says so. `features().geos` follows the
  host build too.
- **Point the data files at the host install.** `index.js` sets `GDAL_DATA` /
  `PROJ_DATA` to the packaged `assets/` only when they are unset; for a system GDAL set
  them to that install's own data, which is the version that matches.
- **The `.node` now needs the host libraries at run time** (and, on Windows, their
  DLLs on `PATH`). The "nothing on the host" promise of the bundled build does not
  hold on this route — that is the trade.

## Route 2 — ask `gdal-src` for a feature

The only route that keeps the self-contained promise. A feature has to (a) flip the
matching `GDAL_USE_*` on and (b) provide or find the dependency:

| Proposed feature | CMake flag | Dependency |
|---|---|---|
| `driver_jpeg2000` | `GDAL_USE_OPENJPEG=ON` | an OpenJPEG `-sys` crate, or a system probe |
| `driver_webp` | `GDAL_USE_WEBP=ON` | libwebp |
| `driver_heif` | `GDAL_USE_LIBHEIF=ON` | libheif (+ libaom for AVIF) |
| `driver_kml` / `driver_gml` / `driver_gpx` | `GDAL_USE_EXPAT=ON` or `GDAL_USE_LIBXML2=ON` | expat / libxml2 |
| `driver_mbtiles` / `driver_rasterlite` | (none beyond SQLite) | none — SQLite is already vendored |

Setting a specific `GDAL_USE_<LIB>=ON` overrides the global `GDAL_USE_EXTERNAL_LIBS`,
so the policy line does not have to change for this to work.

## Route 3 — patch `gdal-src` locally

A `[patch.crates-io]` entry pointing at a fork whose `build.rs` changes those lines
gets the drivers today. It is a fork to maintain against every `gdal-src` release and
every GDAL upgrade, so it is for a driver that is genuinely business-critical, not for
convenience.

## The default stays what it is

The released artifact keeps `all_drivers` and the host-free promise. The system route
is opt-in for the deployments that need a driver the bundle cannot carry — see also
`README.md`'s *What is actually compiled*, and `docs/PARITY.md` for how the two
bindings divide on this.
