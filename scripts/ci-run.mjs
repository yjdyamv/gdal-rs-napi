#!/usr/bin/env node
// Runs one command for a CI matrix leg.
//
// A musl addon is dynamically linked against musl, so the glibc runner's own Node
// cannot load it — and that is true of the build and of the tests, not just the
// artifact. Rather than fork every step on the target (`if: matrix.musl_container`
// on half the workflow), the steps send the commands that touch the addon through
// here, and this re-enters the musl container when the target is a musl one. Every
// other leg runs the command as it stands, so the workflow keeps a single set of
// steps and the matrix is just `target` + `runs-on`.
//
//   CI_TARGET=x86_64-unknown-linux-gnu  node scripts/ci-run.mjs npm test
//   CI_TARGET=x86_64-unknown-linux-musl node scripts/ci-run.mjs npm test
//
// The container is built from `docker/musl.Dockerfile` on first use, so a step that
// never touches the addon (packing, the LGPL materials) still runs on the runner
// itself and needs no Docker at all.

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const IMAGE = 'gdal-rs-napi-musl'
const DOCKERFILE = 'docker/musl.Dockerfile'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.env.CI_TARGET ?? ''
const [command, ...commandArgs] = process.argv.slice(2)

if (command === undefined) {
  console.error('usage: node scripts/ci-run.mjs <command> [args...]')
  process.exit(2)
}

/** Run a command in the repository root and exit with its status. */
function run(executable, args) {
  const result = spawnSync(executable, args, { stdio: 'inherit', cwd: repoRoot })
  if (result.error) {
    console.error(`ci-run: ${executable}: ${result.error.message}`)
    process.exit(1)
  }
  process.exit(result.status ?? 1)
}

/** The container is only built once, however many steps go through it. */
function buildImage() {
  const exists = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' })
  if (exists.status === 0) return
  console.log(`ci-run: building ${IMAGE} from ${DOCKERFILE}`)
  run('docker', ['build', '-f', DOCKERFILE, '-t', IMAGE, '.'])
}

if (target.endsWith('-linux-musl')) {
  buildImage()
  // `env:` on the runner does not reach into the container, and `npm ci` runs its
  // `prepare` hook — so HUSKY (and CI, which the test runner reads) are forwarded
  // by name, which hands over the runner's value.
  run('docker', [
    'run',
    '--rm',
    '-v',
    `${repoRoot}:/work`,
    '-w',
    '/work',
    '-e',
    'HUSKY',
    '-e',
    'CI',
    IMAGE,
    command,
    ...commandArgs,
  ])
}

// A native leg runs where it stands. On Windows the command is usually `npm`, which
// is `npm.cmd` there and needs a shell to be resolved at all, so that one goes
// through the host shell the way the workflow would have.
if (process.platform === 'win32') {
  const line = [command, ...commandArgs].join(' ')
  run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line])
}

run(command, commandArgs)
