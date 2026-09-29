# Third-party components

This package's own source is MIT (`LICENSE`). What follows is the native code that
ends up **inside the shipped artefact**, and under which terms.

| Component | Licence | Linked |
|---|---|---|
| GDAL 3.12.1 | MIT/X11 | static |
| PROJ 9.6.x | MIT/X11 | static |
| **GEOS 3.15.1dev** | **LGPL-2.1** | **static** |
| HDF5, netCDF, curl, libpq, SQLite, libtiff, libgeotiff, libjpeg, libpng, zlib, … | permissive (MIT/BSD/zlib-style) | static |
| data files under `assets/proj` and `assets/gdal` | MIT/X11 (PROJ / GDAL) | data |

`gdal.info().build` is the authoritative list for the build you are running: it is
GDAL's own `BUILD_INFO`, so it names the versions and the libraries that were
actually compiled in.

## GEOS, and what LGPL-2.1 §6 asks of a release

GEOS is the one **copyleft** component here, and it is linked **statically** into
the `.node`. That does not change the licence of this package's source — but
LGPL-2.1 §6 attaches a condition to distributing a work that has the library's
object code linked into it: the distributor must also provide the means to relink
that work against a modified GEOS.

So a release carries, beside each platform tarball:

- **`…-lgpl-geos.tar.gz`** — the exact GEOS source this build compiled (the tree
  `geos-src` builds, whose version is also pinned in `Cargo.lock`), the static
  archives the build produced, and a `RELINK.md` with the steps to relink.

Anyone who wants to audit or replace GEOS can take that source, edit it, rebuild
`geos`/`geos_c`, and relink the addon as `RELINK.md` describes — which is the
freedom §6 exists to preserve.

The full text of the GEOS licence is `geos-source/COPYING` inside that archive.

`docs/GEOS.md` records why the build links GEOS statically rather than as a shared
library, which would have discharged §6 differently.
