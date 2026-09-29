// Assemble a standalone, installable tarball for the platform that was just
// built: the root package files (loader, types, and the packaged GDAL/PROJ data)
// plus this platform's `.node`.
//
// The published-package design would put the binary in a
// `gdal-rs-napi-<platform>` npm package and let npm pick one via
// `optionalDependencies`. We do not publish to npm, so instead each tarball
// carries its own binary and `os`/`cpu`/`libc` fields, which makes it both
// self-contained and impossible to install on the wrong machine.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const binaryName = pkg.napi?.binaryName ?? pkg.name

/** Files that make the root package work, relative to the repo root. */
const ROOT_FILES = [
  'index.js',
  'index.d.ts',
  'binding.js',
  'binding.d.ts',
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'LICENSE',
  // GEOS is LGPL-2.1 and statically linked, so the package has to say so where a
  // consumer will see it — and point at the release material for §6.
  'THIRD-PARTY.md',
]

function fail(message) {
  console.error(`[pack-platform] ${message}`)
  process.exit(1)
}

// Exactly one `gdal-rs-napi.<platform-arch-abi>.node` is expected; its name is
// where the platform string comes from.
const bindings = readdirSync(repoRoot).filter(
  (name) => name.startsWith(`${binaryName}.`) && name.endsWith('.node'),
)
if (bindings.length !== 1) {
  fail(`expected exactly one ${binaryName}.<platform>.node, found ${bindings.length}: ${bindings.join(', ')}`)
}
const [binary] = bindings
const platform = binary.slice(binaryName.length + 1, -'.node'.length)

/** `npm`'s os / cpu / libc fields, derived from the platform triple. */
function npmPlatformFields(platform) {
  const [os, cpu, ...rest] = platform.split('-')
  const abi = rest.join('-')
  const fields = { os: [os], cpu: [cpu] }
  if (os === 'linux') fields.libc = [abi === 'musl' ? 'musl' : 'glibc']
  return fields
}

const staging = join(repoRoot, 'dist', platform)
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

for (const file of ROOT_FILES) {
  const source = join(repoRoot, file)
  if (!existsSync(source)) fail(`missing ${file}; run \`npm run build\` first`)
  cpSync(source, join(staging, file))
}
cpSync(join(repoRoot, 'assets'), join(staging, 'assets'), { recursive: true })
cpSync(join(repoRoot, binary), join(staging, binary))

// A consumer-only manifest: no scripts (so installing never runs anything), no
// build metadata, and platform fields that make npm reject a mismatched machine.
const consumer = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  main: 'index.js',
  types: 'index.d.ts',
  engines: pkg.engines,
  keywords: pkg.keywords,
  repository: pkg.repository,
  ...npmPlatformFields(platform),
}
writeFileSync(join(staging, 'package.json'), `${JSON.stringify(consumer, null, 2)}\n`)

const distDir = join(repoRoot, 'dist')

// Run the npm CLI as a script rather than through a shell: on Windows `npm` is a
// `.cmd`, and spawning that with `shell: true` both quotes poorly and trips a
// Node deprecation warning.
function npmPack() {
  const cli =
    process.env.npm_execpath ??
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const args = ['pack', '--pack-destination', distDir]
  if (existsSync(cli)) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: staging, stdio: 'inherit' })
  }
  return spawnSync('npm', args, { cwd: staging, stdio: 'inherit', shell: process.platform === 'win32' })
}

const packed = npmPack()
if (packed.status !== 0) fail('npm pack failed')

// `npm pack` names the file after the package; add the platform so the release
// assets are distinguishable.
const packageSlug = pkg.name.replace('@', '').replace('/', '-')
const defaultName = `${packageSlug}-${pkg.version}.tgz`
const target = join(distDir, `${packageSlug}-${pkg.version}-${platform}.tgz`)
if (existsSync(join(distDir, defaultName))) {
  rmSync(target, { force: true })
  cpSync(join(distDir, defaultName), target)
  rmSync(join(distDir, defaultName))
}

console.log(`[pack-platform] ${platform}: ${target}`)
