// @ts-nocheck
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'vitest'

import { bytesOf, gdal, ramp, tmp } from '../helpers.js'

/** A single-band GTiff holding a known ramp, so every assertion has a fixed answer. */
function fixture(path, width, height) {
  const dataset = gdal.createSync(path, { driver: 'GTiff', width, height, bandCount: 1 })
  dataset.band(0).writePixelsSync(bytesOf(ramp(width, height)))
  dataset.close()
}

/** What a single-band ramp raster should read back as for `window`. */
function rampWindow(width, height, window) {
  const source = ramp(width, height)
  const values = []
  for (let row = 0; row < window.height; row += 1) {
    const start = (window.y + row) * width + window.x
    values.push(...source.slice(start, start + window.width))
  }
  return values
}

test('openThreadSafe reads the same pixels as open, and reports itself', async () => {
  const path = tmp('threadsafe.tif')
  const expected = ramp(32, 32)
  fixture(path, 32, 32)

  const serial = gdal.openSync(path)
  assert.equal(serial.threadSafe, false, 'open() must not claim to be thread-safe')

  const concurrent = gdal.openThreadSafeSync(path)
  assert.equal(concurrent.threadSafe, true)
  assert.equal(concurrent.driver.name, 'GTiff')
  assert.equal(concurrent.width, 32)
  assert.equal(concurrent.height, 32)
  assert.deepEqual(Array.from(concurrent.band(0).readPixelsSync()), Array.from(expected))

  const opened = await gdal.openThreadSafe(path)
  assert.equal(opened.threadSafe, true)
  assert.deepEqual(Array.from(opened.band(0).readPixelsSync()), Array.from(expected))

  // Metadata still works; only the access path differs.
  assert.equal(concurrent.band(0).dataType, 'Uint8')
  assert.deepEqual(concurrent.band(0).size, [32, 32])

  opened.close()
  concurrent.close()
  serial.close()
})

test('concurrent reads of one band agree with sequential reads', async () => {
  const width = 64
  const height = 64
  const path = tmp('tiles.tif')
  fixture(path, width, height)

  const dataset = gdal.openThreadSafeSync(path)
  const band = dataset.band(0)

  const windows = []
  for (let y = 0; y < height; y += 16) {
    for (let x = 0; x < width; x += 16) {
      windows.push({ x, y, width: 16, height: 16 })
    }
  }

  // All sixteen at once. On a thread-safe dataset these run in parallel rather
  // than queueing behind the process-wide lock, and the point of the test is
  // that they still produce exactly what a single read would.
  const buffers = await Promise.all(windows.map((window) => band.readPixels(window)))

  for (const [index, window] of windows.entries()) {
    assert.deepEqual(
      Array.from(buffers[index]),
      rampWindow(width, height, window),
      `window ${index} at ${window.x},${window.y}`,
    )
  }

  // Interleaved with reads that take the write lock, to catch a lock-ordering
  // mistake: metadata is answered under the exclusive lock.
  assert.equal(dataset.bandCount, 1)
  assert.deepEqual(Array.from(band.readPixelsSync()), Array.from(ramp(width, height)))

  dataset.close()
})

test('a thread-safe dataset refuses every write', () => {
  const path = tmp('readonly.tif')
  fixture(path, 8, 8)

  const dataset = gdal.openThreadSafeSync(path)
  const band = dataset.band(0)

  const attempts = {
    writePixelsSync: () => band.writePixelsSync(bytesOf(ramp(8, 8))),
    setNoDataValue: () => band.setNoDataValue(0),
    setProjection: () => dataset.setProjection(gdal.epsgToWkt(4326)),
    setGeoTransform: () => dataset.setGeoTransform([0, 1, 0, 8, 0, -1]),
    setMetadataItem: () => dataset.setMetadataItem('key', 'value'),
    flushSync: () => dataset.flushSync(),
  }

  for (const [label, attempt] of Object.entries(attempts)) {
    assert.throws(
      attempt,
      (error) => {
        assert.equal(error.code, 'GDAL_BAD_ARGUMENT', `${label}: unexpected code`)
        assert.match(error.message, /read-only/, `${label}: ${error.message}`)
        return true
      },
      `${label} should have been refused`,
    )
  }

  dataset.close()
})

