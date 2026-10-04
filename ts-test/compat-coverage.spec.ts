import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import gdal from '../compat/index.js'
import { hasDriver, mdScratch, native, sampleRaster, sampleVector, tmp } from './helpers.js'

// The getters, error branches and callback forms the area suites do not reach. The
// subject is the `npm run test:coverage` number: a member that exists on only one
// path — a getter nobody reads, a node-callback form nobody calls — shows up as an
// uncovered line here rather than as a surprise in the coverage gate.

/** Call an async form that carries a trailing node callback the types do not declare. */
type LooseCall = (...args: unknown[]) => unknown
const loose = (fn: unknown): LooseCall => fn as LooseCall

describe('geometry extras', () => {
  it('constructs every shape', () => {
    expect(new gdal.MultiPoint().type).toBe('MultiPoint')
    expect(new gdal.MultiLineString().type).toBe('MultiLineString')
    expect(new gdal.GeometryCollection().type).toBe('GeometryCollection')
    expect(new gdal.MultiCurve()).toBeInstanceOf(gdal.GeometryCollection)
  })

  it('answers toObject and the measures', () => {
    const point = gdal.fromWKT('POINT (1 2)')
    expect(point.toObject()).toMatchObject({ type: 'Point' })
    expect(point.getArea()).toBe(0)
    expect(point.getLength()).toBe(0)
    expect(point.getGeometryType()).toBe('Point')
    expect(point.getEnvelope().minX).toBe(1)
  })

  it('brands the four collections', () => {
    const line = new gdal.LineString()
    line.points.add(0, 0)
    line.points.add(3, 4)
    expect(line.points).toBeInstanceOf(gdal.LineStringPoints)

    const polygon = new gdal.Polygon()
    polygon.rings.add(ringOf(0, 0, 2, 2))
    expect(polygon.rings).toBeInstanceOf(gdal.PolygonRings)

    const multi = new gdal.MultiPolygon()
    multi.children.add(new gdal.Polygon())
    expect(multi.children).toBeInstanceOf(gdal.GeometryCollectionChildren)

    const arc = new gdal.CircularString()
    arc.points.add(0, 0)
    arc.points.add(1, 1)
    arc.points.add(2, 0)
    const compound = new gdal.CompoundCurve()
    compound.curves.add(arc)
    expect(compound.curves).toBeInstanceOf(gdal.CompoundCurveCurves)
  })

  it('runs the ring and children iterators', () => {
    const polygon = new gdal.Polygon()
    polygon.rings.add(ringOf(0, 0, 3, 3))
    const ringIndexes: number[] = []
    polygon.rings.forEach((_ring, index) => ringIndexes.push(index))
    expect(ringIndexes).toEqual([0])
    expect(polygon.rings.map((ring) => ring.points.count())).toEqual([5])
    expect([...polygon.rings].length).toBe(1)

    const multi = new gdal.MultiPolygon()
    multi.children.add(new gdal.Polygon())
    const childIndexes: number[] = []
    multi.children.forEach((_child, index) => childIndexes.push(index))
    expect(childIndexes).toEqual([0])
    expect(multi.children.map(() => 'x')).toEqual(['x'])
    expect(multi.children.toArray().length).toBe(1)
    expect([...multi.children].length).toBe(1)
  })

  it('refuses nonsense in the collections', () => {
    const line = new gdal.LineString()
    expect(() => line.points.get(92)).toThrow(/does not exist/)
    expect(() => (line.points.add as () => void)()).toThrow()
    expect(() => line.points.add('nope' as never)).toThrow(/a point must be/)
    expect(() => line.points.add([{}] as never)).toThrow()

    const polygon = new gdal.Polygon()
    expect(() => polygon.rings.get(92)).toThrow(/does not exist/)
    expect(() => polygon.rings.add(new gdal.LineString() as never)).toThrow(/LinearRing/)

    const multi = new gdal.MultiPolygon()
    expect(() => multi.children.get(92)).toThrow(/does not exist/)
    expect(() => (multi.children.add as () => void)()).toThrow(/geometry/)
    expect(() => multi.children.add({} as never)).toThrow(/geometry/)
  })
})

