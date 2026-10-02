// @ts-nocheck
// GDAL's second data model — `Dataset.root`, `Group`, `MDArray`, `Attribute`,
// `Dimension` — which is what NetCDF, HDF5 and Zarr look like through GDAL.
//
// The fixture writes itself: this build can read multidimensional files but only
// writes one format, NetCDF, so the test translates a small GeoTIFF into it. The
// same file then opens twice, once as bands and once as a root group, which is
// exactly the distinction `multidimensional: true` draws.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { bytesOf, gdal, ramp } from '../helpers.js'

// The fixtures live outside the helper's `workdir`, for two reasons, both of them
// about this driver file handle outliving the JS dataset:
//
// - The netCDF *writer* leaves the file open for the life of the process — a plain
//   `gdal_translate` is enough, no open by us involved.
// - A multidimensional handle keeps GDAL's own reference to its dataset, so an
//   `MDArray` taken from a band keeps that band's file open too.
//
// Either one inside `workdir` makes the helper's exit-time cleanup fail on Windows.
// Neither is the binding's doing in the sense of a leak it could close: both are
// GDAL holding the file for an object that is still alive.
const scratch = mkdtempSync(join(tmpdir(), 'gdal-rs-napi-multidim-'))
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // Still held, as above. Left to the OS temp directory.
  }
})

/** A 4x3 raster, and the NetCDF copy of it. Built once for the whole file. */
let built
function fixtures() {
  built ??= (async () => {
    const raster = join(scratch, 'multidim-source.tif')
    const created = await gdal.create(raster, {
      driver: 'GTiff',
      width: 4,
      height: 3,
      bands: 1,
    })
    created.band(0).writePixelsSync(bytesOf(ramp(4, 3)))
    await created.close()
    const netcdf = join(scratch, 'multidim.nc')
    await gdal.translate(netcdf, raster, ['-of', 'netCDF'])
    return { raster, netcdf }
  })()
  return built
}

// A second fixture, the first one plus a CRS. It is a **projected** CRS on purpose:
// the netCDF writer gives a geographic one no `grid_mapping`, so the array's own `srs`
// stays null — while a projected one it does keep, which is the case that used to
// deadlock. `MDArray.srs` took the write lock and then the `SpatialRef` constructor
// took the shared side again on the same thread.
let crsBuilt
function crsFixture() {
  crsBuilt ??= (async () => {
    const raster = join(scratch, 'multidim-crs-source.tif')
    const created = await gdal.create(raster, {
      driver: 'GTiff',
      width: 4,
      height: 3,
      bands: 1,
    })
    created.band(0).writePixelsSync(bytesOf(ramp(4, 3)))
    created.setProjection(gdal.epsgToWkt(32633))
    await created.close()
    const netcdf = join(scratch, 'multidim-crs.nc')
    await gdal.translate(netcdf, raster, ['-of', 'netCDF', '-a_srs', 'EPSG:32633'])
    return netcdf
  })()
  return crsBuilt
}

test('a multidimensional file opens with a root group, a raster one without', async () => {
  const { raster, netcdf } = await fixtures()

  // Without the flag GDAL builds no root group, even for NetCDF: the file is
  // handed over as bands and nothing else.
  const asBands = await gdal.open(netcdf)
  assert.equal(asBands.root, null)
  assert.deepEqual(asBands.rasterSize, { width: 4, height: 3 })
  assert.equal(asBands.bandCount, 1)
  await asBands.close()

  // With it, the multidimensional model is what comes back — so the band side is
  // empty and `root` is the way in.
  const asModel = await gdal.open(netcdf, { multidimensional: true })
  assert.equal(asModel.bandCount, 0)
  assert.notEqual(asModel.root, null)
  assert.equal(asModel.root.fullName, '/')
  await asModel.close()

  // A file with no multidimensional model opens as a plain raster either way.
  const plain = await gdal.open(raster, { multidimensional: true })
  assert.equal(plain.root, null)
  assert.deepEqual(plain.rasterSize, { width: 4, height: 3 })
  await plain.close()
})

