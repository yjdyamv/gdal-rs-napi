import { describe, expect, it } from 'vitest'

import gdal from '../compat/index.js'
import { native, sampleRaster, sampleVector, tmp } from './helpers.js'

// The per-class reachability the union-based coverage count cannot see: every
// member gdal-async documents on a class, exercised through a real `compat`
// object. It is the regression guard for the gaps the review found — band
// algebra and async getters, the GCP surface, the collections' async twins,
// `clampBlock`, `DatasetBands.create`, the geometry async twins and the rest.

describe('RasterBand async getters', () => {
  it('answers every read-only property off the thread pool', async () => {
    const dataset = gdal.open(sampleRaster('ts-reach-band.tif', 8, 6))
    const band = dataset.bands.get(1)!

    expect(await band.sizeAsync).toEqual({ x: 8, y: 6 })
    expect(await band.blockSizeAsync).toEqual(band.blockSize)
    expect(await band.dataTypeAsync).toBe(band.dataType)
    expect(await band.colorInterpretationAsync).toBe(band.colorInterpretation)
    expect(await band.descriptionAsync).toBe(band.description)
    expect(await band.unitTypeAsync).toBe(band.unitType)
    expect(await band.noDataValueAsync).toBe(band.noDataValue)
    expect(await band.scaleAsync).toBe(band.scale)
    expect(await band.offsetAsync).toBe(band.offset)
    expect(await band.minimumAsync).toBe(band.minimum)
    expect(await band.maximumAsync).toBe(band.maximum)
    expect(await band.idAsync).toBe(band.id)
    expect(await band.readOnlyAsync).toBe(band.readOnly)
    expect(await band.hasArbitraryOverviewsAsync).toBe(band.hasArbitraryOverviews)
    expect(await band.categoryNamesAsync).toEqual(band.categoryNames)

    expect(band.ds).toBe(dataset)
    dataset.close()
  })
})

describe('RasterBand algebra through compat', () => {
  it('wraps every operator and its async twin', async () => {
    const dataset = gdal.open(sampleRaster('ts-reach-algebra.tif', 4, 4))
    const band = dataset.bands.get(1)!

    for (const name of ['add', 'sub', 'mul', 'div', 'pow', 'eq', 'notEq', 'lt', 'lte', 'gt', 'gte', 'and', 'or']) {
      const direct = (band as any)[name](1)
      expect(direct).toBeInstanceOf(gdal.RasterBand)
      expect(direct.pixels.get(0, 0)).toBeTypeOf('number')
      expect(await (band as any)[`${name}Async`](1)).toBeInstanceOf(gdal.RasterBand)
    }
    for (const name of ['abs', 'sqrt', 'log', 'log10', 'not']) {
      expect((band as any)[name]()).toBeInstanceOf(gdal.RasterBand)
      expect(await (band as any)[`${name}Async`]()).toBeInstanceOf(gdal.RasterBand)
    }
    expect(band.ifThenElse(1, 0)).toBeInstanceOf(gdal.RasterBand)
    expect(await band.ifThenElseAsync(1, 0)).toBeInstanceOf(gdal.RasterBand)

    // A result band belongs to the in-memory dataset it was computed into, and
    // `ds` wraps that lazily on the compat side.
    const derived = band.add(1)
    expect(derived.ds).toBeInstanceOf(gdal.Dataset)
    derived.ds!.close()

    const converted = band.asType('GDT_Float64')
    expect(converted).toBeInstanceOf(gdal.RasterBand)
    expect(converted.dataType).toBe(gdal.GDT_Float64)
    expect(await band.asTypeAsync('GDT_Float64')).toBeInstanceOf(gdal.RasterBand)

    // Both `setStatistics` shapes, and the stored pair read back.
    band.setStatistics(0, 10, 5, 1)
    expect(band.getStatistics(false, false)?.min).toBe(0)
    band.setStatistics({ min: 1, max: 9, mean: 4, stdDev: 2 })
    expect(band.getStatistics(false, false)?.max).toBe(9)

    dataset.close()
  })
})

describe('Dataset GCPs and async getters', () => {
  it('reads and writes ground control points', async () => {
    const dataset = gdal.open(sampleRaster('ts-reach-gcp.tif', 4, 4))
    const gcps = [
      { id: '1', info: 'SW', pixel: 0, line: 0, x: 0, y: 4, z: 0 },
      { id: '2', info: 'NE', pixel: 4, line: 4, x: 4, y: 0, z: 0 },
    ]
    dataset.setGCPs(gcps, native.epsgToWkt(4326))
    expect(dataset.getGCPs().length).toBe(2)
    expect(dataset.getGCPProjection()).toContain('4326')
    expect(await dataset.rasterSizeAsync).toEqual({ x: 4, y: 4 })
    expect(await dataset.geoTransformAsync).toEqual(dataset.geoTransform)
    dataset.close()
  })
})

