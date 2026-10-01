// The `Driver` object and the dataset-level accessors that go with it.
//
// The point of the object is that a driver's own metadata is reachable without
// guessing: what it can create, what extensions it claims, what options it takes.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'

import { gdal, tmp } from './helpers.mjs'

const GTiff = 'GTiff'

test('gdal.driver() finds a driver by name, or answers null', () => {
  const gtiff = gdal.driver(GTiff)
  assert.equal(gtiff.name, GTiff)
  assert.equal(gtiff.longName, 'GeoTIFF')
  assert.equal(typeof gtiff.description, 'string')

  // A name this build does not have is an answer, not an error — the call is a
  // lookup. The same shape `Layer.testCapability` has.
  assert.equal(gdal.driver('NoSuchDriverAnywhere'), null)
})

test('gdal.drivers() hands back Driver objects, sorted and complete', () => {
  const drivers = gdal.drivers()
  assert.equal(drivers.length, gdal.info().driverCount)
  assert.equal(drivers.length, new Set(drivers.map((d) => d.name)).size, 'names are unique')

  const names = drivers.map((d) => d.name)
  assert.deepEqual(names, [...names].sort(), 'sorted by short name')

  // The elements are objects now, but the accessor the old shape had still works.
  assert.ok(drivers.every((d) => typeof d.name === 'string' && typeof d.longName === 'string'))
  assert.ok(drivers.some((d) => d.name === GTiff))
  assert.equal(String(gdal.driver(GTiff)), GTiff, '`${driver}` stays the short name')
})

test("testCapability answers GDAL's DCAP_* questions", () => {
  const gtiff = gdal.driver(GTiff)
  assert.equal(gtiff.testCapability('DCAP_CREATE'), true)
  assert.equal(gtiff.testCapability('DCAP_CREATECOPY'), true)
  assert.equal(gtiff.testCapability('DCAP_RASTER'), true)
  // A raster-only driver: the flag is stored as metadata with the value "NO", and
  // "NO" has to read as false rather than as "present".
  assert.equal(gtiff.testCapability('DCAP_VECTOR'), false)
  // Unrecognised is absent, which is also false rather than a throw.
  assert.equal(gtiff.testCapability('DCAP_NOT_A_REAL_CAPABILITY'), false)

  const gpkg = gdal.driver('GPKG')
  assert.equal(gpkg.testCapability('DCAP_VECTOR'), true)
  assert.equal(gpkg.testCapability('DCAP_CREATE'), true)
})

test('a driver reports its metadata, extensions and creation options', () => {
  const gtiff = gdal.driver(GTiff)

  assert.equal(gtiff.metadata().DMD_MIMETYPE, 'image/tiff')
  assert.deepEqual(gtiff.fileExtensions(), ['tif', 'tiff'])

  // The XML document `gdalinfo --format GTiff` prints, which is how a caller
  // learns an option name without guessing at it. GDAL writes the attribute with
  // single quotes.
  const options = gtiff.creationOptionList()
  assert.match(options, /<Option name='TILED'/)
  assert.match(options, /COMPRESS/)

  // A driver that creates nothing has no list rather than an empty document.
  const netcdf = gdal.driver('netCDF')
  assert.equal(typeof netcdf.creationOptionList(), 'string')
})

test('driver.openSync reads with that driver only', () => {
  // A real GeoJSON file, written by hand: an empty datasource creates a zero-byte
  // file that no driver can sniff, which is a property of the format rather than of
  // the driver scope this test is about.
  const path = tmp('driver-scoped.geojson')
  writeFileSync(
    path,
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { n: 1 }, geometry: { type: 'Point', coordinates: [1, 2] } },
      ],
    }),
  )

  // Through the right driver it opens.
  const geo = gdal.driver('GeoJSON').openSync(path)
  assert.equal(geo.driver.name, 'GeoJSON')
  geo.close()

  // Through the wrong one it does not, which is the whole point of the scope: a
  // failure names the driver instead of silently loading as something else.
  assert.throws(() => gdal.driver(GTiff).openSync(path))

  // The same restriction is expressible through the module-level open.
  const viaOption = gdal.openSync(path, { drivers: ['GeoJSON'] })
  assert.equal(viaOption.driver.name, 'GeoJSON')
  viaOption.close()

  assert.throws(() => gdal.openSync(path, { drivers: [GTiff] }))
})

test('driver.createCopy copies a dataset through that driver', async () => {
  const sourcePath = tmp('driver-copy-src.tif')
  const source = gdal.createSync(sourcePath, {
    driver: GTiff,
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Uint8',
  })
  source.band(0).fill(7)
  source.close()

  // The driver object carries the name, so the call cannot pass the wrong one —
  // and this is the road to drivers (COG, JPEG) that implement CreateCopy only.
  const opened = gdal.openSync(sourcePath)
  const copied = gdal.driver(GTiff).createCopySync(tmp('driver-copy-out.tif'), opened, {
    COMPRESS: 'DEFLATE',
  })
  assert.equal(copied.driver.name, GTiff)
  assert.equal(copied.band(0).readPixelsSync()[0], 7)
  copied.close()
  opened.close()

  // The async form runs the same body, so it agrees.
  const reopened = gdal.openSync(sourcePath)
  const asyncCopy = await gdal.driver(GTiff).createCopy(tmp('driver-copy-async.tif'), reopened)
  assert.equal(asyncCopy.band(0).readPixelsSync()[0], 7)
  asyncCopy.close()
  reopened.close()
})

