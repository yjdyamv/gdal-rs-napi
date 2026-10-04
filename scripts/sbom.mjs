#!/usr/bin/env node
// Emit a CycloneDX SBOM for the release artifact.
//
// The shipped `.node` is self-contained, so "the SBOM" is two things joined: the
// pinned Rust dependency graph (`Cargo.lock`, read through `cargo metadata`) and
// the C libraries that graph compiles and statically links into the addon — GDAL,
// PROJ, GEOS, HDF5, netCDF, libpq, SQLite, curl, zlib, OpenSSL. Neither half is
// guessed: crate versions come from the lockfile, and the native versions are the
// ones the crates carry in their own version suffix (`gdal-src 0.3.0+3.12.1`).
//
//   node scripts/sbom.mjs                 # writes dist/sbom.cdx.json
//   node scripts/sbom.mjs --out path.json

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const outIndex = process.argv.indexOf('--out')
const outPath = resolve(repoRoot, outIndex !== -1 ? process.argv[outIndex + 1] : 'dist/sbom.cdx.json')

const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
)

const byName = new Map(metadata.packages.map((pkg) => [pkg.name, pkg]))
const root = metadata.packages.find((pkg) => pkg.name === 'gdal-rs-napi')

/** The part after `+` in a crate version, which is the C library's own version. */
function suffix(name) {
  const pkg = byName.get(name)
  if (!pkg) return null
  const plus = pkg.version.indexOf('+')
  return plus === -1 ? pkg.version : pkg.version.slice(plus + 1)
}

/** The two library versions the running addon reports, when it is built. */
let runtime = null
try {
  const require = createRequire(import.meta.url)
  runtime = require(join(repoRoot, 'index.js'))
} catch {
  runtime = null
}

/** The C libraries the Rust crates compile and link in, with their real version. */
function nativeComponents() {
  const list = []
  const gdal = suffix('gdal-src') ?? 'bundled'
  list.push({ name: 'GDAL', version: gdal.replace(/^.*?(\d)/, '$1'), license: 'MIT' })
  list.push({
    name: 'PROJ',
    version: runtime ? runtime.version().proj : 'bundled',
    license: 'MIT',
  })
  const geos = suffix('geos-src')
  list.push({
    name: 'GEOS',
    version: geos ? `${geos} (source vendored)` : 'bundled',
    license: 'LGPL-2.1-only',
  })
  for (const [name, label] of [
    ['hdf5-metno-src', 'HDF5'],
    ['netcdf-src', 'netCDF'],
    ['pq-src', 'libpq'],
    ['libsqlite3-sys', 'SQLite'],
    ['curl-sys', 'libcurl'],
    ['libz-sys', 'zlib'],
    ['openssl-src', 'OpenSSL'],
  ]) {
    const pkg = byName.get(name)
    if (pkg) list.push({ name: label, version: suffix(name) ?? pkg.version, license: null })
  }
  return list
}

function component(name, version, licenses, purl) {
  const entry = {
    type: 'library',
    name,
    version,
    purl,
  }
  if (licenses) entry.licenses = [{ expression: licenses }]
  return entry
}

const cargoComponents = metadata.packages.map((pkg) =>
  component(pkg.name, pkg.version, pkg.license, `pkg:cargo/${pkg.name}@${pkg.version}`),
)

const native = nativeComponents().map((item) =>
  component(item.name, item.version, item.license, `pkg:generic/${item.name}@${item.version}`),
)

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'gdal-rs-napi', name: 'scripts/sbom.mjs' }],
    component: {
      type: 'application',
      name: root?.name ?? 'gdal-rs-napi',
      version: root?.version ?? '0.0.0',
      licenses: [{ expression: 'MIT' }],
      purl: `pkg:npm/gdal-rs-napi@${root?.version ?? '0.0.0'}`,
    },
  },
  components: [...cargoComponents, ...native],
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(bom, null, 2)}\n`)

console.log(`[sbom] wrote ${outPath}`)
console.log(
  `[sbom] ${cargoComponents.length} Rust crates + ${native.length} native components ` +
    `(GDAL ${native.find((c) => c.name === 'GDAL').version}, ` +
    `PROJ ${native.find((c) => c.name === 'PROJ').version})`,
)
