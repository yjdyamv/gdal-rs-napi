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

  // This is the bundled build — the whole point of the package.
  assert.equal(gdal.bundled, true)
})

test('a band says whether it has arbitrary overviews', () => {
  const path = tmp('arbitrary-overviews.tif')
  const dataset = gdal.createSync(path, {
    driver: 'GTiff',
    width: 8,
    height: 8,
    bandCount: 1,
    dataType: 'Uint8',
  })
  // A plain file has fixed (here, no) overviews; the getter is the question a
  // network source answers `true` to, and it is a boolean either way.
  assert.equal(dataset.band(0).hasArbitraryOverviews, false)
  dataset.close()
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
  assert.equal(reopened.driver.name, 'netCDF')
  assert.equal(reopened.width, 8)
  assert.equal(reopened.height, 4)
  assert.deepEqual(Array.from(reopened.band(0).readPixelsSync()), Array.from(values))
  reopened.close()
})

test('diagnostics() finds the packaged CRS database', () => {
  const diagnostics = gdal.diagnostics()
  assert.equal(diagnostics.epsg4326Resolves, true, diagnostics.error ?? '')
  assert.equal(diagnostics.crsDatabaseFound, true)
  // GEOS is vendored and linked the way GDAL itself is, so the OGR predicates it
  // backs are part of the bundled build. `diagnostics()` and `features()` are the
  // two places that answer it, and they agree with GDAL's own BUILD_INFO.
  assert.equal(diagnostics.geosAvailable, true, 'the bundled build links GEOS')
  assert.equal(gdal.features().geos, diagnostics.geosAvailable)
})

test('bytesPerSample covers the sample types', () => {
  assert.equal(gdal.bytesPerSample('Uint8'), 1)
  assert.equal(gdal.bytesPerSample('Int16'), 2)
  assert.equal(gdal.bytesPerSample('Float32'), 4)
  assert.equal(gdal.bytesPerSample('Float64'), 8)
})

test('toDataType and fromDataType are each other inverse', () => {
  // GDAL's own numeric codes, for the corners that want them.
  assert.equal(gdal.toDataType('Byte'), 1)
  assert.equal(gdal.toDataType('Float32'), 6)
  assert.equal(gdal.fromDataType(6), 'Float32')
  assert.equal(gdal.fromDataType(0), 'Unknown')

  // `fromDataType` answers in *this* binding's spelling, so it matches `band.dataType`
  // and the pair round-trips: `1` is `Uint8` here where GDAL would say `Byte`.
  assert.equal(gdal.fromDataType(1), 'Uint8')
  assert.equal(gdal.fromDataType(4), 'Uint32')
  for (const name of ['Uint8', 'Int16', 'Uint32', 'Float64']) {
    assert.equal(gdal.fromDataType(gdal.toDataType(name)), name)
  }

  // GDAL's spellings are accepted on the way in too.
  assert.equal(gdal.toDataType('UInt32'), 4)

  // A name GDAL does not know is refused, not answered `Unknown`.
  assert.throws(() => gdal.toDataType('Nope'), /unknown data type name/)
})

test('creates a GTiff, writes it, and reads back identical bytes', () => {
  const path = tmp('roundtrip.tif')
  const expected = ramp(4, 4)

  const created = gdal.createSync(path, { driver: 'GTiff', width: 4, height: 4, bandCount: 1 })
  created.band(0).writePixelsSync(bytesOf(expected))
  created.close()

  const reopened = gdal.openSync(path)
  assert.equal(reopened.driver.name, 'GTiff')
  assert.equal(reopened.width, 4)
  assert.equal(reopened.height, 4)
  assert.equal(reopened.bandCount, 1)
  assert.equal(reopened.band(0).dataType, 'Uint8')
  assert.deepEqual(Array.from(reopened.band(0).readPixelsSync()), Array.from(expected))
  reopened.close()
})

