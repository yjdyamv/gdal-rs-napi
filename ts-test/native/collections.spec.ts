// @ts-nocheck
// The reference's collection shape, on this binding's own members.
//
// gdal-async spells a container as an object with `get` / `count` / `getNames` and
// iterators; this binding spells it as a call that returns an array. Both are the same
// object here — the call is untouched and the collection surface hangs off it — so
// this file checks both, and that neither tramples the other.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { gdal, ramp, tmp } from '../helpers.js'

const scratch = mkdtempSync(join(tmpdir(), 'gdal-rs-napi-collections-'))
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // Held by the driver, as with the other NetCDF fixtures.
  }
})

test('a dataset answers both spellings of bands and layers', async () => {
  const dataset = await gdal.create(tmp('collections.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 2,
    bandCount: 2,
    dataType: 'Uint8',
  })

  // The call is what it always was.
  assert.ok(Array.isArray(dataset.bands()))
  assert.equal(dataset.bands().length, 2)

  // And the same object is the collection: 1-based, as the reference counts. A band
  // handle is built per call, so the two spellings are compared by what they name.
  assert.equal(dataset.bands.count(), 2)
  assert.equal(dataset.bands.get(1).id, dataset.band(0).id)
  assert.equal(dataset.bands.get(2).id, dataset.band(1).id)
  assert.equal(dataset.bands.get(3), null)
  assert.equal(dataset.bands, dataset.bands, 'one collection per dataset, as the reference has')

  assert.deepEqual(
    [...dataset.bands].map((band) => band.id),
    dataset.bands().map((band) => band.id),
  )
  const async = []
  for await (const band of dataset.bands) async.push(band.id)
  assert.deepEqual(async, [1, 2])
  const seen = []
  dataset.bands.forEach((band, index) => seen.push([index, band.id]))
  assert.deepEqual(seen, [
    [1, 1],
    [2, 2],
  ])
  assert.deepEqual(
    dataset.bands.map((band) => band.id),
    [1, 2],
  )
  // The index counts from 1, as `get` does, and answering `false` stops the walk —
  // which is what the reference's callbacks do.
  const stopped = []
  dataset.bands.forEach((band, index) => {
    stopped.push([index, band.id])
    if (index === 1) return false
    return undefined
  })
  assert.deepEqual(stopped, [[1, 1]])

  // Layers are the same, and their `get` takes a name too.
  const vector = await gdal.createVector(tmp('collections-layers.gpkg'), 'GPKG')
  vector.createLayer({ name: 'things', geometryType: 'Point' })
  assert.equal(vector.layers.get(1).name, 'things')
  assert.equal(vector.layers.get('things').name, 'things')
  assert.equal(vector.layers.get(2), null)
  assert.equal(vector.layers.count(), 1)

  await vector.close()
  await dataset.close()
})

test('a layer hands out fields and features as collections', async () => {
  const dataset = await gdal.createVector(tmp('collections.gpkg'), 'GPKG')
  const layer = dataset.createLayer({ name: 'things', geometryType: 'Point', epsg: 4326 })
  layer.createFeature({ type: 'Point', coordinates: [0, 0] }, { name: 'first', population: 1 })
  layer.createFeature({ type: 'Point', coordinates: [1, 1] }, { name: 'second', population: 2 })

  // Fields: the getter still answers an array, and the array is a collection.
  assert.ok(Array.isArray(layer.fields))
  assert.deepEqual(
    layer.fields.map((field) => field.name),
    ['name', 'population'],
  )
  assert.deepEqual(layer.fields.getNames(), ['name', 'population'])
  assert.equal(layer.fields.get('population').name, 'population')
  assert.equal(layer.fields.get(1).name, 'name')
  assert.equal(layer.fields.get('nope'), null)
  assert.equal(layer.fields.count(), 2)

  // Features: `count` asks the layer, and the collection iterates.
  assert.equal(layer.features.count(), 2)
  assert.equal(layer.features.get(1).fid, 1)
  assert.equal(layer.features.get(99), null)
  const names = []
  for await (const feature of layer.features) names.push(feature.fid)
  assert.deepEqual(names, [1, 2])
  // The call is still the call: a fresh read, off the event loop.
  assert.ok(layer.features() instanceof Promise)
  assert.equal((await layer.features()).length, 2)

  await dataset.close()
})

