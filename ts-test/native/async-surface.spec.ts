// @ts-nocheck
// The async surface: what the shell adds on top of the generated binding.
//
// An async failure carries `err.code`, because napi pins a `Task`'s error type
// and the stable token has to travel in the message otherwise. And a cursor is
// async-iterable, so a paged layer can be read with `for await`.
//
// The declaration-side check — that every async member is exactly one the shell
// wraps, per class — lives in `types.test.mjs`, where it is held against the
// runtime rather than against a hand-copied list.

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { gdal, tmp } from '../helpers.js'

test('an async failure carries err.code, and keeps the prefix in its message', async () => {
  await assert.rejects(
    gdal.open(tmp('does-not-exist.tif')),
    (error) => {
      // The same token the sync surface reports, now as a field.
      assert.equal(error.code, 'GDAL_BAD_ARGUMENT')
      // ... and still at the front of the message, so a caller matching text is
      // unaffected by the field appearing.
      assert.match(error.message, /^\[GDAL_BAD_ARGUMENT\]/)
      assert.match(error.message, /does-not-exist\.tif/)
      return true
    },
  )
})

test('the token in the field is the one in the message, for a different failure', async () => {
  // A second one, to show the code is lifted rather than hard-coded somewhere.
  await assert.rejects(
    gdal.buildVrt(tmp('built.vrt'), []),
    (error) => {
      assert.equal(error.code, 'GDAL_BAD_ARGUMENT')
      assert.match(error.message, /^\[GDAL_BAD_ARGUMENT\]/)
      assert.match(error.message, /at least one source/)
      return true
    },
  )
})

test('a cursor is async-iterable, and yields one feature at a time', async () => {
  const path = tmp('async-cursor.gpkg')
  const dataset = gdal.createVectorSync(path, 'GPKG')
  const layer = dataset.createLayer({ name: 'places', geometryType: 'Point', epsg: 4326 })
  for (let index = 0; index < 5; index += 1) {
    layer.createFeature({ type: 'Point', coordinates: [index, index] }, { n: index })
  }
  dataset.close()

  const reopened = gdal.openSync(path)
  const cursor = reopened.layer(0).openCursor({ batchSize: 2 })

  const seen = []
  for await (const feature of cursor) {
    // A record, not a batch — the batches are an implementation detail here.
    assert.equal(typeof feature.fid, 'number')
    seen.push(feature.properties.n)
  }
  assert.deepEqual(seen, [0, 1, 2, 3, 4], 'every feature, in order')

  // Breaking out stops without draining the layer, the way `read()` lets a caller
  // stop after a batch.
  const second = reopened.layer(0).openCursor({ batchSize: 2 })
  const firstTwo = []
  for await (const feature of second) {
    firstTwo.push(feature.properties.n)
    if (firstTwo.length === 2) break
  }
  assert.deepEqual(firstTwo, [0, 1])

  reopened.close()
})

test('an empty layer iterates zero times rather than once with nothing', async () => {
  const path = tmp('async-cursor-empty.gpkg')
  const dataset = gdal.createVectorSync(path, 'GPKG')
  dataset.createLayer({ name: 'places', geometryType: 'Point', epsg: 4326 })
  dataset.close()

  const reopened = gdal.openSync(path)
  const seen = []
  for await (const feature of reopened.layer(0).openCursor()) {
    seen.push(feature)
  }
  assert.deepEqual(seen, [])
  reopened.close()
})