test('a read can fill a buffer the caller owns, and hands that same one back', async () => {
  const path = tmp('into.tif')
  const expected = ramp(8, 8)
  const created = gdal.createSync(path, { driver: 'GTiff', width: 8, height: 8, bandCount: 1 })
  created.band(0).writePixelsSync(bytesOf(expected))
  created.close()

  const dataset = gdal.openSync(path)
  const band = dataset.band(0)

  // GDAL writes through the buffer, so it is filled in place — and what comes back is
  // that very object, not a fresh view of the same memory.
  const into = Buffer.alloc(64)
  assert.equal(band.readPixelsSync({ into }), into)
  assert.deepEqual(Array.from(into), Array.from(expected))

  // The same on the pool, and the memory is still the caller's afterwards.
  const threaded = Buffer.alloc(64)
  assert.equal(await band.readPixels({ into: threaded }), threaded)
  assert.deepEqual(Array.from(threaded), Array.from(expected))

  // A window fills exactly the window's worth…
  const window = Buffer.alloc(4)
  band.readPixelsSync({ x: 2, y: 3, width: 2, height: 2, into: window })
  const rows = [3, 4].flatMap((row) => [2, 3].map((column) => expected[row * 8 + column]))
  assert.deepEqual(Array.from(window), rows)

  // …and a resampled read fills the size of the *result*, not of the window.
  const shrunk = Buffer.alloc(4)
  band.readPixelsSync({ width: 4, height: 4, outWidth: 2, outHeight: 2, into: shrunk })
  assert.equal(shrunk.length, 4)

  // `readAs` writes its converted samples through the buffer too.
  const floats = Buffer.alloc(64 * 4)
  assert.equal(band.readAsSync('Float32', { into: floats }), floats)

  dataset.close()
})

test('a destination of the wrong size is refused, on both paths', async () => {
  const path = tmp('into-size.tif')
  const created = gdal.createSync(path, { driver: 'GTiff', width: 8, height: 8, bandCount: 1 })
  created.close()

  const dataset = gdal.openSync(path)
  const band = dataset.band(0)

  assert.throws(() => band.readPixelsSync({ into: Buffer.alloc(63) }), /holds 63 bytes/)
  await assert.rejects(band.readPixels({ into: Buffer.alloc(63) }), /holds 63 bytes/)

  // `into` describes a read. A write takes its data as an argument, and says so
  // rather than quietly ignoring the buffer it was handed.
  assert.throws(
    () => band.writePixelsSync(Buffer.alloc(64), { into: Buffer.alloc(64) }),
    /`into` is for reads/,
  )

  dataset.close()
})

test('two async reads may not fill the same buffer at once', async () => {
  const path = tmp('into-concurrent.tif')
  const expected = ramp(8, 8)
  const created = gdal.createSync(path, { driver: 'GTiff', width: 8, height: 8, bandCount: 1 })
  created.band(0).writePixelsSync(bytesOf(expected))
  created.close()

  const dataset = gdal.openSync(path)
  const band = dataset.band(0)
  const shared = Buffer.alloc(64)

  // The claim is taken by the call, so the second read is refused before either one
  // writes the memory.
  const first = band.readPixels({ into: shared })
  assert.throws(
    () => band.readPixels({ into: shared }),
    /already being filled by another read/,
  )

  assert.equal(await first, shared)
  assert.deepEqual(Array.from(shared), Array.from(expected))

  // Once the first has settled the buffer is free again, and reads reuse it as before.
  assert.equal(await band.readPixels({ into: shared }), shared)

  dataset.close()
})

