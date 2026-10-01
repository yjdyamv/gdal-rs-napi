// The one place that knows how a Rust target triple becomes the platform
// string napi puts in a `.node` filename, and how that platform string becomes
// npm's `os` / `cpu` / `libc` fields.
//
// Two scripts need it (`pack-platform.mjs` and `pack-packages.mjs`), and CI
// needs the other direction — it asserts that the binary a leg just built
// carries the label its target implies, because a leg that quietly built for
// its host produces a tarball named after another platform, and the v0.1.0
// release shipped four assets instead of six for exactly that reason. That
// check used to be a `case` statement inlined in the workflow, which meant the
// mapping was written down twice: once here and once in YAML, free to drift.
//
// The napi labels are also what `platforms` in `package.json` lists, so the two
// are kept in step deliberately rather than by accident.

/**
 * Rust target triple -> the platform string in `gdal-rs-napi.<platform>.node`.
 *
 * The ABI is not in the triple for every target (`x86_64-pc-windows-msvc` has
 * no `libc` part, `aarch64-apple-darwin` has no `abi`), which is why these are
 * spelled out rather than derived.
 */
const TRIPLE_TO_PLATFORM = {
  'x86_64-pc-windows-msvc': 'win32-x64-msvc',
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-unknown-linux-gnu': 'linux-x64-gnu',
  'aarch64-unknown-linux-gnu': 'linux-arm64-gnu',
  'x86_64-unknown-linux-musl': 'linux-x64-musl',
  'aarch64-unknown-linux-musl': 'linux-arm64-musl',
}

/**
 * The platform string a build for `target` must have produced, or `null` for a
 * target that is not one of the six we ship.
 */
export function platformForTarget(target) {
  return TRIPLE_TO_PLATFORM[target] ?? null
}

/**
 * npm's `os` / `cpu` / `libc` fields, derived from the platform string.
 *
 * `libc` is only set on Linux, where npm needs it to tell a glibc machine from
 * a musl one; on the other platforms the field is absent rather than empty,
 * because an empty array would match nothing.
 */
export function npmPlatformFields(platform) {
  const [os, cpu, ...rest] = platform.split('-')
  const abi = rest.join('-')
  const fields = { os: [os], cpu: [cpu] }
  if (os === 'linux') fields.libc = [abi === 'musl' ? 'musl' : 'glibc']
  return fields
}