test('the root group lists its arrays, groups, dimensions and attributes', async () => {
  const { netcdf } = await fixtures()
  const dataset = await gdal.open(netcdf, { multidimensional: true })
  const root = dataset.root

  assert.deepEqual(root.arrayNames(), ['Band1'])
  assert.deepEqual(root.groupNames(), [])
  assert.equal(root.name, '/')

  // NetCDF's own bookkeeping arrives as attributes, in the order the file has them.
  const attributes = root.attributes()
  assert.deepEqual(
    attributes.map((attribute) => attribute.name),
    ['Conventions', 'GDAL', 'history'],
  );
  assert.equal(root.openAttribute('Conventions').value, 'CF-1.5')
  assert.equal(root.openAttribute('Conventions').dataType, 'String')
  assert.equal(root.openAttribute('nope'), null)

  // The group's dimensions are x then y; the array indexes them y then x.
  const dimensions = root.dimensions()
  assert.deepEqual(
    dimensions.map((dimension) => [dimension.name, dimension.size]),
    [
      ['x', 4],
      ['y', 3],
    ],
  )
  assert.equal(root.openDimension('x').size, 4)
  assert.equal(root.openDimension('nope'), null)
  // A classic NetCDF leaves the axes untyped and gives them no direction.
  assert.equal(dimensions[0].typeName, '')
  assert.equal(dimensions[0].direction, null)
  assert.equal(dimensions[0].indexingVariable, null)

  assert.equal(root.openArray('nope'), null)
  assert.equal(root.openGroup('nope'), null)
  await dataset.close()
})

test('an MDArray reads a hyperslab in its own sample type', async () => {
  const { netcdf } = await fixtures()
  const dataset = await gdal.open(netcdf, { multidimensional: true })
  const array = dataset.root.openArray('Band1')

  assert.equal(array.name, 'Band1')
  assert.equal(array.fullName, '/Band1')
  assert.equal(array.dimensionCount, 2)
  assert.deepEqual(array.shape, [3, 4])
  assert.equal(array.dataType, 'Uint8')
  assert.deepEqual(
    array.dimensions().map((dimension) => dimension.name),
    ['y', 'x'],
  )

  // No scaling, no missing value and no CRS on this file, and it says so.
  assert.equal(array.unit, null)
  assert.equal(array.noDataValue, null)
  assert.equal(array.offset, null)
  assert.equal(array.scale, null)
  assert.equal(array.srs, null)

  assert.deepEqual(
    array.attributes().map((attribute) => attribute.name),
    ['long_name', 'valid_range'],
  )
  assert.equal(array.openAttribute('long_name').value, 'GDAL Band Number 1')
  // A two-element attribute comes back as an array of its own type.
  assert.equal(array.openAttribute('valid_range').dataType, 'Uint16')
  assert.deepEqual(array.openAttribute('valid_range').value, [0, 255])

  // Raw bytes in the array's own type — one byte per sample here.
  const whole = array.read()
  assert.equal(whole.length, 12)
  // The raster's rows run north-to-south and NetCDF's y runs the other way, so
  // the array is the raster's rows in reverse.
  assert.deepEqual(Array.from(whole), [8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3])
  // The same bytes, as a typed view.
  assert.deepEqual(Array.from(new Uint8Array(whole.buffer, whole.byteOffset, whole.length)), [
    8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3,
  ])

  // A window: two elements in from each corner.
  assert.deepEqual(Array.from(array.read({ start: [1, 1], count: [2, 2] })), [5, 6, 1, 2])
  // A start of the right length but not the right shape is still wrong.
  assert.throws(() => array.read({ start: [1] }), /start has to name every dimension: 2 of them, got 1/)
  assert.throws(
    () => array.read({ count: [1, 2, 3] }),
    /count has to name every dimension: 2 of them, got 3/,
  )

  await dataset.close()
})

test('an MDArray reports the CRS the file carries', async () => {
  const netcdf = await crsFixture()
  const dataset = await gdal.open(netcdf, { multidimensional: true })
  const array = dataset.root.openArray('Band1')

  // Reading this used to hang the process: `srs` held the exclusive lock and then the
  // `SpatialRef` constructor tried to take the shared side on the same thread.
  const srs = array.srs
  assert.notEqual(srs, null)
  assert.equal(srs.authName, 'EPSG')
  assert.equal(srs.authCode, 32633)
  assert.match(srs.wkt, /UTM zone 33N/)

  await dataset.close()
})

