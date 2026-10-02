import { describe, expect, it } from 'vitest'

import gdal from '../compat/index.js'
import { native, sampleVector, tmp } from './helpers.js'

// The vector surface: reads, the write forwarding, the schema, SQL and the
// collection shapes.
describe('vector', () => {
  it('reads layers, fields and features', () => {
    const path = sampleVector('ts-vector.gpkg')
    const dataset = gdal.open(path)
    expect(dataset.layers).toBeInstanceOf(gdal.DatasetLayers)
    expect(dataset.layers.count()).toBe(1)

    const layer = dataset.layers.get(1)!
    expect(layer).toBeInstanceOf(gdal.Layer)
    expect(layer.name).toBe('things')
    expect(layer.geomType).toBe('Point')
    expect(layer.ds).toBe(dataset)
    expect(layer.fidColumn).toBe('fid')
    expect(layer.geomColumn).toBe('geom')
    expect(layer.testCapability('FastFeatureCount')).toBeTypeOf('boolean')
    expect(layer.fields).toBeInstanceOf(gdal.LayerFields)
    expect(layer.fields.getNames()).toContain('name')
    expect(layer.fields.indexOf('name')).toBeGreaterThan(0)
    expect(layer.fields.get('name')?.fieldType).toBe('String')
    expect(layer.defn.name).toBe('things')
    expect(layer.defn.geomType).toBe('Point')
    expect(layer.defn.fields.getNames()).toEqual(layer.fields.getNames())
    expect(layer.extent).not.toBeNull()
    expect(layer.getExtent()?.minX).toBeCloseTo(1, 5)

    const feature = layer.features.first()!
    expect(feature).toBeInstanceOf(gdal.Feature)
    expect(feature.fid).toBeTypeOf('number')
    expect(feature.geometry).toBeInstanceOf(gdal.Point)
    expect(feature.fields.toObject()).toMatchObject({ name: 'alpha' })
    expect(feature.fields.get('population')).toBe(120)
    expect(feature.fields.names).toContain('name')
    expect(feature.fields.getNames()).toContain('name')
    expect(feature.fields.has('name')).toBe(true)
    expect(feature.fields.toArray().length).toBeGreaterThan(0)
    expect(feature.getGeometry()).toBeInstanceOf(gdal.Point)
    expect(feature.defn.name).toBe('things')
    expect(layer.features.get(feature.fid!)).toBeInstanceOf(gdal.Feature)
    expect(layer.features.get(9999)).toBeNull()
    dataset.close()
  })

  it('writes with add, set and remove', () => {
    const path = tmp('ts-vector-write.gpkg')
    const created = native.createVectorSync(path, 'GPKG')
    created.createLayer({ name: 'things', geometryType: 'Point', epsg: 4326 })
    created.close()

    const dataset = gdal.open(path, 'r+')
    const layer = dataset.layers.get(1)!
    // A bare geometry has no id to hand back, but the write lands.
    expect(layer.features.add(gdal.fromWKT('POINT (3 4)'), { name: 'a' })).toBeNull()
    expect(layer.features.count()).toBe(1)

    const feature = layer.features.first()!
    expect(feature.geometry?.toWKT()).toBe('POINT (3 4)')

    layer.features.set(feature.fid!, gdal.fromWKT('POINT (9 9)'))
    expect(layer.features.get(feature.fid!)?.geometry?.toWKT()).toBe('POINT (9 9)')

    feature.fields.set('name', 'b')
    expect(layer.features.get(feature.fid!)?.fields.get('name')).toBe('b')

    layer.features.remove(feature.fid!)
    expect(layer.features.count()).toBe(0)
    dataset.close()
  })

  it('grows and reorders the schema', () => {
    const path = sampleVector('ts-vector-schema.gpkg')
    const dataset = gdal.open(path, 'r+')
    const layer = dataset.layers.get(1)!
    const before = layer.fields.getNames()
    layer.fields.add({ name: 'extra', fieldType: 'Integer' })
    expect(layer.fields.getNames()).toContain('extra')
    expect(layer.fields.indexOf('extra')).toBe(layer.fields.getNames().length)
    layer.fields.reorder(['extra', ...before])
    expect(layer.fields.getNames()[0]).toBe('extra')
    layer.fields.remove('extra')
    expect(layer.fields.getNames()).toEqual(before)
    dataset.close()
  })

  it('creates a layer and runs SQL', async () => {
    const path = tmp('ts-vector-create.gpkg')
    const dataset = gdal.open(path, 'w', 'GPKG')
    const layer = dataset.layers.create('places', gdal.SpatialReference.fromEPSG(4326), 'Point')
    expect(layer).toBeInstanceOf(gdal.Layer)
    layer.features.add(gdal.fromWKT('POINT (1 1)'), { name: 'x' })
    dataset.close()

    const reopened = gdal.open(path)
    expect(reopened.layers.get(1)!.name).toBe('places')
    expect(reopened.executeSQL('SELECT * FROM places').length).toBe(1)
    expect((await reopened.executeSQLAsync('SELECT * FROM places')).length).toBe(1)
    reopened.close()
  })

  it('filters by attribute and geometry, and groups writes in a transaction', () => {
    const path = sampleVector('ts-vector-filters.gpkg')
    const dataset = gdal.open(path, 'r+')
    const layer = dataset.layers.get(1)!

    expect(layer.getSpatialFilter()).toBeNull()
    layer.setSpatialFilter(gdal.fromWKT('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))'))
    expect(layer.getSpatialFilter()).toBeInstanceOf(gdal.Polygon)
    layer.setSpatialFilter(null)

    layer.setAttributeFilter('population > 1000')
    expect(layer.features.count()).toBe(0)
    layer.setAttributeFilter(null)
    expect(layer.features.count()).toBe(1)

    layer.flush()
    dataset.close()
  })

  it('iterates `layer.features`, the reference\'s collection shape', () => {
    const path = sampleVector('ts-vector-iterate.gpkg')
    const dataset = gdal.open(path)
    const layer = dataset.layers.get(1)!
    const seen: gdal.Feature[] = []
    for (const feature of layer.features) seen.push(feature)
    expect(seen.length).toBe(1)
    expect(seen[0]).toBeInstanceOf(gdal.Feature)
    dataset.close()
  })

  it('copies a layer between two datasets', () => {
    const sourcePath = sampleVector('ts-vector-copy-src.gpkg')
    const targetPath = tmp('ts-vector-copy-dst.gpkg')
    const source = gdal.open(sourcePath)
    const target = gdal.open(targetPath, 'w', 'GPKG')
    const copied = target.layers.copy(source.layers.get(1)!, 'places')
    expect(copied.name).toBe('places')
    expect(copied.features.count()).toBe(1)
    source.close()
    target.close()
  })

  it('drops a layer by name', () => {
    const path = tmp('ts-vector-drop.gpkg')
    const dataset = gdal.open(path, 'w', 'GPKG')
    dataset.layers.create('one', gdal.SpatialReference.fromEPSG(4326), 'Point')
    dataset.layers.create('two', gdal.SpatialReference.fromEPSG(4326), 'Point')
    expect(dataset.layers.count()).toBe(2)
    dataset.layers.remove('one')
    expect(dataset.layers.count()).toBe(1)
    expect(dataset.layers.get(1)!.name).toBe('two')
    dataset.close()
  })
})
