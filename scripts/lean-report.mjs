#!/usr/bin/env node
// Report what the addon built right now contains, so a `bundled-lean` build can
// be compared with the default. Run it after `npm run build` or
// `npm run build:lean`.
//
//   node scripts/lean-report.mjs
//
// The numbers this prints are what `docs/MUSL-LEAN.md` asks to be measured: the
// `.node` size and the driver count, plus which of the library-backed drivers
// the lean set drops are actually absent.

import { readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The drivers `bundled-lean` deliberately leaves out. */
const LIBRARY_BACKED = [
  'HDF5',
  'netCDF',
  'WMS',
  'WMTS',
  'WCS',
  'OGCAPI',
  'PLMOSAIC',
  'PostgreSQL',
]

const binary = readdirSync(repoRoot).find((name) => name.endsWith('.node'))
if (!binary) {
  console.error('[lean-report] no .node in the repository root — build first')
  process.exit(1)
}

const bytes = statSync(join(repoRoot, binary)).size
const require = createRequire(import.meta.url)
const gdal = require(join(repoRoot, 'index.js'))
const { gdal: gdalRelease, proj } = gdal.version()
const names = gdal.drivers().map((driver) => driver.name)

const present = LIBRARY_BACKED.filter((name) => names.includes(name))
const absent = LIBRARY_BACKED.filter((name) => !names.includes(name))
const mib = (value) => (value / 1024 / 1024).toFixed(1)

console.log(`[lean-report] ${binary}`)
console.log(`[lean-report] .node size: ${bytes} bytes (${mib(bytes)} MiB)`)
console.log(`[lean-report] ${gdalRelease}, PROJ ${proj}`)
console.log(`[lean-report] drivers: ${names.length}`)
console.log(`[lean-report] library-backed present: ${present.join(', ') || '(none)'}`)
console.log(`[lean-report] library-backed absent:  ${absent.join(', ') || '(none)'}`)
