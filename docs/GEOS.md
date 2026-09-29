# GEOS: the decision (C1)

`C1` in [`PHASE1.md`](../PHASE1.md) asked whether this binding should offer GDAL's
GEOS-backed geometry operations (`ST_Intersects`, `ST_Buffer`, `-simplify`, …).
It was left open because GEOS is LGPL-2.1 and this package ships a statically
linked GDAL. This document is the decision, and the reasoning it rests on.

## Decision

**Ship them — in a separate, opt-in build that links GEOS as a *shared library*.**

The default package does not change: no GEOS, `gdal.features().geos === false`, and
the geometry predicates are honest about it. A second artifact, built with the
crate's `geos` feature, carries them.

## "The `.node` is a shared library" is not the part that matters

It is worth stating plainly, because it is the easy mistake: the addon being a
shared object is **not** what discharges the LGPL. What the licence looks at is how
GEOS is linked *into* the addon.

- `gdal-src/geos_static` compiles GEOS and links it **into** the `.node`. The
  `.node` is still a shared library, and GEOS's object code is still *inside* it.
  That is static linking, and LGPL-2.1 §6 then asks the distributor for the means
  to relink the combined work against a modified GEOS — object files, or a build
  that yields them.
- `gdal-src/geos` links GDAL against a **shared** GEOS, leaving `libgeos_c` /
  `geos_c.dll` a separate library the loader resolves. "Replace the LGPL library"
  is then a file swap, which is the obligation discharged.

So the choice is `gdal-src/geos`, and the release has to **ship the GEOS shared
libraries** next to the `.node` — staged the way `assets/` already is — because the
package's promise is that an install needs nothing on the host. `geos_static`
stays available as a fallback; if it is ever what ships, the release carries the
relinkable objects, and that is a release-engineering task rather than something
to wave through.

Note also that `gdal-src/geos` finds GEOS through the build system (pkg-config or
a CMake prefix), so the variant build needs a GEOS to point at. Producing that —
vendoring or fetching one, and staging the shared libraries — is the work of
Phase 2, not of the API.

## What this changes in the code

- **No predicate is compiled out, and none is `#[cfg]`-gated into the default
  build by accident.** The `gdal` crate exposes only the non-GEOS geometry calls
  (`area`, `length`, `envelope`, …), so the predicates go through `gdal_sys`'s
  `OGR_G_*` directly and each checks `VersionInfo::has_geos()` first. In a build
  without GEOS the call answers with "this build has no GEOS" rather than throwing
  a `TypeError` — the surface is the same, only the answer differs, which is
  exactly what `gdal.features().geos` exists to let a caller branch on.
- The GEOS build is a **variant**, not the default: it adds two shared libraries
  and a heavier addon, and most callers never touch a predicate. `features().geos`
  is the runtime probe; `--features geos` is the build switch.

## Where it stands

| | |
|---|---|
| Non-GEOS geometry object model (`gdal.Geometry`, factories, conversions, measures, transforms) | Phase 1 |
| Predicates written against `gdal_sys` and guarded by `has_geos()` | Phase 1 |
| `--features geos` build, with the GEOS shared libraries staged into the package | Phase 2 |
| A CI leg for that build, asserting `features().geos === true` and exercising a predicate | Phase 2 |

Until the Phase 2 build exists, the predicates are exercised only by their
guard path (the default build's "no GEOS" answer); the operations themselves are
untested here, and the table above says so rather than implying otherwise.
