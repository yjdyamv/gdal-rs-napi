import assert from 'node:assert/strict'
import { test } from 'vitest'

import compat from '../compat/index.js'
import { native, tmp } from './helpers.js'

/** A one-row Float32 raster, written natively and opened through the compat layer. */
function band(name: string, values: number[]) {
  const path = tmp(name)
  const dataset = native.createSync(path, {
    driver: 'GTiff',
    width: values.length,
    height: 1,
    bandCount: 1,
    dataType: 'Float32',
  })
  dataset.band(0).writePixelsSync(Buffer.from(Float32Array.from(values).buffer))
  dataset.close()
  return compat.open(path).bands.get(1)!
}

/** The band's first-row samples, as plain numbers, in the band's own type. */
function samples(band: {
  size: { x: number }
  pixels: { read(x: number, y: number, w: number, h: number): ArrayLike<number> }
}) {
  return Array.from(band.pixels.read(0, 0, band.size.x, 1))
}

test('gdal.algebra computes eagerly, as compat bands', () => {
  const a = band('algebra-a.tif', [1, 2, 3, 4])
  const b = band('algebra-b.tif', [10, 20, 30, 40])

  assert.deepEqual(samples(compat.algebra.add(a, b)), [11, 22, 33, 44])
  assert.deepEqual(samples(compat.algebra.sub(a, b)), [-9, -18, -27, -36])
  assert.deepEqual(samples(compat.algebra.mul(a, b)), [10, 40, 90, 160])
  assert.deepEqual(samples(compat.algebra.min(a, b)), [1, 2, 3, 4])
  assert.deepEqual(samples(compat.algebra.max(a, b)), [10, 20, 30, 40])
  assert.deepEqual(samples(compat.algebra.mean(a, b)), [5.5, 11, 16.5, 22])
  assert.deepEqual(samples(compat.algebra.abs(compat.algebra.sub(a, b))), [9, 18, 27, 36])
})

test('gdal.algebra takes a number operand the way the reference does', () => {
  const a = band('algebra-num.tif', [1, 2, 3, 4])

  assert.deepEqual(samples(compat.algebra.add(a, 10)), [11, 12, 13, 14])
  assert.deepEqual(samples(compat.algebra.add(10, a)), [11, 12, 13, 14])
  assert.deepEqual(samples(compat.algebra.sub(10, a)), [9, 8, 7, 6])
  assert.deepEqual(samples(compat.algebra.lt(10, a)), [0, 0, 0, 0])
  assert.deepEqual(samples(compat.algebra.gt(10, a)), [1, 1, 1, 1])
})

test('gdal.algebra has the async twins', async () => {
  const a = band('algebra-async.tif', [1, 2, 3, 4])

  assert.deepEqual(samples(await compat.algebra.addAsync(a, 2)), [3, 4, 5, 6])
  assert.deepEqual(samples(await compat.algebra.meanAsync(a, a)), [1, 2, 3, 4])
})

test('half-float is a known sample type', () => {
  assert.equal(native.bytesPerSample('Float16'), 2)
  assert.equal(native.bytesPerSample('CFloat16'), 4)
  assert.equal(native.fromDataType(15), 'Float16')
  assert.equal(native.fromDataType(16), 'CFloat16')
  assert.equal(native.const.DataType.Float16, 'Float16')
  assert.equal(native.const.DataType.CFloat16, 'CFloat16')
  // The reference exports the constructor it reads Float16 with; Node has one from v24.
  if (typeof globalThis.Float16Array === 'function') {
    assert.equal(typeof compat.Float16Array, 'function')
  }
})

test('the compat constants the reference spells now answer', () => {
  for (const name of [
    'DMD_MIMETYPE',
    'DMD_EXTENSION',
    'DMD_LONGNAME',
    'DMD_HELPTOPIC',
    'DMD_CREATIONOPTIONLIST',
    'DMD_CREATIONDATATYPES',
    'GA_Readonly',
    'GA_Update',
    'GF_Read',
    'GF_Write',
    'GDT_CFloat16',
    'GRA_NearestNeighbor',
    'wkbNDR',
    'wkbXDR',
    'wkbVariantIso',
    'wkbVariantOgc',
    'wkbVariantOldOgc',
  ]) {
    assert.ok(name in compat, `${name} is missing from the compat layer`)
  }
})