/** A square `LinearRing` between two corners. */
function ringOf(minX: number, minY: number, maxX: number, maxY: number): gdal.LinearRing {
  const ring = new gdal.LinearRing()
  ring.points.add(minX, minY)
  ring.points.add(maxX, minY)
  ring.points.add(maxX, maxY)
  ring.points.add(minX, maxY)
  ring.points.add(minX, minY)
  return ring
}

describe('ColorTable extras', () => {
  it('reads, writes, iterates and compares', () => {
    const table = new gdal.ColorTable(gdal.GPI_CMYK)
    expect(table.interpretation).toBe(gdal.GPI_CMYK)
    table.ramp(0, { c1: 0, c2: 0, c3: 0, c4: 0 }, 3, { c1: 3, c2: 6, c3: 9, c4: 12 })
    table.set(0, { c1: 100, c2: 0, c3: 0, c4: 0 })
    expect(table.get(0)).toEqual({ c1: 100, c2: 0, c3: 0, c4: 0 })
    expect(table.get(999)).toBeUndefined()
    expect(table.toArray()).toHaveLength(4)
    expect([...table]).toHaveLength(4)

    // `isSame` is false for a non-table, a different interpretation and a different
    // length; true only for the same table twice.
    expect(table.isSame('nope' as never)).toBe(false)
    const same = table.clone()
    expect(table.isSame(same)).toBe(true)
    same.ramp(0, { c1: 0, c2: 0, c3: 0, c4: 0 }, 9, { c1: 0, c2: 0, c3: 0, c4: 0 })
    expect(table.isSame(same)).toBe(false)
    expect(table.isSame(new gdal.ColorTable(gdal.GPI_RGB, table.toArray()))).toBe(false)

    // A string interpretation is accepted too, and an unknown one falls back to Rgba.
    expect(new gdal.ColorTable('Cmyk').interpretation).toBe(gdal.GPI_CMYK)
    expect(new gdal.ColorTable('NoSuchPalette').interpretation).toBe(gdal.GPI_RGB)
  })

  it('refuses a write through the read-only table a band hands out', () => {
    const dataset = gdal.open(tmp('ts-cov-color.tif'), 'w', 'MEM', 2, 2, 1, 'GDT_Byte')
    const band = dataset.bands.get(1)!
    const writable = new gdal.ColorTable(gdal.GPI_RGB)
    writable.ramp(0, { c1: 0, c2: 0, c3: 0, c4: 0 }, 2, { c1: 2, c2: 2, c3: 2, c4: 2 })
    band.colorTable = writable
    const readOnly = band.colorTable!
    expect(() => readOnly.ramp(0, { c1: 0, c2: 0, c3: 0, c4: 0 }, 1, { c1: 1, c2: 1, c3: 1, c4: 1 })).toThrow(
      /read-only/,
    )
    expect(() => {
      band.colorTable = 7 as never
    }).toThrow(/ColorTable/)
    dataset.close()
  })
})

describe('raster extras', () => {
  it('reads into a supplied buffer and as a requested type', () => {
    const dataset = gdal.open(sampleRaster('ts-cov-read.tif', 4, 3))
    const band = dataset.bands.get(1)!
    const converted = band.pixels.read(0, 0, 4, 3, undefined, 'GDT_Float64')
    expect(converted).toBeInstanceOf(Float64Array)
    expect(converted.length).toBe(12)
    const into = new Float64Array(12)
    expect(band.pixels.read(0, 0, 4, 3, into)).toBe(into)
    dataset.close()
  })

  it('picks an overview by sample count', () => {
    const dataset = gdal.open(sampleRaster('ts-cov-ovr.tif', 64, 64), 'r+')
    dataset.buildOverviews({ levels: [2, 4] })
    const overviews = dataset.bands.get(1)!.overviews
    expect(overviews.get(1)).toBeTruthy()
    expect(overviews.getBySampleCount(1_000_000)).toBeTruthy()
    expect(overviews.getBySampleCount(1)).toBeTruthy()
    dataset.close()
  })

  it('answers the statistics spellings and a callback', async () => {
    const dataset = gdal.open(sampleRaster('ts-cov-stats.tif', 4, 4))
    const band = dataset.bands.get(1)!
    expect(band.computeStatistics(false, true)).toHaveProperty('min')
    expect(band.getStatistics(false, true)).toHaveProperty('max')
    const viaCallback = await new Promise((resolve) => {
      band.computeStatisticsAsync(false, true).then(resolve)
    })
    expect(viaCallback).toHaveProperty('mean')
    dataset.close()
  })
})

