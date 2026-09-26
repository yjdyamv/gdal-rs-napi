// Stages the runtime data files that a statically linked PROJ/GDAL still needs at
// run time into <repo>/assets, which the root npm package ships via `files`.
//
// A static libproj bakes in a build-machine search path for proj.db, so the data
// has to travel with the addon and be pointed at explicitly (see index.js).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = join(repoRoot, 'assets')

// Directories that never contain the data we are after, and can be huge.
const SKIP_DIRS = new Set([
  'incremental',
  '.fingerprint',
  'deps',
  'examples',
  'docs',
  'test',
  'tests',
  'autotest',
  'swig',
  'java',
  'python',
  'perl',
  'node_modules',
])

function buildDirCandidates() {
  const targetDir = join(repoRoot, 'target')
  if (!existsSync(targetDir)) return []

  // `napi build --platform` passes `--target <host triple>`, so its build-script
  // output lives in target/<triple>/<profile>/build, while a plain `cargo build`
  // uses target/<profile>/build. A machine that has done both has several trees
  // that are NOT interchangeable — an abandoned one can hold a half-generated
  // data directory — so search them in a fixed order of preference and take the
  // data from the first tree that has it.
  const triples = readdirSync(targetDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !['release', 'debug'].includes(entry.name))
    .map((entry) => entry.name)

  const ordered = [
    ...triples.map((triple) => join(targetDir, triple, 'release', 'build')),
    join(targetDir, 'release', 'build'),
    ...triples.map((triple) => join(targetDir, triple, 'debug', 'build')),
    join(targetDir, 'debug', 'build'),
  ]

  const found = []
  for (const dir of ordered) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!/^(gdal-src|proj-sys|gdal-sys)-/.test(entry.name)) continue
      found.push(join(dir, entry.name, 'out'))
    }
  }
  return found
}

/** Breadth-first search for a directory satisfying `predicate`. */
function findDir(roots, predicate, maxDepth = 8) {
  const queue = roots.filter((r) => existsSync(r)).map((r) => [r, 0])
  while (queue.length > 0) {
    const [dir, depth] = queue.shift()
    if (predicate(dir)) return dir
    if (depth >= maxDepth) continue
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
      queue.push([join(dir, entry.name), depth + 1])
    }
  }
  return null
}

function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(path)
    else total += statSync(path).size
  }
  return total
}

function stage(label, source, destination, filter) {
  if (!source) {
    console.warn(`[stage-assets] ${label}: not found — skipping`)
    return false
  }
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(source, destination, { recursive: true, filter })
  const mb = (dirSize(destination) / 1024 / 1024).toFixed(1)
  console.log(`[stage-assets] ${label}: ${source} -> ${destination} (${mb} MB)`)
  return true
}

const roots = buildDirCandidates()
if (roots.length === 0) {
  console.warn('[stage-assets] no gdal-src/proj-sys build output found under target/')
  console.warn('[stage-assets] build with the `bundled` feature first (npm run build)')
  process.exit(0)
}

// PROJ data: the directory holding proj.db (also carries proj.ini).
const projDir = findDir(roots.filter((r) => /proj-sys-/.test(r)), (dir) =>
  existsSync(join(dir, 'proj.db')),
)

// Build-time-only artefacts that would just bloat the npm tarball:
//   for_tests/   PROJ's own test database (~16 MB)
//   CMakeFiles/  cmake bookkeeping
//   all.sql.in   the SQL used to *generate* proj.db (~13 MB)
const PROJ_EXCLUDE = [
  /[/\\](for_tests|CMakeFiles)([/\\]|$)/,
  /[/\\](all\.sql\.in|PROJ_DB_SQL_MD5\.h|cmake_install\.cmake)$/,
]
const keepProj = (src) => !PROJ_EXCLUDE.some((re) => re.test(src))

// GDAL's data/ directory. Its contents changed across versions — the old
// coordinate_axis.csv / gdalvsi files are gone in 3.12 (PROJ owns them now) —
// so match on any of the markers rather than a single one.
const GDAL_MARKERS = [
  'gdalvrt.xsd',
  'gdalmdiminfo_output.schema.json',
  'epsg.wkt',
  'grib2_center.csv',
  'coordinate_axis.csv',
  'gdalvsi',
  'gml_registry.xml',
]
const gdalDir = findDir(roots, (dir) =>
  GDAL_MARKERS.some((marker) => existsSync(join(dir, marker))),
)

const okProj = stage('proj', projDir, join(assetsDir, 'proj'), keepProj)
const okGdal = stage('gdal', gdalDir, join(assetsDir, 'gdal'))

if (!okProj || !okGdal) {
  console.warn('[stage-assets] incomplete: EPSG lookups / CRS parsing may fail at runtime')
}
