// Build the npm platform package for the binary that was just built, and pack it.
//
// The published layout is the one napi generates a loader for: the root package
// carries the JavaScript, the types and the PROJ/GDAL data files, and lists one
// `optionalDependencies` entry per platform — `gdal-rs-napi-<platform>` — whose
// own package contains nothing but the `.node`. npm installs the one that matches
// the machine, and `binding.js` requires it by name (and checks its version
// against the root's).
//
// The self-contained tarball `pack-platform.mjs` makes is a *different* artifact
// and stays: it is what a GitHub Release attaches, and what someone installs
// directly without npm resolving anything.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { npmPlatformFields } from './platform.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const binaryName = pkg.napi?.binaryName ?? pkg.name

function fail(message) {
  console.error(`[pack-packages] ${message}`)
  process.exit(1)
}

// Exactly one `gdal-rs-napi.<platform-arch-abi>.node` is expected; its name is
// where the platform string comes from. `pack-platform.mjs` derives it the same
// way, so the two artifacts always agree on a label.
const bindings = readdirSync(repoRoot).filter(
  (name) => name.startsWith(`${binaryName}.`) && name.endsWith('.node'),
)
if (bindings.length !== 1) {
  fail(`expected exactly one ${binaryName}.<platform>.node, found ${bindings.length}: ${bindings.join(', ')}`)
}
const [binary] = bindings
const platform = binary.slice(binaryName.length + 1, -'.node'.length)

const packageName = `${pkg.name}-${platform}`
const staging = join(repoRoot, 'npm', platform)
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

cpSync(join(repoRoot, binary), join(staging, binary))
// The GEOS licence notice travels with the binary that contains GEOS, not only
// with the root package.
for (const file of ['LICENSE', 'THIRD-PARTY.md']) {
  if (existsSync(join(repoRoot, file))) cpSync(join(repoRoot, file), join(staging, file))
}

// A consumer-only manifest: `main` is the addon itself, so requiring the package
// hands back the binding. No scripts, so installing never runs anything.
const manifest = {
  name: packageName,
  version: pkg.version,
  description: `${pkg.description} (the ${platform} binary)`,
  license: pkg.license,
  main: binary,
  files: [binary, 'LICENSE', 'THIRD-PARTY.md'],
  engines: pkg.engines,
  keywords: pkg.keywords,
  repository: pkg.repository,
  ...npmPlatformFields(platform),
}
writeFileSync(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

// Platform packages go to `dist/npm/` rather than beside the self-contained
// tarball, so the release job can tell the two kinds apart with a path test
// instead of guessing from a filename.
const distDir = join(repoRoot, 'dist', 'npm')
mkdirSync(distDir, { recursive: true })

// Run the npm CLI as a script rather than through a shell: on Windows `npm` is a
// `.cmd`, and spawning that with `shell: true` both quotes poorly and trips a
// Node deprecation warning.
const npmCli =
  process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
if (!existsSync(npmCli)) fail(`could not find the npm CLI at ${npmCli}`)

function npmPack() {
  return spawnSync(
    process.execPath,
    [npmCli, 'pack', '--pack-destination', distDir],
    { cwd: staging, stdio: 'inherit' },
  )
}

const packed = npmPack()
if (packed.status !== 0) fail('npm pack failed')

const target = join(distDir, `${packageName}-${pkg.version}.tgz`)
if (!existsSync(target)) fail(`npm pack did not produce ${target}`)
console.log(`[pack-packages] ${platform}: ${packageName}@${pkg.version} -> ${target}`)

// ... and the root package, packed by npm from the repository itself so its
// `files` list decides what ships. This is what `npm publish` takes — it is *not*
// the self-contained tarball `pack-platform.mjs` builds, which carries the binary
// and a consumer-only manifest for a direct install.
const rootDir = join(repoRoot, 'dist', 'root')
rmSync(rootDir, { recursive: true, force: true })
mkdirSync(rootDir, { recursive: true })

const rootPacked = spawnSync(
  process.execPath,
  [npmCli, 'pack', '--pack-destination', rootDir],
  { cwd: repoRoot, stdio: 'inherit' },
)
if (rootPacked.status !== 0) fail('npm pack of the root package failed')

const rootTarget = join(rootDir, `${pkg.name}-${pkg.version}.tgz`)
if (!existsSync(rootTarget)) fail(`npm pack did not produce ${rootTarget}`)
console.log(`[pack-packages] root: ${pkg.name}@${pkg.version} -> ${rootTarget}`)
