import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import { bytesOf, gdal, tmp } from './helpers.mjs'

/**
 * A raster with a geotransform, which the terrain tools want. 1024x1024 is enough
 * work for GDAL to report progress on.
 */
function ramp(path, size) {
  const pixels = Uint8Array.from({ length: size * size }, (_, index) => index % 256)
  const dataset = gdal.createSync(path, { driver: 'GTiff', width: size, height: size })
  dataset.band(0).writePixelsSync(bytesOf(pixels))
  dataset.setGeoTransform([500000, 30, 0, 4600000, 0, -30])
  dataset.setProjection(gdal.epsgToWkt(32633))
  dataset.close()
}

test('onProgress reports the work while it happens', async () => {
  const source = tmp('progress-source.tif')
  const dest = tmp('progress-hillshade.tif')
  ramp(source, 1024)

  const seen = []
  const dataset = await gdal.demProcess(
    dest,
    source,
    'hillshade',
    [],
    undefined,
    (progress) => {
      seen.push(progress.complete)
    },
  )
  dataset.close()

  assert.ok(seen.length > 0, 'the callback was called at least once')
  assert.equal(typeof seen[0], 'number')
  // A callback that returns nothing must not cancel: that is the common shape.
  const last = seen.at(-1)
  assert.ok(last > 0 && last <= 1, `complete should climb to 1, finished at ${last}`)

  assert.ok(existsSync(dest), 'the work still completed')
})

test('warp reports progress as well, through the path-based entry point', async () => {
  const source = tmp('progress-warp-source.tif')
  const dest = tmp('progress-warp-dest.tif')
  ramp(source, 1024)

  const seen = []
  const dataset = await gdal.warp(
    dest,
    [source],
    ['-t_srs', 'EPSG:3857', '-r', 'bilinear'],
    (progress) => {
      seen.push(progress.complete)
    },
  )
  dataset.close()

  // A warp goes through different plumbing from `demProcess`: the sources are paths
  // that GDAL opens itself, rather than a dataset we already hold.
  assert.ok(seen.length > 0, 'gdalwarp reported progress')
  const last = seen.at(-1)
  assert.ok(last > 0 && last <= 1, `complete should climb to 1, finished at ${last}`)
})

test('returning false cancels, and says so rather than reporting a failure', async () => {
  const source = tmp('cancel-source.tif')
  const dest = tmp('cancel-dest.tif')
  ramp(source, 1024)

  let calls = 0
  await assert.rejects(
    gdal.demProcess(dest, source, 'hillshade', [], undefined, () => {
      calls += 1
      return false
    }),
    (error) => {
      // Not a generic failure, and not `GDAL_BAD_ARGUMENT`: the caller needs to be
      // able to tell "I stopped it" from "it went wrong". On the async surface the
      // token arrives in the message rather than as `err.code`, because
      // `napi::Task` pins the error type — the same asymmetry the README describes
      // for every other async method.
      assert.equal(error.code, 'GenericFailure')
      assert.match(error.message, /\[GDAL_CANCELLED\]/)
      assert.match(error.message, /cancelled by the progress callback/)
      return true
    },
  )

  // With the answer actually waited for, the sink's short-circuit does its job:
  // GDAL reports again while it unwinds, but the callback is not asked a second time.
  assert.equal(calls, 1, 'the callback was not asked again after it said stop')
})