test('MEM datasets need no file at all', () => {
  const dataset = gdal.createSync('', { driver: 'MEM', width: 3, height: 2, bandCount: 2 })
  assert.equal(dataset.driver.name, 'MEM')
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
  assert.equal(dataset.driver.name, 'VRT')
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

test('checksum fingerprints a window, and refuses the resampling knobs', () => {
  const dataset = gdal.createSync(tmp('checksum.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
  })
  const band = dataset.band(0)
  band.writePixelsSync(bytesOf(ramp(4, 4)))

  const whole = band.checksumSync()
  assert.equal(typeof whole, 'number')

  // The same samples in another file are the same fingerprint.
  const twin = gdal.createSync(tmp('checksum-twin.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
  })
  twin.band(0).writePixelsSync(bytesOf(ramp(4, 4)))
  assert.equal(twin.band(0).checksumSync(), whole)
  twin.close()

  // Change one sample and the fingerprint changes.
  band.writePixelsSync(bytesOf(Uint8Array.from([99, ...ramp(4, 4).slice(1)])))
  assert.notEqual(band.checksumSync(), whole)

  // A window checksums exactly those samples, so a band holding them agrees.
  band.writePixelsSync(bytesOf(ramp(4, 4)))
  const windowed = band.checksumSync({ x: 1, y: 1, width: 2, height: 2 })
  const sliced = gdal.createSync(tmp('checksum-window.tif'), {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 1,
  })
  // ramp(4, 4) read from (1,1) is 5, 6 / 9, 10.
  sliced.band(0).writePixelsSync(bytesOf(Uint8Array.from([5, 6, 9, 10])))
  assert.equal(sliced.band(0).checksumSync(), windowed)
  sliced.close()

  // A checksum is of the samples as they are, so resampling into it is refused.
  assert.throws(() => band.checksumSync({ outWidth: 2 }), /do not apply/)
  assert.throws(() => band.checksumSync({ resampling: 'average' }), /do not apply/)
  dataset.close()
})

test('fillNoData fills a hole from its neighbours, in place', () => {
  const dataset = gdal.createSync(tmp('fill.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Float32',
  })
  const band = dataset.band(0)
  band.setNoDataValue(-9999)

  const values = new Float32Array(16).fill(5)
  values[5] = -9999
  band.writePixelsSync(bytesOf(values))

  band.fillNoDataSync()
  const filled = Array.from(asTypedArray(band.readPixelsSync(), Float32Array))
  // Interpolation between equal neighbours gives that value back; allow for the
  // last bit or two of a float.
  assert.ok(
    filled.every((value) => Math.abs(value - 5) < 1e-6),
    `every sample should be near 5, got ${filled}`,
  )
  dataset.close()

  // Without a no-data value there is nothing to fill, and that is said plainly
  // rather than left to GDAL.
  const noHole = gdal.createSync(tmp('fill-nodata.tif'), {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 1,
  })
  assert.throws(() => noHole.band(0).fillNoDataSync(), (err) => err.code === 'GDAL_BAD_ARGUMENT')
  assert.throws(() => noHole.band(0).fillNoDataSync({ maxDistance: 0 }), /positive number of pixels/)
  noHole.close()
})

test('sieveFilter drops regions below the threshold', () => {
  const dataset = gdal.createSync(tmp('sieve.tif'), {
    driver: 'GTiff',
    width: 8,
    height: 8,
    bandCount: 1,
  })
  const band = dataset.band(0)

  const values = new Uint8Array(64).fill(1)
  values[8 * 3 + 3] = 7
  band.writePixelsSync(bytesOf(values))

  band.sieveFilterSync({ threshold: 5 })
  assert.equal(Array.from(band.readPixelsSync())[8 * 3 + 3], 1, 'a lone pixel is below the threshold')

  // The same region survives a threshold of one.
  band.writePixelsSync(bytesOf(values))
  band.sieveFilterSync({ threshold: 1, connectedness: 8 })
  assert.equal(Array.from(band.readPixelsSync())[8 * 3 + 3], 7)

  assert.throws(() => band.sieveFilterSync({ threshold: 0 }), /remove nothing/)
  assert.throws(() => band.sieveFilterSync({ threshold: 4, connectedness: 5 }), /4 or 8/)
  dataset.close()
})

test('rasterize burns GeoJSON into a band, in the raster own coordinates', () => {
  const dataset = gdal.createSync(tmp('rasterize.tif'), {
    driver: 'GTiff',
    width: 8,
    height: 8,
    bandCount: 2,
    dataType: 'Float32',
  })

  // With no geotransform, geometry speaks pixel coordinates, so a ring over
  // pixels 2..6 lands there — no reprojection happens, on purpose.
  const square = { type: 'Polygon', coordinates: [[[2, 2], [6, 2], [6, 6], [2, 6], [2, 2]]] }
  dataset.rasterizeSync([square], { burnValues: [1] })

  const samples = (index) =>
    Array.from(asTypedArray(dataset.band(index).readPixelsSync(), Float32Array))
  assert.equal(samples(0)[2 * 8 + 2], 1, 'inside the ring')
  assert.equal(samples(0)[5 * 8 + 5], 1, 'still inside it')
  assert.equal(samples(0)[0], 0, 'outside the ring')
  assert.equal(samples(0)[7 * 8 + 7], 0)

  // The second band is only touched when it is named.
  assert.deepEqual(samples(1), Array(64).fill(0))

  // `MERGE_ALG` is GDAL's own option name, passed through as written.
  dataset.rasterizeSync([square], { burnValues: [1], options: { MERGE_ALG: 'ADD' } })
  assert.equal(samples(0)[2 * 8 + 2], 2)

  // The burn values are positional, so a short list is a mistake rather than
  // something to pad.
  assert.throws(
    () => dataset.rasterizeSync([square, square], { burnValues: [1] }),
    /burn value per geometry/,
  )
  dataset.close()
})

test('rasterize runs on the pool too', async () => {
  const dataset = await gdal.create(tmp('rasterize-async.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Float32',
  })

  await dataset.rasterize([{ type: 'Point', coordinates: [1.5, 1.5] }], { burnValues: [9] })
  const samples = Array.from(asTypedArray(dataset.band(0).readPixelsSync(), Float32Array))
  assert.equal(samples[1 * 4 + 1], 9, 'the pixel the point falls in')
  assert.equal(samples[0], 0)
  dataset.close()
})

test('polygonize turns band values into layer polygons', () => {
  const raster = gdal.createSync(tmp('polygonize.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
  })
  const values = new Uint8Array(16).fill(1)
  values[0] = 2
  values[1] = 2
  values[4] = 2 // a 2x2 block of 2s in the corner, the rest one region of 1s
  raster.band(0).writePixelsSync(bytesOf(values))

  const vector = gdal.createVectorSync(tmp('polygonize.gpkg'), 'GPKG')
  const layer = vector.createLayer({ name: 'values', geometryType: 'Polygon', epsg: 4326 })

  raster.band(0).polygonizeSync(layer)

  const features = layer.featuresSync()
  assert.equal(features.length, 2, 'one polygon per connected region of equal value')
  assert.deepEqual(
    features.map((feature) => feature.properties.DN).sort(),
    [1, 2],
  )
  for (const feature of features) assert.equal(feature.geometry.type, 'Polygon')

  // The 2s are the corner block, and the raster has no geotransform, so the ring
  // is in pixel coordinates.
  const ring = features.find((feature) => feature.properties.DN === 2).geometry.coordinates[0]
  const xs = ring.map(([x]) => x)
  const ys = ring.map(([, y]) => y)
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 2])
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [0, 2])

  vector.close()
  raster.close()
})