describe('vector extras', () => {
  it('answers the field count, the back-reference and a Feature add', () => {
    const dataset = gdal.open(sampleVector('ts-cov-vector.gpkg'), 'r+')
    const layer = dataset.layers.get(1)!
    const feature = layer.features.first()!
    expect(feature.fields.count).toBeGreaterThan(0)
    expect(feature.fields.getNames()).toEqual(feature.fields.names)
    expect(layer.features.layer).toBe(layer)
    expect(layer.getMetadata()).toBeInstanceOf(Object)
    expect(layer.extent).toBeInstanceOf(Object)

    // `add(Feature)` carries the feature's own fields across, unlike a bare geometry.
    const target = dataset.layers.create('copies', null, 'Point')
    target.features.add(feature)
    const copy = target.features.first()!
    expect(copy.fields.get('name')).toBe(feature.fields.get('name'))

    // `set(feature)` uses its own id; `set(fid, geometry)` names it.
    target.features.set(copy)
    target.features.set(copy.fid!, gdal.fromWKT('POINT (5 5)'))
    expect(target.features.get(copy.fid!)!.geometry!.toWKT()).toBe('POINT (5 5)')
    dataset.close()
  })

  it('answers null extent for an empty layer', () => {
    const dataset = gdal.open(tmp('ts-cov-empty.gpkg'), 'w', 'GPKG')
    const layer = dataset.layers.create('empty', null, 'Point')
    expect(layer.extent).toBeNull()
    dataset.close()
  })

  it('drives the driver and layer async forms through callbacks', async () => {
    const driver = gdal.drivers.get('GTiff')!
    const path = tmp('ts-cov-driver.tif')
    await new Promise<void>((resolve, reject) => {
      loose(driver.createAsync.bind(driver))(path, 2, 2, 1, gdal.GDT_Byte, (error: Error | null, dataset?: gdal.Dataset) => {
        if (error) reject(error)
        else {
          dataset!.close()
          resolve()
        }
      })
    })

    const opened = await new Promise<gdal.Dataset>((resolve, reject) => {
      loose(driver.openAsync.bind(driver))(path, 'r', (error: Error | null, dataset?: gdal.Dataset) =>
        error ? reject(error) : resolve(dataset!),
      )
    })
    opened.close()

    await new Promise<void>((resolve, reject) => {
      const source = driver.open(path)
      loose(driver.createCopyAsync.bind(driver))(
        tmp('ts-cov-driver-copy.tif'),
        source,
        (error: Error | null, dataset?: gdal.Dataset) => {
          source.close()
          if (error) reject(error)
          else {
            dataset!.close()
            resolve()
          }
        },
      )
    })
    driver.delete(tmp('ts-cov-driver-copy.tif'))
    driver.delete(path)

    const dataset = gdal.open(tmp('ts-cov-layer.gpkg'), 'w', 'GPKG')
    await new Promise<void>((resolve, reject) => {
      loose(dataset.layers.createAsync.bind(dataset.layers))('one', null, 'Point', (error: Error | null, layer?: gdal.Layer) => {
        if (error) reject(error)
        else if (layer!.name !== 'one') reject(new Error('wrong layer'))
        else resolve()
      })
    })
    const source = gdal.open(sampleVector('ts-cov-layer-src.gpkg'))
    await new Promise<void>((resolve, reject) => {
      loose(dataset.layers.copyAsync.bind(dataset.layers))(
        source.layers.get(1)!,
        'copied',
        (error: Error | null, layer?: gdal.Layer) => (error ? reject(error) : (expect(layer!.name).toBe('copied'), resolve())),
      )
    })
    source.close()
    await new Promise<void>((resolve, reject) => {
      loose(dataset.layers.removeAsync.bind(dataset.layers))('one', (error: Error | null) => (error ? reject(error) : resolve()))
    })
    expect(dataset.layers.get('one')).toBeNull()
    dataset.close()
  })
})

