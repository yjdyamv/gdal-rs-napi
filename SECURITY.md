# Security policy

`gdal-rs-napi` is a native Node.js addon: a Rust binding over a **statically
linked** GDAL + PROJ + GEOS. A vulnerability can therefore live in this
repository, in one of the native libraries compiled into the `.node`, or in the
JavaScript shell that loads it. Reports are welcome for any of the three.

## Versions

The package is **pre-1.0** and not on npm yet; only the most recent release is
supported. Fixes land on `main` and are cut as a new tag.

| Version | Supported |
|---|---|
| latest `0.x` | yes |
| older `0.x` | no — please retest on the latest |

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   (<https://github.com/yjdyamv/gdal-rs-napi/security/advisories/new>).
2. Describe the impact, the affected platform/target, and the smallest
   reproduction you can produce.

If you cannot use GitHub advisories, open a public issue that says only that you
have a security report and ask for a private channel — do not include details.

Please include, where you can:

- `gdal.version()`, `gdal.apiVersion` and `gdal.info()` from the running build
  (`info()` lists what was compiled in);
- `gdal.diagnostics()` and `gdal.features()`;
- the platform / Rust target (`win32-x64-msvc`, `linux-x64-musl`, …);
- whether the issue reproduces with a plain `openSync`/`readPixelsSync` script
  or needs a particular driver or format.

## What to expect

This is a volunteer project without a paid security team. Reports are read and
acknowledged on a best-effort basis; a confirmed issue is fixed on `main` and,
where it affects a released artifact, credited in the release notes unless you
ask otherwise. There is no bug-bounty programme.

## Scope

In scope:

- memory-safety or use-after-close bugs in the addon (the Rust/FFI boundary, the
  `.node`, the JS shell in `index.js`);
- a crash or corruption reachable from the documented API with an untrusted
  input file;
- an issue in a **bundled** native component (GDAL, PROJ, GEOS, HDF5, netCDF,
  curl, libpq, SQLite, …) that this package ships and that upstream has not yet
  fixed;
- a dependency or build-pipeline issue (for example, a compromised dependency).

Out of scope:

- the LGPL-2.1 obligations around statically linked GEOS — that is a licensing
  matter, recorded in [`docs/GEOS.md`](./docs/GEOS.md), not a vulnerability;
- vulnerabilities in a **system** GDAL/PROJ/GEOS when the addon was built with
  `--no-default-features` (the addon then contains none of it);
- denial of service from processing an intentionally huge or malformed dataset,
  unless it is a memory-safety failure rather than slow work;
- issues that require an already-compromised local machine.

## Supply chain

The shipped artifact is self-contained, so its dependency surface is the build
instead of the host. `Cargo.lock` pins every Rust crate, `scripts/sbom.mjs`
emits a CycloneDX inventory for a release, `scripts/check-licenses.mjs` holds
the licence allow-list, and `THIRD-PARTY.md` names the native components that
end up inside the `.node`.
