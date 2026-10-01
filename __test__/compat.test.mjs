// The compatibility layer: the same binding wearing `gdal-async`'s conventions.
//
// Every test here is written the way a `gdal-async` program is written — 1-based
// indexing, `xxx()` blocking with `xxxAsync()` beside it, assignment for setters,
// the class family — because that is the whole claim this layer makes. If a test
// had to be written the native way to pass, the layer would not be doing its job.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gdal as native, tmp } from './helpers.mjs'

const gdal = /** @type {any} */ (
  await import('../compat/index.js').then((module) => module.default ?? module)
)

/** A small GeoTIFF written through the *native* API, to read back through compat. */
function sampleRaster(name, options = {}) {
  const width = options.width ?? 4
  const height = options.height ?? 4
  const path = tmp(name)
  const dataset = native.createSync(path, {
    driver: 'GTiff',
    width,
    height,
    bandCount: 1,
    dataType: options.dataType ?? 'Uint8',
  })
  const band = dataset.band(0)
  band.writePixelsSync(
    Buffer.from(Uint8Array.from({ length: width * height }, (_, index) => index % 256)),
  )
  dataset.setProjection(native.epsgToWkt(4326))
  dataset.setGeoTransform([0, 1, 0, 0, 0, -1])
  dataset.close()
  return path
}

test('the module keeps gdal-async shapes: version is a string, drivers is a collection', () => {
  assert.equal(typeof gdal.version, 'string')
  assert.match(gdal.version, /^GDAL \d/)

  // `gdal.drivers.get('GTiff')` — a collection keyed by name, not an array search.
  const gtiff = gdal.drivers.get('GTiff')
  assert.equal(gtiff.name, 'GTiff')
  assert.ok(gdal.drivers.count() > 100)
  // One collection for the process, as gdal-async's is.
  assert.equal(gdal.drivers, gdal.drivers)
  assert.equal(typeof gdal.drivers.get(1).name, 'string')

  // Iterable, the way a collection is.
  const names = [...gdal.drivers].map((driver) => driver.name)
  assert.ok(names.includes('GTiff'))
})

test('open() is blocking, openAsync() is not, and both block the same dataset', async () => {
  const path = sampleRaster('compat-open.tif')

  const dataset = gdal.open(path)
  assert.equal(dataset.rasterSize.xSize, 4)
  assert.equal(dataset.rasterSize.ySize, 4)
  dataset.close()

  const opened = await gdal.openAsync(path)
  assert.equal(opened.rasterSize.xSize, 4)
  opened.close()

  // gdal-async's other call shape: a node-style callback.
  await new Promise((resolve, reject) => {
    gdal.openAsync(path, 'r', (error, asyncDataset) => {
      try {
        assert.equal(error, null)
        assert.equal(asyncDataset.rasterSize.xSize, 4)
        asyncDataset.close()
        resolve()
      } catch (assertion) {
        reject(assertion)
      }
    })
  })
})

test('bands and layers count from 1, and report gdal-async shapes', () => {
  const path = sampleRaster('compat-bands.tif', { width: 8, height: 6 })
  const dataset = gdal.open(path)

  assert.equal(dataset.bands.count(), 1)
  // 1 is the first band — the native API calls this `dataset.band(0)`.
  const band = dataset.bands.get(1)
  assert.deepEqual(band.size, { xSize: 8, ySize: 6 })
  assert.equal(band.dataType, gdal.GDT_Byte)
  assert.equal(band.colorInterpretation, 'GrayIndex')
  assert.equal(dataset.bands.get(2), null)

  // Assignment, where the native API has `setNoDataValue`.
  band.noDataValue = 255
  assert.equal(band.noDataValue, 255)
  band.description = 'elevation'
  assert.equal(band.description, 'elevation')

  // The geometry of the whole dataset, as gdal-async spells it.
  assert.equal(dataset.geoTransform[1], 1)
  dataset.geoTransform = [0, 2, 0, 0, 0, -2]
  assert.equal(dataset.geoTransform[1], 2)

  const srs = dataset.srs
  assert.match(srs.toWKT(), /4326|WGS 84/)
  assert.equal(srs.getAuthorityCode(), '4326')
  dataset.srs = new gdal.SpatialReference(native.epsgToWkt(3857))
  assert.equal(dataset.srs.getAuthorityCode(), '3857')

  // The band metadata assigned above went through GDAL's PAM layer on a read-only
  // handle, so a sidecar is legitimately part of the dataset now.
  assert.ok(dataset.getFileList().some((file) => file.endsWith('compat-bands.tif')))
  dataset.close()
})

