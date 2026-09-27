import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import { bytesOf, gdal, tmp } from './helpers.mjs'

/** A GTiff holding 0, 1, 2, … so every statistic has an exact answer. */
function ramp(path, width, height) {
  const pixels = Uint8Array.from({ length: width * height }, (_, index) => index % 256)
  const dataset = gdal.createSync(path, { driver: 'GTiff', width, height, bandCount: 1 })
  dataset.band(0).writePixelsSync(bytesOf(pixels))
  dataset.close()
  return pixels
}

/**
 * Standard deviation of 0..count-1 over the whole set, which is the definition
 * GDAL reports (`sum(x²)/n`, not the sample estimator).
 */
function populationStdDev(count) {
  const mean = (count - 1) / 2
  let squares = 0
  for (let value = 0; value < count; value += 1) squares += (value - mean) ** 2
  return Math.sqrt(squares / count)
}

/**
 * GDAL accumulates in its own order, so the last bits of a standard deviation can
 * differ from a recomputation. The other three are exact.
 */
function assertSameStatistics(actual, expected) {
  assert.equal(actual.min, expected.min)
  assert.equal(actual.max, expected.max)
  assert.equal(actual.mean, expected.mean)
  assert.ok(
    Math.abs(actual.stdDev - expected.stdDev) < 1e-6,
    `stdDev ${actual.stdDev} vs ${expected.stdDev}`,
  )
}

test('statistics() computes exact values over a known ramp', async () => {
  const path = tmp('stats.tif')
  ramp(path, 16, 16) // 256 samples, values 0..255 each once

  const dataset = gdal.openSync(path)
  const band = dataset.band(0)

  const statistics = band.statisticsSync()
  assert.equal(statistics.min, 0)
  assert.equal(statistics.max, 255)
  assert.equal(statistics.mean, 127.5)
  assert.ok(
    Math.abs(statistics.stdDev - populationStdDev(256)) < 1e-9,
    `stdDev ${statistics.stdDev} should be the population deviation`,
  )

  // The async form has to agree with it.
  assertSameStatistics(await band.statistics(), statistics)

  dataset.close()
})

test('statistics({ force: false }) reports the cache instead of computing', async () => {
  const path = tmp('stats-cache.tif')
  ramp(path, 16, 16)

  // A fresh open has nothing cached. `force: false` must say so rather than
  // quietly computing — which is the whole difference between force and not.
  const dataset = gdal.openSync(path)
  const band = dataset.band(0)
  assert.equal(band.statisticsSync({ force: false }), null)

  // Computing caches, so the second look finds them.
  const computed = band.statisticsSync()
  assertSameStatistics(band.statisticsSync({ force: false }), computed)

  // And a different handle on the same file starts over.
  const reopened = gdal.openSync(path)
  assert.equal(reopened.band(0).statisticsSync({ force: false }), null)

  reopened.close()
  dataset.close()
})

test('statistics({ approx: true }) stays within the real range', () => {
  const path = tmp('stats-approx.tif')
  ramp(path, 16, 16)

  const dataset = gdal.openSync(path)
  const approximate = dataset.band(0).statisticsSync({ approx: true })

  assert.ok(approximate.min >= 0, `min ${approximate.min}`)
  assert.ok(approximate.max <= 255, `max ${approximate.max}`)
  assert.ok(approximate.min <= approximate.mean && approximate.mean <= approximate.max)

  dataset.close()
})

test('histogram() counts buckets exactly', async () => {
  const path = tmp('histogram.tif')
  ramp(path, 16, 16) // 256 samples, 0..255

  const dataset = gdal.openSync(path)
  const band = dataset.band(0)

  // 0..255 in four buckets of 64 values each.
  const histogram = band.histogramSync({ min: 0, max: 256, buckets: 4 })
  assert.equal(histogram.min, 0)
  assert.equal(histogram.max, 256)
  assert.deepEqual(histogram.counts, [64, 64, 64, 64])

  const async = await band.histogram({ min: 0, max: 256, buckets: 4 })
  assert.deepEqual(async.counts, histogram.counts)

  dataset.close()
})

test('a rejected histogram request fails at the call, not on the pool', () => {
  const path = tmp('histogram-bad.tif')
  ramp(path, 16, 16)
  const dataset = gdal.openSync(path)

  assert.throws(() => dataset.band(0).histogramSync({ min: 0, max: 0, buckets: 4 }), /increasing/)
  assert.throws(() => dataset.band(0).histogramSync({ min: 0, max: 1, buckets: 0 }), /bucket/)

  dataset.close()
})