describe('the module-level callback forms and error branches', () => {
  it('reports a rejected open through a callback', async () => {
    await new Promise<void>((resolve) => {
      const returned = gdal.openAsync(join(tmp('does-not-exist.tif')), (error) => {
        expect(error).toBeTruthy()
        resolve()
      })
      expect(returned).toBeUndefined()
    })
  })

  it('opens with a driver list and the thread-safe modes', async () => {
    const path = sampleRaster('ts-cov-open.tif', 4, 4)
    expect(gdal.open(path, 'r', ['GTiff']).bands.get(1)!.size.x).toBe(4)
    const threadSafe = await gdal.openAsync(path, 'rs')
    expect(threadSafe.threadSafe).toBe(true)
    threadSafe.close()
    const listed = await gdal.openAsync(path, 'r', ['GTiff'])
    expect(listed.rasterSize).toEqual({ x: 4, y: 4 })
    listed.close()
  })

  it('leaves the sample type alone when none is named, and refuses an unknown code', () => {
    const memory = gdal.open('', 'w', 'MEM', 2, 2, 1)
    expect(memory.rasterSize).toEqual({ x: 2, y: 2 })
    memory.close()
    expect(() => gdal.open(tmp('ts-cov-bad-type.tif'), 'w', 'GTiff', 2, 2, 1, 99)).toThrow(
      /unknown data type/,
    )
  })

  it('spatial-reference extras', () => {
    const fromProj4 = gdal.SpatialReference.fromProj4('+proj=longlat +datum=WGS84 +no_defs')
    expect(fromProj4.getAuthorityCode()).toBeNull()
    const wgs84 = gdal.SpatialReference.fromEPSG(4326)
    expect(wgs84.getAuthorityCode()).toBe('4326')
    expect(wgs84.isSame(gdal.SpatialReference.fromEPSG(4326))).toBe(true)
    expect(wgs84.getName()).toContain('WGS')
  })
})

describe('the algorithm async wrappers', () => {
  it('runs contourGenerateAsync and polygonizeAsync, and refuses a bad field index', async () => {
    const source = gdal.open(tmp('ts-cov-algo-src.tif'), 'w', 'GTiff', 16, 16, 1, 'GDT_Float64')
    source.geoTransform = [0, 1, 0, 16, 0, -1]
    const band = source.bands.get(1)!
    band.pixels.write(
      0,
      0,
      16,
      16,
      Buffer.from(Float64Array.from({ length: 256 }, (_, index) => index % 16).buffer),
    )
    const destination = gdal.open(tmp('ts-cov-algo-dst.gpkg'), 'w', 'GPKG')
    const contours = destination.layers.create('contours', null, 'LineString')
    contours.fields.add(new gdal.FieldDefn('id', gdal.OFTInteger))
    contours.fields.add(new gdal.FieldDefn('elev', gdal.OFTReal))
    await gdal.contourGenerateAsync({ src: band, dst: contours, interval: 4, offset: 0, idField: 0, elevField: 1 })
    expect(contours.features.count()).toBeGreaterThan(0)
    expect(() => gdal.contourGenerate({ src: band, dst: contours, interval: 4, idField: 9 })).toThrow(/no field/)

    const polys = destination.layers.create('polys', null, 'Polygon')
    polys.fields.add(new gdal.FieldDefn('val', gdal.OFTInteger))
    await gdal.polygonizeAsync({ src: band, dst: polys, pixValField: 0, connectedness: 8 })
    expect(polys.features.count()).toBeGreaterThan(0)

    source.close()
    destination.close()
  })

  it('refuses a rasterizeAsync whose destination is a dataset', async () => {
    const dataset = gdal.open(sampleRaster('ts-cov-rasterize.tif', 4, 4))
    await expect(gdal.rasterizeAsync(dataset as unknown as string, dataset)).rejects.toThrow(
      /destination path/,
    )
    dataset.close()
  })
})