test('polygonize runs on the pool, and names its field', async () => {
  const raster = gdal.createSync(tmp('polygonize-async.tif'), {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 1,
    dataType: 'Float32',
  })
  raster.band(0).writePixelsSync(bytesOf(new Float32Array([1.5, 1.5, 1.5, 1.5])))

  const vector = gdal.createVectorSync(tmp('polygonize-async.gpkg'), 'GPKG')
  const layer = vector.createLayer({ name: 'values', geometryType: 'Polygon', epsg: 4326 })

  await raster.band(0).polygonize(layer, { fieldName: 'value', connectedness: 8 })

  const features = layer.featuresSync()
  assert.equal(features.length, 1)
  // A float band needs a Real field, or the value would be truncated away.
  assert.equal(features[0].properties.value, 1.5)

  vector.close()
  raster.close()
})

test('contourGenerate draws a line per level', () => {
  const raster = gdal.createSync(tmp('contour.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Float32',
  })
  // One value per row — 0, 10, 20, 30 — so the contour at 15 runs between the
  // second and third rows. GDAL interpolates between pixel *centres*, which sit at
  // y = 1.5 and y = 2.5, so the line is at y = 2.
  const values = new Float32Array(16)
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) values[y * 4 + x] = y * 10
  raster.band(0).writePixelsSync(bytesOf(values))

  const vector = gdal.createVectorSync(tmp('contour.gpkg'), 'GPKG')
  const layer = vector.createLayer({
    name: 'contours',
    geometryType: 'LineString',
    epsg: 4326,
  })

  raster.band(0).contourGenerateSync(layer, { levels: [15] })

  const features = layer.featuresSync()
  assert.equal(features.length, 1)
  assert.equal(features[0].properties.ELEV, 15, 'the elevation field is created and filled')
  assert.equal(features[0].geometry.type, 'LineString')
  const ys = features[0].geometry.coordinates.map(([, y]) => y)
  assert.ok(
    ys.every((y) => Math.abs(y - 2) < 1e-6),
    `the line should sit between the two rows, got ${ys}`,
  )

  // Levels or an interval, not both and not neither.
  assert.throws(() => raster.band(0).contourGenerateSync(layer, {}), /levels or an interval/)
  assert.throws(
    () => raster.band(0).contourGenerateSync(layer, { levels: [1], interval: 1 }),
    /not both/,
  )

  vector.close()
  raster.close()
})

