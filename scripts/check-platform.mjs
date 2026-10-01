// Assert that the `.node` just built carries the platform label its CI target
// implies, and print it for the steps that name their artifacts.
//
// The name is the only thing tying a tarball to a platform, and a leg that
// quietly built for its host rather than its target produces a tarball that
// collides with another leg's — which is how the v0.1.0 release ended up with
// four assets instead of six. Nothing downstream can catch that: `npm pack`
// names the file from the binary's name, so a wrong label propagates straight
// into the release.
//
// The mapping lives in `scripts/platform.mjs`, shared with the two packing
// scripts. It used to be a `case` statement inlined in the workflow, so it was
// written down twice and free to drift.
import { appendFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { platformForTarget } from './platform.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** `--target <triple>`, the way `npm run build` forwards it. */
function targetFromArgs(argv) {
  const index = argv.indexOf('--target')
  if (index !== -1 && argv[index + 1]) return argv[index + 1]
  return process.env.CARGO_BUILD_TARGET || null
}

function fail(message) {
  console.error(`[check-platform] ${message}`)
  process.exit(1)
}

const target = targetFromArgs(process.argv)
if (!target) fail('no --target given, and CARGO_BUILD_TARGET is unset')

const expected = platformForTarget(target)
if (!expected) {
  fail(`no platform is known for ${target}; add it to TRIPLE_TO_PLATFORM in scripts/platform.mjs`)
}

// `pack-platform.mjs` makes the same assumption — exactly one binary in the
// repository root — and refuses to pack otherwise.
const binaryName = 'gdal-rs-napi'
const bindings = readdirSync(repoRoot).filter(
  (name) => name.startsWith(`${binaryName}.`) && name.endsWith('.node'),
)
if (bindings.length !== 1) {
  fail(`expected exactly one ${binaryName}.<platform>.node, found ${bindings.length}: ${bindings.join(', ')}`)
}

const actual = bindings[0].slice(binaryName.length + 1, -'.node'.length)
console.log(`[check-platform] target=${target} expected=${expected} actual=${actual}`)

if (actual !== expected) {
  fail(`the binary is labelled ${actual} but ${target} should give ${expected}`)
}

// The steps after this one name their upload directory from PLATFORM, so hand
// it to the runner the way a workflow does: appended to the file named by
// `$GITHUB_ENV`, one `NAME=value` per line.
//
// This is written here rather than piped from the shell on purpose. A workflow
// step's default shell is PowerShell on a Windows runner, where `$GITHUB_ENV`
// is *not* a variable (it is `$env:GITHUB_ENV`) and `tee` is `Tee-Object` — so a
// `... | tee -a "$GITHUB_ENV"` line fails there with "Cannot bind argument to
// parameter 'FilePath' because it is an empty string". Doing it in Node reads
// the environment the same way on every shell, and keeps the pipeline out of
// the YAML where the quoting rules differ per platform.
if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `PLATFORM=${actual}\n`)
} else {
  // Local run, or a shell that did not set it: the line on stdout is what a
  // human reads, and the workflow gets the variable from the file above.
  console.log(`PLATFORM=${actual}`)
}
