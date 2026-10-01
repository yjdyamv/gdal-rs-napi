// The names the reference's own test suite reaches for.
//
// Derived rather than guessed: `scripts/compat-coverage.mjs` reads gdal-async's ~60
// TypeScript test files and reports every `gdal.<name>` they use that `compat` does not
// answer. The largest single item is **class identity** — those tests ask
// `assert.instanceOf(dataset, gdal.Dataset)` 262 times, and an adapter whose objects are
// instances of nothing *named* fails every one of them. This pins that, and the
// re-exports beside it.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gdal as native, tmp } from './helpers.mjs'

const gdal = /** @type {any} */ (
  await import('../compat/index.js').then((module) => module.default ?? module)
)

test('a raster dataset, its bands and its collections are instances of the named classes', () => {
  const path = tmp('compat-surface.tif')
  const created = native.createSync(path, {
    driver: 'GTiff',
    width: 4,
    height: 2,
    bandCount: 1,
    dataType: 'Uint8',
  })
  created.close()

  const dataset = gdal.open(path)
  assert.ok(dataset instanceof gdal.Dataset)
  assert.ok(dataset.bands instanceof gdal.DatasetBands)
  assert.ok(dataset.drivers === undefined || dataset.drivers instanceof gdal.GDALDrivers)

  const band = dataset.bands.get(1)
  assert.ok(band instanceof gdal.RasterBand)
  assert.ok(band.pixels instanceof gdal.RasterBandPixels)
  assert.ok(band.overviews instanceof gdal.RasterBandOverviews)

  // The registry collection, and the drivers inside it.
  assert.ok(gdal.drivers instanceof gdal.GDALDrivers)
  assert.ok(gdal.drivers.get('GTiff') instanceof gdal.Driver)
  assert.ok(dataset.driver instanceof gdal.Driver)

  dataset.close()
})

test('a layer, its features and its fields are instances of the named classes', () => {
  const path = tmp('compat-surface.gpkg')
  const created = native.createVectorSync(path, 'GPKG')
  const layer = created.createLayer({ name: 'things', geometryType: 'Point', epsg: 4326 })
  layer.createFeature({ type: 'Point', coordinates: [1, 2] }, { name: 'one' })
  created.close()

  const dataset = gdal.open(path)
  assert.ok(dataset.layers instanceof gdal.DatasetLayers)
  const reopened = dataset.layers.get(1)
  assert.ok(reopened instanceof gdal.Layer)
  assert.ok(reopened.fields instanceof gdal.LayerFields)
  assert.ok(reopened.features instanceof gdal.LayerFeatures)

  const feature = reopened.features.get(1)
  assert.ok(feature instanceof gdal.Feature)
  assert.ok(feature.fields instanceof gdal.FeatureFields)
  assert.ok(feature.geometry instanceof gdal.Point)

  dataset.close()
})

test('CoordinateTransformation takes and answers the reference\'s shapes', () => {
  const toMercator = new gdal.CoordinateTransformation(
    new gdal.SpatialReference(native.epsgToWkt(4326)),
    new gdal.SpatialReference(native.epsgToWkt(3857)),
  )

  // Both call shapes, one answer shape — an `{ x, y }` object and `x, y` arguments.
  const fromObject = toMercator.transformPoint({ x: 20, y: 30 })
  const fromArguments = toMercator.transformPoint(20, 30)
  assert.ok(fromObject.x > 2_000_000)
  assert.equal(fromObject.x, fromArguments.x)
  assert.equal(fromObject.y, fromArguments.y)

  // A geometry in, a geometry out.
  const moved = toMercator.transformGeometry(gdal.fromWKT('POINT (13.4 52.5)'))
  assert.ok(moved instanceof gdal.Point)
  assert.equal(moved.type, 'Point')

  // Nonsense is refused rather than answered with a plausible number.
  assert.throws(() => toMercator.transformPoint({ x: 'not a number', y: 30 }))
  assert.throws(() => new gdal.CoordinateTransformation({}, {}), /SpatialReference/)
})

test('the re-exports answer what the main entry point answers', () => {
  // Same objects where the main entry point already has one, so there is nothing to
  // keep in step.
  assert.equal(gdal.fs, native.fs)
  assert.equal(gdal.config, native.config)
  assert.equal(gdal.bundled, native.bundled)
  assert.equal(gdal.RasterMuxStream, native.RasterMuxStream)
  assert.equal(gdal.RasterTransform, native.RasterTransform)

  assert.equal(gdal.info().releaseName, native.info().releaseName)
  assert.equal(gdal.toDataType('Float32'), native.toDataType('Float32'))
  assert.equal(gdal.fromDataType(native.toDataType('Float32')), 'Float32')

  for (const name of [
    'infoAsync',
    'wrapVRT',
    'addPixelFunc',
    'toPixelFunc',
    'createPixelFunc',
    'createPixelFuncWithArgs',
    'calcAsync',
  ]) {
    assert.equal(typeof gdal[name], 'function', `gdal.${name}`)
  }
  assert.equal(gdal.infoAsync() instanceof Promise, true)

  // The warning switch is a property, and it forwards both ways.
  const before = native.eventLoopWarning
  gdal.eventLoopWarning = 100
  assert.equal(native.eventLoopWarning, 100)
  assert.equal(gdal.eventLoopWarning, 100)
  gdal.eventLoopWarning = before
})