describe('collections and their back-references', () => {
  it('answers ds, countAsync, getAsync and the async iterator', async () => {
    const dataset = gdal.open(sampleVector('ts-reach-collections.gpkg'))
    const layer = dataset.layers.get(1)!

    expect(dataset.bands.ds).toBe(dataset)
    expect(dataset.layers.ds).toBe(dataset)
    expect(await dataset.layers.getAsync(1)).toBe(layer)
    expect(await dataset.layers.countAsync()).toBe(1)
    expect(await dataset.layers.countAsync((_error: Error | null) => {})).toBeUndefined()

    const names: string[] = []
    for await (const item of dataset.layers) names.push((item as any).name)
    expect(names).toEqual(['things'])
    dataset.close()
  })

  it('gives the bands collection an envelope and an AddBand', async () => {
    const dataset = gdal.open(sampleRaster('ts-reach-envelope.tif', 4, 4))
    const envelope = dataset.bands.getEnvelope()
    expect(envelope).toBeInstanceOf(gdal.Envelope)
    expect(envelope!.maxX - envelope!.minX).toBe(4)
    dataset.close()

    const memory = gdal.open('', 'w', 'MEM', 2, 2, 1, 'GDT_Byte')
    const added = memory.bands.create('GDT_Float32')
    expect(added).toBeInstanceOf(gdal.RasterBand)
    expect(added.dataType).toBe(gdal.GDT_Float32)
    expect(memory.bands.count()).toBe(2)
    const asyncAdded = await memory.bands.createAsync(gdal.GDT_Int16)
    expect(asyncAdded).toBeInstanceOf(gdal.RasterBand)
    expect(memory.bands.count()).toBe(3)
    memory.close()
  })

  it('gives overviews their async twins', async () => {
    const dataset = gdal.open(sampleRaster('ts-reach-overviews.tif', 16, 16))
    dataset.bands.get(1)!.overviews // a plain read is enough for an empty pyramid
    dataset.buildOverviews({ levels: [2] })
    const overviews = dataset.bands.get(1)!.overviews
    expect(overviews.count()).toBe(1)
    expect(await overviews.countAsync()).toBe(1)
    expect(await overviews.getAsync(1)).toBe(overviews.get(1))
    expect(await overviews.getBySampleCountAsync(16)).toBeTruthy()
    dataset.close()
  })
})

describe('the pixel accessors', () => {
  it('has clampBlock, getAsync, setAsync and its band back-reference', async () => {
    const path = sampleRaster('ts-reach-pixels.tif', 5, 5)
    const dataset = gdal.open(path, 'r+')
    const band = dataset.bands.get(1)!
    const pixels = band.pixels

    expect(pixels.band).toBe(band)
    await pixels.setAsync(0, 0, 7)
    expect(await pixels.getAsync(0, 0)).toBe(7)

    const block = band.blockSize
    const size = band.size
    const x = size.x - 1
    const y = size.y - 1
    const originX = Math.floor(x / block.x) * block.x
    const originY = Math.floor(y / block.y) * block.y
    expect(pixels.clampBlock(x, y)).toEqual({
      x: Math.min(block.x, size.x - originX),
      y: Math.min(block.y, size.y - originY),
    })
    expect(await pixels.clampBlockAsync(0, 0)).toEqual({
      x: Math.min(block.x, size.x),
      y: Math.min(block.y, size.y),
    })
    expect(() => pixels.clampBlock(size.x, 0)).toThrow(/outside/)
    dataset.close()
  })
})