test('contourGenerate takes an interval and an id field', async () => {
  const raster = gdal.createSync(tmp('contour-interval.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Float32',
  })
  const values = new Float32Array(16)
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) values[y * 4 + x] = y * 10
  raster.band(0).writePixelsSync(bytesOf(values))

  const vector = gdal.createVectorSync(tmp('contour-interval.gpkg'), 'GPKG')
  const layer = vector.createLayer({
    name: 'contours',
    geometryType: 'LineString',
    epsg: 4326,
  })

  // Every 20 from 5: the 5 lands between rows 0 and 1, the 25 between rows 2 and 3.
  await raster.band(0).contourGenerate(layer, { interval: 20, base: 5, idField: 'id' })

  const features = layer.featuresSync()
  assert.equal(features.length, 2)
  assert.deepEqual(
    features.map((feature) => feature.properties.ELEV).sort((a, b) => a - b),
    [5, 25],
  )
  assert.deepEqual(
    features.map((feature) => feature.properties.id).sort((a, b) => a - b),
    [0, 1],
    'an id field is created and filled when one is asked for',
  )

  vector.close()
  raster.close()
})

test('readChunksSync walks a band in strips, and the answer stops it', () => {
  const path = tmp('chunks.tif')
  const dataset = gdal.createSync(path, {
    driver: 'GTiff',
    width: 4,
    height: 6,
    bandCount: 1,
    dataType: 'Uint8',
  })
  const band = dataset.band(0)
  band.writeValues(0, 0, 4, 6, bytesOf(ramp(4, 6)))

  // Every strip arrives whole, in the band's own type, and says where it is.
  const seen = []
  const count = band.readChunksSync({ rows: 2 }, (chunk) => {
    seen.push([chunk.y, chunk.height, chunk.width, chunk.data[0]])
    return true
  })
  assert.equal(count, 3)
  assert.deepEqual(seen, [
    [0, 2, 4, 0],
    [2, 2, 4, 8],
    [4, 2, 4, 16],
  ])

  // The answer is the backpressure: `false` ends the walk, and the count says how
  // far it got.
  assert.equal(
    band.readChunksSync({ rows: 1 }, () => false),
    1,
  )

  // A window narrows it, and the strips are that window's columns.
  const windowed = []
  band.readChunksSync({ x: 1, y: 1, width: 2, height: 3, rows: 1 }, (chunk) => {
    windowed.push(Array.from(chunk.data))
    return true
  })
  assert.deepEqual(windowed, [
    [5, 6],
    [9, 10],
    [13, 14],
  ])

  // A window that does not fit fails on the call, before any strip is read.
  assert.throws(() => band.readChunksSync({ x: 3, width: 4 }, () => true), /falls outside the band/i)

  dataset.close()
})

test('readChunks is the same walk off the event loop, and the same backpressure', async () => {
  const path = tmp('chunks-async.tif')
  const dataset = gdal.createSync(path, {
    driver: 'GTiff',
    width: 4,
    height: 6,
    bandCount: 1,
    dataType: 'Uint8',
  })
  const band = dataset.band(0)
  band.writeValues(0, 0, 4, 6, bytesOf(ramp(4, 6)))

  // The strips the sync walk would hand over, read on the thread pool instead.
  const seen = []
  const count = await band.readChunks({ rows: 2 }, (chunk) => {
    seen.push([chunk.y, chunk.height, chunk.width, Array.from(chunk.data)])
    return true
  })
  assert.equal(count, 3)
  assert.deepEqual(seen, [
    [0, 2, 4, [0, 1, 2, 3, 4, 5, 6, 7]],
    [2, 2, 4, [8, 9, 10, 11, 12, 13, 14, 15]],
    [4, 2, 4, [16, 17, 18, 19, 20, 21, 22, 23]],
  ])

  // The answer is the backpressure here too: `false` ends the walk.
  assert.equal(await band.readChunks({ rows: 1 }, () => false), 1)

  // A window that does not fit fails, and on the async side that is a rejection.
  await assert.rejects(band.readChunks({ x: 3, width: 4 }, () => true), /falls outside the band/i)

  dataset.close()
})

