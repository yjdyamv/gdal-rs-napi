// The geometry class family.
//
// gdal-async hands a geometry back as the class its type names — `Point`, `Polygon`,
// `MultiPolygon` — and napi cannot express inheritance, so the binding has one class.
// The shell re-tags what comes out of the factories and the operations instead, which
// is a prototype question: `adopt()` in `index.js`. What matters here is that the tag
// is right *and* that nothing else changed — the geometry still answers every method,
// still passes `instanceof gdal.Geometry`, and a plain GeoJSON object is left alone.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gdal, tmp } from './helpers.mjs'

const { Geometry } = gdal

test('a geometry comes back as the class its type names', () => {
  const shapes = [
    ['POINT (1 2)', 'Point'],
    // The dimensionality is in the type string and not in the class.
    ['POINT Z (1 2 3)', 'Point'],
    ['POINT M (1 2 3)', 'Point'],
    ['LINESTRING (0 0, 3 4)', 'LineString'],
    ['POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))', 'Polygon'],
    ['MULTIPOINT ((0 0), (1 1))', 'MultiPoint'],
    ['MULTILINESTRING ((0 0, 1 1))', 'MultiLineString'],
    ['MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)))', 'MultiPolygon'],
    ['GEOMETRYCOLLECTION (POINT (0 0))', 'GeometryCollection'],
  ]

  for (const [wkt, name] of shapes) {
    const geometry = Geometry.fromWkt(wkt)
    const klass = gdal[name]
    assert.equal(typeof klass, 'function', `${name} is exported`)
    assert.ok(geometry instanceof klass, `${wkt} is a ${name}`)
    // ... and still an instance of the base class, which is the one the generated
    // declarations name in every return type.
    assert.ok(geometry instanceof Geometry, `${wkt} is a Geometry`)
    assert.equal(geometry.constructor.name, name)
    // The native methods are reachable through the subclass prototype.
    assert.ok(geometry.toWkt().length > 0)
  }
  // The class comes off the type, so the dimensionality — which lives in the type
  // string — does not make a shape of its own.
  assert.equal(Geometry.fromWkt('POINT Z (1 2 3)').type, 'Point Z')
  assert.ok(Geometry.fromWkt('POINT Z (1 2 3)') instanceof gdal.Point)
  assert.ok(Geometry.fromWkt('POLYGON Z ((0 0 2, 1 0 2, 1 1 2, 0 0 2))') instanceof gdal.Polygon)

  // A ring is a `LineString` from the outside: rings are reported as coordinates here,
  // not as geometries, so nothing is ever tagged with this one. It exists so a port
  // naming it does not find it missing.
  assert.equal(typeof gdal.LinearRing, 'function')
  assert.ok(gdal.LinearRing.prototype instanceof Geometry)
  assert.equal(Geometry.fromWkt('POINT (1 2)') instanceof gdal.LinearRing, false)

  // The class is not a constructor: a geometry only ever comes from a factory or an
  // operation, which is what keeps the tag honest.
  assert.throws(() => new Geometry(), /not constructible/)
})

test('the operations re-tag what they answer, and leave the receiver alone', () => {
  const square = Geometry.fromWkt('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))')
  assert.ok(square instanceof gdal.Polygon)

  assert.ok(square.buffer(1) instanceof gdal.Polygon)
  assert.ok(square.centroid() instanceof gdal.Point)
  assert.ok(square.convexHull() instanceof gdal.Polygon)
  assert.ok(square.intersection(square) instanceof gdal.Polygon)
  assert.ok(square.union(square) instanceof gdal.Polygon)
  assert.ok(square.difference(square) instanceof gdal.Polygon)
  assert.ok(square.boundary() instanceof gdal.LineString)
  assert.ok(square.clone() instanceof gdal.Polygon)
  assert.ok(square.normalize() instanceof gdal.Polygon)
  assert.ok(square.simplify(0.5) instanceof gdal.Polygon)
  assert.ok(square.pointOnSurface() instanceof gdal.Point)
  assert.ok(square.flattenTo2D() instanceof gdal.Polygon)

  // The receiver keeps its own class, and the result of an operation can be operated
  // on in turn — the chain is what makes the tag worth having.
  assert.ok(square instanceof gdal.Polygon)
  assert.ok(square.buffer(1).centroid() instanceof gdal.Point)
  assert.ok(Geometry.fromWkt('POINT (1 2)').swapXY() instanceof gdal.Point)
  assert.ok(Geometry.fromWkt('LINESTRING (0 0, 0 10)').segmentize(1) instanceof gdal.LineString)

  // `children()` answers a list, and every one of them is tagged.
  const collection = Geometry.fromJson({
    type: 'GeometryCollection',
    geometries: [
      { type: 'Point', coordinates: [0, 0] },
      { type: 'Point', coordinates: [1, 1] },
    ],
  })
  assert.ok(collection instanceof gdal.GeometryCollection)
  for (const child of collection.children()) assert.ok(child instanceof gdal.Point)
})

