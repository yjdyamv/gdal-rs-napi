// The `Geometry` class: an OGR geometry as an object, alongside the GeoJSON plain
// objects the rest of the binding exchanges. The two must agree — `toJson()`
// produces what `featuresSync()` would have put in a feature.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gdal, tmp } from './helpers.mjs'

const { Geometry } = gdal

test('the factories parse each of the three encodings', () => {
  const wkt = 'POINT (10 20)'

  const fromWkt = Geometry.fromWkt(wkt)
  assert.equal(fromWkt.type, 'Point')

  // WKB round-trips through `geometryToWkb`, the module-level helper.
  const fromWkb = Geometry.fromWkb(gdal.geometryToWkb({ type: 'Point', coordinates: [10, 20] }))
  assert.equal(fromWkb.toWkt(), wkt)

  // GeoJSON is the shape the rest of the binding speaks: this is a feature's
  // `geometry` going straight in.
  const fromJson = Geometry.fromJson({ type: 'Point', coordinates: [10, 20] })
  assert.equal(fromJson.toWkt(), wkt)

  // ... and every one of them is the same geometry.
  assert.equal(fromWkt.toJson().coordinates[0], 10)
  assert.deepEqual(fromJson.toObject(), { type: 'Point', coordinates: [10, 20] })

  // The module-level helper and the class agree, so neither is a second dialect.
  assert.equal(fromJson.toWkt(), gdal.geometryToWkt({ type: 'Point', coordinates: [10, 20] }))
})

test('a geometry reports its type, its points and its emptiness', () => {
  const point = Geometry.fromWkt('POINT (1 2)')
  assert.equal(point.type, 'Point')
  assert.equal(point.pointCount, 1)
  assert.equal(point.isEmpty, false)

  const line = Geometry.fromWkt('LINESTRING (0 0, 3 4)')
  assert.equal(line.pointCount, 2)

  // GDAL's own count does not walk into a polygon's rings, so this is 0 rather
  // than a number that looks like an answer.
  const ring = Geometry.fromWkt('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))')
  assert.equal(ring.type, 'Polygon')
  assert.equal(ring.pointCount, 0)

  assert.equal(Geometry.fromWkt('GEOMETRYCOLLECTION EMPTY').isEmpty, true)

  // A Z coordinate is part of the type name, as everywhere else here.
  assert.equal(Geometry.fromWkt('POINT (1 2 3)').type, 'Point Z')
})

test('area, length and envelope are the measurements that need no GEOS', () => {
  const square = Geometry.fromWkt('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))')
  assert.equal(square.area(), 100)
  assert.equal(square.length(), 40)
  assert.deepEqual(square.envelope(), { minX: 0, minY: 0, maxX: 10, maxY: 10 })

  // A line has length and no area; a point has neither.
  const line = Geometry.fromWkt('LINESTRING (0 0, 3 4)')
  assert.equal(line.length(), 5)
  assert.equal(line.area(), 0)

  assert.equal(Geometry.fromWkt('POINT (1 2)').length(), 0)

  // An empty geometry has no box to report — `null`, not a box of zeros.
  assert.equal(Geometry.fromWkt('POINT EMPTY').envelope(), null)
})

test('the transforms return a new geometry and leave the original alone', () => {
  const original = Geometry.fromWkt('POINT (1 2 3)')
  const flat = original.flattenTo2D()

  assert.equal(flat.toWkt(), 'POINT (1 2)')
  assert.equal(original.toWkt(), 'POINT (1 2 3)', 'the original kept its Z')

  const swapped = Geometry.fromWkt('POINT (1 2)').swapXY()
  assert.equal(swapped.toWkt(), 'POINT (2 1)')

  const dense = Geometry.fromWkt('LINESTRING (0 0, 0 10)').segmentize(1)
  assert.equal(dense.pointCount, 11, 'a 10-unit segment cut at every unit')

  const copy = original.clone()
  assert.equal(copy.toWkt(), original.toWkt())
  assert.notEqual(copy, original)
})

test('transform moves a geometry between two named CRSs', () => {
  // A geometry carries no CRS of its own, so both ends are named.
  const point = Geometry.fromJson({ type: 'Point', coordinates: [13.4, 52.5] })
  const moved = point.transform(gdal.SpatialRef.fromEpsg(4326), gdal.SpatialRef.fromEpsg(3857))

  const [x, y] = moved.toJson().coordinates
  // Berlin in Web Mercator, to within a kilometre or so — the exact metres are
  // PROJ's business, not this test's.
  assert.ok(Math.abs(x - 1_491_563) < 1000, `x was ${x}`)
  assert.ok(Math.abs(y - 6_891_042) < 1000, `y was ${y}`)

  // The original did not move.
  assert.deepEqual(point.toJson().coordinates, [13.4, 52.5])
})

test('a geometry from a feature is the same shape the feature carried', () => {
  const path = tmp('geometry-feature.gpkg')
  const dataset = gdal.createVectorSync(path, 'GPKG')
  const layer = dataset.createLayer({ name: 'things', geometryType: 'Point', epsg: 4326 })
  layer.createFeature({ type: 'Point', coordinates: [1, 2] }, { name: 'a' })

  const [record] = layer.featuresSync()
  const geometry = Geometry.fromJson(record.geometry)
  assert.equal(geometry.toWkt(), 'POINT (1 2)')
  // ... and back out again, which is the round trip the two worlds need.
  assert.deepEqual(geometry.toJson(), record.geometry)

  dataset.close()
})

test('a malformed input is refused at the call, not accepted as an empty geometry', () => {
  assert.throws(() => Geometry.fromWkt('NOT A GEOMETRY'), /Geometry|WKT|parse/i)
  assert.throws(() => Geometry.fromJson({ type: 'Nonsense' }), /Unsupported geometry type/)
  assert.throws(() => Geometry.fromWkt('POINT (1 2)').segmentize(0), /greater than zero/)
})