test('a band lists its overview levels, and each one reads whole', async () => {
  const path = tmp('overview-levels.tif')
  const dataset = gdal.createSync(path, {
    driver: 'GTiff',
    width: 16,
    height: 16,
    bandCount: 1,
    dataType: 'Uint8',
  })
  const band = dataset.band(0)
  band.fill(3)

  // Nothing is there until something builds it.
  assert.deepEqual(band.overviews, [])

  dataset.buildOverviewsSync({ levels: [2, 4] })

  // The getter asks GDAL, so it sees levels that were built after the band object
  // was made.
  const levels = band.overviews
  assert.deepEqual(
    levels.map((level) => level.size),
    [
      [8, 8],
      [4, 4],
    ],
  )
  assert.deepEqual(
    levels.map((level) => level.index),
    [0, 1],
  )
  assert.equal(levels[0].dataType, 'Uint8')

  // A level reads at its own size, in its own type: the stored decimation rather
  // than a fresh resampling.
  const values = Uint8Array.from(levels[1].readSync())
  assert.equal(values.length, 4 * 4)
  assert.ok(values.every((value) => value === 3))

  const asynchronously = Uint8Array.from(await levels[0].read())
  assert.equal(asynchronously.length, 8 * 8)

  dataset.close()
})

test('the pixel accessors take single samples, windows and blocks', () => {
  const path = tmp('pixel-accessors.tif')
  const dataset = gdal.createSync(path, {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Int16',
  })
  const band = dataset.band(0)

  // One sample in and out, in the band's own type.
  band.setPixel(1, 2, -300)
  assert.equal(band.getPixel(1, 2), -300)
  assert.equal(band.getPixel(0, 0), 0) // never written

  // A window is the options object `readPixelsSync` takes, spelled as four
  // numbers, and it is the same bytes either way.
  const window = { x: 0, y: 0, width: 2, height: 2 }
  band.writeValues(0, 0, 2, 2, bytesOf(Int16Array.from([1, 2, 3, 4])))
  assert.deepEqual(band.readValues(0, 0, 2, 2), band.readPixelsSync(window))
  assert.deepEqual(Array.from(asTypedArray(band.readValues(0, 0, 2, 2), Int16Array)), [1, 2, 3, 4])
  assert.equal(band.getPixel(1, 0), 2)

  // Blocks are GDAL's own unit of I/O. At the origin the block is whole, so it is
  // exactly the window of `blockSize`; away from it the result is the block's
  // rectangle clipped to the band, so its length is a whole number of rows.
  const [blockWidth, blockHeight] = band.blockSize
  assert.ok(blockWidth > 0 && blockHeight > 0)
  assert.deepEqual(band.readBlock(0, 0), band.readValues(0, 0, blockWidth, blockHeight))
  assert.equal(band.readBlock(3, 3).length % (2 * blockWidth), 0)

  // Writing a block is that same rectangle, and the values come back as they went
  // in.
  band.writeBlock(0, 0, bytesOf(new Int16Array(blockWidth * blockHeight).fill(7)))
  assert.equal(band.getPixel(0, 0), 7)
  assert.equal(band.getPixel(1, 1), 7)

  // A window off the edge of the band is an error rather than a quiet zero, and
  // the message names the window that did not fit.
  assert.throws(() => band.getPixel(4, 0), /falls outside the band/i)

  dataset.close()
})