describe('the geometry surface', () => {
  const box = () => gdal.fromWKT('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))')

  it('answers the properties the reference documents', () => {
    const point = gdal.fromWKT('POINT (1 2)')
    expect(point.wkbSize).toBe(point.toWKB().length)
    expect(point.coordinateDimension).toBe(2)
    expect(gdal.fromWKT('POINT Z (1 2 3)').coordinateDimension).toBe(3)
    expect(point.dimension).toBe(0)
    expect(gdal.fromWKT('LINESTRING (0 0, 1 1)').dimension).toBe(1)
    expect(box().dimension).toBe(2)
    const collection = gdal.fromWKT('GEOMETRYCOLLECTION (POINT (0 0), LINESTRING (0 0, 1 1))')
    expect(collection.dimension).toBe(1)
  })

  it('answers every async predicate twin', async () => {
    const line = gdal.fromWKT('LINESTRING (-1 5, 20 5)')
    const point = gdal.fromWKT('POINT (5 5)')
    expect(await point.isEmptyAsync()).toBe(false)
    expect(await box().isValidAsync()).toBe(true)
    expect(await gdal.fromWKT('LINESTRING (0 0, 1 1)').isSimpleAsync()).toBe(true)
    const ring = gdal.fromWKT('LINESTRING (0 0, 1 0, 1 1, 0 0)')
    expect(await ring.isRingAsync()).toBe(true)
    expect(await box().intersectsAsync(line)).toBe(true)
    expect(await box().containsAsync(point)).toBe(true)
    expect(await point.withinAsync(box())).toBe(true)
    expect(await gdal.fromWKT('LINESTRING (0 0, 10 10)').crossesAsync(gdal.fromWKT('LINESTRING (0 10, 10 0)'))).toBe(true)
    expect(await box().touchesAsync(gdal.fromWKT('LINESTRING (10 0, 10 10)'))).toBe(true)
    expect(await box().equalsAsync(box())).toBe(true)
  })

  it('covers the builder async twins', async () => {
    const polygon = box()
    await polygon.closeRingsAsync()
    const line = gdal.fromWKT('LINESTRING (0 0, 1 1)')
    await line.emptyAsync()
    expect(line.isEmpty).toBe(true)
  })

  it('creates, names and parses geometries', async () => {
    const empty = gdal.Geometry.create(1)
    expect(empty).toBeInstanceOf(gdal.Point)
    expect(gdal.Geometry.create('LineString')).toBeInstanceOf(gdal.LineString)
    expect(() => gdal.Geometry.create(999)).toThrow(/no geometry type/)
    expect(gdal.Geometry.getName(1)).toBe('Point')
    expect(gdal.Geometry.getName(3)).toBe('Polygon')
    expect(gdal.Geometry.getName(999)).toBeNull()

    const json = { type: 'Point', coordinates: [1, 2] }
    expect(gdal.Geometry.fromGeoJson(json).toWKT()).toBe('POINT (1 2)')
    expect(await gdal.Geometry.fromGeoJsonAsync(json)).toBeInstanceOf(gdal.Point)
    const buffer = Buffer.from(JSON.stringify(json))
    expect(gdal.Geometry.fromGeoJsonBuffer(buffer).toWKT()).toBe('POINT (1 2)')
    expect(await gdal.Geometry.fromGeoJsonBufferAsync(buffer)).toBeInstanceOf(gdal.Point)
  })

  it('transforms through a CoordinateTransformation, and refuses transformTo', async () => {
    const transformation = new gdal.CoordinateTransformation(
      gdal.SpatialReference.fromEPSG(4326),
      gdal.SpatialReference.fromEPSG(3857),
    )
    const source = () => gdal.fromWKT('POINT (13.4 52.5)')
    const moved = source().transform(transformation)
    expect(moved.x).not.toBeCloseTo(13.4, 3)
    expect(await source().transformAsync(transformation)).toBeInstanceOf(gdal.Point)

    const target = gdal.SpatialReference.fromEPSG(3857)
    expect(() => source().transformTo(target)).toThrow(/source CRS/)
    await expect(source().transformToAsync(target)).rejects.toThrow(/source CRS/)
  })
})

