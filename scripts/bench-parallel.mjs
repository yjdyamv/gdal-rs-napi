#!/usr/bin/env node
// Measures what `openThreadSafe()` actually buys you, on real data.
//
// `open()` serialises every GDAL call behind one process-wide lock: the async
// methods free the event loop, but concurrent reads still queue. `openThreadSafe()`
// opens a dataset whose reads take the shared side of that lock instead, so they
// genuinely overlap. This script runs the *same* concurrent workload through
// both and compares the wall times.
//
// Four workloads are measured, because the shared side covers more than pixels:
// whole-band reads, a batch of reads with the read-only accessors asked in the
// middle of them, a workload with no dataset in it at all, and the module-level
// surface — which is dataset-free in the same way, so it answers *during* that
// workload rather than behind it.
//
//   node scripts/bench-parallel.mjs [raster.tif] [--concurrency 4] [--rounds 5]
//                                   [--min-speedup 1.5]
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
// This is a benchmark, not a test: the numbers depend on the machine, the driver and
// the storage, and by default nothing here fails on them. The one exception is
// `--min-speedup`, which CI passes to catch a *structural* regression — dataset-free
// work being put back on the exclusive side of the lock, which takes the four
// concurrent transforms from about 3x down to about 1x. That is a ratio of two
// measurements on the same machine rather than a wall time, which is what makes it
// safe to fail on; the other numbers have no floor and are there to be read.

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
const optionNames = ['concurrency', 'rounds', 'size', 'min-speedup']
const provided = argv.find(
  (arg, index) => !arg.startsWith('--') && !optionNames.includes(argv[index - 1]?.replace(/^--/, '')),
)
const concurrency = option('concurrency', 4)
const rounds = option('rounds', 5)
const generated = option('size', 2048)
// The floor for the dataset-free overlap, in multiples of one transform. Zero — the
// default — means no gate, which is what keeps this a benchmark rather than a test.
const minSpeedup = option('min-speedup', 0)

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

/**
 * `NaN` is a legitimate answer here — a band with no no-data value reports one — and
 * `NaN !== NaN` would report a disagreement between two datasets that agree exactly.
 */
const sameValue = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b))

const sameValues = (a, b) => a.length === b.length && a.every((value, index) => sameValue(value, b[index]))

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
 * One round of the read-only accessors — the getters that only look at what the
 * dataset already knows, so on a thread-safe dataset they take the shared side of the
 * lock. The values are returned so they can be compared rather than discarded.
 *
 * The expensive ones are deliberately absent: `projection` re-exports the whole WKT,
 * and a benchmark of GDAL's lock has no business measuring the cost of that.
 */
const askAccessors = (dataset, band) => [
  dataset.width,
  dataset.height,
  dataset.bandCount,
  dataset.rasterSize.width,
  dataset.description.length,
  dataset.driver.name.length,
  dataset.getFileList().length,
  band.size[0],
  band.blockSize[0],
  band.id,
  band.colorInterpretation.length,
  band.noDataValue,
  band.overviewCount,
  band.readOnly,
  band.metadata().size,
]

/**
 * How many rounds of getters to ask while the reads are in flight.
 *
 * The number has to be about the same as the read time they are asked during, and
 * neither machine nor raster holds still for a hard-coded one: a shorter loop is
 * hidden behind the reads and a longer one outlasts them, and then both paths are
 * simply as slow as the getters. So it is calibrated against `batchMs`.
 */
const accessorRoundsFor = (dataset, band, batchMs) => {
  // Warmed, then the best of three: the first call pays for GDAL's own one-time
  // lookups, and a single sample of a sub-millisecond loop is mostly noise. Understating
  // the per-round cost is safe — the loop stays comparable to the reads, which is all
  // the calibration is for.
  askAccessors(dataset, band)
  const samples = []
  for (let index = 0; index < 3; index += 1) {
    const start = performance.now()
    askAccessors(dataset, band)
    samples.push(performance.now() - start)
  }
  const perRound = Math.min(...samples)
  return { rounds: Math.max(1, Math.round(batchMs / perRound)), perRound }
}

