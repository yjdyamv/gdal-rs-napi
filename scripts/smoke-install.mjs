// Install a packed tarball into an empty directory and use it, the way a
// stranger would.
//
// This is the check the "no host dependency" claim stands on: a directory with
// nothing in it but a `package.json`, an `npm install` of our own artifact, and
// then a program that asks GDAL what it is. If a system GDAL, PROJ or GEOS were
// being reached, a machine that has none of them would fail here — which is what
// CI runs it on.
//
//   node scripts/smoke-install.mjs [tarball]
//
// With no argument it takes the self-contained tarball `pack-platform.mjs`
// produced for this platform.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

function fail(message) {
  console.error(`[smoke] ${message}`)
  process.exit(1)
}

/** The self-contained tarball for this platform — `<name>-<version>-<platform>.tgz`. */
function selfContainedTarball() {
  const distDir = join(repoRoot, 'dist')
  if (!existsSync(distDir)) return null
  const prefix = `${pkg.name}-${pkg.version}-`
  const candidates = readdirSync(distDir).filter(
    (name) => name.startsWith(prefix) && name.endsWith('.tgz') && !name.includes('-lgpl-geos'),
  )
  return candidates.length > 0 ? join(distDir, candidates[0]) : null
}

const tarball = resolve(process.argv[2] ?? selfContainedTarball() ?? '')
if (!tarball || !existsSync(tarball)) {
  fail('no tarball to install — run `npm run pack` first, or pass one as an argument')
}

const workdir = mkdtempSync(join(tmpdir(), 'gdal-rs-napi-smoke-'))
const cleanup = () => rmSync(workdir, { recursive: true, force: true })
process.on('exit', cleanup)

writeFileSync(join(workdir, 'package.json'), `${JSON.stringify({ name: 'smoke', private: true }, null, 2)}\n`)

function run(command, args, description) {
  console.log(`[smoke] ${description}`)
  const result = spawnSync(command, args, { cwd: workdir, encoding: 'utf8' })
  if (result.error) fail(`${description} could not start: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`${description} failed (exit ${result.status})\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
  return result.stdout ?? ''
}

// `npm install` the tarball by path — no registry, no other dependency. The npm
// CLI is run as a *script through node* rather than as `npm`/`npm.cmd`: spawning
// a `.cmd` needs a shell, which brings its own quoting problems (the same reason
// `pack-platform.mjs` does it this way).
const npmCli =
  process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
if (!existsSync(npmCli)) fail(`could not find the npm CLI at ${npmCli}`)

run(
  process.execPath,
  [npmCli, 'install', '--no-audit', '--no-fund', '--loglevel', 'error', tarball],
  `installing ${tarball}`,
)

// A program that uses the package the way a consumer would, including the parts
// that only work when the packaged data files were found.
writeFileSync(
  join(workdir, 'check.mjs'),
  `import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const gdal = require('gdal-rs-napi')

const version = gdal.version()
const diagnostics = gdal.diagnostics()
const features = gdal.features()
const drivers = gdal.drivers().length

if (!diagnostics.crsDatabaseFound) throw new Error('the packaged CRS database was not found')
if (!diagnostics.epsg4326Resolves) throw new Error('EPSG:4326 did not resolve')
if (drivers < 100) throw new Error(\`only \${drivers} drivers registered\`)
if (!features.threadSafe) throw new Error('openThreadSafe is missing')

// GEOS is linked in statically, so a geometry predicate should work with nothing
// installed on the host.
const square = gdal.Geometry.fromWkt('POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))')
const buffered = square.buffer(1).area()
if (!(buffered > 4)) throw new Error(\`buffer produced \${buffered}, expected more than 4\`)

// ... and a raster really round-trips, which exercises the data files too.
const path = '/vsimem/smoke.tif'
const dataset = gdal.createSync(path, { driver: 'GTiff', width: 4, height: 4, bandCount: 1, dataType: 'Uint8' })
dataset.band(0).fill(7)
dataset.flushSync()
if (dataset.band(0).readPixelsSync()[0] !== 7) throw new Error('a written pixel did not read back')
dataset.close()
gdal.fs.unlink(path)

console.log(\`[smoke] gdal=\${version.gdal} proj=\${version.proj} drivers=\${drivers} geos=\${features.geos} bufferArea=\${buffered.toFixed(3)}\`)
`,
)

const output = run(process.execPath, ['check.mjs'], 'running the consumer program')
process.stdout.write(output)
console.log(`[smoke] OK — ${tarball} installs and works with nothing on the host`)
