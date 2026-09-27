import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'

import { asTypedArray, bytesOf, gdal, ramp, tmp } from './helpers.mjs'

test('version() and drivers() report the statically linked build', () => {
  const version = gdal.version()
  assert.match(version.gdal, /^GDAL 3\./)
  assert.match(version.proj, /^\d+\.\d+/)

  const drivers = gdal.drivers()
  // The all-drivers build. The floor is a regression guard: dropping back to the
  // internal set alone lands at 131.
  assert.ok(drivers.length >= 140, `expected the full driver set, got ${drivers.length}`)

  const names = new Set(drivers.map((d) => d.name))
  for (const expected of [
    // The internal set.
    'GTiff',
    'MEM',
    'VRT',
    'GeoJSON',
    'GPKG',
    'ESRI Shapefile',
    // Each of these needs a library that only the full build links in, so they
    // also prove the static HDF5/netCDF/curl/libpq chain came together.
    'HDF5',
    'netCDF',
    'WMS',
    'WMTS',
    'WCS',
    'OGCAPI',
    'PLMOSAIC',
    'PostgreSQL',
  ]) {
    assert.ok(names.has(expected), `${expected} is missing from the driver list`)
  }

  // PDS is the one driver the package cannot offer: gdal-src does not ship
  // frmts/pds/data, so enabling it fails GDAL's configure step.
  assert.equal(names.has('PDS'), false)

  assert.ok(drivers.every((d) => typeof d.longName === 'string'))
})

test('a driver the full build adds works end to end, not just in the list', () => {
  // netCDF reads and writes through a library the internal-only build does not
  // link, so a round trip is the honest proof that the driver arrived.
  const path = tmp('netcdf-roundtrip.nc')
  const values = ramp(8, 4)

  const created = gdal.createSync(path, {
    driver: 'netCDF',
    width: 8,
    height: 4,
    bandCount: 1,
  })
  created.band(0).writePixelsSync(bytesOf(values))
  created.close()

  const reopened = gdal.openSync(path)
  assert.equal(reopened.driver, 'netCDF')
  assert.equal(reopened.width, 8)
  assert.equal(reopened.height, 4)
  assert.deepEqual(Array.from(reopened.band(0).readPixelsSync()), Array.from(values))
  reopened.close()
})

test('diagnostics() finds the packaged CRS database', () => {
  const diagnostics = gdal.diagnostics()
  assert.equal(diagnostics.epsg4326Resolves, true, diagnostics.error ?? '')
  assert.equal(diagnostics.crsDatabaseFound, true)
  // GEOS is LGPL and deliberately not linked, so the OGR predicates it backs are
  // absent. diagnostics is where that is answerable without a probe.
  assert.equal(diagnostics.geosAvailable, false, 'GEOS is deliberately not linked')
})

test('bytesPerSample covers the sample types', () => {
  assert.equal(gdal.bytesPerSample('Uint8'), 1)
  assert.equal(gdal.bytesPerSample('Int16'), 2)
  assert.equal(gdal.bytesPerSample('Float32'), 4)
  assert.equal(gdal.bytesPerSample('Float64'), 8)
})

test('creates a GTiff, writes it, and reads back identical bytes', () => {
  const path = tmp('roundtrip.tif')
  const expected = ramp(4, 4)

  const created = gdal.createSync(path, { driver: 'GTiff', width: 4, height: 4, bandCount: 1 })
  created.band(0).writePixelsSync(bytesOf(expected))
  created.close()

  const reopened = gdal.openSync(path)
  assert.equal(reopened.driver, 'GTiff')
  assert.equal(reopened.width, 4)
  assert.equal(reopened.height, 4)
  assert.equal(reopened.bandCount, 1)
  assert.equal(reopened.band(0).dataType, 'Uint8')
  assert.deepEqual(Array.from(reopened.band(0).readPixelsSync()), Array.from(expected))
  reopened.close()
})

