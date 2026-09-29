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

test('a Geometry object goes wherever a GeoJSON geometry goes', () => {
  const path = tmp('geometry-accepted.gpkg')
  const dataset = gdal.createVectorSync(path, 'GPKG')
  const layer = dataset.createLayer({ name: 'things', geometryType: 'Point', epsg: 4326 })

  // createFeature takes either shape, in the same layer.
  layer.createFeature(Geometry.fromJson({ type: 'Point', coordinates: [1, 2] }), { name: 'a' })
  layer.createFeature({ type: 'Point', coordinates: [100, 100] }, { name: 'b' })
  assert.equal(layer.featuresSync().length, 2)

  // setSpatialFilter takes either shape and narrows identically.
  layer.setSpatialFilter(Geometry.fromWkt('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))'))
  assert.equal(layer.featuresSync().length, 1)
  layer.setSpatialFilter(null)
  assert.equal(layer.featuresSync().length, 2)

  // updateFeature takes either shape.
  const [first] = layer.featuresSync()
  layer.updateFeature(first.fid, Geometry.fromJson({ type: 'Point', coordinates: [5, 6] }))
  assert.deepEqual(layer.feature(first.fid).geometry, { type: 'Point', coordinates: [5, 6] })

  // ... and so does Feature.setGeometry.
  const feature = layer.getFeature(first.fid)
  feature.setGeometry(Geometry.fromWkt('POINT (7 8)'))
  assert.deepEqual(layer.feature(first.fid).geometry, { type: 'Point', coordinates: [7, 8] })
  feature.setGeometry({ type: 'Point', coordinates: [9, 9] })
  assert.deepEqual(layer.feature(first.fid).geometry, { type: 'Point', coordinates: [9, 9] })

  // rasterize takes both shapes in one call, which is the point of the overload.
  const raster = gdal.createSync(tmp('geometry-rasterize.tif'), {
    driver: 'GTiff',
    width: 10,
    height: 10,
    bandCount: 1,
    dataType: 'Uint8',
  })
  raster.rasterizeSync(
    [
      Geometry.fromWkt('POLYGON ((0 0, 5 0, 5 5, 0 5, 0 0))'),
      { type: 'Polygon', coordinates: [[[5, 5], [10, 5], [10, 10], [5, 10], [5, 5]]] },
    ],
    { burnValues: [1, 2] },
  )
  assert.equal(raster.band(0).getPixel(1, 1), 1)
  assert.equal(raster.band(0).getPixel(6, 6), 2)
  raster.close()

  // CoordinateTransform.transformGeometry takes either shape.
  const transform = new gdal.CoordinateTransform(
    gdal.SpatialRef.fromEpsg(4326),
    gdal.SpatialRef.fromEpsg(3857),
  )
  const moved = transform.transformGeometry(Geometry.fromWkt('POINT (13.4 52.5)'))
  assert.equal(moved.type, 'Point')
  assert.ok(moved.coordinates[0] > 1_000_000)

  dataset.close()
})

test('the shape-specific accessors answer for their shape, and are null otherwise', () => {
  const point = Geometry.fromWkt('POINT (3 4)')
  assert.equal(point.x, 3)
  assert.equal(point.y, 4)
  assert.equal(point.z, null, 'a 2D point reports no z rather than 0')
  assert.deepEqual(point.coordinates, [3, 4])
  assert.deepEqual(point.points(), [[3, 4]])
  // The accessors that belong to other shapes are null, not wrong answers.
  assert.equal(point.rings(), null)
  assert.equal(point.exteriorRing, null)
  assert.equal(point.interiorRings, null)
  assert.equal(point.children(), null)

  // A Z point carries it, and says so in every form.
  const zPoint = Geometry.fromWkt('POINT Z (3 4 5)')
  assert.equal(zPoint.z, 5)
  assert.deepEqual(zPoint.coordinates, [3, 4, 5])
  assert.deepEqual(zPoint.points(), [[3, 4, 5]])

  const line = Geometry.fromWkt('LINESTRING (0 0, 1 1, 2 0)')
  assert.deepEqual(line.points(), [[0, 0], [1, 1], [2, 0]])
  assert.equal(line.x, null)
  assert.equal(line.coordinates.length, 3)

  // A `LinearRing` has no WKT spelling of its own — GDAL's WKT reader rejects
  // `LINEARRING (…)` — so a ring is only ever reached through the polygon that
  // owns it, which is what `exteriorRing` and `interiorRings` are for.
})

