#!/usr/bin/env node
// Measures what `openThreadSafe()` actually buys you, on real data.
//
// `open()` serialises every GDAL call behind one process-wide lock: the async
// methods free the event loop, but concurrent reads still queue. `openThreadSafe()`
// opens a dataset whose pixel reads take the shared side of that lock instead, so
// they genuinely overlap. This script runs the *same* concurrent workload through
// both and compares the wall times.
//
//   node scripts/bench-parallel.mjs [raster.tif] [--concurrency 4] [--rounds 5]
//
// Without a path it generates a temporary raster that compresses badly on purpose,
// so the reads are real work rather than a constant being squashed by the driver.
//
// Three things to know when reading the numbers:
//
//   * Node's worker pool defaults to four threads (`UV_THREADPOOL_SIZE`), so
//     nothing above four overlaps without restarting Node with that raised.
//   * A read GDAL serves from its block cache is nearly free, and then the lock is
//     not the bottleneck and there is nothing to win. `GDAL_CACHEMAX` is lowered
//     here for that reason, and the win shows up when reads are expensive: cold
//     I/O, or decompression.
//   * The first round pays for a cold cache. Every round is printed so you can see
//     the spread; only the later ones are used to rank the paths.
//
// This is a benchmark, not a test: the numbers depend on the machine, the driver
// and the storage, and there is no threshold to fail.

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Has to be set before the addon loads: GDAL reads it when its block cache first
// spins up.
const CACHE_MAX_MB = '10'
process.env.GDAL_CACHEMAX ??= CACHE_MAX_MB

const gdal = createRequire(import.meta.url)('..')

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : Number(argv[index + 1])
}
// The raster path is the one argument that is neither an option nor an option's
// value — without that second test, `--rounds 3` reads `3` as a filename.
const optionNames = ['concurrency', 'rounds', 'size']
const provided = argv.find(
  (arg, index) => !arg.startsWith('--') && !optionNames.includes(argv[index - 1]?.replace(/^--/, '')),
)
const concurrency = option('concurrency', 4)
const rounds = option('rounds', 5)
const generated = option('size', 2048)

let workdir = null
let source = provided
if (!source) {
  workdir = mkdtempSync(join(tmpdir(), 'gdal-rs-napi-bench-'))
  source = join(workdir, 'bench.tif')

  // Pseudo-random bytes: a constant would compress to nothing and every read
  // afterwards would be nearly free.
  const pixels = Buffer.alloc(generated * generated)
  let state = 12345
  for (let index = 0; index < pixels.length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    pixels[index] = state >> 16
  }

  const dataset = gdal.createSync(source, {
    driver: 'GTiff',
    width: generated,
    height: generated,
    bandCount: 1,
    options: { COMPRESS: 'DEFLATE' },
  })
  dataset.band(0).writePixelsSync(pixels)
  dataset.close()
  console.log(`[bench] generated ${generated}x${generated} DEFLATE GTiff at ${source}`)
}

/**
 * Run the same whole-band workload `rounds` times, printing every round: the
 * spread is the honest part of the answer. `run` decides whether the reads are
 * issued together or one after another.
 */
async function measure(label, run, reference) {
  const times = []
  let expected = reference

  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now()
    const buffers = await run()
    times.push(performance.now() - start)

    if (!expected) expected = buffers[0]
    else if (!buffers[0].equals(expected)) {
      console.error(`[bench] ${label} read disagreeing bytes — that is a bug, not a benchmark`)
      process.exitCode = 1
    }
  }

  const steady = times.slice(1)
  const best = Math.min(...(steady.length > 0 ? steady : times))
  console.log(
    `[bench] ${label.padEnd(34)} best ${best.toFixed(1).padStart(7)} ms ` +
      `| ${times.map((t) => t.toFixed(1)).join(', ')}`,
  )
  return { best, reference: expected }
}

/** `concurrency` full-band reads at once, or one at a time. */
const allAtOnce = (band) => Promise.all(Array.from({ length: concurrency }, () => band.readPixels()))
const oneAtATime = async (band) => {
  const buffers = []
  for (let index = 0; index < concurrency; index += 1) buffers.push(await band.readPixels())
  return buffers
}

const sameValues = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])

