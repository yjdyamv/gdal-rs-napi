import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'

import { gdal, tmp } from './helpers.mjs'

/** A GPKG holding `count` point features, so a cursor has something to page. */
function manyFeatures(path, count) {
  const dataset = gdal.createVectorSync(path, 'GPKG')
  const layer = dataset.createLayer({ name: 'points', geometryType: 'Point', epsg: 4326 })
  for (let index = 0; index < count; index += 1) {
    layer.createFeature(
      { type: 'Point', coordinates: [index / 10, index / 10] },
      { name: `n${index}`, n: index },
    )
  }
  dataset.close()
}

test('a cursor pages a layer, exactly as materialising it would', async () => {
  const path = tmp('cursor.gpkg')
  manyFeatures(path, 250)

  const dataset = gdal.openSync(path)
  const layer = dataset.layer(0)
  const everything = layer.featuresSync()

  const cursor = layer.openCursor({ batchSize: 100 })
  assert.equal(cursor.batchSize, 100)
  assert.equal(cursor.finished, false)

  const batches = []
  for (;;) {
    const batch = await cursor.read()
    if (batch.length === 0) break
    batches.push(batch)
  }

  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 50],
  )
  assert.equal(cursor.finished, true)

  // The whole point of the thing: paged and materialised reads have to agree
  // field for field — fid, properties and geometry alike.
  assert.deepEqual(batches.flat(), everything)

  // And reading past the end stays empty rather than throwing.
  assert.deepEqual(await cursor.read(), [])
  cursor.close()

  dataset.close()
})

test('a cursor respects the attribute filter, and readSync matches read', () => {
  const path = tmp('cursor-filter.gpkg')
  manyFeatures(path, 40)

  const dataset = gdal.openSync(path)
  const layer = dataset.layer(0)

  layer.setAttributeFilter('n >= 20')
  const filtered = layer.featuresSync()
  assert.equal(filtered.length, 20)

  const paged = []
  const cursor = layer.openCursor({ batchSize: 7 })
  while (!cursor.finished) paged.push(...cursor.readSync())
  cursor.close()

  assert.deepEqual(paged, filtered)

  dataset.close()
})

test('a cursor refuses nonsense, and stops when it is closed', async () => {
  const path = tmp('cursor-errors.gpkg')
  manyFeatures(path, 5)

  const dataset = gdal.openSync(path)
  const layer = dataset.layer(0)

  assert.throws(() => layer.openCursor({ batchSize: 0 }), /at least 1/)

  const cursor = layer.openCursor()
  assert.equal(cursor.batchSize, 1000, 'the documented default')
  assert.equal((await cursor.read()).length, 5)

  cursor.close()
  cursor.close() // idempotent
  await assert.rejects(cursor.read(), /closed/)
  assert.throws(() => cursor.readSync(), /closed/)

  // Closing the dataset shuts the cursor too, through the handle it shares.
  const other = layer.openCursor()
  dataset.close()
  await assert.rejects(other.read(), /closed/)
})

const nOf = (feature) => feature.properties.n

test('one layer reads one way at a time, and a second handle is the way around it', () => {
  const path = tmp('one-reader.gpkg')
  manyFeatures(path, 8)

  // GDAL keeps the reading position on the layer, so two cursors on one handle
  // share it: their batches interleave rather than each seeing the layer.
  const shared = gdal.openSync(path)
  const layer = shared.layer(0)
  const one = layer.openCursor({ batchSize: 2 })
  const two = layer.openCursor({ batchSize: 2 })

  assert.deepEqual(one.readSync().map(nOf), [0, 1])
  assert.deepEqual(two.readSync().map(nOf), [0, 1])
  // The second cursor's first read rewound the layer under the first, so from here
  // they are walking one shared position between them.
  assert.deepEqual(one.readSync().map(nOf), [2, 3])
  assert.deepEqual(two.readSync().map(nOf), [4, 5])

  // A whole-layer read is still the whole layer, even with a cursor part-way
  // through: it rewinds first rather than picking up wherever the cursor stopped.
  // (It does still rewind the cursor afterwards — one position, one reader.)
  assert.equal(layer.featuresSync().length, 8)
  assert.deepEqual(one.readSync().map(nOf), [0, 1])
  shared.close()

  // Two handles have two positions, so both cursors see everything. That is the
  // mitigation: reopen the dataset, do not fight over the layer.
  const left = gdal.openSync(path)
  const right = gdal.openSync(path)
  const leftCursor = left.layer(0).openCursor({ batchSize: 2 })
  const rightCursor = right.layer(0).openCursor({ batchSize: 2 })

  assert.deepEqual(leftCursor.readSync().map(nOf), [0, 1])
  assert.deepEqual(rightCursor.readSync().map(nOf), [0, 1])
  assert.deepEqual(leftCursor.readSync().map(nOf), [2, 3])
  assert.deepEqual(rightCursor.readSync().map(nOf), [2, 3])
  left.close()
  right.close()
})

test('reading one feature by id does not move the reading position', () => {
  const path = tmp('random-access.gpkg')
  manyFeatures(path, 8)

  const dataset = gdal.openSync(path)
  const layer = dataset.layer(0)
  const cursor = layer.openCursor({ batchSize: 2 })
  assert.deepEqual(cursor.readSync().map(nOf), [0, 1])

  // `getFeature(fid)` is random access, so it answers for its one feature without
  // disturbing a reader that is part-way through the layer.
  assert.equal(layer.getFeature(5).fields.get('n'), 4)
  assert.deepEqual(cursor.readSync().map(nOf), [2, 3])

  dataset.close()
})

