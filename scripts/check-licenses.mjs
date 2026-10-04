#!/usr/bin/env node
// Licence allow-list gate for the dependency graph.
//
// `Cargo.lock` pins every build-time crate, but nothing checks what those crates
// are licensed under. This reads `cargo metadata --locked` (metadata only — no
// compile, no network) and refuses a licence that is not on the list, so a new
// dependency with a surprising licence fails in CI instead of at release time.
//
// The allow-list is permissive licences only. A crate whose licence is worth a
// conversation is an explicit exception here, with the reason written down next
// to it — which is the review step this gate exists to force.
//
//   node scripts/check-licenses.mjs

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Permissive licences (and their common disjunctions) accepted without review. */
const ALLOWED = new Set([
  '0BSD',
  '0BSD OR MIT OR Apache-2.0',
  'Apache-2.0',
  'Apache-2.0 OR MIT',
  'Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-3-Clause OR MIT',
  'BSL-1.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT OR Apache-2.0',
  'MIT OR Zlib OR Apache-2.0',
  'MIT/Apache-2.0',
  'Unlicense OR MIT',
  'Zlib',
  '(MIT OR Apache-2.0) AND Unicode-3.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
])

/**
 * Crate name → the reason it is allowed despite not matching ALLOWED.
 * These are the crates that vendor a C library whose own terms are what matter;
 * `THIRD-PARTY.md` and `docs/GEOS.md` carry the prose.
 */
const EXCEPTIONS = new Map([
  ['pq-src', 'bundled libpq — PostgreSQL licence'],
  ['gdal-src', 'vendored GDAL — MIT/X11 (licence-file)'],
  ['hdf5-metno-src', 'vendored HDF5 — BSD-style (licence-file)'],
  ['netcdf-src', 'vendored netCDF — BSD-style (licence-file)'],
])

let metadata
try {
  const raw = execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  metadata = JSON.parse(raw)
} catch (error) {
  console.error(`[check-licenses] could not read cargo metadata: ${error.message}`)
  process.exit(1)
}

const failures = []
const exceptions = []

for (const pkg of metadata.packages) {
  // The workspace root has no `source` and is this project; its licence is MIT
  // and it is listed in ALLOWED anyway.
  const licence = pkg.license ?? null
  if (licence === null) {
    // A licence-file-only crate must be an explicit exception.
    if (EXCEPTIONS.has(pkg.name)) {
      exceptions.push(`${pkg.name} ${pkg.version}: ${EXCEPTIONS.get(pkg.name)}`)
      continue
    }
    failures.push(`${pkg.name} ${pkg.version}: no SPDX licence and no exception`)
    continue
  }
  if (ALLOWED.has(licence)) continue
  if (EXCEPTIONS.has(pkg.name)) {
    exceptions.push(`${pkg.name} ${pkg.version}: ${licence} — ${EXCEPTIONS.get(pkg.name)}`)
    continue
  }
  failures.push(`${pkg.name} ${pkg.version}: ${licence} is not on the allow-list`)
}

console.log(`[check-licenses] scanned ${metadata.packages.length} packages`)
for (const exception of exceptions) console.log(`[check-licenses] exception: ${exception}`)

if (failures.length > 0) {
  for (const failure of failures) console.error(`[check-licenses] FAIL: ${failure}`)
  console.error('[check-licenses] add the licence to ALLOWED, or an exception with a reason')
  process.exit(1)
}
console.log('[check-licenses] ok')
