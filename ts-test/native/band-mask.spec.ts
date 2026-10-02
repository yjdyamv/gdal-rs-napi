// @ts-nocheck
// Mask bands: `band.mask` is the validity mask as another band, `band.maskFlags`
// says where the mask comes from, and `band.createMask()` builds one.
//
// A mask is what separates a valid sample from the rest, and GDAL answers with one
// whether or not the file carries one — an implicit all-valid band reads 255
// everywhere — so what these tests pin is mostly the difference between the two, and
// the fact that a mask is a band with the whole read surface on it.

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { bytesOf, gdal, ramp, tmp } from '../helpers.js'

test('a band with no mask still has one, and says it is all valid', () => {
  const dataset = gdal.createSync(tmp('no-mask.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 3,
    bandCount: 1,
  })
  const band = dataset.band(0)

  assert.deepEqual(band.maskFlags, {
    allValid: true,
    perDataset: false,
    alpha: false,
    noData: false,
  })

  // The implicit mask is a real band reading 255 everywhere, not a null.
  const mask = band.mask
  assert.equal(mask.dataType, 'Uint8')
  assert.deepEqual(mask.size, [4, 3])
  assert.deepEqual(Array.from(mask.readPixelsSync()), Array.from({ length: 12 }, () => 255))
  // It reports the band it is the mask *of*, and has no band number of its own.
  assert.equal(mask.index, band.index)
  assert.equal(mask.id, 0)

  dataset.close()
})

test('the implicit mask is not a place to write', () => {
  const dataset = gdal.createSync(tmp('implicit-mask.tif'), {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 1,
  })
  const band = dataset.band(0)

  // GDAL refuses rather than quietly allocating a mask: an all-valid mask that could
  // be written to would be a mask nobody asked for. `createMask()` is the way.
  assert.throws(
    () => band.mask.writePixelsSync(Buffer.from([0, 0, 0, 0])),
    (error) => {
      assert.equal(error.code, 'GDAL_CPL_FAILURE')
      assert.match(error.message, /implicit mask/)
      return true
    },
  )
  assert.throws(() => band.mask.fill(0), /implicit mask/)

  dataset.close()
})

test('createMask gives a band a mask, written through band.mask', () => {
  const path = tmp('created-mask.tif')
  const dataset = gdal.createSync(path, { driver: 'GTiff', width: 4, height: 3, bandCount: 1 })
  const band = dataset.band(0)
  band.writePixelsSync(bytesOf(ramp(4, 3)))

  band.createMask()
  // Creating one changes what the flags say: there is a real mask now.
  assert.deepEqual(band.maskFlags, {
    allValid: false,
    perDataset: false,
    alpha: false,
    noData: false,
  })

  const mask = Uint8Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? 0 : 255))
  band.mask.writePixelsSync(bytesOf(mask))
  assert.deepEqual(Array.from(band.mask.readPixelsSync()), Array.from(mask))
  // The mask is its own band, so the samples are untouched by writing it.
  assert.deepEqual(Array.from(band.readPixelsSync()), Array.from(ramp(4, 3)))

  dataset.close()

  // And it is in the file rather than only in memory.
  const reopened = gdal.openSync(path)
  assert.deepEqual(Array.from(reopened.band(0).mask.readPixelsSync()), Array.from(mask))
  assert.equal(reopened.band(0).maskFlags.allValid, false)
  assert.deepEqual(Array.from(reopened.band(0).readPixelsSync()), Array.from(ramp(4, 3)))
  reopened.close()
})

test('a per-dataset mask is one mask every band reports', () => {
  const dataset = gdal.createSync(tmp('per-dataset-mask.tif'), {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 2,
  })
  dataset.band(0).createMask(true)

  // Which flavour GDAL built is what the flags report — that is the thing to read,
  // not what was asked for — and a per-dataset mask is answered by every band.
  assert.deepEqual(dataset.band(0).maskFlags, {
    allValid: false,
    perDataset: true,
    alpha: false,
    noData: false,
  })
  assert.equal(dataset.band(1).maskFlags.perDataset, true)

  // Asking twice is the driver's answer rather than a rule here: GTiff says it
  // already has one, so `maskFlags` is how to ask whether there is a mask instead of
  // calling this and hoping.
  assert.throws(() => dataset.band(0).createMask(true), /already an internal mask band/)

  dataset.close()
})

test('a mask derived from the no-data value marks where the data is missing', () => {
  const path = tmp('nodata-mask.tif')
  const dataset = gdal.createSync(path, { driver: 'GTiff', width: 2, height: 2, bandCount: 1 })
  const band = dataset.band(0)
  band.writePixelsSync(Buffer.from([1, 0, 0, 2]))
  band.setNoDataValue(0)
  dataset.close()

  // Reopened, the mask is GDAL *deriving* one from the no-data value rather than
  // reading a stored mask, which is what the flags say and what the pixels show.
  // (In the session that set the value, GDAL still reports the flags of a band with
  // no mask; it is the file that answers `noData`.)
  const reopened = gdal.openSync(path)
  assert.deepEqual(reopened.band(0).maskFlags, {
    allValid: false,
    perDataset: false,
    alpha: false,
    noData: true,
  })
  assert.deepEqual(Array.from(reopened.band(0).mask.readPixelsSync()), [255, 0, 0, 255])
  reopened.close()
})

test('a mask is a band, so the whole read surface works on it', async () => {
  const dataset = gdal.createSync('', { driver: 'MEM', width: 4, height: 4, bandCount: 1 })
  const band = dataset.band(0)
  band.createMask(true)

  const values = Uint8Array.from({ length: 16 }, (_, index) => (index % 2 === 0 ? 0 : 255))
  band.mask.writePixelsSync(bytesOf(values))

  assert.deepEqual(Array.from(await band.mask.readPixels()), Array.from(values))
  assert.deepEqual(await band.mask.statistics(), { min: 0, max: 255, mean: 127.5, stdDev: 127.5 })
  assert.equal(typeof band.mask.checksumSync(), 'number')
  assert.deepEqual(band.mask.overviews, [])
  assert.deepEqual(band.mask.blockSize, band.blockSize)

  dataset.close()
})

test('a thread-safe dataset reads a mask but cannot create one', () => {
  const path = tmp('threadsafe-mask.tif')
  gdal.createSync(path, { driver: 'GTiff', width: 2, height: 2, bandCount: 1 }).close()

  const dataset = gdal.openThreadSafeSync(path)
  // Reading the mask is a read, so it takes the shared side of the lock with the
  // others — and an implicit one is all valid.
  assert.deepEqual(Array.from(dataset.band(0).mask.readPixelsSync()), [255, 255, 255, 255])

  // Creating one is a write, and a thread-safe dataset is read-only.
  assert.throws(
    () => dataset.band(0).createMask(),
    (error) => {
      assert.equal(error.code, 'GDAL_BAD_ARGUMENT')
      assert.match(error.message, /read-only/)
      return true
    },
  )

  dataset.close()
})