/**
 * The same batch of reads, with a round of getters asked while they are in flight. Both
 * paths get an identical workload, so the wall times are comparable.
 *
 * A getter is synchronous and there is one JS thread, so it cannot overlap another
 * getter; what the shared lock changes is that it can run *beside* the reads. The
 * getter loop is timed on its own as well, because that is the number the wall time
 * has to be read against: a serialised round cannot be shorter than the reads plus the
 * getters, a thread-safe one can be as short as the larger of the two.
 */
async function measureMixed(label, dataset, band, accessorRounds) {
  const times = []
  const getterTimes = []
  let reference = null
  let answers = null

  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now()
    // Dispatched first, then never awaited until the getters are done: they are what
    // runs *during* the reads, which is the only interesting ordering.
    const reads = Promise.all(Array.from({ length: concurrency }, () => band.readPixels()))
    const gettersStart = performance.now()
    let served = 0
    while (served < accessorRounds) {
      const values = askAccessors(dataset, band)
      // Checked every round rather than summed: two datasets answering the same is
      // the claim, and a sum would hide which accessor disagreed.
      if (!answers) answers = values
      else if (!sameValues(answers, values)) {
        console.error(`[bench] ${label} — the accessors disagree with themselves`)
        process.exitCode = 1
      }
      served += 1
    }
    getterTimes.push(performance.now() - gettersStart)
    const [pixels] = await reads
    times.push(performance.now() - start)

    if (!reference) reference = pixels
    else if (!pixels.equals(reference)) {
      console.error(`[bench] ${label} read disagreeing bytes — that is a bug, not a benchmark`)
      process.exitCode = 1
    }
  }

  const steady = times.slice(1)
  const best = Math.min(...(steady.length > 0 ? steady : times))
  const getters = Math.min(...(getterTimes.length > 1 ? getterTimes.slice(1) : getterTimes))
  console.log(
    `[bench] ${label.padEnd(34)} best ${best.toFixed(1).padStart(7)} ms ` +
      `| ${times.map((t) => t.toFixed(1)).join(', ')} | getters alone ${getters.toFixed(1)} ms`,
  )
  return { best, getters, answers }
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

/**
 * The module-level surface, asked once: the versions, the driver registry, the CRS
 * database, and a geometry round trip. None of it touches a dataset, so it takes the
 * same shared side of the lock the transforms above take, and the numbers are only
 * here to be compared with each other.
 */
const askModuleSurface = () => [
  gdal.version().gdal.length,
  gdal.info().driverCount,
  gdal.drivers().length,
  gdal.driver('GTiff').longName.length,
  gdal.epsgToWkt(4326).length,
  gdal.geometryTypeOf({ type: 'Point', coordinates: [1, 2] }).length,
  gdal.diagnostics().crsDatabaseFound ? 1 : 0,
  gdal.lastError() === null ? 0 : 1,
]

