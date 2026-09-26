import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'

import { gdal, tmp } from './helpers.mjs'

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