describe('the reachable defensive branches', () => {
  it('falls back to wkb 0 for a type the table does not name', () => {
    expect(gdal.fromWKT('TRIANGLE ((0 0, 1 0, 0 1, 0 0))').wkbType).toBe(0)
  })

  it('defaults a field type, and finds nothing for a missing field', () => {
    expect(new gdal.FieldDefn('noType').type).toBe('String')
    const dataset = gdal.open(sampleVector('ts-cov-fields.gpkg'), 'r+')
    const layer = dataset.layers.get(1)!
    expect(layer.fields.indexOf('missing')).toBe(-1)
    expect(layer.fields.get('missing')).toBeNull()
    dataset.close()
  })

  it('handles a null geometry, a plain object, and a bare geometry', () => {
    const dataset = gdal.open(sampleVector('ts-cov-geom.gpkg'), 'r+')
    const layer = dataset.layers.get(1)!

    // A feature created with no geometry reads back `null`.
    layer.features.add(null, { name: 'no-geometry' })
    const bare = [...layer.features].find((item) => item.fields.get('name') === 'no-geometry')!
    expect(bare.geometry).toBeNull()

    const feature = layer.features.first()!
    // `null` takes the clear path (the GPKG driver keeps the geometry, but the branch runs).
    feature.geometry = null
    // A plain GeoJSON object takes `unwrapGeometry`'s non-`toJson` path.
    feature.geometry = { type: 'Point', coordinates: [4, 5] } as unknown as gdal.Geometry
    expect(feature.geometry!.toWKT()).toBe('POINT (4 5)')

    layer.features.add(gdal.fromWKT('POINT (7 7)'))
    expect(layer.features.count()).toBe(3)
    dataset.close()
  })

  it('drives the feature async forms with callbacks', async () => {
    const dataset = gdal.open(sampleVector('ts-cov-features.gpkg'), 'r+')
    const layer = dataset.layers.get(1)!
    const features = layer.features
    await new Promise<void>((resolve, reject) => {
      loose(features.addAsync.bind(features))(gdal.fromWKT('POINT (1 1)'), (error: Error | null) =>
        error ? reject(error) : resolve(),
      )
    })
    await new Promise<void>((resolve, reject) => {
      loose(features.addAsync.bind(features))(
        gdal.fromWKT('POINT (2 2)'),
        { name: 'two' },
        (error: Error | null) => (error ? reject(error) : resolve()),
      )
    })
    const first = features.first()!
    await new Promise<void>((resolve, reject) => {
      loose(features.setAsync.bind(features))(first.fid, (error: Error | null) =>
        error ? reject(error) : resolve(),
      )
    })
    await new Promise<void>((resolve, reject) => {
      loose(features.setAsync.bind(features))(first, (error: Error | null) =>
        error ? reject(error) : resolve(),
      )
    })
    await new Promise<void>((resolve, reject) => {
      loose(features.setAsync.bind(features))(first.fid, gdal.fromWKT('POINT (9 9)'), (error: Error | null) =>
        error ? reject(error) : resolve(),
      )
    })
    await new Promise<void>((resolve, reject) => {
      loose(features.removeAsync.bind(features))(first.fid, (error: Error | null) =>
        error ? reject(error) : resolve(),
      )
    })
    expect(features.count()).toBeGreaterThan(0)
    dataset.close()
  })

  it('runs executeSQLAsync with a dialect and through a callback', async () => {
    const dataset = gdal.open(sampleVector('ts-cov-sql.gpkg'))
    expect((await dataset.executeSQLAsync('SELECT * FROM things', 'OGRSQL')).length).toBe(1)
    await new Promise<void>((resolve, reject) => {
      loose(dataset.executeSQLAsync.bind(dataset))('SELECT * FROM things', (error: Error | null) =>
        error ? reject(error) : resolve(),
      )
    })
    dataset.close()
  })

  it('extends the 3D envelope rules', () => {
    const box = new gdal.Envelope3D({ minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 0 })
    box.merge(2, 3, 4)
    expect(box.maxZ).toBe(4)
    box.merge(2, 3)
    expect(box.maxX).toBe(2)
    expect(box.maxY).toBe(3)
    const other = new gdal.Envelope3D({ minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: -1, maxZ: 1 })
    box.merge(other)
    expect(box.minZ).toBe(-1)
    expect(other.intersects(box)).toBe(true)
    expect(other.contains(box)).toBe(false)
  })

  it('runs the algorithm wrappers with no optional fields', async () => {
    const source = gdal.open(tmp('ts-cov-algo-min-src.tif'), 'w', 'GTiff', 16, 16, 1, 'GDT_Float64')
    source.geoTransform = [0, 1, 0, 16, 0, -1]
    const band = source.bands.get(1)!
    band.pixels.write(
      0,
      0,
      16,
      16,
      Buffer.from(Float64Array.from({ length: 256 }, (_, index) => index % 16).buffer),
    )
    const destination = gdal.open(tmp('ts-cov-algo-min-dst.gpkg'), 'w', 'GPKG')
    const contours = destination.layers.create('contours', null, 'LineString')
    await gdal.contourGenerateAsync({ src: band, dst: contours, interval: 4 })
    expect(contours.features.count()).toBeGreaterThan(0)

    const polys = destination.layers.create('polys', null, 'Polygon')
    await gdal.polygonizeAsync({ src: band, dst: polys })
    expect(polys.features.count()).toBeGreaterThan(0)

    source.close()
    destination.close()
  })
})