test('drivers, overviews and pixels carry the reference names', async () => {
  // `drivers` counts from 0 by index — that is the reference's index, and the one
  // place in this surface where an index is not 1-based.
  assert.ok(gdal.drivers.count() > 100)
  assert.equal(gdal.drivers.get(0).name, gdal.drivers()[0].name)
  assert.equal(gdal.drivers.get('GTiff').name, 'GTiff')
  assert.equal(gdal.drivers.get('NOPE'), null)
  assert.ok(gdal.drivers.getNames().includes('GTiff'))
  assert.equal([...gdal.drivers].length, gdal.drivers().length)

  const dataset = await gdal.create(tmp('collections-overviews.tif'), {
    driver: 'GTiff',
    width: 64,
    height: 64,
    bandCount: 1,
    dataType: 'Uint8',
  })
  const band = dataset.band(0)
  band.writeValues(0, 0, 64, 64, Buffer.alloc(64 * 64, 7))
  dataset.flushSync()
  await dataset.buildOverviews({ levels: [2, 4, 8] })

  assert.ok(Array.isArray(band.overviews), 'the getter still answers an array')
  assert.equal(band.overviews.count(), 3)
  // The levels' own `index` is 0-based, like every other index here; `get` counts from
  // 1, like every other collection.
  assert.deepEqual(band.overviews.getNames(), [0, 1, 2])
  assert.deepEqual(band.overviews.get(1).size, [32, 32])
  assert.equal(band.overviews.get(4), null)
  // The first level at or below the count asked for; the smallest when none is.
  assert.deepEqual(band.overviews.getBySampleCount(32).size, [32, 32])
  assert.deepEqual(band.overviews.getBySampleCount(8).size, [8, 8])
  assert.deepEqual(band.overviews.getBySampleCount(1).size, [8, 8])
  assert.equal([...band.overviews].length, band.overviews.length)

  // Pixels: the same accessors the band has, under the reference's names.
  const pixels = band.pixels
  assert.equal(pixels.band, band)
  assert.equal(pixels, band.pixels, 'one per band')
  assert.equal(pixels.get(1, 1), 7)
  pixels.set(1, 1, 9)
  assert.equal(pixels.get(1, 1), 9)
  assert.deepEqual([...pixels.read(0, 0, 2, 1)], [7, 7])
  pixels.write(0, 0, 2, 1, Uint8Array.from([1, 2]))
  assert.deepEqual([...pixels.read(0, 0, 2, 1)], [1, 2])
  assert.deepEqual([...pixels.readBlock(0, 0)], [...band.readBlock(0, 0)])
  assert.equal(typeof pixels.createReadStream, 'function')

  await dataset.close()
})

test('the multidimensional model answers both spellings too', async () => {
  // A NetCDF file, which is the fixture the multidimensional tests use: it is kept
  // out of `workdir` because this build's netCDF writer holds the file open.
  const raster = tmp('collections-md.tif')
  const created = gdal.createSync(raster, {
    driver: 'GTiff',
    width: 4,
    height: 2,
    bandCount: 1,
    dataType: 'Uint8',
  })
  created.band(0).writeValues(0, 0, 4, 2, Buffer.from(ramp(4, 2)))
  created.close()
  const netcdf = join(scratch, 'collections-md.nc')
  await gdal.translate(netcdf, raster, ['-of', 'netCDF'])

  const dataset = gdal.openSync(netcdf, { multidimensional: true })
  const root = dataset.root

  // `arrays` and `groups` are new names, so they are plain collections.
  assert.equal(root.arrays.get('Band1').name, 'Band1')
  assert.equal(root.arrays.get(1).name, 'Band1')
  assert.equal(root.arrays.get('nope'), null)
  assert.deepEqual(root.arrays.getNames(), ['Band1'])
  assert.deepEqual(root.groups.getNames(), [])
  assert.equal(root.groups.count(), 0)

  // `dimensions` and `attributes` are calls here, so they answer both ways.
  assert.ok(Array.isArray(root.dimensions()))
  assert.equal(root.dimensions.get('x').size, 4)
  assert.deepEqual(root.dimensions.getNames(), ['x', 'y'])
  assert.equal(root.attributes.get('Conventions').value, 'CF-1.5')

  const array = root.arrays.get('Band1')
  assert.ok(Array.isArray(array.dimensions()))
  assert.equal(array.dimensions.get('y').size, 2)
  assert.deepEqual(array.attributes.getNames(), ['long_name', 'valid_range'])
  assert.equal(array.attributes.get('long_name').value, 'GDAL Band Number 1')

  dataset.close()
})