test('driver.createSync and driver.create name the driver for you', async () => {
  const path = tmp('driver-created.tif')
  const dataset = gdal.driver(GTiff).createSync(path, {
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Float32',
  })
  assert.equal(dataset.driver.name, GTiff)
  assert.equal(dataset.bandCount, 1)
  dataset.close()

  const asyncPath = tmp('driver-created-async.tif')
  const asyncDataset = await gdal.driver(GTiff).create(asyncPath, { width: 2, height: 2 })
  assert.equal(asyncDataset.driver.name, GTiff)
  asyncDataset.close()

  // And the async open, with the same driver scope.
  const reopened = await gdal.driver(GTiff).open(asyncPath)
  assert.deepEqual(reopened.rasterSize, { width: 2, height: 2 })
  reopened.close()
})

test('dataset.driver is the Driver object, and toString keeps the old reading', () => {
  const path = tmp('driver-object.tif')
  const dataset = gdal.createSync(path, {
    driver: GTiff,
    width: 2,
    height: 2,
    bandCount: 1,
  })

  assert.equal(dataset.driver.name, GTiff)
  assert.equal(dataset.driver.longName, 'GeoTIFF')
  assert.equal(dataset.driver.testCapability('DCAP_CREATE'), true)
  // The same object `gdal.driver(name)` hands out, so `===` holds there too.
  assert.equal(String(dataset.driver), GTiff)
  assert.equal(`${dataset.driver}`, GTiff)

  dataset.close()
})

test('getFileList, description and rasterSize report the dataset itself', () => {
  const path = tmp('driver-files.tif')
  const dataset = gdal.createSync(path, {
    driver: GTiff,
    width: 8,
    height: 4,
    bandCount: 1,
  })
  dataset.band(0).fill(1)
  dataset.close()

  const reopened = gdal.openSync(path)
  const files = reopened.getFileList()
  assert.ok(Array.isArray(files))
  assert.ok(files.length >= 1, `a GTiff is at least one file, got ${JSON.stringify(files)}`)
  assert.ok(files.some((file) => file.endsWith('driver-files.tif')))

  // For a file, GDAL's description is the file name.
  assert.ok(reopened.description.endsWith('driver-files.tif'))

  assert.deepEqual(reopened.rasterSize, { width: 8, height: 4 })
  // `width` / `height` stay as the flat accessors — the pair, grouped, is additive.
  assert.equal(reopened.rasterSize.width, reopened.width)
  assert.equal(reopened.rasterSize.height, reopened.height)

  reopened.close()
})

test('a dataset with nothing behind it reports no files', () => {
  // MEM is the only shape that answers empty: a /vsimem/ dataset reports its
  // /vsimem/ name, because that file really exists to GDAL.
  const memory = gdal.createSync('', { driver: 'MEM', width: 2, height: 2, bandCount: 1 })
  assert.deepEqual(memory.getFileList(), [])
  memory.close()

  const vsi = gdal.createSync('/vsimem/file-list.tif', {
    driver: GTiff,
    width: 2,
    height: 2,
    bandCount: 1,
  })
  assert.deepEqual(vsi.getFileList(), ['/vsimem/file-list.tif'])
  vsi.close()
})

test('a driver renames and copies a dataset, files and all', () => {
  const from = tmp('driver-from.tif')
  const copied = tmp('driver-copied.tif')
  const renamed = tmp('driver-renamed.tif')

  const created = gdal.createSync(from, {
    driver: GTiff,
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Uint8',
  })
  created.band(0).fill(3)
  created.close()

  const gtiff = gdal.driver(GTiff)

  // `copyFiles` is the copy twin of `rename`: the driver moves every file the
  // dataset is made of, not just the one the path names.
  gtiff.copyFiles(copied, from)
  assert.equal(gdal.fs.exists(copied), true)

  gtiff.rename(renamed, from)
  assert.equal(gdal.fs.exists(renamed), true)
  assert.equal(gdal.fs.exists(from), false)

  // What came out the other side is still a GeoTIFF with its pixels.
  const reopened = gdal.openSync(renamed)
  assert.equal(reopened.band(0).getPixel(0, 0), 3)
  reopened.close()
})

test('getEnvelope reports the bounding box a dataset covers', () => {
  // A raster's is its four corners under the geotransform.
  const raster = gdal.createSync('', {
    driver: 'MEM',
    width: 4,
    height: 6,
    bandCount: 1,
    dataType: 'Uint8',
  })
  raster.setGeoTransform([100, 2, 0, 200, 0, -3])
  assert.deepEqual(raster.getEnvelope(), { minX: 100, minY: 182, maxX: 108, maxY: 200 })
  raster.close()

  // A vector one's is the union of its layers' extents.
  const vector = gdal.createVectorSync(tmp('envelope.gpkg'), 'GPKG')
  const layer = vector.createLayer({ name: 'things', geometryType: 'Point', epsg: 4326 })
  layer.createFeature({ type: 'Point', coordinates: [1, 2] }, { n: 1 })
  layer.createFeature({ type: 'Point', coordinates: [5, 8] }, { n: 2 })

  const box = vector.getEnvelope()
  assert.ok(Math.abs(box.minX - 1) < 1e-9, `minX ${box.minX}`)
  assert.ok(Math.abs(box.minY - 2) < 1e-9, `minY ${box.minY}`)
  assert.ok(Math.abs(box.maxX - 5) < 1e-9, `maxX ${box.maxX}`)
  assert.ok(Math.abs(box.maxY - 8) < 1e-9, `maxY ${box.maxY}`)
  vector.close()
})