describe('the async program callback forms', () => {
  /** Run an async wrapper that carries a trailing node callback the types do not declare. */
  const called = (fn: (callback: (error: Error | null, value?: unknown) => void) => void) =>
    new Promise<void>((resolve, reject) => {
      fn((error) => (error ? reject(error) : resolve()))
    })

  it('accepts a callback on each async program', async () => {
    const dataset = gdal.open(sampleRaster('ts-cov-progs.tif', 8, 6))
    const band = dataset.bands.get(1)!

    await called((cb) => loose(gdal.translateAsync)(tmp('ts-cov-progs-tr.tif'), dataset, ['-of', 'GTiff'], cb))
    await called((cb) => loose(gdal.buildVRTAsync)(tmp('ts-cov-progs.vrt'), [dataset], cb))
    await called((cb) =>
      loose(gdal.warpAsync)(tmp('ts-cov-progs-warp.tif'), null, [dataset], ['-t_srs', 'EPSG:3857'], cb),
    )
    await called((cb) => loose(gdal.demAsync)(tmp('ts-cov-progs-dem.tif'), dataset, 'hillshade', [], undefined, cb))
    await called((cb) => loose(gdal.checksumImageAsync)(band, 0, 0, 8, cb))
    await called((cb) => loose(gdal.suggestedWarpOutputAsync)({ src: dataset }, cb))
    // `s_srs` / `t_srs` are optional: with neither, the current grid is reported.
    expect(gdal.suggestedWarpOutput({ src: dataset }).rasterSize).toEqual({ x: 8, y: 6 })

    const vector = gdal.open(sampleVector('ts-cov-progs-vec.gpkg'))
    await called((cb) =>
      loose(gdal.vectorTranslateAsync)(tmp('ts-cov-progs-vtr.geojson'), vector, ['-f', 'GeoJSON'], cb),
    )
    vector.close()

    const fill = gdal.open(tmp('ts-cov-progs-fill.tif'), 'w', 'GTiff', 8, 8, 1, 'Float32')
    const fillBand = fill.bands.get(1)!
    fillBand.fill(1)
    fillBand.noDataValue = -9999
    await called((cb) => loose(gdal.fillNodataAsync)({ src: fillBand, searchDist: 3 }, cb))
    await called((cb) => loose(gdal.sieveFilterAsync)({ src: fillBand, threshold: 2 }, cb))
    fill.close()

    dataset.close()
  })
})