const collection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'alpha', population: 120, height: 1.5 },
      geometry: { type: 'Point', coordinates: [10, 20] },
    },
    {
      type: 'Feature',
      properties: { name: 'beta', population: 4500, height: 8.25 },
      geometry: { type: 'Point', coordinates: [11, 21] },
    },
    {
      type: 'Feature',
      properties: { name: 'gamma', population: 7, height: 0 },
      geometry: { type: 'Point', coordinates: [30, 40] },
    },
  ],
}

function writeCollection(name, body = collection) {
  const path = tmp(name)
  writeFileSync(path, JSON.stringify(body))
  return path
}

test('reads layers, fields and the layer geometry type', () => {
  const dataset = gdal.openSync(writeCollection('points.geojson'))

  assert.equal(dataset.layerCount, 1)
  assert.deepEqual(
    dataset.layers().map((layer) => layer.index),
    [0],
  )

  const layer = dataset.layer(0)
  assert.equal(layer.geometryType, 'Point')
  assert.equal(layer.featureCount, 3)
  assert.equal(dataset.layerByName(layer.name).index, 0)
  assert.throws(() => dataset.layerByName('nope'), /no layer named/)
  assert.throws(() => dataset.layer(7), /out of range/)

  const names = layer.fields.map((field) => field.name).sort()
  assert.deepEqual(names, ['height', 'name', 'population'])
  const byName = new Map(layer.fields.map((field) => [field.name, field]))
  assert.equal(byName.get('name').fieldType, 'String')
  assert.match(byName.get('population').fieldType, /^(Integer|Integer64|Real)$/)
  for (const field of layer.fields) {
    assert.doesNotMatch(field.fieldType, /^\d+$/, `${field.name} leaked a raw OGRFieldType`)
    assert.equal(typeof field.width, 'number')
  }

  dataset.close()
})

test('materialises features with attributes and GeoJSON geometry', () => {
  const dataset = gdal.openSync(writeCollection('features.geojson'))
  const layer = dataset.layer(0)

  const features = layer.featuresSync()
  assert.equal(features.length, 3)

  const [alpha, beta] = features
  assert.equal(alpha.fid, 0)
  assert.equal(alpha.properties.name, 'alpha')
  assert.equal(alpha.properties.population, 120)
  assert.equal(alpha.properties.height, 1.5)

  assert.equal(beta.fid, 1)
  assert.equal(beta.properties.name, 'beta')
  assert.equal(beta.properties.population, 4500)

  // Geometry arrives as a parsed GeoJSON object, not a string.
  assert.equal(alpha.geometry.type, 'Point')
  assert.deepEqual(alpha.geometry.coordinates, [10, 20])

  // A null field is present as null, not missing.
  assert.ok('height' in alpha.properties)

  const byId = layer.feature(1)
  assert.equal(byId.properties.name, 'beta')
  assert.equal(layer.feature(99), null)

  dataset.close()
})

test('attribute and spatial filters narrow the feature set', () => {
  const dataset = gdal.openSync(writeCollection('filters.geojson'))
  const layer = dataset.layer(0)

  layer.setAttributeFilter('population > 100')
  assert.deepEqual(
    layer.featuresSync().map((feature) => feature.properties.name),
    ['alpha', 'beta'],
  )

  layer.setAttributeFilter(null)
  assert.equal(layer.featuresSync().length, 3)

  // A box around the first point only.
  layer.setSpatialFilterRect(9.5, 19.5, 10.5, 20.5)
  assert.deepEqual(
    layer.featuresSync().map((feature) => feature.properties.name),
    ['alpha'],
  )

  layer.clearSpatialFilter()
  assert.equal(layer.featuresSync().length, 3)

  dataset.close()
})

test('reports the layer extent and CRS', () => {
  const dataset = gdal.openSync(writeCollection('extent.geojson'))
  const layer = dataset.layer(0)

  const extent = layer.extent
  assert.equal(extent.length, 4)
  assert.deepEqual(extent, [10, 20, 30, 40])
  // GeoJSON is defined as WGS84, so the driver assigns that CRS even though the
  // file itself names none.
  assert.match(layer.spatialRefWkt, /WGS 84/)

  dataset.close()
})

test('geometry conversions round-trip through WKT and WKB', () => {
  const point = { type: 'Point', coordinates: [10, 20] }

  assert.equal(gdal.geometryTypeOf(point), 'Point')
  assert.equal(gdal.geometryToWkt(point), 'POINT (10 20)')

  assert.deepEqual(gdal.geometryFromWkt('POINT (10 20)'), point)

  const wkb = gdal.geometryToWkb(point)
  assert.ok(wkb.length > 4)
  assert.deepEqual(gdal.geometryFromWkb(wkb), point)

  const polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  }
  assert.equal(gdal.geometryTypeOf(polygon), 'Polygon')
  assert.deepEqual(gdal.geometryFromWkt(gdal.geometryToWkt(polygon)), polygon)
})

test('a raster dataset simply has no layers', () => {
  const dataset = gdal.createSync(tmp('raster-no-layers.tif'), {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 1,
  })
  assert.equal(dataset.layerCount, 0)
  assert.throws(() => dataset.layer(0), /out of range/)
  dataset.close()
})

test('closing invalidates layer objects too', () => {
  const dataset = gdal.openSync(writeCollection('closed-vector.geojson'))
  const layer = dataset.layer(0)
  dataset.close()

  assert.throws(() => layer.name, (err) => err.code === 'GDAL_BAD_ARGUMENT')
  assert.throws(() => layer.featuresSync(), (err) => err.code === 'GDAL_BAD_ARGUMENT')
})