test('buildOverviews() builds the levels gdaladdo would', async () => {
  const path = tmp('overviews.tif')
  ramp(path, 1024, 1024)

  const dataset = gdal.openSync(path, { update: true })
  const band = dataset.band(0)
  assert.equal(band.overviewCount, 0)

  // Halving 1024 until the smallest overview is below 256 gives 2, 4 and 8.
  dataset.buildOverviewsSync()
  assert.equal(band.overviewCount, 3)

  // Explicit levels are taken as written, on a raster that has none yet.
  const explicitPath = tmp('overviews-explicit.tif')
  ramp(explicitPath, 1024, 1024)
  const explicit = gdal.openSync(explicitPath, { update: true })
  explicit.buildOverviewsSync({ levels: [2, 4] })
  assert.equal(explicit.band(0).overviewCount, 2)
  explicit.buildOverviewsSync({ levels: [2, 4, 8] })
  assert.equal(explicit.band(0).overviewCount, 3)
  explicit.close()

  // Building is additive, exactly as it is in gdaladdo: levels that are already
  // there get recomputed in place and the others are left alone, so asking for a
  // subset rebuilds rather than prunes.
  await dataset.buildOverviews({ levels: [2, 4] })
  assert.equal(band.overviewCount, 3, 'a subset rebuilds in place; it does not prune')

  dataset.close()
})

test('removeOverviews() prunes the whole pyramid', async () => {
  const path = tmp('overviews-remove.tif')
  ramp(path, 1024, 1024)

  const dataset = gdal.openSync(path, { update: true })
  dataset.buildOverviewsSync()
  assert.equal(dataset.band(0).overviewCount, 3)

  await dataset.removeOverviews()
  assert.equal(dataset.band(0).overviewCount, 0)

  // And again synchronously, to show the pair is symmetric in both directions.
  dataset.buildOverviewsSync({ levels: [2] })
  assert.equal(dataset.band(0).overviewCount, 1)
  dataset.removeOverviewsSync()
  assert.equal(dataset.band(0).overviewCount, 0)

  dataset.close()
})

test('a raster too small for overviews is not an error', () => {
  const path = tmp('overviews-small.tif')
  ramp(path, 16, 16)

  const dataset = gdal.openSync(path, { update: true })
  dataset.buildOverviewsSync()
  assert.equal(dataset.band(0).overviewCount, 0)

  dataset.close()
})

test('a partial band list reaches GDAL, which refuses it on GTiff', () => {
  const path = tmp('overviews-bands.tif')
  const created = gdal.createSync(path, {
    driver: 'GTiff',
    width: 1024,
    height: 1024,
    bandCount: 2,
  })
  created.close()

  const dataset = gdal.openSync(path, { update: true })

  // The translation from this API's 0-based indices to GDAL's 1-based band
  // numbers is unit-tested in Rust, because it cannot be observed through GTiff:
  // GTiff builds overviews for all bands or none. What matters here is that the
  // list is passed through instead of being silently ignored.
  assert.throws(() => dataset.buildOverviewsSync({ bands: [0] }), /all bands/)

  dataset.close()
})

test('overviews go in the file when writable and into a .ovr when not', () => {
  const writable = tmp('overviews-internal.tif')
  ramp(writable, 1024, 1024)

  const internal = gdal.openSync(writable, { update: true })
  internal.buildOverviewsSync()
  internal.close()
  assert.equal(existsSync(`${writable}.ovr`), false, 'a writable GTiff keeps them inside')

  const readOnly = tmp('overviews-external.tif')
  ramp(readOnly, 1024, 1024)

  const external = gdal.openSync(readOnly)
  external.buildOverviewsSync()
  external.close()
  assert.equal(existsSync(`${readOnly}.ovr`), true, 'a read-only GTiff writes a sidecar')
})

test('a bad overview resampling name is reported before GDAL sees it', () => {
  const path = tmp('overviews-bad.tif')
  ramp(path, 1024, 1024)

  const dataset = gdal.openSync(path, { update: true })
  assert.throws(
    () => dataset.buildOverviewsSync({ resampling: 'cubicc' }),
    (error) => {
      assert.equal(error.code, 'GDAL_BAD_ARGUMENT')
      assert.match(error.message, /unknown overview resampling/)
      assert.match(error.message, /cubicspline/, 'the alternatives are listed')
      return true
    },
  )
  assert.throws(() => dataset.buildOverviewsSync({ levels: [0, 2] }), /at least 2/)

  dataset.close()
})

test('a thread-safe dataset computes statistics but cannot build overviews', async () => {
  const path = tmp('overviews-threadsafe.tif')
  ramp(path, 1024, 1024)

  const dataset = gdal.openThreadSafeSync(path)

  // Statistics are a read, so they are allowed — they just take the exclusive
  // side of the lock while they run.
  const statistics = await dataset.band(0).statistics()
  assert.equal(statistics.min, 0)
  assert.equal(statistics.max, 255)

  // Overviews write, and a thread-safe dataset is read-only.
  assert.throws(
    () => dataset.buildOverviewsSync({ levels: [2] }),
    (error) => {
      assert.equal(error.code, 'GDAL_BAD_ARGUMENT')
      assert.match(error.message, /read-only/)
      return true
    },
  )

  dataset.close()
})
