#!/usr/bin/env node
// Wrapper around `napi build` that also sanitises PATH on Windows.
//
// Why this exists — the bundled GDAL/PROJ configure step runs find_package()
// against every prefix CMake can discover from PATH. MSYS2's UCRT64 tree ships
// an ArrowConfig.cmake that overwrites CMAKE_MODULE_PATH without restoring it,
// which makes GDAL's own `include(GdalDriverHelper)` fail with
// "include could not find requested file: GdalDriverHelper" and kills the whole
// configure. Its MinGW `.a` libraries are also unusable from an MSVC build.
//
// Verified: with `C:\msys64\ucrt64\bin` on PATH the configure dies in
// frmts/zlib/contrib/infback9; with it removed the same configure succeeds and
// produces a working 131-driver static GDAL.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const POLLUTED = /[\\/](msys2?|mingw32|mingw64|ucrt64|clang64|clangarm64|cygwin|cygwin64)[\\/]/i

function sanitizedPath() {
  const current = process.env.PATH ?? ''
  if (process.platform !== 'win32') return current
  const dropped = []
  const kept = current.split(';').filter((entry) => {
    if (!entry) return false
    if (POLLUTED.test(`${entry}\\`)) {
      dropped.push(entry)
      return false
    }
    return true
  })
  if (dropped.length > 0) {
    console.log(`[build] dropping from PATH: ${dropped.join(', ')}`)
  }
  return kept.join(';')
}

// PROJ's configure shells out to the `sqlite3` *command line tool* to generate
// proj.db, so it has to be reachable — while MSYS2's copy, which is usually the
// only one on a Windows box, has to be the one we just filtered out above.
// Check for it up front rather than letting CMake fail minutes into the build.
const buildPath = sanitizedPath()
const sqlite = spawnSync(process.platform === 'win32' ? 'sqlite3.exe' : 'sqlite3', ['--version'], {
  env: { ...process.env, PATH: buildPath },
  encoding: 'utf8',
})
if (sqlite.status !== 0) {
  console.error(
    '[build] `sqlite3` was not found on PATH, but PROJ needs it to generate proj.db.\n' +
      '[build] Install it somewhere other than an MSYS2/Cygwin tree, e.g.\n' +
      '[build]   Windows:  winget install SQLite.SQLite     (or: choco install sqlite)\n' +
      '[build]   macOS:    brew install sqlite\n' +
      '[build]   Debian:   sudo apt-get install sqlite3\n' +
      '[build] (MSYS2 ships one, but that whole prefix has to stay off PATH: see the\n' +
      '[build]  comment at the top of this file.)',
  )
  process.exit(1)
}

const cli = join(repoRoot, 'node_modules', '@napi-rs', 'cli', 'dist', 'cli.js')
if (!existsSync(cli)) {
  console.error(
    '[build] @napi-rs/cli is not installed.\n' +
      '[build] Run `npm install`. If a `NODE_ENV=production` is set in your\n' +
      '[build] environment npm silently skips devDependencies — use\n' +
      '[build] `npm install --include=dev` in that case.',
  )
  process.exit(1)
}

const args = [cli, 'build', ...process.argv.slice(2)]
const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  cwd: repoRoot,
  env: { ...process.env, PATH: buildPath },
})

process.exit(result.status ?? 1)
