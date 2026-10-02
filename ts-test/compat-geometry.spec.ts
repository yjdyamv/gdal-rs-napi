import { describe, expect, it } from 'vitest'

import gdal from '../compat/index.js'
import { native } from './helpers.js'

// The geometry class family, the value operations, the GEOS surface and the two
// envelope classes. `instanceof` is the half a port depends on, so it is asserted
// at every factory and every operation that answers a geometry.
describe('geometry', () => {
  it('answers the class its type names, from every factory', () => {
    const point = gdal.fromWKT('POINT (1 2)')
    expect(point).toBeInstanceOf(gdal.Geometry)
    expect(point).toBeInstanceOf(gdal.Point)
    expect(point.type).toBe('Point')
    expect(point.x).toBe(1)
    expect(point.y).toBe(2)
    expect(point.z).toBeNull()
    expect(point.toWKT()).toBe('POINT (1 2)')
    expect(point.toJSON()).toEqual({ type: 'Point', coordinates: [1, 2] })

    expect(gdal.fromWKB(native.geometryToWkb(point.toJSON())).type).toBe('Point')
    expect(gdal.Geometry.fromWKT('POINT (1 2)')).toBeInstanceOf(gdal.Point)
    expect(
      gdal.Geometry.fromWKB(native.geometryToWkb({ type: 'Point', coordinates: [1, 2] })),
    ).toBeInstanceOf(gdal.Point)
    expect(gdal.Geometry.fromGeoJson({ type: 'Point', coordinates: [1, 2] })).toBeInstanceOf(
      gdal.Point,
    )
    expect(
      gdal.Geometry.fromGeoJsonBuffer(
        Buffer.from(JSON.stringify({ type: 'Point', coordinates: [1, 2] })),
      ).toWKT(),
    ).toBe('POINT (1 2)')
    expect(gdal.geometryFromWKT('POINT (1 2)').type).toBe('Point')
    expect(gdal.fromJSON({ type: 'Point', coordinates: [1, 2] }).type).toBe('Point')
    expect(gdal.fromObject({ type: 'Point', coordinates: [1, 2] }).type).toBe('Point')
    expect(gdal.geometryFromWKB(native.geometryToWkb(point.toJSON())).type).toBe('Point')
    expect(gdal.geometryFromJSON({ type: 'Point', coordinates: [1, 2] }).type).toBe('Point')
  })

  it('reads the shape-specific accessors, and answers null for the wrong shape', () => {
    const line = gdal.fromWKT('LINESTRING (0 0, 1 1)')
    expect(line).toBeInstanceOf(gdal.LineString)
    expect(line.points()).toEqual([
      [0, 0],
      [1, 1],
    ])
    expect(line.rings()).toBeNull()
    expect(line.pointCount).toBe(2)

    const polygon = gdal.fromWKT('POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0))')
    expect(polygon).toBeInstanceOf(gdal.Polygon)
    expect(polygon.rings()?.length).toBe(1)
    expect(polygon.exteriorRing?.length).toBe(5)
    expect(polygon.interiorRings).toEqual([])
    expect(polygon.points()).toBeNull()
    expect(polygon.area()).toBe(16)
    expect(polygon.length()).toBe(16)

    const multi = gdal.fromWKT('MULTIPOINT ((0 0), (1 1))')
    expect(multi).toBeInstanceOf(gdal.MultiPoint)
    expect(multi.children()?.length).toBe(2)
    expect(multi.children()?.[0]).toBeInstanceOf(gdal.Point)

    const collection = gdal.fromWKT('GEOMETRYCOLLECTION (POINT (0 0))')
    expect(collection).toBeInstanceOf(gdal.GeometryCollection)
    expect(collection.children()?.length).toBe(1)
  })

  it('returns new geometries from the value operations', () => {
    const point = gdal.fromWKT('POINT (1 2 3)')
    expect(point.flattenTo2D().toWKT()).toBe('POINT (1 2)')
    expect(point.z).toBe(3)
    expect(gdal.fromWKT('LINESTRING (0 0, 0 10)').segmentize(1).pointCount).toBe(11)
    expect(gdal.fromWKT('POINT (1 2)').swapXY().toWKT()).toBe('POINT (2 1)')
    expect(point.clone()).not.toBe(point)
    expect(gdal.fromWKT('POINT (1 2)').isEmpty).toBe(false)
  })

  it('moves a geometry between two CRSs', () => {
    const wgs84 = gdal.SpatialReference.fromEPSG(4326)
    const webMercator = gdal.SpatialReference.fromEPSG(3857)
    const moved = gdal.fromWKT('POINT (13.4 52.5)').transform(wgs84, webMercator)
    expect(moved).toBeInstanceOf(gdal.Point)
    expect(Math.abs((moved.x ?? 0) - 1_491_000)).toBeLessThan(20_000)
  })

  it('answers the GEOS predicates and set algebra', () => {
    const square = gdal.fromWKT('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))')
    const inner = gdal.fromWKT('POLYGON ((1 1, 2 1, 2 2, 1 2, 1 1))')
    expect(square.intersects(inner)).toBe(true)
    expect(square.contains(inner)).toBe(true)
    expect(inner.within(square)).toBe(true)
    expect(square.disjoint(inner)).toBe(false)
    expect(square.touches(inner)).toBe(false)
    expect(square.overlaps(inner)).toBe(false)
    expect(square.crosses(inner)).toBe(false)
    expect(square.equals(gdal.fromWKT('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))'))).toBe(true)
    expect(square.isValid()).toBe(true)
    expect(square.isSimple()).toBe(true)
    expect(square.isRing()).toBe(false)
    expect(typeof square.distance(inner)).toBe('number')

    expect(square.buffer(1)).toBeInstanceOf(gdal.Polygon)
    expect(square.centroid()).toBeInstanceOf(gdal.Point)
    expect(square.convexHull()).toBeInstanceOf(gdal.Polygon)
    expect(square.concaveHull(0.5)).toBeInstanceOf(gdal.Polygon)
    expect(square.simplify(0.1)).toBeInstanceOf(gdal.Polygon)
    expect(square.simplifyPreserveTopology(0.1)).toBeInstanceOf(gdal.Polygon)
    expect(square.union(inner)).toBeInstanceOf(gdal.Polygon)
    expect(square.intersection(inner)).toBeInstanceOf(gdal.Polygon)
    expect(square.difference(inner)).toBeInstanceOf(gdal.Polygon)
    expect(square.symDifference(inner)).toBeInstanceOf(gdal.Polygon)
    expect(square.makeValid()).toBeInstanceOf(gdal.Polygon)
    expect(square.boundary()).toBeTruthy()
    expect(square.pointOnSurface()).toBeInstanceOf(gdal.Point)
    expect(square.normalize()).toBeInstanceOf(gdal.Polygon)
    expect(square.setPrecision(1)).toBeInstanceOf(gdal.Polygon)
    expect(square.unaryUnion()).toBeInstanceOf(gdal.Polygon)
    expect(
      gdal
        .fromWKT('MULTIPOLYGON (((0 0, 1 0, 1 1, 0 1, 0 0)), ((1 0, 2 0, 2 1, 1 1, 1 0)))')
        .unionCascaded(),
    ).toBeInstanceOf(gdal.Polygon)
  })

  it('encodes to GML and KML without GEOS', () => {
    const point = gdal.fromWKT('POINT (1 2)')
    expect(point.toGML()).toContain('Point')
    expect(point.toKML()).toContain('Point')
    expect(point.toWKB()).toBeInstanceOf(Uint8Array)
  })

  it('Envelope merges, intersects and becomes a polygon', () => {
    const box = new gdal.Envelope({ minX: 0, minY: 0, maxX: 2, maxY: 2 })
    expect(box.isEmpty()).toBe(false)
    expect(new gdal.Envelope().isEmpty()).toBe(true)
    expect(box.contains(new gdal.Envelope({ minX: 1, minY: 1, maxX: 1, maxY: 1 }))).toBe(true)
    expect(box.intersects(new gdal.Envelope({ minX: 1, minY: 1, maxX: 5, maxY: 5 }))).toBe(true)
    const merged = new gdal.Envelope().merge(box).merge(new gdal.Envelope({ minX: -1, maxX: 0, minY: -1, maxY: 0 }))
    expect(merged.minX).toBe(-1)
    const intersected = new gdal.Envelope({ minX: 0, minY: 0, maxX: 2, maxY: 2 }).intersect(
      new gdal.Envelope({ minX: 1, minY: 1, maxX: 3, maxY: 3 }),
    )
    expect(intersected.maxX).toBe(2)
    expect(box.toPolygon()).toBeInstanceOf(gdal.Polygon)
  })

  it('Envelope3D extends the box with Z', () => {
    const box = new gdal.Envelope3D({ minX: 0, minY: 0, maxX: 1, maxY: 1, minZ: -1, maxZ: 1 })
    expect(box.minZ).toBe(-1)
    expect(box.contains(new gdal.Envelope3D({ minX: 0, minY: 0, maxX: 1, maxY: 1, minZ: 0, maxZ: 0 }))).toBe(true)
    expect(box.intersects(new gdal.Envelope3D({ minX: 0, minY: 0, maxX: 1, maxY: 1, minZ: 2, maxZ: 3 }))).toBe(false)
  })

  it('refuses a malformed WKT rather than answering an empty geometry', () => {
    expect(() => gdal.fromWKT('NOT A GEOMETRY')).toThrow()
  })
})