describe('module odds and ends', () => {
  it('runs infoAsync with args-as-callback and with a dataset', async () => {
    const dataset = gdal.open(sampleRaster('ts-cov-info.tif', 4, 4))
    const viaCallback = await new Promise<string>((resolve, reject) => {
      loose(gdal.infoAsync)(dataset, (error: Error | null, text?: string) =>
        error ? reject(error) : resolve(text!),
      )
    })
    expect(viaCallback).toContain('Driver')
    expect(typeof gdal.info().releaseName).toBe('string')
    dataset.close()
  })

  it('refuses a warp with an existing destination dataset', () => {
    const dataset = gdal.open(sampleRaster('ts-cov-warp-refuse.tif', 4, 4))
    expect(() =>
      gdal.warp(tmp('ts-cov-warp-out.tif'), dataset as unknown as null, [dataset], []),
    ).toThrow(/existing destination/)
    dataset.close()
  })

  it('answers instanceof false for a value of the wrong shape', () => {
    expect(('x' as unknown as object) instanceof gdal.GeometryCollectionChildren).toBe(false)
    expect(('x' as unknown as object) instanceof gdal.LineStringPoints).toBe(false)
  })

  it('falls back to String for an unknown field code, and passes a native band to calcAsync', async () => {
    expect(new gdal.FieldDefn('x', 9999).type).toBe('String')

    const output = gdal.open(tmp('ts-cov-calc-out.tif'), 'w', 'GTiff', 4, 1, 1, 'GDT_Float64')
    const source = native.createSync(tmp('ts-cov-calc-in.tif'), {
      driver: 'GTiff',
      width: 4,
      height: 1,
      bandCount: 1,
      dataType: 'Float64',
    })
    source.band(0).fill(2)
    // A native band (no `_native`) goes straight through the adapter's unwrap.
    await loose(gdal.calcAsync)(
      { a: source.band(0) },
      output.bands.get(1)!,
      (value: number) => value + 1,
    )
    expect(output.bands.get(1)!.pixels.get(0, 0)).toBe(3)
    source.close()
    output.close()
  })
})

describe.skipIf(!hasDriver('netCDF'))('multidimensional getters', () => {
  let netcdf = ''
  beforeAll(async () => {
    netcdf = join(mdScratch, 'ts-cov-md.nc')
    await native.translate(netcdf, sampleRaster('ts-cov-md-src.tif', 4, 3), ['-of', 'netCDF'])
  })

  it('reads the group, dimension, attribute and array metadata', async () => {
    const dataset = gdal.open(netcdf)
    const root = dataset.root!
    expect(root.name).toBe('/')

    // The dimension names follow the CRS (this fixture is WGS 84, so `lon`/`lat`).
    const dimensionNames = root.dimensions.getNames()
    expect(dimensionNames.length).toBeGreaterThan(0)
    const dimension = root.dimensions.get(dimensionNames[0])!
    expect(dimension.description).toBe(dimension.name)
    expect(dimension.type).toBeTypeOf('string')
    expect(dimension.direction === null || typeof dimension.direction === 'string').toBe(true)

    const attribute = root.attributes.get(root.attributes.getNames()[0])!
    expect(attribute.description).toBe(attribute.name)

    const array = root.arrays.get('Band1')!
    expect(array.offset).toBeNull()
    expect(array.scale).toBeNull()
    expect(array.unitType).toBeNull()

    // The named collections are all async-iterable.
    const arrayNames: string[] = []
    for await (const item of root.arrays) arrayNames.push(item.name)
    expect(arrayNames).toContain('Band1')
    const iteratedDimensions: string[] = []
    for await (const item of root.dimensions) iteratedDimensions.push(item.name)
    expect(iteratedDimensions).toEqual(dimensionNames)

    dataset.close()
  })
})