test('a polygon reports its rings, exterior first', () => {
  const polygon = Geometry.fromWkt(
    'POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0), (1 1, 2 1, 2 2, 1 2, 1 1))',
  )

  assert.equal(polygon.points(), null, 'a polygon has rings, not a point list')
  assert.equal(polygon.rings().length, 2)
  assert.deepEqual(polygon.rings()[0], polygon.exteriorRing)
  assert.deepEqual(polygon.exteriorRing, [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]])
  assert.deepEqual(polygon.interiorRings, [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]])

  // No holes is an empty list — an answer, not an absence.
  const solid = Geometry.fromWkt('POLYGON ((0 0, 1 0, 1 1, 0 0))')
  assert.deepEqual(solid.interiorRings, [])
  assert.equal(solid.exteriorRing.length, 4)
})

test('a collection hands out its parts as geometries', () => {
  const multi = Geometry.fromWkt('MULTIPOINT ((0 0), (1 1))')
  const points = multi.children()
  assert.equal(points.length, 2)
  assert.ok(points[0] instanceof Geometry, 'parts are Geometry objects')
  assert.equal(points[0].x, 0)
  assert.deepEqual(points[1].coordinates, [1, 1])
  // A collection's coordinates are geometries, so the coordinate accessor steps
  // aside rather than inventing a nesting the caller has to guess at.
  assert.equal(multi.coordinates, null)
  assert.equal(multi.points(), null)

  const collection = Geometry.fromJson({
    type: 'GeometryCollection',
    geometries: [
      { type: 'Point', coordinates: [0, 0] },
      { type: 'LineString', coordinates: [[0, 0], [2, 2]] },
    ],
  })
  const parts = collection.children()
  assert.deepEqual(parts.map((part) => part.type), ['Point', 'LineString'])
  // The parts are independent copies, so they carry their own accessors.
  assert.deepEqual(parts[1].points(), [[0, 0], [2, 2]])
  assert.equal(parts[1].area(), 0)

  // A single geometry has no parts.
  assert.equal(Geometry.fromWkt('POINT (1 1)').children(), null)
})

test('the GEOS operations answer, or say why they cannot', () => {
  const a = Geometry.fromWkt('POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))')
  const b = Geometry.fromWkt('POLYGON ((1 1, 3 1, 3 3, 1 3, 1 1))')

  if (!gdal.features().geos) {
    // The default build. A clear refusal is the contract: `false` would look like
    // an answer, and a TypeError would look like a bug. `features().geos` is how
    // a caller branches before getting here at all.
    for (const call of [
      () => a.intersects(b),
      () => a.disjoint(b),
      () => a.distance(b),
      () => a.isValid(),
      () => a.buffer(1),
      () => a.centroid(),
      () => a.convexHull(),
      () => a.simplify(0.1),
      () => a.union(b),
    ]) {
      assert.throws(call, /no GEOS/)
    }
    return
  }

  // A GEOS build. The same calls, now with answers.
  assert.equal(a.intersects(b), true)
  assert.equal(a.disjoint(b), false)
  assert.equal(a.equals(a.clone()), true)
  assert.equal(a.contains(Geometry.fromWkt('POINT (1 1)')), true)
  assert.equal(a.isValid(), true)
  assert.equal(a.isSimple(), true)

  // The set algebra returns real geometries, which is the round trip through a
  // C-owned handle that `adopt` exists for.
  assert.ok(Math.abs(a.intersection(b).area() - 1) < 1e-9)
  assert.ok(Math.abs(a.union(b).area() - 7) < 1e-9)
  assert.ok(Math.abs(a.difference(b).area() - 3) < 1e-9)
  assert.equal(a.centroid().type, 'Point')
  assert.equal(a.convexHull().type, 'Polygon')
  assert.ok(a.buffer(1).area() > 4, 'a buffer covers more than the original')
  assert.equal(a.simplify(0.1).type, 'Polygon')
  assert.ok(a.distance(b) >= 0)
})

test('a malformed input is refused at the call, not accepted as an empty geometry', () => {
  assert.throws(() => Geometry.fromWkt('NOT A GEOMETRY'), /Geometry|WKT|parse/i)
  assert.throws(() => Geometry.fromJson({ type: 'Nonsense' }), /Unsupported geometry type/)
  assert.throws(() => Geometry.fromWkt('POINT (1 2)').segmentize(0), /greater than zero/)
})