test('MEM datasets need no file at all', () => {
  const dataset = gdal.createSync('', { driver: 'MEM', width: 3, height: 2, bandCount: 2 })
  assert.equal(dataset.driver, 'MEM')
  assert.equal(dataset.bandCount, 2)
  dataset.band(1).writePixelsSync(bytesOf(ramp(3, 2)))
  assert.deepEqual(Array.from(dataset.band(1).readPixelsSync()), Array.from(ramp(3, 2)))
  dataset.close()
})

test('readAs converts between sample types', () => {
  const dataset = gdal.createSync(tmp('float.tif'), {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 1,
    dataType: 'Float32',
  })
  const values = new Float32Array([1.5, -2.25, 3, 4.75])
  const band = dataset.band(0)
  band.writePixelsSync(bytesOf(values))

  assert.equal(band.dataType, 'Float32')
  const asFloat = asTypedArray(band.readPixelsSync(), Float32Array)
  assert.deepEqual(Array.from(asFloat), Array.from(values))

  // A Uint8 view of the same band goes through GDAL's conversion path.
  const asByte = asTypedArray(band.readAsSync('Uint8'), Uint8Array)
  assert.deepEqual(Array.from(asByte), [2, 0, 3, 5])

  dataset.close()
})

test('reads a sub-window and resamples', () => {
  const dataset = gdal.createSync(tmp('window.tif'), {
    driver: 'GTiff',
    width: 8,
    height: 8,
    bandCount: 1,
  })
  const band = dataset.band(0)
  band.writePixelsSync(bytesOf(ramp(8, 8)))

  // Row-major: (2,2), (3,2), (2,3), (3,3) are sample indexes 18, 19, 26, 27.
  assert.deepEqual(Array.from(band.readPixelsSync({ x: 2, y: 2, width: 2, height: 2 })), [
    18, 19, 26, 27,
  ])

  const downsampled = band.readPixelsSync({ outWidth: 4, outHeight: 4, resampling: 'average' })
  assert.equal(downsampled.length, 16)

  assert.throws(() => band.readPixelsSync({ x: 6, y: 0, width: 4, height: 1 }), /outside the band/)
  assert.throws(() => band.readPixelsSync({ resampling: 'not-a-kernel' }), /unknown resampling/)

  dataset.close()
})

test('geotransform, projection, no-data value and metadata round-trip', () => {
  const dataset = gdal.createSync(tmp('meta.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Int16',
  })

  assert.equal(dataset.geoTransform, null, 'a fresh dataset has no geotransform')
  dataset.band(0).setNoDataValue(-9999)
  assert.equal(dataset.band(0).noDataValue, -9999)

  dataset.setMetadataItem('AREA_OR_POINT', 'Area')
  dataset.setMetadataItem('MY_TAG', 'hello')
  assert.equal(dataset.metadata().MY_TAG, 'hello')
  assert.equal(dataset.metadata('').AREA_OR_POINT, 'Area')
  assert.ok(dataset.metadataDomains().includes(''))

  dataset.band(0).writePixelsSync(bytesOf(new Int16Array(16)))
  dataset.close()

  const reopened = gdal.openSync(tmp('meta.tif'))
  assert.equal(reopened.band(0).noDataValue, -9999)
  assert.equal(reopened.metadata().MY_TAG, 'hello')
  assert.equal(reopened.band(0).size.join('x'), '4x4')
  assert.ok(reopened.band(0).blockSize[0] > 0)
  assert.equal(typeof reopened.band(0).colorInterpretation, 'string')
  reopened.close()
})