/** Time `rounds` of `ask`, best of `samples`; the first call is warm-up and is not timed. */
function timeRounds(ask, rounds, samples = 4) {
  ask()
  let best = Number.POSITIVE_INFINITY
  for (let index = 0; index < samples; index += 1) {
    const start = performance.now()
    for (let round = 0; round < rounds; round += 1) ask()
    best = Math.min(best, performance.now() - start)
  }
  return best
}

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
  const { rounds: accessorRounds, perRound } = accessorRoundsFor(
    serial,
    serialBand,
    perRead * concurrency,
  )
  console.log(
    `[bench] now the same ${concurrency} reads with ${accessorRounds} round(s) of read-only ` +
      `accessors asked while they are in flight (calibrated: one round is ` +
      `${perRound.toFixed(2)} ms, the batch of reads about ${(perRead * concurrency).toFixed(1)} ms)`,
  )
  const mixedSerial = await measureMixed('open(), reads + accessors', serial, serialBand, accessorRounds)
  const mixedThreadSafe = await measureMixed(
    'openThreadSafe(), reads + accessors',
    threadSafe,
    threadSafeBand,
    accessorRounds,
  )
  if (!sameValues(mixedSerial.answers, mixedThreadSafe.answers)) {
    console.error(
      '[bench] the accessors answered differently on the two datasets — that is a bug, not a benchmark',
    )
    process.exitCode = 1
  }
  console.log(
    `[bench] the same ${accessorRounds} rounds of getters on both paths, and the loop itself ` +
      `took ${mixedSerial.getters.toFixed(1)} ms serialised vs ` +
      `${mixedThreadSafe.getters.toFixed(1)} ms thread-safe: identical calls, and the ` +
      `difference is how long each one waited for the read holding the lock. The whole ` +
      `round came to ${mixedSerial.best.toFixed(1)} ms vs ${mixedThreadSafe.best.toFixed(1)} ms ` +
      `-> ${(mixedSerial.best / mixedThreadSafe.best).toFixed(2)}x — on the serialised path the ` +
      `reads and the getters are in one line, on the thread-safe one only the larger of ` +
      `the two is.`,
  )

  console.log('')
  const sequenceTransforms = await measureValues('transforms, one at a time', transformed)
  const togetherTransforms = await measureValues('transforms, all at once', transformedTogether)
  const overlap = sequenceTransforms / togetherTransforms
  console.log(
    `[bench] with no dataset involved: ${concurrency} transforms took ` +
      `${togetherTransforms.toFixed(1)} ms issued together vs ` +
      `${(sequenceTransforms / concurrency).toFixed(1)} ms apiece one at a time -> ` +
      `${overlap.toFixed(2)}x. A number near 1.00x means the ` +
      `lock serialised them; near ${concurrency}.00x means they overlapped.`,
  )

  // The one gate. Everything above is a ratio of two runs on this machine, which is
  // what lets a floor be safe here: a slower runner moves both numbers together. The
  // floor is well under the ~3x this measures on a developer machine, because the
  // thing it is watching for is structural — the dataset-free work going back onto the
  // exclusive side, which lands near 1x.
  if (minSpeedup > 0) {
    if (overlap < minSpeedup) {
      console.error(
        `[bench] ${overlap.toFixed(2)}x is below the ${minSpeedup.toFixed(2)}x floor for ` +
          `dataset-free work: ${concurrency} concurrent transforms did not overlap, so they ` +
          `were serialised. That is the shared side of the lock not being shared.`,
      )
      process.exitCode = 1
    } else {
      console.log(
        `[bench] the ${minSpeedup.toFixed(2)}x floor for dataset-free work is met at ` +
          `${overlap.toFixed(2)}x`,
      )
    }
  }

  console.log('')
  // The same question as the accessors above, asked of the module surface instead of a
  // dataset. It is dataset-free, so it takes the shared side with the transforms and
  // does not queue behind them — and unlike the accessors there is no serialised
  // counterpart to race against: the comparison is the loop against *itself*, the same
  // rounds on an idle process and then while a batch of transforms is in flight. The
  // round count is calibrated against the transform batch for the reason the accessor
  // loop is: a shorter one is hidden behind the transforms, a longer one outlasts them.
  const perModuleRound = Math.max(timeRounds(askModuleSurface, 1, 3), 0.001)
  const moduleRounds = Math.max(1, Math.round(togetherTransforms / perModuleRound))
  const moduleIdle = timeRounds(askModuleSurface, moduleRounds)

  const moduleTimes = []
  for (let round = 0; round < rounds; round += 1) {
    // Dispatched first and only awaited afterwards, so the transforms are what the
    // surface is asked *during*.
    const inFlight = transformedTogether()
    const start = performance.now()
    for (let index = 0; index < moduleRounds; index += 1) askModuleSurface()
    moduleTimes.push(performance.now() - start)
    await inFlight
  }
  const moduleDuring = Math.min(...(moduleTimes.length > 1 ? moduleTimes.slice(1) : moduleTimes))

  console.log(
    `[bench] ${moduleRounds} rounds of the module surface (versions, drivers, CRS, geometry) ` +
      `took ${moduleIdle.toFixed(1)} ms idle and ${moduleDuring.toFixed(1)} ms while ` +
      `${concurrency} transforms were in flight -> ${(moduleDuring / moduleIdle).toFixed(2)}x. ` +
      `Near 1.00x means they overlapped those transforms; had they queued behind them it ` +
      `would be about ${((moduleIdle + togetherTransforms) / moduleIdle).toFixed(2)}x.`,
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