test('a thread-safe dataset has no vector layers', () => {
  const path = tmp('no-layers.tif')
  fixture(path, 8, 8)

  const dataset = gdal.openThreadSafeSync(path)

  for (const [label, attempt] of Object.entries({
    layerCount: () => dataset.layerCount,
    layer: () => dataset.layer(0),
    layerByName: () => dataset.layerByName('anything'),
    layers: () => dataset.layers(),
    createLayer: () => dataset.createLayer({ name: 'anything' }),
  })) {
    assert.throws(
      attempt,
      (error) => {
        assert.equal(error.code, 'GDAL_BAD_ARGUMENT', `${label}: unexpected code`)
        assert.match(error.message, /no vector layers/, `${label}: ${error.message}`)
        return true
      },
      `${label} should have been refused`,
    )
  }

  dataset.close()
})

test('close() invalidates a thread-safe dataset, like the serialised one', () => {
  const path = tmp('closes.tif')
  fixture(path, 8, 8)

  const dataset = gdal.openThreadSafeSync(path)
  const band = dataset.band(0)
  assert.deepEqual(Array.from(band.readPixelsSync()), Array.from(ramp(8, 8)))

  dataset.close()
  // Bands hold their own reference to the underlying handle, so without the
  // closed flag this read would quietly keep working.
  assert.throws(() => band.readPixelsSync(), /the dataset is closed/)
  assert.throws(() => dataset.width, /the dataset is closed/)
})

test('dataset-free work runs together and still answers the same', async () => {
  // None of this touches a dataset, so it takes the shared side of the GDAL lock and
  // really does overlap. What is being checked here is that sharing it changes
  // nothing it computes — the concurrency itself is what scripts/bench-parallel.mjs
  // measures. (The lock's exclusive side would serialise these; either way the
  // answers have to match, and a race would show up as a wrong one.)
  const transform = new gdal.CoordinateTransform(
    gdal.SpatialRef.fromEpsg(4326),
    gdal.SpatialRef.fromEpsg(3857),
  )
  const points = Float64Array.from({ length: 2000 }, (_, index) => (index % 2 === 0 ? 13.4 : 52.5))
  const expected = transform.transformPointsSync(points)

  const answers = await Promise.all(Array.from({ length: 8 }, () => transform.transformPoints(points)))
  for (const answer of answers) assert.deepEqual(answer, expected)

  // `identifyEpsg` is on the same side of the lock — it reads the CRS database and
  // nothing else — so it runs with the transforms above rather than behind them.
  const wkt = gdal.SpatialRef.fromEpsg(4326).wkt
  const found = await Promise.all(
    Array.from({ length: 4 }, () => gdal.identifyEpsg(wkt)),
  )
  for (const authority of found) assert.equal(authority, 'EPSG:4326')
})