test('buildVrt wraps rasters without copying them', async () => {
  const first = tmp('vrt-a.tif')
  const second = tmp('vrt-b.tif')
  for (const [path, value] of [
    [first, 1],
    [second, 2],
  ]) {
    const dataset = gdal.createSync(path, { driver: 'GTiff', width: 2, height: 2, bandCount: 1 })
    // `GDALBuildVRT` refuses ungeoreferenced inputs, so both get one footprint.
    dataset.setGeoTransform([0, 1, 0, 0, 0, -1])
    dataset.setProjection(gdal.epsgToWkt(4326))
    dataset.band(0).fill(value)
    dataset.close()
  }

  // `-separate` gives each source its own band, which is the predictable shape.
  const path = tmp('merged.vrt')
  const built = gdal.buildVrtSync(path, [first, second], ['-separate'])
  assert.equal(built.driver.name, 'VRT')
  assert.equal(built.bandCount, 2)
  assert.equal(built.band(0).readPixelsSync()[0], 1)
  assert.equal(built.band(1).readPixelsSync()[0], 2)
  built.close()

  // A VRT describes the sources rather than holding a copy of them.
  const reopened = gdal.openSync(path)
  assert.equal(reopened.driver.name, 'VRT')
  assert.equal(reopened.bandCount, 2)
  reopened.close()

  // An empty destination is an in-memory VRT, and the async form agrees.
  const memory = await gdal.buildVrt('', [first])
  assert.equal(memory.driver.name, 'VRT')
  memory.close()

  assert.throws(() => gdal.buildVrtSync(path, []), /at least one source/)
})

test('suggestedWarpOutput says what a warp would produce, and reprojectImage does it', async () => {
  // A small raster in degrees, so warping it to metres is a real change of CRS.
  const source = gdal.createSync(tmp('warp-src.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Float32',
  })
  source.setGeoTransform([10, 0.1, 0, 50, 0, -0.1])
  source.setProjection(gdal.epsgToWkt(4326))
  source.band(0).fill(7)

  const webMercator = gdal.epsgToWkt(3857)
  const suggested = source.suggestedWarpOutputSync({ dstWkt: webMercator })

  assert.equal(suggested.geoTransform.length, 6)
  assert.ok(suggested.width > 0 && suggested.height > 0)
  // The extent is in metres now, and 10°E is about 1.11 million of them.
  assert.ok(
    Math.abs(suggested.extent[0] - 10 * 111319.49) < 1000,
    `the extent should be in Web Mercator metres, got ${suggested.extent}`,
  )
  // The pool answers the same as the call does.
  assert.deepEqual(await source.suggestedWarpOutput({ dstWkt: webMercator }), suggested)

  // Now warp into a destination that is the size the suggestion asked for.
  const dest = gdal.createSync(tmp('warp-dst.tif'), {
    driver: 'GTiff',
    width: suggested.width,
    height: suggested.height,
    bandCount: 1,
    dataType: 'Float32',
  })
  dest.setGeoTransform(suggested.geoTransform)
  dest.setProjection(webMercator)

  source.reprojectImageSync(dest, { dstWkt: webMercator })

  const samples = Array.from(asTypedArray(dest.band(0).readPixelsSync(), Float32Array))
  assert.equal(samples.length, suggested.width * suggested.height)
  // The source is one value everywhere, so most of the destination is that value.
  // The corners of the suggested box fall outside the warped quad, and those stay
  // at the driver's default.
  const filled = samples.filter((value) => Math.abs(value - 7) < 1e-3).length
  assert.ok(filled > samples.length / 2, `only ${filled} of ${samples.length} samples came through`)

  // `gauss` is a RasterIO kernel, and reprojection does not take it.
  assert.throws(() => source.reprojectImageSync(dest, { resampling: 'gauss' }), /unknown resampling/)

  // Two datasets are taken at once, and their per-dataset mutexes are not
  // reentrant: passing one handle twice has to be refused, not deadlock the process
  // while holding the exclusive GDAL lock.
  assert.throws(() => source.reprojectImageSync(source), /both handles name the same one/)

  dest.close()
  source.close()
})

