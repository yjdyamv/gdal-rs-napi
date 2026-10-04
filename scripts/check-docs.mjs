#!/usr/bin/env node
// Guards the documentation claims that can be checked mechanically.
//
// The failure this exists for is the quiet kind: a version bumped in
// `package.json` but not in `Cargo.toml`, a file dropped from the `files` array
// so the tarball silently loses it, or a README example that names a driver
// count or version the build no longer produces. None of those break a test.
//
// The static checks run everywhere, including CI's GDAL-free `checks` job. The
// runtime checks run only where the addon is already built; when it is not, they
// are skipped with a note rather than failing.
//
//   node scripts/check-docs.mjs            # static + runtime-if-built
//   node scripts/check-docs.mjs --static   # static only

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const staticOnly = process.argv.includes('--static')

const failures = []
const notes = []

function read(rel) {
  return readFileSync(join(repoRoot, rel), 'utf8')
}

function fail(message) {
  failures.push(message)
}

// --- Version parity between the two manifests ------------------------------
// `apiVersion` is `env!("CARGO_PKG_VERSION")`, so Cargo.toml is the one that
// really decides the binding's version; package.json must agree or the npm
// package and `gdal.apiVersion` disagree.
const pkg = JSON.parse(read('package.json'))
const cargo = read('Cargo.toml')
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
if (!cargoVersion) {
  fail('Cargo.toml: could not find the [package] version')
} else if (cargoVersion !== pkg.version) {
  fail(`version drift: package.json is ${pkg.version} but Cargo.toml is ${cargoVersion}`)
}

// --- The CHANGELOG has a section for this version --------------------------
const changelog = read('CHANGELOG.md')
const hasSection =
  changelog.includes(`## [${pkg.version}]`) ||
  changelog.includes(`## ${pkg.version}`) ||
  changelog.includes('## Unreleased')
if (!hasSection) {
  fail(`CHANGELOG.md has no section for ${pkg.version} (or an "## Unreleased" heading)`)
}

// --- Everything the tarball lists actually exists --------------------------
const declared = [...(pkg.files ?? []), pkg.main, pkg.types].filter(Boolean)
for (const rel of declared) {
  // A trailing slash means a directory that ships whole.
  const path = join(repoRoot, rel)
  if (!existsSync(path)) {
    fail(`package.json lists "${rel}", which does not exist`)
  }
}

// --- Entry points the docs promise -----------------------------------------
for (const rel of [
  'index.js',
  'index.d.ts',
  'binding.js',
  'binding.d.ts',
  'async-methods.js',
  'compat/index.js',
  'compat/index.d.ts',
]) {
  if (!existsSync(join(repoRoot, rel))) fail(`the documented entry point "${rel}" is missing`)
}

// --- Claims with no version in them, but a number that can go stale ---------
// These are the sentences that have drifted before. Each is a literal the docs
// are not allowed to keep once it stops being true.
const staleClaims = [
  {
    files: ['ROADMAP.md'],
    pattern: /`node --test`\s*103/,
    why: 'the suite is vitest (49 files / 436 tests), not node --test with 103',
  },
  {
    files: ['CHANGELOG.md'],
    pattern: /__test__\/|\.test\.mjs\b/,
    why: 'the suite moved from `__test__/*.test.mjs` to `ts-test/**/*.spec.ts` (vitest)',
  },
]
for (const claim of staleClaims) {
  for (const rel of claim.files) {
    if (claim.pattern.test(read(rel))) fail(`${rel} keeps a stale claim: ${claim.why}`)
  }
}

// --- Runtime claims, when the addon is built --------------------------------
if (!staticOnly) {
  let gdal = null
  try {
    const require = createRequire(import.meta.url)
    gdal = require(join(repoRoot, 'index.js'))
  } catch (error) {
    notes.push(`runtime checks skipped (the addon is not built): ${error.message}`)
  }

  if (gdal) {
    const readme = read('README.md')

    // `gdal.version()` names the exact GDAL release the README quotes.
    const readmeVersion = readme.match(/gdal\.version\(\)\s*\n\/\/\s*\{ gdal: '([^']+)'/)
    if (readmeVersion) {
      const actual = gdal.version().gdal
      if (readmeVersion[1] !== actual) {
        fail(`README quotes GDAL as "${readmeVersion[1]}" but the build reports "${actual}"`)
      }
    }

    // The driver count, in both READMEs, in either spelling the docs use.
    const actualDrivers = gdal.drivers().length
    for (const rel of ['README.md', 'README.zh-CN.md']) {
      const text = read(rel)
      for (const pattern of [
        /gdal\.drivers\(\)\.length\s*\/\/\s*(\d+)/,
        /driverCount:\s*(\d+)/,
      ]) {
        const claim = text.match(pattern)
        if (claim && Number(claim[1]) !== actualDrivers) {
          fail(`${rel} says the driver count is ${claim[1]} but the build registers ${actualDrivers}`)
        }
      }
    }

    // `gdal.apiVersion // '0.1.0'`
    const apiClaim = readme.match(/gdal\.apiVersion\s*\/\/\s*'([^']+)'/)
    if (apiClaim && apiClaim[1] !== gdal.apiVersion) {
      fail(`README says apiVersion is ${apiClaim[1]} but the build reports ${gdal.apiVersion}`)
    }

    // `gdal.features()` example object: every key the README shows must exist.
    const featuresClaim = readme.match(/gdal\.features\(\)\s*\n\/\/\s*\{ ([^}]+) \}/)
    if (featuresClaim) {
      const actual = gdal.features()
      for (const key of featuresClaim[1].split(',').map((pair) => pair.trim().split(':')[0])) {
        if (key && !(key in actual)) fail(`README's features() example names "${key}", which is absent`)
      }
    }
    notes.push(`runtime checks ran against GDAL ${gdal.version().gdal}, apiVersion ${gdal.apiVersion}`)
  }
}

for (const note of notes) console.log(`[check-docs] note: ${note}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`[check-docs] FAIL: ${failure}`)
  process.exit(1)
}
console.log(`[check-docs] ok${staticOnly ? ' (static)' : ''}`)