test('the module-level surface is dataset-free too', async () => {
  // `version` / `info` / `diagnostics` / `lastError` / `epsgToWkt`, the driver-registry
  // reads and the `geometry*` helpers touch no dataset, so they take the same shared
  // side of the lock as the transforms below. A test cannot see which side a call
  // took; what it can see is that asking the whole surface *while* the transforms are
  // in flight neither hangs nor changes an answer, and a lock-ordering mistake lands
  // as exactly one of those two. The overlap itself is what scripts/bench-parallel.mjs
  // measures.
  const geometry = { type: 'Point', coordinates: [1, 2] }
  const surface = () => {
    const gtiff = gdal.driver('GTiff')
    return {
      gdal: gdal.version().gdal,
      proj: gdal.version().proj,
      driverCount: gdal.info().driverCount,
      drivers: gdal.drivers().length,
      longName: gtiff.longName,
      mimetype: gtiff.metadata()['DMD_MIMETYPE'],
      extension: gtiff.fileExtensions[0],
      wkt: gdal.epsgToWkt(4326).slice(0, 15),
      geometryWkt: gdal.geometryToWkt(geometry),
      geometryType: gdal.geometryTypeOf(geometry),
      // A name nothing registered answers `null` rather than throwing, which is the
      // lookup contract `gdal.driver()` documents.
      unknownDriver: gdal.driver('NoSuchDriverHere'),
      crsDatabase: gdal.diagnostics().crsDatabaseFound,
      lastError: gdal.lastError(),
    }
  }

  // Warmed first: GDAL answers a couple of these from a one-time lookup, and the
  // claim is that the repeat agrees, not that it is cheap.
  surface()
  const expected = surface()
  assert.equal(expected.geometryType, 'Point')
  assert.equal(expected.unknownDriver, null)
  assert.equal(expected.crsDatabase, true)

  const transform = new gdal.CoordinateTransform(
    gdal.SpatialRef.fromEpsg(4326),
    gdal.SpatialRef.fromEpsg(3857),
  )
  const points = Float64Array.from({ length: 20_000 }, (_, index) => (index % 2 === 0 ? 13.4 : 52.5))

  const during = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const answers = surface()
      await transform.transformPoints(points)
      return answers
    }),
  )
  for (const answers of during) assert.deepEqual(answers, expected)
})

test('the read-only accessors answer the same on a thread-safe dataset', async () => {
  const path = tmp('threadsafe-accessors.tif')
  fixture(path, 32, 32)

  const serial = gdal.openSync(path)
  const dataset = gdal.openThreadSafeSync(path)
  const serialBand = serial.band(0)
  const band = dataset.band(0)

  // Each of these only looks at what the dataset already knows, so on a thread-safe
  // dataset it takes the shared side of the lock and runs *alongside* pixel reads
  // rather than behind them. What a test can pin is that the answers still agree —
  // the concurrency itself is what scripts/bench-parallel.mjs measures.
  assert.equal(dataset.width, serial.width)
  assert.equal(dataset.height, serial.height)
  assert.deepEqual(dataset.rasterSize, serial.rasterSize)
  assert.equal(dataset.bandCount, serial.bandCount)
  assert.equal(dataset.description, serial.description)
  assert.equal(dataset.driver.name, serial.driver.name)
  assert.deepEqual(dataset.geoTransform, serial.geoTransform)
  assert.equal(dataset.projection, serial.projection)
  assert.deepEqual(dataset.getFileList(), serial.getFileList())

  assert.deepEqual(band.size, serialBand.size)
  assert.deepEqual(band.blockSize, serialBand.blockSize)
  assert.equal(band.id, serialBand.id)
  assert.equal(band.colorInterpretation, serialBand.colorInterpretation)
  assert.equal(band.readOnly, true)
  assert.equal(band.noDataValue, serialBand.noDataValue)
  assert.equal(band.overviewCount, serialBand.overviewCount)

  // A checksum walks the samples without keeping them, so it moved to the same side
  // as the reads it is made of — and the two forms agree.
  assert.equal(await band.checksum(), band.checksumSync())

  // A pixel read still behaves with all of the above going on.
  assert.deepEqual(Array.from(band.readPixelsSync()), Array.from(ramp(32, 32)))

  serial.close()
  dataset.close()
})

test('openThreadSafe rejects something that is not a read-only raster', () => {
  // A vector file cannot be opened with the raster-only flags openThreadSafe
  // needs, so it fails rather than quietly handing back a serialised dataset.
  const path = tmp('points.geojson')
  writeFileSync(
    path,
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [1, 2] },
          properties: { name: 'a point' },
        },
      ],
    }),
  )

  assert.throws(() => gdal.openThreadSafeSync(path))
})
