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

test('metadata, statistics and the mask answer under the reference\'s names', async () => {
  const path = tmp('compat-surface-alias.tif')
  const created = native.createSync(path, {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Uint8',
  })
  created.band(0).writePixelsSync(Buffer.from(Uint8Array.from({ length: 16 }, (_, index) => index)))
  created.setMetadataItem('AREA_OR_POINT', 'Area')
  created.close()

  const dataset = gdal.open(path)
  assert.deepEqual(dataset.getMetadata(), dataset._native.metadata())
  dataset.close()

  // `setMetadata` takes an object or an array of `key=value` strings, and answers true.
  const writable = gdal.open(path, 'r+')
  assert.equal(writable.setMetadata({ name: 'temporary' }), true)
  assert.equal(writable.getMetadata().name, 'temporary')
  assert.equal(writable.setMetadata(['name=other']), true)
  assert.equal(writable.getMetadata().name, 'other')

  const band = writable.bands.get(1)
  assert.deepEqual(band.getMetadata(), band._native.metadata())
  // Writing *band* metadata is a gap in the main entry point rather than in this
  // adapter — the binding has no `RasterBand.setMetadataItem` — so it is not claimed
  // here. The dataset and layer halves both write.

  // `computeStatistics(allowApproximation, force)` — two booleans for one options object.
  const statistics = band.computeStatistics(false, true)
  assert.equal(statistics.min, 0)
  assert.equal(statistics.max, 15)
  assert.equal(typeof (await band.computeStatisticsAsync(false, true)).mean, 'number')

  // The mask, which this adapter does not wrap, is reachable under both spellings.
  assert.ok(band.getMaskFlags() !== undefined)
  assert.equal(typeof band.getMaskBand().readPixelsSync, 'function')

  writable.close()
})

test('SpatialReference answers the reference\'s statics and accessors', () => {
  const { SpatialReference } = gdal

  // The `from*` family: each name the reference splits out lands on the door that
  // actually handles it — one `OSRSetFromUserInput` for the URL/URN/WMS/MapInfo forms.
  assert.equal(SpatialReference.fromEPSG(4326).authCode, 4326)
  assert.equal(SpatialReference.fromWKT(native.epsgToWkt(4326)).authCode, 4326)
  // A PROJ string carries no authority of its own. `autoIdentifyEPSG` is the call that
  // goes looking for one; what it finds — and when it finds nothing — is pinned by this
  // binding's own CRS tests, so all that is checked here is that the name is wired.
  const fromProj4 = SpatialReference.fromProj4('+proj=longlat +datum=WGS84 +no_defs')
  assert.equal(fromProj4.authCode, null)
  fromProj4.autoIdentifyEPSG()
  assert.equal(typeof fromProj4.toWKT(), 'string')
  assert.equal(SpatialReference.fromURN('urn:ogc:def:crs:EPSG::4326').authCode, 4326)
  assert.equal(SpatialReference.fromUserInput('EPSG:4326').authCode, 4326)
  assert.equal(SpatialReference.fromURL('EPSG:4326').authCode, 4326)
  assert.equal(SpatialReference.fromCRSURL('EPSG:4326').authCode, 4326)
  assert.equal(SpatialReference.fromWMSAUTO('EPSG:4326').authCode, 4326)
  assert.equal(SpatialReference.fromMICoordSys('EPSG:4326').authCode, 4326)
  // `fromEPSGA` is the same code read in the authority's axis order.
  assert.equal(SpatialReference.fromEPSGA(4326).axisMapping, 'authority')

  const wgs84 = SpatialReference.fromEPSG(4326)
  assert.equal(wgs84.toPrettyWKT().includes('\n'), true)
  assert.equal(typeof wgs84.toXML(), 'string')
  assert.equal(wgs84.validate(), true)
  assert.equal(wgs84.isGeographic, true)
  assert.equal(wgs84.isProjected, false)
  assert.equal(wgs84.isGeocentric, false)
  assert.equal(wgs84.isLocal, false)
  assert.equal(wgs84.isCompound, false)
  assert.equal(wgs84.equals(SpatialReference.fromWKT(native.epsgToWkt(4326))), true)
  assert.equal(wgs84.isSameGeogCS(SpatialReference.fromEPSG(32631)), true)
  assert.equal(wgs84.cloneGeogCS().authCode, 4326)
  // What this adapter adds is the *name*; what `getAttrValue` answers is the binding's
  // own semantics, pinned by the main entry point's CRS tests.
  assert.equal(typeof wgs84.getAttrValue, 'function')
  assert.equal(typeof wgs84.getAngularUnits(), 'number')

  const projected = SpatialReference.fromEPSG(32631)
  assert.equal(projected.isProjected, true)
  assert.equal(projected.getLinearUnits(), 1)

  const morphed = SpatialReference.fromEPSG(4326)
  morphed.morphToESRI()
  morphed.morphFromESRI()
  assert.equal(morphed.authCode, 4326)
})

test('deleteDataset removes the file through its own driver', () => {
  const path = tmp('compat-surface-delete.tif')
  const created = native.createSync(path, {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 1,
    dataType: 'Uint8',
  })
  created.close()

  gdal.deleteDataset(path)
  assert.throws(() => gdal.open(path))
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