test('asDataset() hands the array back as a raster, and takes the axes when told', async () => {
  const { netcdf } = await fixtures()
  const dataset = await gdal.open(netcdf, { multidimensional: true })
  const array = dataset.root.openArray('Band1')

  // Untagged axes fall to the last two dimensions, which gives width = y.
  const guessed = array.asDataset()
  assert.deepEqual(guessed.rasterSize, { width: 3, height: 4 })
  assert.equal(guessed.bandCount, 1)
  assert.equal(guessed.band(0).dataType, 'Uint8')
  assert.deepEqual(Array.from(guessed.band(0).readPixelsSync()), [
    8, 4, 0, 9, 5, 1, 10, 6, 2, 11, 7, 3,
  ])
  await guessed.close()

  // Told which is which, the view is the array's own layout and the pixels come
  // back exactly as `read()` returns them.
  const told = array.asDataset({ xDim: 1, yDim: 0 })
  assert.deepEqual(told.rasterSize, { width: 4, height: 3 })
  assert.deepEqual(Array.from(told.band(0).readPixelsSync()), [
    8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3,
  ])
  await told.close()

  // Half a pair, the same axis twice, and an axis that is not there are all refused
  // rather than guessed at.
  assert.throws(() => array.asDataset({ xDim: 0 }), /give both xDim and yDim, or neither/)
  assert.throws(() => array.asDataset({ xDim: 0, yDim: 0 }), /cannot be the same dimension/)
  assert.throws(() => array.asDataset({ xDim: 0, yDim: 9 }), /indexes below 2/)

  await dataset.close()
})

test('structural info is borrowed from the driver, not freed by the binding', async () => {
  const { netcdf } = await fixtures()
  const dataset = await gdal.open(netcdf, { multidimensional: true })
  const root = dataset.root

  // GDAL answers this one with a list the group still owns — freeing it corrupts
  // the heap, so reading it twice and closing afterwards is the real assertion.
  assert.deepEqual(root.structuralInfo(), { NC_FORMAT: 'CLASSIC' })
  assert.deepEqual(root.structuralInfo(), { NC_FORMAT: 'CLASSIC' })
  assert.deepEqual(root.openArray('Band1').structuralInfo(), {})

  await dataset.close()
  // A handle GDAL handed out carries its own reference, so it outlives `close()`:
  // the group still answers, and the file stays open until it is let go. Closing
  // the dataset is what makes the *raster* side refuse, not this one.
  assert.deepEqual(root.arrayNames(), ['Band1'])
  assert.throws(() => dataset.rasterSize, /the dataset is closed/)
})

test('a band is an MDArray too, which is the way in from a plain raster', async () => {
  const { raster } = await fixtures()
  const dataset = await gdal.open(raster)
  const array = dataset.band(0).asMDArray()

  // No `multidimensional: true` needed: the band's own dataset is the backing.
  assert.deepEqual(array.shape, [3, 4])
  assert.equal(array.dataType, 'Uint8')
  assert.deepEqual(
    array.dimensions().map((dimension) => dimension.name),
    ['Y', 'X'],
  )
  assert.deepEqual(Array.from(array.read()), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

  // And straight back to a raster.
  const back = array.asDataset()
  assert.deepEqual(back.rasterSize, { width: 3, height: 4 })
  await back.close()

  // A mask band is not attached to a dataset of its own, so GDAL has nothing to
  // build an array on and says so rather than answering with a broken one.
  assert.throws(
    () => dataset.band(0).mask.asMDArray(),
    /GDAL would not make a multidimensional array/,
  )

  await dataset.close()
})

test('the mask and a view are arrays in their own right', async () => {
  const { netcdf } = await fixtures()
  const dataset = await gdal.open(netcdf, { multidimensional: true })
  const array = dataset.root.openArray('Band1')

  // NetCDF gives every variable a mask, so this one is all valid.
  const mask = array.getMask()
  assert.equal(mask.name, 'Mask of /Band1')
  assert.equal(mask.dataType, 'Uint8')
  assert.deepEqual(mask.shape, [3, 4])
  assert.deepEqual(Array.from(mask.read()), new Array(12).fill(1))

  // A view is a new array over the same data, and the original is unchanged.
  // A single index collapses that dimension instead of keeping it.
  const first = array.getView('[0,:]')
  assert.deepEqual(first.shape, [4])
  assert.deepEqual(Array.from(first.read()), [8, 9, 10, 11])
  assert.deepEqual(Array.from(array.read({ count: [1, 4] })), [8, 9, 10, 11])

  const decimated = array.getView('[::2,::2]')
  assert.deepEqual(decimated.shape, [2, 2])
  assert.deepEqual(Array.from(decimated.read()), [8, 10, 0, 2])

  // GDAL's own view grammar, so a broken one is refused rather than guessed at.
  assert.throws(() => array.getView('[bogus'), /view expression could not be applied/)

  await dataset.close()
})