test('the factories and the two members elsewhere that answer a geometry', () => {
  assert.ok(Geometry.fromWkt('POINT (1 2)') instanceof gdal.Point)
  assert.ok(Geometry.fromWkb(gdal.geometryToWkb({ type: 'Point', coordinates: [1, 2] })) instanceof gdal.Point)
  assert.ok(Geometry.fromJson({ type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] }) instanceof gdal.MultiPoint)
  // The multidimensional and programmatic paths are untouched by any of this.
  assert.equal(typeof gdal.geometryFromWkt, 'function')
  assert.equal(typeof Geometry.fromWkt, 'function')
  assert.equal(Geometry.fromWkt.length, 1)

  const dataset = gdal.createVectorSync(tmp('geometry-family.gpkg'), 'GPKG')
  const layer = dataset.createLayer({ name: 'things', geometryType: 'Polygon', epsg: 4326 })
  layer.setSpatialFilter(Geometry.fromWkt('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))'))
  assert.ok(layer.getSpatialFilter() instanceof gdal.Polygon)
  layer.setSpatialFilter(null)
  assert.equal(layer.getSpatialFilter(), null)

  const transform = new gdal.CoordinateTransform(
    gdal.SpatialRef.fromEpsg(4326),
    gdal.SpatialRef.fromEpsg(3857),
  )
  // `transformGeometry` is not one of them: it answers GeoJSON, like the free
  // factories, so the geometry you get out of it is read with `Geometry.fromJson`.
  const moved = transform.transformGeometry(Geometry.fromWkt('POINT (13.4 52.5)'))
  assert.deepEqual(Object.keys(moved).sort(), ['coordinates', 'type'])
  assert.ok(moved.coordinates[0] > 1_000_000)
  assert.ok(Geometry.fromJson(moved) instanceof gdal.Point)
  dataset.close()
})

test('the factories that answer GeoJSON are left that way', () => {
  // This is the design, not an oversight: `createFeature`, `updateFeature`,
  // `setSpatialFilter` and `FeatureRecord.geometry` all speak GeoJSON, so the free
  // factories do too, and a plain object handed a prototype it was never built with is
  // how a native method ends up called on the wrong receiver.
  for (const plain of [
    gdal.geometryFromWkt('POINT (1 2)'),
    gdal.geometryFromWkb(gdal.geometryToWkb({ type: 'Point', coordinates: [1, 2] })),
    Geometry.fromWkt('POINT (1 2)').toObject(),
    Geometry.fromWkt('POINT (1 2)').toJson(),
  ]) {
    assert.equal(Object.getPrototypeOf(plain), Object.prototype)
    assert.equal(plain instanceof Geometry, false)
    assert.equal(plain.toWkt, undefined)
  }
})

test('a plain GeoJSON geometry is left alone', () => {
  // The free factories answer GeoJSON by design — that is the shape `createFeature`
  // and `setSpatialFilter` take — and re-tagging one of those with a prototype it was
  // never built with is how a native method ends up called on the wrong receiver.
  const plain = gdal.geometryFromWkt('POINT (1 2)')
  assert.deepEqual(plain, { type: 'Point', coordinates: [1, 2] })
  assert.equal(Object.getPrototypeOf(plain), Object.prototype)
  assert.equal(plain instanceof Geometry, false)
  assert.equal(plain.toWkt, undefined)

  // ... and a feature's geometry is still GeoJSON, which is the documented shape of
  // `FeatureRecord.geometry` on this entry point.
  const dataset = gdal.createVectorSync(tmp('geometry-family-plain.gpkg'), 'GPKG')
  const layer = dataset.createLayer({ name: 'things', geometryType: 'Point', epsg: 4326 })
  layer.createFeature(Geometry.fromWkt('POINT (1 2)'), { name: 'a' })
  const [record] = layer.featuresSync()
  assert.deepEqual(record.geometry, { type: 'Point', coordinates: [1, 2] })
  // It is a `Geometry` the moment it is read as one.
  assert.ok(Geometry.fromJson(record.geometry) instanceof gdal.Point)
  dataset.close()
})
