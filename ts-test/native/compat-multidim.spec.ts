// @ts-nocheck
// The compat layer's multidimensional model: gdal-async's Group / MDArray / Attribute /
// Dimension, and the six collections that hang off them.
//
// The fixture is a NetCDF file, the one multidimensional format this build can also
// *write*, and it is kept out of the helper's `workdir`: this build's netCDF writer
// holds the file open for the life of the process, so a `.nc` inside it would make the
// exit-time cleanup fail on Windows.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { gdal as native, ramp, tmp } from '../helpers.js'

/** The compat entry point rather than the main one: this is its shape being checked. */
const gdal = createRequire(import.meta.url)('../../compat')

const scratch = mkdtempSync(join(tmpdir(), 'gdal-rs-napi-compat-md-'))
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // Still held by the driver, as above.
  }
})

let built
function fixtures() {
  built ??= (async () => {
    const raster = tmp('compat-md-source.tif')
    const created = gdal.open(raster, 'w', 'GTiff', 4, 3, 1, 'GDT_Byte')
    created.bands.get(1).pixels.write(0, 0, 4, 3, ramp(4, 3))
    created.close()
    const netcdf = join(scratch, 'compat-md.nc')
    // The NetCDF is scaffolding, not the thing under test: `translate` is one of the
    // entry points the compat layer does not reshape, so the native one makes it.
    await native.translate(netcdf, raster, ['-of', 'netCDF'])
    return { raster, netcdf }
  })()
  return built
}

test('a dataset hands out its root group, with all four of its collections', async () => {
  const dataset = gdal.open((await fixtures()).netcdf)

  const root = dataset.root
  assert.notEqual(root, null)
  assert.equal(root.description, '/')
  assert.equal(root.ds, dataset._model, 'the group carries the dataset it came from')

  // The arrays, by name and by position.
  assert.deepEqual(root.arrays.getNames(), ['Band1'])
  assert.equal(root.arrays.count(), 1)
  assert.equal(root.arrays.get(1).description, '/Band1')
  assert.equal(root.arrays.get('Band1').description, '/Band1')
  assert.equal(root.arrays.get(2), null)
  assert.deepEqual(root.groups.getNames(), [])
  assert.deepEqual(root.dimensions.getNames(), ['x', 'y'])
  assert.deepEqual(
    root.attributes.getNames(),
    ['Conventions', 'GDAL', 'history'],
  )

  // Collections iterate, which is what the reference's do.
  assert.deepEqual(
    [...root.arrays].map((array) => array.description),
    ['/Band1'],
  )
  const async = []
  for await (const array of root.arrays) async.push(array.description)
  assert.deepEqual(async, ['/Band1'])
  assert.deepEqual(
    root.arrays.map((array) => array.description),
    ['/Band1'],
  )
  const seen = []
  root.dimensions.forEach((dimension) => seen.push(dimension.description))
  assert.deepEqual(seen, ['x', 'y'])

  dataset.close()
})

test('an MDArray reads as a typed array, and answers like the reference', async () => {
  const dataset = gdal.open((await fixtures()).netcdf)
  const array = dataset.root.arrays.get('Band1')

  assert.equal(array.dataType, 'Uint8')
  assert.equal(array.length, 12, 'three rows of four')
  assert.equal(array.noDataValue, null)
  assert.equal(array.offset, null)
  assert.equal(array.scale, null)
  assert.equal(array.unitType, null)
  assert.equal(array.srs, null)
  assert.deepEqual(array.dimensions.getNames(), ['y', 'x'])
  assert.equal(array.dimensions.get('y').size, 3)

  const all = array.read()
  assert.ok(all instanceof Uint8Array)
  // The raster runs north to south and NetCDF's y the other way, so the array is the
  // raster's rows reversed.
  assert.deepEqual([...all], [8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3])

  // A hyperslab, the way the reference takes one.
  assert.deepEqual([...array.read([1, 1], [2, 2])], [5, 6, 1, 2])

  const attributes = array.attributes
  assert.deepEqual(attributes.getNames(), ['long_name', 'valid_range'])
  assert.equal(attributes.get('long_name').value, 'GDAL Band Number 1')
  assert.equal(attributes.get('long_name').dataType, 'String')

  // A view is another array, and the mask is one too.
  assert.deepEqual([...array.getView('[0,:]').read()], [8, 9, 10, 11])
  assert.deepEqual([...array.getMask().read()], new Array(12).fill(1))

  // And back to a classic dataset, whose bands are the raster side again.
  const asDataset = array.asDataset()
  assert.deepEqual(asDataset.rasterSize, { x: 3, y: 4 })
  assert.equal(asDataset.bands.count(), 1)
  asDataset.close()

  dataset.close()
})

test('a dataset with no multidimensional model answers null', async () => {
  const { raster, netcdf } = await fixtures()

  // The GeoTIFF the NetCDF was made from has no such model; the NetCDF does.
  const geotiff = gdal.open(raster)
  assert.equal(geotiff.root, null)
  geotiff.close()
  const dataset = gdal.open(netcdf)
  assert.notEqual(dataset.root, null)

  // Asking twice hands back the same second handle rather than opening a third.
  const model = dataset._model
  assert.equal(dataset.root.ds, model)
  assert.equal(dataset.root.ds, model)

  // And closing releases it with the rest.
  dataset.close()
  assert.equal(dataset._model, undefined)
})