test('the async twins of the band tools do the same thing', async () => {
  const dataset = await gdal.create(tmp('async-tools.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Float32',
  })
  const band = dataset.band(0)
  band.setNoDataValue(-9999)

  const values = new Float32Array(16).fill(2)
  values[10] = -9999
  await band.writePixels(bytesOf(values))

  assert.equal(await band.checksum(), band.checksumSync())

  await band.fillNoData()
  const filled = Array.from(asTypedArray(band.readPixelsSync(), Float32Array))
  assert.ok(filled.every((value) => Math.abs(value - 2) < 1e-6), `got ${filled}`)

  // A sieve on a band that is all one value has nothing to remove, which is the
  // point: it runs, and leaves the data alone.
  await band.sieveFilter({ threshold: 2 })
  const sieved = Array.from(asTypedArray(band.readPixelsSync(), Float32Array))
  assert.ok(
    sieved.every((value) => Math.abs(value - 2) < 1e-6),
    `the sieve should have left the band alone, got ${sieved}`,
  )

  dataset.close()
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

test('asType converts a band into an independent in-memory band', () => {
  const path = tmp('as-type.tif')
  const dataset = gdal.createSync(path, {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Uint8',
  })
  const band = dataset.band(0)
  band.fill(7)

  const asFloat = band.asType('Float32')
  assert.equal(asFloat.dataType, 'Float32')
  assert.equal(asFloat.getPixel(0, 0), 7)

  // A mask band has no translated counterpart.
  assert.throws(() => band.mask.asType('Float32'), /not on a mask/)

  // The conversion is materialised, so the result is independent of the source:
  // closing the source leaves it readable, which a VRT-backed band could not
  // promise (it shares the source handle and would dangle).
  dataset.close()
  assert.equal(asFloat.getPixel(0, 0), 7)
})

test('the band arithmetic is elementwise, eager and independent', () => {
  const make = (values) => {
    const dataset = gdal.createSync('', {
      driver: 'MEM',
      width: 2,
      height: 2,
      bandCount: 1,
      dataType: 'Uint8',
    })
    dataset.band(0).writeValues(0, 0, 2, 2, bytesOf(Uint8Array.from(values)))
    return dataset
  }
  const a = make([1, 2, 3, 4])
  const b = make([10, 20, 30, 40])

  // Arithmetic comes back as Float64; the other operand may be a band or a number.
  const sum = a.band(0).add(b.band(0))
  assert.equal(sum.dataType, 'Float64')
  assert.deepEqual(
    [sum.getPixel(0, 0), sum.getPixel(1, 0), sum.getPixel(0, 1), sum.getPixel(1, 1)],
    [11, 22, 33, 44],
  )
  assert.equal(a.band(0).add(5).getPixel(0, 0), 6)
  assert.equal(a.band(0).mul(2).getPixel(1, 1), 8)

  // Comparisons and logic come back as a Uint8 mask of 0s and 1s.
  const over = a.band(0).gt(2)
  assert.equal(over.dataType, 'Uint8')
  assert.deepEqual(
    [over.getPixel(0, 0), over.getPixel(1, 0), over.getPixel(0, 1), over.getPixel(1, 1)],
    [0, 0, 1, 1],
  )
  assert.equal(a.band(0).eq(b.band(0)).getPixel(0, 0), 0)
  assert.equal(a.band(0).and(b.band(0)).getPixel(0, 0), 1)
  assert.equal(a.band(0).not().getPixel(0, 0), 0)

  // `ifThenElse` is the ternary operator, elementwise.
  const picked = over.ifThenElse(a.band(0), 0)
  assert.deepEqual(
    [picked.getPixel(0, 0), picked.getPixel(1, 0), picked.getPixel(0, 1), picked.getPixel(1, 1)],
    [0, 0, 3, 4],
  )

  // Two bands of different sizes are refused.
  const wrong = gdal.createSync('', {
    driver: 'MEM',
    width: 3,
    height: 1,
    bandCount: 1,
    dataType: 'Uint8',
  })
  assert.throws(() => a.band(0).add(wrong.band(0)), /same size/)

  // The result is materialised, so it outlives the bands it came from.
  a.close()
  b.close()
  wrong.close()
  assert.equal(sum.getPixel(0, 0), 11)
  assert.equal(picked.getPixel(1, 1), 4)
})

test('a band and a layer flush below the dataset, both ways', async () => {
  const path = tmp('flush.tif')
  const raster = gdal.createSync(path, {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Uint8',
  })
  const band = raster.band(0)
  band.fill(5)
  band.flushSync()
  await band.flush()
  raster.close()

  const vector = gdal.createVectorSync(tmp('flush.gpkg'), 'GPKG')
  const layer = vector.createLayer({ name: 'things', geometryType: 'Point', epsg: 4326 })
  layer.createFeature({ type: 'Point', coordinates: [1, 2] }, { n: 1 })
  layer.flushSync()
  await layer.flush()
  vector.close()
})