test('a band reports its GDAL identity and access mode, and can be filled', () => {
  const path = tmp('band-identity.tif')
  const dataset = gdal.createSync(path, {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 2,
    dataType: 'Float32',
  })
  const band = dataset.band(0)

  // `id` is GDAL's 1-based band number; `index` is this API's 0-based one.
  assert.equal(band.index, 0)
  assert.equal(band.id, 1)
  assert.equal(dataset.band(1).id, 2)

  // A freshly created band has no format metadata yet.
  assert.equal(band.description, null)
  assert.equal(band.unitType, null)
  assert.equal(band.scale, null)
  assert.equal(band.offset, null)
  assert.deepEqual(band.categoryNames, [])

  // create() opens for update, so the band is writable.
  assert.equal(band.readOnly, false)

  // fill() writes one value everywhere without a buffer per sample.
  band.fill(7)
  assert.deepEqual(Array.from(asTypedArray(band.readPixelsSync(), Float32Array)), Array(16).fill(7))
  dataset.close()

  // Reopened read-only it says so, and so does a thread-safe handle.
  const readOnly = gdal.openSync(path)
  assert.equal(readOnly.band(0).readOnly, true)
  readOnly.close()

  const concurrent = gdal.openThreadSafeSync(path)
  assert.equal(concurrent.band(0).readOnly, true, 'a thread-safe dataset is read-only')
  concurrent.close()
})

test('minimum and maximum are GDAL caches that statistics() fills in', () => {
  const dataset = gdal.createSync(tmp('min-max.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Float32',
  })
  const band = dataset.band(0)
  band.writePixelsSync(bytesOf(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])))

  // Nothing has asked GDAL for a range, so it has none cached.
  assert.equal(band.minimum, null)
  assert.equal(band.maximum, null)

  const statistics = band.statisticsSync()
  assert.equal(band.minimum, statistics.min)
  assert.equal(band.maximum, statistics.max)
  dataset.close()
})

test('band scale, offset, unit, description and categories come from the format', () => {
  // A VRT carries band metadata that no gdal_translate flag can set, which makes
  // it the way to exercise the getters against real values.
  const path = tmp('band-metadata.vrt')
  writeFileSync(
    path,
    `<?xml version="1.0"?>
<VRTDataset rasterXSize="2" rasterYSize="2">
  <VRTRasterBand dataType="Byte" band="1">
    <Description>my band</Description>
    <UnitType>metre</UnitType>
    <Scale>2.5</Scale>
    <Offset>10</Offset>
    <CategoryNames>
      <Category>water</Category>
      <Category>land</Category>
    </CategoryNames>
  </VRTRasterBand>
</VRTDataset>
`,
  )

  const dataset = gdal.openSync(path)
  const band = dataset.band(0)
  assert.equal(dataset.driver, 'VRT')
  assert.equal(band.description, 'my band')
  assert.equal(band.unitType, 'metre')
  assert.equal(band.scale, 2.5)
  assert.equal(band.offset, 10)
  assert.deepEqual(band.categoryNames, ['water', 'land'])
  dataset.close()
})

test('scale and offset written by gdal_translate read back off the band', () => {
  const source = tmp('scale-source.tif')
  const created = gdal.createSync(source, {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 1,
    dataType: 'Float32',
  })
  created.band(0).fill(1)
  created.close()

  const dest = tmp('scaled.tif')
  gdal.translateSync(dest, source, ['-a_scale', '2', '-a_offset', '10']).close()

  const reopened = gdal.openSync(dest)
  assert.equal(reopened.band(0).scale, 2)
  assert.equal(reopened.band(0).offset, 10)
  reopened.close()
})

test('the async API mirrors the sync API', async () => {
  const path = tmp('async.tif')
  const created = await gdal.create(path, { driver: 'GTiff', width: 4, height: 1, bandCount: 1 })
  const expected = ramp(4, 1)
  await created.band(0).writePixels(bytesOf(expected))
  await created.flush()
  created.close()

  const reopened = await gdal.open(path)
  assert.equal(reopened.width, 4)
  const got = await reopened.band(0).readPixels()
  assert.deepEqual(Array.from(got), Array.from(expected))
  reopened.close()
})

test('a closed dataset fails loudly instead of touching freed memory', () => {
  const dataset = gdal.createSync(tmp('closed.tif'), {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 1,
  })
  const band = dataset.band(0)
  dataset.close()
  dataset.close() // idempotent

  assert.throws(() => dataset.bandCount, (err) => err.code === 'GDAL_BAD_ARGUMENT')
  assert.throws(() => band.readPixelsSync(), (err) => err.code === 'GDAL_BAD_ARGUMENT')
  assert.doesNotThrow(() => dataset.close(), 'close is idempotent, not an error')
})
