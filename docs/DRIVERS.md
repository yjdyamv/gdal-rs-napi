# Drivers the bundled build does not have

GDAL has every driver named here. The **bundled** build does not, and the reason is
one line in the dependency, not anything in this repository.

## The mechanism

`gdal-src` compiles GDAL from source with:

```rust
.define("GDAL_USE_INTERNAL_LIBS", "ON")
.define("GDAL_USE_EXTERNAL_LIBS", "OFF")
```

and then a fixed list of `handle_gdal_driver!` / `handle_ogr_driver!` calls:

```rust
macro_rules! handle_gdal_driver {
    ($config: ident, $driver: literal) => {
        if cfg!(feature = $driver) {
            $config.define(format!("GDAL_ENABLE_{}", $driver.to_ascii_uppercase()), "ON");
        } else {
            $config.define(format!("GDAL_ENABLE_{}", $driver.to_ascii_uppercase()), "OFF");
        }
    };
}
```

A *library-backed* driver follows the same shape with one more step: the feature turns
on a `-sys` crate, and `build.rs` reads that crate's `DEP_*` variables to define
`GDAL_USE_<LIB>=ON` and the include/library paths. `libsqlite3-sys`, `hdf5-metno-sys`,
`netcdf-sys`, `curl-sys`, `pq-src` and `geos-src` are the ones `gdal-src` carries.

**That is the whole reason these drivers cannot be added from here.** `gdal-src` owns
the `cmake::Config`, and a CMake define can only be written inside its `build.rs`,
gated on *its own* Cargo features. A downstream crate can enable a feature a dependency
already declares, but it cannot declare a new one for it; and the only environment
`gdal-src` reads is `OUT_DIR` plus the `DEP_*` values of the `-sys` crates it already
depends on. Pointing `CMAKE_PREFIX_PATH` at an OpenJPEG would not help either, because
`GDAL_USE_EXTERNAL_LIBS=OFF` gates external libraries off regardless. "Do it the way
`gdal-src` does" therefore means doing it **inside** `gdal-src` — or replacing it.

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

A `[patch.crates-io]` entry pointing at a fork gets a driver today: add the `-sys`
dependency and a `driver_*` feature, then a `cfg!(feature)` arm that defines
`GDAL_USE_<LIB>=ON` and wires the include/library paths, exactly as the existing ones
do. What you take on is not just those lines — the fork has to be carried through every
`gdal-src` release (its GDAL version, its feature list, its vendored
`sqlite`/`hdf5`/`netcdf`/`curl`/`pq`/`geos` wiring) — so it is for a driver that is
genuinely business-critical, not for convenience. The alternative is to stop using
`gdal-src` and write this crate's own GDAL build script, which is re-implementing the
dependency: most of what `gdal-src` does is exactly the part that is tedious and
error-prone, and it is the part we currently get for free.

## The default stays what it is

The released artifact keeps `all_drivers` and the host-free promise. The system route
is opt-in for the deployments that need a driver the bundle cannot carry — see also
`README.md`'s *What is actually compiled*, and `docs/PARITY.md` for how the two
bindings divide on this.
