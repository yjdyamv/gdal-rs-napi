// Assemble the LGPL-2.1 §6 material for the platform that was just built: the
// exact GEOS source that went into the `.node`, the static archives the build
// produced, and a note explaining how to relink against a modified GEOS.
//
// LGPL-2.1 §6 asks the distributor of a statically linked work for the means to
// relink it. GEOS is the one component here under such a licence, so this is the
// thing a release owes beside each platform tarball — see THIRD-PARTY.md and
// docs/GEOS.md.
//
// It takes the source from wherever this build actually got it: `geos-src`'s
// vendored tree, located through `cargo metadata`, falling back to the source
// directory CMake recorded in its own cache.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const binaryName = pkg.napi?.binaryName ?? pkg.name
const distDir = join(repoRoot, 'dist')

function fail(message) {
  console.error(`[lgpl-geos] ${message}`)
  process.exit(1)
}

// The platform comes from the built addon, the same way `pack-platform.mjs` gets
// it, so the two artifacts always agree on a label.
const bindings = readdirSync(repoRoot).filter(
  (name) => name.startsWith(`${binaryName}.`) && name.endsWith('.node'),
)
if (bindings.length !== 1) {
  fail(`expected exactly one ${binaryName}.<platform>.node, found ${bindings.length}: ${bindings.join(', ')}`)
}
const platform = bindings[0].slice(binaryName.length + 1, -'.node'.length)

/** `geos-src`'s vendored source, via `cargo metadata` (the crate knows where it is). */
function sourceFromCargo() {
  const result = spawnSync('cargo', ['metadata', '--format-version', '1'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.status !== 0) return null

  let metadata
  try {
    metadata = JSON.parse(result.stdout)
  } catch {
    return null
  }

  const pkgInfo = metadata.packages?.find((entry) => entry.name === 'geos-src')
  if (!pkgInfo) return null
  const dir = dirname(pkgInfo.manifest_path)
  const source = join(dir, 'source')
  return existsSync(source) ? { source, version: pkgInfo.version, dir } : null
}

/** The source directory CMake recorded, for when `cargo metadata` cannot say. */
function sourceFromBuildCache() {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 6 || !existsSync(dir)) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name.startsWith('geos-src-')) {
        const cache = join(full, 'out', 'build', 'CMakeCache.txt')
        if (existsSync(cache)) found.push(cache)
        continue
      }
      walk(full, depth + 1)
    }
  }
  walk(join(repoRoot, 'target'), 0)

  for (const cache of found) {
    const line = readFileSync(cache, 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith('CMAKE_HOME_DIRECTORY:INTERNAL='))
    if (!line) continue
    const source = line.slice('CMAKE_HOME_DIRECTORY:INTERNAL='.length).trim()
    if (existsSync(join(source, 'Version.txt'))) return { source, version: null, cache }
  }
  return null
}

/** The static archives the build produced, whichever profile/target they are in. */
function builtArchives() {
  const archives = new Map()
  const walk = (dir, depth) => {
    if (depth > 6 || !existsSync(dir)) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name.startsWith('geos-src-')) {
        const libDir = join(full, 'out', 'lib')
        if (existsSync(libDir)) {
          for (const file of readdirSync(libDir)) {
            if (!file.endsWith('.lib') && !file.endsWith('.a')) continue
            const candidate = join(libDir, file)
            // Several profiles/targets may each have one; keep the largest per
            // name, since a debug and a release archive are the same library.
            const known = archives.get(file)
            if (!known || statSync(candidate).size > statSync(known).size) {
              archives.set(file, candidate)
            }
          }
        }
        continue
      }
      walk(full, depth + 1)
    }
  }
  walk(join(repoRoot, 'target'), 0)
  return [...archives.values()]
}

const located = sourceFromCargo() ?? sourceFromBuildCache()
if (!located) {
  fail(
    'could not find the GEOS source this build used — run `npm run build` first, and make sure the ' +
      '`geos` feature is on (it is part of `bundled`, so the default build has it)',
  )
}
if (!existsSync(join(located.source, 'Version.txt'))) {
  fail(`found ${located.source}, but it does not look like a GEOS source tree`)
}

// `Version.txt` is GEOS's own: `GEOS_VERSION_MAJOR=3`, `GEOS_PATCH_WORD=dev`, …
const versionFields = {}
for (const line of readFileSync(join(located.source, 'Version.txt'), 'utf8').split('\n')) {
  const number = line.match(/^GEOS_VERSION_(MAJOR|MINOR|PATCH)=(\d+)/)
  if (number) versionFields[number[1].toLowerCase()] = number[2]
  const word = line.match(/^GEOS_PATCH_WORD=(.*)$/)
  if (word) versionFields.word = word[1].trim()
}
const versionText = `${versionFields.major}.${versionFields.minor}.${versionFields.patch}${versionFields.word}`

const archives = builtArchives()

const staging = join(distDir, `${platform}-lgpl-geos`)
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

// The source itself is the material §6 asks for; copy it whole rather than the
// files we happen to think are used.
cpSync(located.source, join(staging, 'geos-source'), { recursive: true })
if (archives.length > 0) {
  mkdirSync(join(staging, 'lib'))
  for (const archive of archives) cpSync(archive, join(staging, 'lib', archive.split(/[\\/]/).pop()))
}

const libNote =
  archives.length > 0
    ? `The static archives this build produced are in \`lib/\` (${archives
        .map((a) => a.split(/[\\/]/).pop())
        .join(', ')}).`
    : 'No static archives were found under `target/`; rebuild to produce them, or rebuild GEOS from `geos-source/` yourself.'

writeFileSync(
  join(staging, 'RELINK.md'),
  `# Relinking ${pkg.name} against a modified GEOS

The \`${bindings[0]}\` addon on this platform has **GEOS ${versionText}** linked
into it statically. GEOS is LGPL-2.1 (\`geos-source/COPYING\`), and LGPL-2.1 §6
asks a distributor of a statically linked work for the means to relink it against
a modified version of the library. This archive is that material.

## What is here

- \`geos-source/\` — the exact GEOS source tree this addon compiled.
- \`lib/\` — ${libNote}
- This note.

## Relinking against your own GEOS

1. Edit \`geos-source/\` as you like — or replace it with another interface-compatible
   GEOS of the same CAPI major.
2. Rebuild \`geos\` / \`geos_c\` from it (CMake; the tree is upstream GEOS, unmodified).
3. Rebuild this addon against it, from this project's source, following
   \`scripts/build.mjs\` — the same recipe that produced the addon you have. Point
   the build at your GEOS the way \`gdal-src\`'s \`GEOS_INCLUDE_DIR\` /
   \`GEOS_LIBRARY\` expect, which is what the \`geos-src\` stage does.

Nothing about the addon's public API changes; the relinked build reports the same
\`gdal.features().geos === true\` and exposes the same geometry operations.

The recipe, the Rust sources and the pinned versions are all in the project
repository; \`Cargo.lock\` fixes the GEOS source revision, and \`docs/GEOS.md\`
explains why it is linked this way.
`,
)

const slug = pkg.name.replace('@', '').replace('/', '-')
const archivePath = join(distDir, `${slug}-${pkg.version}-${platform}-lgpl-geos.tgz`)
rmSync(archivePath, { force: true })

const tarred = spawnSync('tar', ['-czf', archivePath, '-C', distDir, `${platform}-lgpl-geos`], {
  stdio: 'inherit',
})
if (tarred.status !== 0) fail('tar failed')

console.log(
  `[lgpl-geos] ${platform}: ${archivePath} (GEOS ${versionText}, ${archives.length} archive(s))`,
)