test('pixels read and write in typed arrays, the way gdal-async does', () => {
  const path = sampleRaster('compat-pixels.tif')
  const dataset = gdal.open(path, 'r+')
  const pixels = dataset.bands.get(1).pixels

  // `get`/`set` address one pixel.
  assert.equal(pixels.get(0, 0), 0)
  pixels.set(1, 0, 42)
  assert.equal(pixels.get(1, 0), 42)

  // `read` allocates a typed array of the band's own type; gdal-async's callers
  // index it as numbers, which is why this is not a Buffer.
  const window = pixels.read(0, 0, 4, 4)
  assert.ok(window instanceof Uint8Array)
  assert.equal(window.length, 16)
  assert.equal(window[1], 42)

  // ... and fills a caller's array when given one.
  const into = new Uint8Array(16)
  const returned = pixels.read(0, 0, 4, 4, into)
  assert.equal(returned, into)
  assert.equal(into[1], 42)

  // `readAsync` is gdal-async's spelling; the work is the same, and the callback
  // form is the second shape it accepts.
  return new Promise((resolve, reject) => {
    pixels.readAsync(0, 0, 4, 4, (error, values) => {
      try {
        assert.equal(error, null)
        assert.equal(values[1], 42)
        resolve()
      } catch (assertion) {
        reject(assertion)
      }
    })
  }).then(() => {
    const written = Uint8Array.from({ length: 4 }, () => 7)
    pixels.write(0, 0, 2, 2, written)
    assert.equal(pixels.get(1, 1), 7)
    dataset.close()
  })
})

test('statistics come back under gdal-async names', () => {
  const path = sampleRaster('compat-stats.tif')
  const dataset = gdal.open(path)
  const band = dataset.bands.get(1)

  const statistics = band.getStatistics(false, true)
  assert.equal(statistics.min, 0)
  assert.equal(statistics.max, 15)
  assert.ok(statistics.stdDev > 0, 'stdDev, not std_dev')
  dataset.close()

  // `computeStatistics` is the blocking one — the reference spells the promise
  // `computeStatisticsAsync` — and the two answer the same numbers.
  const reopened = gdal.open(path)
  return reopened.bands
    .get(1)
    .computeStatistics(true)
    .max === 15 &&
    reopened.bands
      .get(1)
      .computeStatisticsAsync(true)
      .then((async_) => {
        assert.equal(async_.max, 15)
        reopened.close()
      })
})

test('a layer hands out features and fields the gdal-async way', () => {
  const path = tmp('compat-vector.gpkg')

  // Written through the native API and read back through compat: the layer is the
  // same file either way, which is the point of an adapter rather than a second
  // implementation.
  const writable = native.createVectorSync(path, 'GPKG')
  const layer = writable.createLayer({ name: 'places', geometryType: 'Point', epsg: 4326 })
  layer.createFeature({ type: 'Point', coordinates: [1, 2] }, { name: 'alpha', population: 10 })
  layer.createFeature({ type: 'Point', coordinates: [3, 4] }, { name: 'beta', population: 20 })
  writable.close()

  // Opened `r+` because this test writes: gdal-async's `'r+'` is update mode.
  const reopened = gdal.open(path, 'r+')
  const compatLayer = reopened.layers.get(1)
  assert.equal(compatLayer.name, 'places')
  assert.equal(compatLayer.geomType, 'Point')
  assert.match(compatLayer.srs.toWKT(), /4326|WGS 84/)

  assert.equal(compatLayer.features.count(), 2)

  // Iterating features gives objects with `fid`, `fields` and `geometry`.
  for (const feature of compatLayer.features) {
    assert.equal(typeof feature.fid, 'number')
    assert.equal(typeof feature.fields.toObject().name, 'string')
    assert.ok(feature.geometry instanceof gdal.Point, 'a Point, by instanceof')
    assert.equal(feature.geometry.toWKT().startsWith('POINT'), true)
  }

  const first = compatLayer.features.first()
  assert.equal(first.fields.get('name'), 'alpha')
  first.fields.set('population', 11)
  assert.equal(first.fields.get('population'), 11)
  assert.deepEqual(first.fields.toArray(), ['alpha', 11])

  // Assignment to `geometry`, with a geometry object.
  first.geometry = gdal.fromWKT('POINT (9 9)')
  assert.equal(first.geometry.toJSON().coordinates[0], 9)

  // Fields are a 1-based collection too.
  assert.equal(compatLayer.fields.get(1).name, 'name')
  assert.equal(compatLayer.fields.get('population').fieldType, 'Integer64')

  reopened.close()
})

test('geometries carry the class family and gdal-async method names', () => {
  const point = gdal.fromWKT('POINT (3 4)')
  assert.ok(point instanceof gdal.Point)
  assert.ok(point instanceof gdal.Geometry)
  assert.equal(point.x, 3)
  assert.equal(point.y, 4)

  // toWKT / toJSON, and the `get*` spellings gdal-async uses.
  assert.equal(point.toWKT(), 'POINT (3 4)')
  assert.deepEqual(point.toJSON(), { type: 'Point', coordinates: [3, 4] })
  assert.equal(point.getGeometryType(), 'Point')
  assert.equal(point.isEmpty, false)

  const polygon = gdal.fromJSON({
    type: 'Polygon',
    coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]],
  })
  assert.ok(polygon instanceof gdal.Polygon)
  assert.equal(polygon.getArea(), 16)
  assert.equal(polygon.getLength(), 16)
  assert.deepEqual(polygon.getEnvelope(), {
    minX: 0,
    minY: 0,
    maxX: 4,
    maxY: 4,
    minx: 0,
    miny: 0,
    maxx: 4,
    maxy: 4,
  })

  // A Multi* gets its own class, and the base class is what a plain geometry is.
  assert.ok(gdal.fromJSON({ type: 'MultiPoint', coordinates: [[0, 0]] }) instanceof gdal.MultiPoint)
  assert.ok(gdal.fromJSON({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }) instanceof gdal.LineString)
})