/** The same comparison for a workload that answers with numbers instead of bytes. */
async function measureValues(label, run) {
  const times = []
  let reference = null

  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now()
    const results = await run()
    times.push(performance.now() - start)

    if (!reference) reference = results[0]
    else if (results.some((result) => !sameValues(result, reference))) {
      console.error(`[bench] ${label} produced disagreeing numbers — that is a bug, not a benchmark`)
      process.exitCode = 1
    }
  }

  const steady = times.slice(1)
  const best = Math.min(...(steady.length > 0 ? steady : times))
  console.log(
    `[bench] ${label.padEnd(34)} best ${best.toFixed(1).padStart(7)} ms ` +
      `| ${times.map((t) => t.toFixed(1)).join(', ')}`,
  )
  return best
}

/**
 * A workload with no dataset in it at all: a coordinate transform. It touches
 * PROJ rather than a file, so whether N of them overlap is a question about the
 * process-wide lock and nothing else — the sharpest measurement of that lock.
 */
const POINTS = 400_000
const transform = new gdal.CoordinateTransform(
  gdal.SpatialRef.fromEpsg(4326),
  gdal.SpatialRef.fromEpsg(3857),
)
const coordinates = Float64Array.from({ length: POINTS * 2 }, (_, index) =>
  index % 2 === 0 ? 13.4 : 52.5,
)
const transformed = async () => {
  const results = []
  for (let index = 0; index < concurrency; index += 1) {
    results.push(await transform.transformPoints(coordinates))
  }
  return results
}
const transformedTogether = () =>
  Promise.all(Array.from({ length: concurrency }, () => transform.transformPoints(coordinates)))

const threadSafe = gdal.openThreadSafeSync(source)
console.log(
  `[bench] ${threadSafe.width}x${threadSafe.height} ${threadSafe.driver}, ` +
    `${concurrency} read(s) of the whole band, ${rounds} round(s)`,
)
console.log(
  `[bench] GDAL_CACHEMAX=${process.env.GDAL_CACHEMAX} MB, ` +
    `UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? '4 (default)'}`,
)
console.log('')

try {
  const serial = gdal.openSync(source)
  const serialBand = serial.band(0)
  const threadSafeBand = threadSafe.band(0)

  const single = await measure('open(), one at a time', () => oneAtATime(serialBand))
  const serialised = await measure(
    'open(), all at once',
    () => allAtOnce(serialBand),
    single.reference,
  )
  const parallel = await measure(
    'openThreadSafe(), all at once',
    () => allAtOnce(threadSafeBand),
    single.reference,
  )

  const perRead = single.best / concurrency
  console.log('')
  console.log(
    `[bench] ${concurrency} concurrent reads: ${serialised.best.toFixed(1)} ms serialised vs ` +
      `${parallel.best.toFixed(1)} ms thread-safe -> ${(serialised.best / parallel.best).toFixed(2)}x`,
  )
  console.log(
    `[bench] issuing them together bought nothing on the serialised path ` +
      `(${single.best.toFixed(1)} ms one at a time vs ${serialised.best.toFixed(1)} ms together) — ` +
      `that is the lock doing its job`,
  )
  console.log(
    `[bench] one read costs ${perRead.toFixed(1)} ms, so perfect overlap would be ` +
      `${perRead.toFixed(1)} ms (measured: ${parallel.best.toFixed(1)} ms)`,
  )
  if (parallel.best >= serialised.best) {
    console.log(
      '[bench] no gain here — these reads are cheap enough that the lock was never the bottleneck',
    )
  }

  console.log('')
  const sequenceTransforms = await measureValues('transforms, one at a time', transformed)
  const togetherTransforms = await measureValues('transforms, all at once', transformedTogether)
  console.log(
    `[bench] with no dataset involved: ${concurrency} transforms took ` +
      `${togetherTransforms.toFixed(1)} ms issued together vs ` +
      `${(sequenceTransforms / concurrency).toFixed(1)} ms apiece one at a time -> ` +
      `${(sequenceTransforms / togetherTransforms).toFixed(2)}x. A number near 1.00x means the ` +
      `lock serialised them; near ${concurrency}.00x means they overlapped.`,
  )

  console.log('')
  console.log('[bench] most drivers are not natively thread-safe, and GDAL reopens the')
  console.log('[bench] file per thread for those. GTiff/COG (libtiff) are the exception,')
  console.log('[bench] and the cheap case; watch your file-descriptor limit when raising')
  console.log('[bench] --concurrency on the others.')

  serial.close()
} finally {
  threadSafe.close()
  if (workdir) rmSync(workdir, { recursive: true, force: true })
}
