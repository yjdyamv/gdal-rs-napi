// The band metadata writers: `setScale`, `setOffset`, `setUnitType`,
// `setDescription`, `setCategoryNames`, `setDefaultHistogram` — the counterparts
// of the getters that have been read-only until now.
//
// They are exercised against a GTiff because that is the format this binding both
// writes and reads back, and because its band metadata goes through GDAL's PAM
// layer, which is the same road a `.aux.xml` sidecar takes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bytesOf, gdal, tmp } from './helpers.mjs'

/** A writable one-band GTiff to hang band metadata on. */
function writableBand(name, options = {}) {
  const dataset = gdal.createSync(tmp(name), {
    driver: 'GTiff',
    width: options.width ?? 2,
    height: options.height ?? 2,
    bandCount: 1,
    dataType: options.dataType ?? 'Float32',
  })
  return { dataset, band: dataset.band(0) }
}

test('band metadata setters write values the getters read back', () => {
  const path = tmp('band-metadata-write.tif')
  const { dataset, band } = writableBand('band-metadata-write.tif')

  // Nothing is set on a freshly created band.
  assert.equal(band.scale, null)
  assert.equal(band.offset, null)
  assert.equal(band.unitType, null)
  assert.equal(band.description, null)
  assert.deepEqual(band.categoryNames, [])

  band.setScale(2.5)
  band.setOffset(10)
  band.setUnitType('metre')
  band.setDescription('my band')
  band.setCategoryNames(['water', 'land'])

  assert.equal(band.scale, 2.5)
  assert.equal(band.offset, 10)
  assert.equal(band.unitType, 'metre')
  assert.equal(band.description, 'my band')
  assert.deepEqual(band.categoryNames, ['water', 'land'])

  dataset.flushSync()
  dataset.close()

  // Reopened read-only, the values come off the file rather than out of memory.
  const reopened = gdal.openSync(path)
  const persisted = reopened.band(0)
  assert.equal(persisted.scale, 2.5)
  assert.equal(persisted.offset, 10)
  assert.equal(persisted.unitType, 'metre')
  assert.equal(persisted.description, 'my band')
  assert.deepEqual(persisted.categoryNames, ['water', 'land'])
  reopened.close()
})

test('unit, description and categories clear; scale and offset have no unset', () => {
  const { dataset, band } = writableBand('band-metadata-clear.tif')

  band.setUnitType('metre')
  band.setDescription('label')
  band.setCategoryNames(['a', 'b'])
  band.setUnitType(null)
  band.setDescription(null)
  band.setCategoryNames([])

  assert.equal(band.unitType, null)
  assert.equal(band.description, null)
  assert.deepEqual(band.categoryNames, [])

  // GDAL's scale and offset setters take a number and nothing else: there is no
  // null pointer to pass, so 0 is a value like any other rather than a way back
  // to `null`. The getter has to say 0.
  band.setScale(0)
  band.setOffset(0)
  assert.equal(band.scale, 0)
  assert.equal(band.offset, 0)

  dataset.close()
})

test('a NUL byte in a band string is refused rather than truncated', () => {
  const { dataset, band } = writableBand('band-metadata-nul.tif')

  assert.throws(() => band.setUnitType('met\0re'), /NUL byte/)
  assert.throws(() => band.setDescription('a\0b'), /NUL byte/)
  assert.throws(() => band.setCategoryNames(['ok', 'not\0ok']), /NUL byte/)

  // The failed calls left nothing behind.
  assert.equal(band.unitType, null)
  assert.equal(band.description, null)
  assert.deepEqual(band.categoryNames, [])

  dataset.close()
})

test('defaultHistogram stores what histogramSync computed', () => {
  const path = tmp('band-histogram-write.tif')
  const { dataset, band } = writableBand('band-histogram-write.tif')
  band.writePixelsSync(bytesOf(new Float32Array([0, 1, 2, 3])))

  // A computed histogram is not a *stored* one, so nothing is there yet.
  assert.equal(band.defaultHistogram(), null)

  const computed = band.histogramSync({ min: 0, max: 4, buckets: 4 })
  assert.deepEqual(computed, { min: 0, max: 4, counts: [1, 1, 1, 1] })

  band.setDefaultHistogram(computed)
  assert.deepEqual(band.defaultHistogram(), computed)

  dataset.flushSync()
  dataset.close()

  const reopened = gdal.openSync(path)
  assert.deepEqual(reopened.band(0).defaultHistogram(), computed)
  reopened.close()
})

test('defaultHistogram(force) computes one when nothing is stored', () => {
  const { dataset, band } = writableBand('band-histogram-force.tif')
  band.writePixelsSync(bytesOf(new Float32Array([0, 1, 2, 3])))

  // Off by default, because forcing it reads the whole band.
  assert.equal(band.defaultHistogram(), null)

  // Forced, GDAL computes one itself — and picks the range, which is padded
  // rather than exactly the data's min/max, so only the shape is asserted.
  const forced = band.defaultHistogram(true)
  assert.ok(forced.counts.length > 0)
  assert.ok(forced.min < forced.max)
  assert.ok(forced.min <= 0 && forced.max >= 3, `range ${forced.min}..${forced.max} covers 0..3`)

  dataset.close()
})

test('setDefaultHistogram rejects what GDAL could not act on', () => {
  const { dataset, band } = writableBand('band-histogram-bad.tif')

  assert.throws(
    () => band.setDefaultHistogram({ min: 0, max: 1, counts: [] }),
    /at least one bucket/,
  )
  assert.throws(
    () => band.setDefaultHistogram({ min: 1, max: 1, counts: [1] }),
    /finite and increasing/,
  )
  assert.throws(
    () => band.setDefaultHistogram({ min: 0, max: Number.NaN, counts: [1] }),
    /finite and increasing/,
  )
  assert.throws(
    () => band.setDefaultHistogram({ min: 0, max: Number.POSITIVE_INFINITY, counts: [1] }),
    /finite and increasing/,
  )

  dataset.close()
})
