# GEOS: the decision (C1)

`C1` in [`PHASE1.md`](../PHASE1.md) asked whether this binding should offer GDAL's
GEOS-backed geometry operations (`ST_Intersects`, `ST_Buffer`, `-simplify`, …), and
how. This document is the decision, and the reasoning it rests on.

## Decision

**Build GEOS from source and link it statically**, exactly as GDAL and PROJ are
built. It is part of the `bundled` feature, so the shipped package has it — no
variant package, no shared libraries beside the `.node`.

```sh
cargo build                      # default: GEOS included
cargo build --no-default-features  # no bundled GDAL/PROJ/GEOS at all
```

## The mistake worth recording: "the `.node` is a shared library" proves nothing

The tempting shortcut is "our addon is a shared object, so linking an LGPL library
is fine". It is not, and it is worth writing down because it nearly produced the
wrong decision here. What the licence looks at is how GEOS is linked **into** the
`.node`:

- `gdal-src/geos_static` compiles GEOS and links it **into** the addon. The
  `.node` is still a shared library, and GEOS's object code is still inside it.
  That is static linking, and LGPL-2.1 §6 then asks the distributor for the means
  to relink the combined work against a modified GEOS.
- `gdal-src/geos` links a **shared** GEOS, where "replace the library" is a file
  swap and the obligation is discharged that way.

The second is the cleaner licence story, and it is still the wrong choice here:

- **It does not work on Windows/MSVC.** `gdal-src/geos` finds GEOS through the
  build system, and the GEOS a Windows box tends to have is MSYS2/MinGW's — whose
  import libraries an MSVC link cannot use. (Verified: the GEOS present on the
  build machine is `libgeos_c.dll.a`, MinGW.)
- **It breaks the package's whole promise.** The point of this package is one
  self-contained artifact with nothing on the host. A shared GEOS means staging
  platform-specific libraries, and teaching each platform's loader where to find
  them — on Windows that means prepending the package directory to `PATH` before
  requiring the addon, because `LoadLibraryExW` does not search the addon's own
  directory for its dependencies; on Linux/macOS, `$ORIGIN` / `@loader_path`
  rpath. Six platforms of loader plumbing to avoid a release-checklist item.

## What the licence actually asks of us

LGPL-2.1 §6 is a **distribution** condition, not a change to this crate's licence.
The source here stays MIT. When a release ships a `.node` with GEOS's object code
inside it, that release must also carry the means to relink against a modified
GEOS: the corresponding GEOS source, the build recipe, and the object files (or a
static archive) needed to relink. None of that is hypothetical — the version is
pinned in `Cargo.lock`, `geos-src` vendors the source, and `scripts/build.mjs` is
the recipe — so this is a release-job item and a paragraph in the licence notes,
not a reason to relicense the project.

(That is the engineering read, not legal advice; a release should get the
materials reviewed.)

## What it changes in the code

- The predicates and algorithms go through `gdal_sys`'s `OGR_G_*` directly — the
  `gdal` crate exposes no GEOS calls — and each checks `VersionInfo::has_geos()`
  first. That guard stays even though the shipped build has GEOS: a lean build
  may not, and "this build has no GEOS" is an answer a caller can act on where a
  `false` that looks like an answer is not. `gdal.features().geos` is the probe.
- Operations that return a geometry cannot be built from the `OGRGeometryH` GDAL
  hands back (`Geometry::with_c_geometry` is private in the `gdal` crate), so they
  go through `adopt`, which exports the handle to WKB and re-parses it. The cost
  is a memcpy; the benefit is that a C-owned handle never has to be handed to Rust
  ownership.

## Where it stands

| | |
|---|---|
| Non-GEOS geometry object model, predicates, set algebra | done |
| `geos` feature selecting `gdal-src/geos_static`, in `bundled` | done |
| The GEOS build itself (`geos-src` compiles GEOS, GDAL links it statically) | verified on Windows/MSVC |
| LGPL-2.1 §6 release materials (corresponding source + relink notes/objects) | **not yet** — a release item |
| A CI leg asserting `features().geos === true` and exercising a predicate | **not yet** |
| The remaining platforms (macOS, Linux gnu/musl) | expected to work the same way; unverified |
