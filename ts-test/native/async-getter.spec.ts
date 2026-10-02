// @ts-nocheck
// The `xxxAsync` halves of the read-only getters.
//
// A getter takes the process-wide lock, and on an ordinary dataset that is the
// exclusive side — so a getter read while an async read is in flight waits for it with
// the event loop stopped. These do the same work on the thread pool: same answer, and
// the event loop keeps running while they wait.

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { bytesOf, gdal, tmp } from '../helpers.js'

/** A band with every property set to something the getters can report. */
function fixture() {
  const dataset = gdal.createSync(tmp('async-gets.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 2,
    bandCount: 1,
    dataType: 'Uint8',
  })
  const band = dataset.band(0)
  band.writeValues(0, 0, 4, 2, bytesOf(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])))
  band.setNoDataValue(0)
  band.setScale(2)
  band.setOffset(1)
  band.setUnitType('metre')
  band.setDescription('a description')
  dataset.setGeoTransform([0, 1, 0, 10, 0, -1])
  dataset.setProjection('EPSG:4326')
  return { dataset, band }
}

test('every async getter answers exactly what its own getter does', async () => {
  const { dataset, band } = fixture()

  // The pair is what matters, so it is the table: the synchronous property first, its
  // `xxxAsync` twin second.
  const band_ = {
    size: [band.size, await band.sizeAsync],
    blockSize: [band.blockSize, await band.blockSizeAsync],
    dataType: [band.dataType, await band.dataTypeAsync],
    colorInterpretation: [band.colorInterpretation, await band.colorInterpretationAsync],
    description: [band.description, await band.descriptionAsync],
    unitType: [band.unitType, await band.unitTypeAsync],
    noDataValue: [band.noDataValue, await band.noDataValueAsync],
    scale: [band.scale, await band.scaleAsync],
    offset: [band.offset, await band.offsetAsync],
    minimum: [band.minimum, await band.minimumAsync],
    maximum: [band.maximum, await band.maximumAsync],
    id: [band.id, await band.idAsync],
    readOnly: [band.readOnly, await band.readOnlyAsync],
    hasArbitraryOverviews: [band.hasArbitraryOverviews, await band.hasArbitraryOverviewsAsync],
    categoryNames: [band.categoryNames, await band.categoryNamesAsync],
    colorTable: [band.colorTable, await band.colorTableAsync],
  }
  const dataset_ = {
    rasterSize: [dataset.rasterSize, await dataset.rasterSizeAsync],
    geoTransform: [dataset.geoTransform, await dataset.geoTransformAsync],
  }

  for (const [name, [sync, async]] of Object.entries({ ...band_, ...dataset_ })) {
    assert.deepEqual(async, sync, `${name}Async answers what ${name} does`)
  }

  dataset.close()
})

test('the CRS comes back as an object, built on this side of the thread', async () => {
  const { dataset } = fixture()

  const srs = await dataset.spatialRefAsync
  assert.notEqual(srs, null)
  assert.equal(srs.authority, dataset.spatialRef.authority)
  assert.equal(srs.authority, 'EPSG:4326')

  dataset.close()
})

test('they are getters, like the ones they twin', () => {
  // `await band.sizeAsync` is the reference's shape: a property that hands back a
  // promise, not a method that returns one.
  for (const [className, names] of [
    ['RasterBand', ['sizeAsync', 'dataTypeAsync', 'noDataValueAsync']],
    ['Dataset', ['rasterSizeAsync', 'geoTransformAsync', 'spatialRefAsync']],
  ]) {
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(gdal[className].prototype, name)
      assert.equal(typeof descriptor?.get, 'function', `${className}.${name} is a getter`)
      assert.equal(descriptor.set, undefined, `${className}.${name} is read-only`)
    }
  }
})

test('a closed dataset rejects, with the same err.code the rest of the surface uses', async () => {
  const { dataset, band } = fixture()
  dataset.close()

  await assert.rejects(band.sizeAsync, (error) => {
    assert.equal(error.code, 'GDAL_BAD_ARGUMENT')
    assert.match(error.message, /the dataset is closed/)
    return true
  })
  await assert.rejects(dataset.rasterSizeAsync, /the dataset is closed/)
})

test('reading an async getter does not stop the event loop', async () => {
  const dataset = gdal.createSync(tmp('async-gets-big.tif'), {
    driver: 'GTiff',
    width: 1500,
    height: 1500,
    bandCount: 1,
    dataType: 'Float64',
  })
  const band = dataset.band(0)
  band.fill(1)
  const size = band.size

  // Building overviews holds the exclusive lock for a while — long enough that a
  // getter asking for it cannot answer yet, which is what makes the timer below mean
  // something.
  const building = dataset.buildOverviews('average', [2, 4])

  // Asking for the async getter has to come back *now*, with the waiting left to the
  // thread pool. A synchronous getter would wait here, and this timer with it.
  const pending = band.sizeAsync
  let ticked = false
  const timer = new Promise((resolve) => {
    setTimeout(() => {
      ticked = true
      resolve()
    }, 0)
  })
  await timer
  assert.equal(ticked, true, 'the event loop ran while the getter was waiting')

  assert.deepEqual(await pending, size)
  await building
  dataset.close()
})
