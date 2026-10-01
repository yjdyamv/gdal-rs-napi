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

test('vsimem is the memory file system under the reference\'s names', () => {
  const path = gdal.vsimem.set(Buffer.from('hello'), 'compat-surface.bin')
  assert.equal(path, '/vsimem/compat-surface.bin')
  assert.deepEqual(native.fs.readFile(path), Buffer.from('hello'))

  // A bare name works as well as the whole path, in both directions.
  gdal.vsimem.copy('compat-surface.bin', '/vsimem/compat-surface-copy.bin')
  assert.deepEqual(native.fs.readFile('/vsimem/compat-surface-copy.bin'), Buffer.from('hello'))
  gdal.vsimem.release('/vsimem/compat-surface-copy.bin')
  assert.equal(native.fs.stat('/vsimem/compat-surface-copy.bin'), null)

  // Releasing what is not there is not an error — the reference calls it from a
  // `finally`, so a second call has to be harmless.
  gdal.vsimem.release('compat-surface.bin')
  gdal.vsimem.release('compat-surface.bin')
  assert.equal(native.fs.stat(path), null)

  // What the object is for: bytes out of a dataset, and back into one.
  const source = native.createSync('/vsimem/compat-surface-raster.tif', {
    driver: 'GTiff',
    width: 4,
    height: 2,
    bandCount: 1,
    dataType: 'Uint8',
  })
  source.band(0).fill(7)
  source.close()

  const bytes = native.fs.readFile('/vsimem/compat-surface-raster.tif')
  const reopenedPath = gdal.vsimem.set(bytes, 'compat-surface-reopened.tif')
  const dataset = gdal.open(reopenedPath)
  assert.equal(dataset.bands.get(1).pixels.read(0, 0, 4, 2).length, 4 * 2)
  dataset.close()

  // A name with nothing behind it still gets one, so `set` without a name is usable.
  const anonymous = gdal.vsimem.set(Buffer.from('bytes'))
  assert.match(anonymous, /^\/vsimem\/gdal-rs-napi-\d+-\d+\.bin$/)
  gdal.vsimem.release(anonymous)
})

test('Envelope is a box object, with the reference\'s rules for it', () => {
  // A default envelope is all zeros, and that is what "empty" means here — the
  // reference's own definition, which its tests check first.
  const empty = new gdal.Envelope()
  assert.equal(empty.isEmpty(), true)
  assert.equal(new gdal.Envelope({ minX: 0, maxX: 5, minY: 0, maxY: 0 }).isEmpty(), false)

  // merge() expands in place, from either an x, y pair or another envelope.
  const merged = new gdal.Envelope({ minX: -1, maxX: 1, minY: -2, maxY: 2 })
  merged.merge(2, 3)
  assert.deepEqual([merged.minX, merged.minY, merged.maxX, merged.maxY], [-1, -2, 2, 3])
  merged.merge(new gdal.Envelope({ minX: -3, maxX: 0, minY: 0, maxY: 1 }))
  assert.deepEqual([merged.minX, merged.minY, merged.maxX, merged.maxY], [-3, -2, 2, 3])

  const a = new gdal.Envelope({ minX: 1, maxX: 2, minY: 1, maxY: 2 })
  assert.equal(a.intersects(new gdal.Envelope({ minX: 2, maxX: 4, minY: 1, maxY: 2 })), true)
  assert.equal(a.intersects(new gdal.Envelope({ minX: 10, maxX: 20, minY: 10, maxY: 20 })), false)

  const outer = new gdal.Envelope({ minX: -10, maxX: 10, minY: -10, maxY: 10 })
  assert.equal(outer.contains(new gdal.Envelope({ minX: -1, maxX: 1, minY: -1, maxY: 1 })), true)
  assert.equal(outer.contains(new gdal.Envelope({ minX: -1, maxX: 1, minY: -1, maxY: 20 })), false)

  // intersect() is in place, and clearing to all zeros is the "no overlap" answer.
  const disposable = new gdal.Envelope({ minX: 1, maxX: 2, minY: 1, maxY: 2 })
  disposable.intersect(new gdal.Envelope({ minX: 10, maxX: 20, minY: 10, maxY: 20 }))
  assert.equal(disposable.isEmpty(), true)
  const overlapping = new gdal.Envelope({ minX: -10, maxX: 10, minY: -10, maxY: 10 })
  overlapping.intersect(new gdal.Envelope({ minX: -2, maxX: 12, minY: -1, maxY: 1 }))
  assert.deepEqual(
    [overlapping.minX, overlapping.minY, overlapping.maxX, overlapping.maxY],
    [-2, -1, 10, 1],
  )

  // ... and the round trip through a polygon, which is the other half of the object.
  const box = new gdal.Envelope({ minX: -1, maxX: 5, minY: -3, maxY: 2 })
  const polygon = box.toPolygon()
  assert.ok(polygon instanceof gdal.Polygon)
  const back = polygon.getEnvelope()
  assert.ok(back instanceof gdal.Envelope)
  assert.deepEqual([back.minX, back.minY, back.maxX, back.maxY], [-1, -3, 5, 2])

  // The 3D box carries Z, and its rules extend the 2D ones.
  const box3d = new gdal.Envelope3D({ minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: -5, maxZ: 5 })
  assert.equal(box3d.isEmpty(), false)
  assert.equal(box3d.contains(new gdal.Envelope3D({ minX: 0, maxX: 1, minY: 0, maxY: 1 })), true)
})