describe('features, fields and definitions', () => {
  it('answers the feature extras and the definition links', async () => {
    const dataset = gdal.open(sampleVector('ts-reach-features.gpkg'), 'r+')
    const layer = dataset.layers.get(1)!
    const feature = layer.features.first()!

    expect(feature.fields.feature).toBe(feature)
    expect(feature.fields.indexOf('population')).toBe(2)
    expect(feature.fields.indexOf('nope')).toBe(-1)
    expect(feature.fields.map((_value: any, name: string) => name)).toEqual(feature.fields.names)
    expect(JSON.parse(feature.fields.toJSON())).toEqual(feature.fields.toObject())

    const clone = feature.clone()
    expect(clone).toBeInstanceOf(gdal.Feature)
    expect(feature.equals(clone)).toBe(true)
    expect(feature.equals({} as any)).toBe(false)
    feature.destroy()

    // A feature from a second handle compares by content; a bogus id has no record.
    const second = gdal.open(sampleVector('ts-reach-features-2.gpkg'))
    const twin = second.layers.get(1)!.features.first()!
    expect(feature.equals(twin)).toBe(true)
    expect(feature.equals(new (gdal.Feature as any)(layer, 999))).toBe(false)
    second.close()

    // `setFrom` copies fields through an index map and a geometry.
    layer.features.add({ type: 'Point', coordinates: [9, 9] }, { name: 'beta', population: 5 })
    const other = layer.features.last()!
    const target = layer.features.get(feature.fid!)!
    target.setFrom(other)
    expect(target.fields.get('name')).toBe('beta')
    expect(() => target.setFrom(null as any)).toThrow(TypeError)
    target.setFrom({ name: 'gamma', population: 1 }, [1, -1], true)
    expect(target.fields.get('name')).toBe('gamma')
    target.setFrom({ name: 'delta', population: 2 }, [1, 3], true)
    expect(target.fields.get('name')).toBe('delta')
    expect(() => target.setFrom({ nope: 1 })).toThrow(/no field/)

    target.fields.reset({ name: 'epsilon' })
    expect(target.fields.get('name')).toBe('epsilon')
    target.fields.reset()
    expect(target.fields.get('name')).toBeNull()

    const defn = layer.defn
    expect(defn.fields.featureDefn).toBe(defn)
    expect(defn.clone()).toBeInstanceOf(gdal.FeatureDefn)

    const features = layer.features
    expect(features.last()).toBeInstanceOf(gdal.Feature)
    expect(features.previous()).toBeNull()
    expect(await features.firstAsync()).toBeInstanceOf(gdal.Feature)
    expect(await features.nextAsync()).toBeInstanceOf(gdal.Feature)
    expect(await features.nextAsync()).toBeInstanceOf(gdal.Feature)
    expect(features.previous()).toBeInstanceOf(gdal.Feature)
    expect(features.map((item: any) => item.fid).length).toBeGreaterThan(0)
    for await (const item of features) {
      expect(item).toBeInstanceOf(gdal.Feature)
      break
    }
    dataset.close()
  })

  it('builds field collections from objects', () => {
    const fields = gdal.LayerFields.fromObject({ name: 'a', count: 3, ratio: 1.5, flag: true })
    expect(fields.getNames()).toEqual(['name', 'count', 'ratio', 'flag'])
    expect(fields.get(1)!.type).toBe('String')
    expect(fields.get(2)!.type).toBe('Integer64')
    expect(fields.get(3)!.type).toBe('Real')
    expect(fields.get(4)!.type).toBe('Integer')
    expect(gdal.LayerFields.fromJSON({ x: 'y' }).count()).toBe(1)
  })
})

describe('color tables, CRS aliases and the PROJ paths', () => {
  it('iterates and back-references the palette', () => {
    const dataset = gdal.open(sampleRaster('ts-reach-palette.tif', 2, 2))
    const band = dataset.bands.get(1)!
    band.colorTable = new gdal.ColorTable(1, [
      { c1: 1, c2: 2, c3: 3, c4: 255 },
      { c1: 4, c2: 5, c3: 6, c4: 255 },
    ])
    const table = band.colorTable!
    expect(table.band).toBe(band)
    const seen: number[] = []
    table.forEach((_color: any, index: number) => seen.push(index))
    expect(seen).toEqual([0, 1])
    expect(table.map((color: any) => color.c1)).toEqual([1, 4])
    band.colorTable = null
    dataset.close()
  })

  it('answers the EPSG axis-order spellings and setPROJSearchPaths', () => {
    const geographic = gdal.SpatialReference.fromEPSG(4326)
    expect(geographic.EPSGTreatsAsLatLong).toBe(true)
    expect(geographic.EPSGTreatsAsNorthingEasting).toBe(false)
    expect(typeof gdal.SpatialReference.fromEPSG(3857).EPSGTreatsAsNorthingEasting).toBe('boolean')

    // The constructor takes a wrapper, a definition string, or a native SpatialRef.
    expect(new gdal.SpatialReference(geographic).authCode).toBe(4326)
    expect(new gdal.SpatialReference(native.SpatialRef.fromEpsg(3857)).authCode).toBe(3857)
    expect(() => new gdal.SpatialReference(123 as any)).toThrow(/needs a WKT/)

    const withoutGeoreference = gdal.open('', 'w', 'MEM', 2, 2, 1, 'GDT_Byte')
    expect(withoutGeoreference.getEnvelope()).toBeNull()
    withoutGeoreference.close()

    const previous = process.env.PROJ_DATA
    gdal.setPROJSearchPaths(previous ?? '.')
    gdal.setPROJSearchPaths([previous ?? '.', previous ?? '.'])
    expect(typeof gdal.setPROJSearchPaths).toBe('function')
  })
})