test('a feature answers getGeometry and setGeometry', () => {
  const path = tmp('compat-surface-envelope.gpkg')
  const created = native.createVectorSync(path, 'GPKG')
  const layer = created.createLayer({ name: 'things', geometryType: 'Point', epsg: 4326 })
  layer.createFeature({ type: 'Point', coordinates: [1, 2] }, { name: 'one' })
  created.close()

  const dataset = gdal.open(path, 'r+')
  const feature = dataset.layers.get(1).features.get(1)
  assert.equal(feature.getGeometry().type, 'Point')
  feature.setGeometry(gdal.fromWKT('POINT (9 9)'))
  assert.equal(feature.getGeometry().toWKT(), 'POINT (9 9)')
  dataset.close()
})

test('the numeric vocabularies come from the headers this build links', () => {
  // The values are read out of `gdal_sys` in `src/constants.rs`, never written out by
  // hand. What is pinned here are GDAL's own ABI values, so a table wired to the wrong
  // enum shows up as a failing test rather than as a silently mis-typed field.
  assert.equal(gdal.wkbPoint, 1)
  assert.equal(gdal.OFTInteger, 0)
  assert.equal(gdal.OFTReal, 2)
  assert.equal(gdal.OFTString, 4)
  assert.equal(gdal.OFTInteger64, 12)
  assert.equal(gdal.GCI_RedBand, 3)
  assert.equal(gdal.GRA_Bilinear, 1)
  assert.equal(gdal.GRA_Lanczos, 4)
  assert.equal(gdal.GPI_RGB, 1)
  assert.equal(gdal.OJLeft, 1)
  assert.equal(gdal.CE_Failure, 3)

  // ... and where this binding has a *derived* answer for the same code, the two have
  // to agree: `toDataType` reads the code out of the linked GDAL as well.
  assert.equal(gdal.GDT_Byte, native.toDataType('Uint8'))
  assert.equal(gdal.GDT_Float32, native.toDataType('Float32'))
  assert.equal(gdal.GDT_Float64, native.toDataType('Float64'))

  // The families `gdal-sys` does not bind are absent rather than guessed — see the
  // note on `numericConstants()` in `src/constants.rs`.
  assert.equal(gdal.OLCRandomRead, undefined)
  assert.equal(gdal.CPLE_AppDefined, undefined)
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
