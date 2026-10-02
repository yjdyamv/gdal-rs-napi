import { describe, expect, it } from 'vitest'

import gdal from '../compat/index.js'
import { tmp, sampleRaster } from './helpers.js'

// The pieces that closed the last module-level gaps against gdal-async's own tests:
// the constant families `gdal_sys` cannot read, the curve geometry classes, the
// named raster streams, `ColorTable`, the two algorithm wrappers and the `…Async`
// twins.

describe('the families gdal_sys cannot read', () => {
  it('exposes the capability and error constants', () => {
    expect(gdal.OLCCreateField).toBe('CreateField')
    expect(gdal.OLCRandomRead).toBe('RandomRead')
    expect(gdal.ODrCCreateDataSource).toBe('CreateDataSource')
    expect(gdal.ODrCDeleteDataSource).toBe('DeleteDataSource')
    expect(gdal.ODsCCreateLayer).toBe('CreateLayer')
    expect(gdal.ODsCDeleteLayer).toBe('DeleteLayer')
    expect(gdal.ODsCCreateGeomFieldAfterCreateLayer).toBe('CreateGeomFieldAfterCreateLayer')
    expect(gdal.DIM_TEMPORAL).toBe('TEMPORAL')
    expect(gdal.DIM_HORIZONTAL_Y).toBe('HORIZONTAL_Y')
    expect(gdal.DIR_NORTH).toBe('NORTH')
    expect(gdal.GEDTC_String).toBe('String')
    expect(gdal.CPLE_AppDefined).toBe(1)
    expect(gdal.DCAP_CREATE).toBe('DCAP_CREATE')
    expect(gdal.wkb25DBit).toBe(-2147483648)
    expect(gdal.wkbPoint25D).toBe(gdal.wkbPoint | gdal.wkb25DBit)
    expect(gdal.wkbLinearRing).toBe(101)
  })

  it('uses them where the reference does', () => {
    const driver = gdal.drivers.get('GTiff')!
    expect(driver.testCapability(gdal.DCAP_CREATE)).toBe(true)
    const dataset = gdal.open(tmp('ts-gap-cap.gpkg'), 'w', 'GPKG')
    expect(dataset.testCapability?.(gdal.ODsCCreateLayer)).toBe(true)
    dataset.close()
  })
})

describe('the curve classes', () => {
  it('answers getConstructor and wkbType', () => {
    expect(gdal.Geometry.getConstructor(0)).toBeNull()
    expect(gdal.Geometry.getConstructor(1)).toBe(gdal.Point)
    expect(gdal.Geometry.getConstructor(8)).toBe(gdal.CircularString)
    expect(gdal.Geometry.getConstructor(9)).toBe(gdal.CompoundCurve)
    expect(gdal.Geometry.getConstructor(11)).toBe(gdal.MultiCurve)
    expect(gdal.Geometry.getConstructor(101)).toBe(gdal.LinearRing)
    expect(gdal.Point.wkbType).toBe(1)
    expect(gdal.LinearRing.wkbType).toBe(101)
    expect(gdal.CircularString.wkbType).toBe(8)
    expect(gdal.CompoundCurve.wkbType).toBe(9)
    expect(gdal.MultiCurve.wkbType).toBe(11)
  })

  it('re-tags curve geometries parsed from WKT', () => {
    const arc = gdal.fromWKT('CIRCULARSTRING (0 0, 1 1, 2 0)')
    expect(arc).toBeInstanceOf(gdal.CircularString)
    expect(arc).toBeInstanceOf(gdal.SimpleCurve)
    expect(arc.wkbType).toBe(8)

    const compound = gdal.fromWKT('COMPOUNDCURVE (CIRCULARSTRING (0 0, 1 1, 2 0))')
    expect(compound).toBeInstanceOf(gdal.CompoundCurve)
    expect(compound.wkbType).toBe(9)

    const multi = gdal.fromWKT('MULTICURVE (CIRCULARSTRING (0 0, 1 1, 2 0))')
    expect(multi).toBeInstanceOf(gdal.MultiCurve)
    expect(multi).toBeInstanceOf(gdal.GeometryCollection)

    expect(gdal.fromWKT('POINT (1 2)').wkbType).toBe(1)
    // A line is a simple curve too, in the reference's hierarchy.
    expect(gdal.fromWKT('LINESTRING (0 0, 1 1)')).toBeInstanceOf(gdal.SimpleCurve)
  })
})

describe('the named raster streams', () => {
  it('answers RasterReadStream and RasterWriteStream', () => {
    const path = sampleRaster('ts-gap-stream.tif', 4, 4)
    const dataset = gdal.open(path)
    const band = dataset.bands.get(1)!
    const readable = band.pixels.createReadStream({})
    expect(readable).toBeInstanceOf(gdal.RasterReadStream)
    readable.destroy()
    dataset.close()

    const memory = gdal.open(tmp('ts-gap-write.tif'), 'w', 'GTiff', 4, 4, 1, 'GDT_Float64')
    const writable = memory.bands.get(1)!.pixels.createWriteStream({})
    expect(writable).toBeInstanceOf(gdal.RasterWriteStream)
    writable.end()
    memory.close()
  })
})

describe('ColorTable', () => {
  it('reshapes a band palette and refuses a write through the read-only view', () => {
    const dataset = gdal.open(tmp('ts-gap-color.tif'), 'w', 'MEM', 4, 4, 1, 'GDT_Byte')
    const band = dataset.bands.get(1)!
    expect(band.colorTable).toBeUndefined()

    const table = new gdal.ColorTable(gdal.GPI_RGB)
    expect(table.count()).toBe(0)
    table.ramp(0, { c1: 0, c2: 99, c3: 0, c4: 0 }, 99, { c1: 99, c2: 0, c3: 0, c4: 0 })
    expect(table.count()).toBe(100)
    expect(table.get(0)).toEqual({ c1: 0, c2: 99, c3: 0, c4: 0 })
    expect(table.get(99)).toEqual({ c1: 99, c2: 0, c3: 0, c4: 0 })
    expect(table.interpretation).toBe(gdal.GPI_RGB)

    band.colorTable = table
    const read = band.colorTable!
    expect(read).toBeInstanceOf(gdal.ColorTable)
    expect(read.isSame(table)).toBe(true)
    expect(() => read.set(0, { c1: 1, c2: 1, c3: 1, c4: 1 })).toThrow(/read-only/)

    const clone = read.clone()
    expect(clone.count()).toBe(table.count())
    expect(clone.isSame(table)).toBe(true)

    expect(() => {
      band.colorTable = 12 as never
    }).toThrow(/must be a gdal.ColorTable/)

    band.colorTable = null
    expect(band.colorTable).toBeUndefined()
    dataset.close()
  })

  it('answers colorTableAsync', async () => {
    const dataset = gdal.open(tmp('ts-gap-color-async.tif'), 'w', 'MEM', 4, 4, 1, 'GDT_Byte')
    const band = dataset.bands.get(1)!
    const table = new gdal.ColorTable(gdal.GPI_HLS)
    table.ramp(0, { c1: 0, c2: 0, c3: 0, c4: 0 }, 4, { c1: 4, c2: 4, c3: 4, c4: 4 })
    band.colorTable = table
    await expect(band.colorTableAsync).resolves.toBeInstanceOf(gdal.ColorTable)
    dataset.close()
  })
})

describe('the algorithm wrappers', () => {
  it('runs contourGenerate through the reference object form', () => {
    const source = gdal.open(tmp('ts-gap-contour-src.tif'), 'w', 'GTiff', 16, 16, 1, 'GDT_Float64')
    source.geoTransform = [0, 1, 0, 16, 0, -1]
    const band = source.bands.get(1)!
    const values = Float64Array.from({ length: 256 }, (_, index) => Math.floor(index / 16))
    band.pixels.write(0, 0, 16, 16, Buffer.from(values.buffer))

    const destination = gdal.open(tmp('ts-gap-contour-dst.gpkg'), 'w', 'GPKG')
    const layer = destination.layers.create('contours', null, 'LineString')
    layer.fields.add(new gdal.FieldDefn('id', gdal.OFTInteger))
    layer.fields.add(new gdal.FieldDefn('elev', gdal.OFTReal))

    let calls = 0
    gdal.contourGenerate({
      src: band,
      dst: layer,
      interval: 4,
      offset: 0,
      idField: 0,
      elevField: 1,
      progress_cb: () => {
        calls += 1
      },
    })
    expect(calls).toBeGreaterThan(0)
    expect(layer.features.count()).toBeGreaterThan(0)

    source.close()
    destination.close()
  })

  it('runs polygonize through the reference object form', () => {
    const source = gdal.open(tmp('ts-gap-poly-src.tif'), 'w', 'GTiff', 16, 16, 1, 'GDT_Int32')
    source.geoTransform = [0, 1, 0, 16, 0, -1]
    const band = source.bands.get(1)!
    const values = Int32Array.from({ length: 256 }, (_, index) => ((index % 16) < 8 ? 1 : 2))
    band.pixels.write(0, 0, 16, 16, Buffer.from(values.buffer))

    const destination = gdal.open(tmp('ts-gap-poly-dst.gpkg'), 'w', 'GPKG')
    const layer = destination.layers.create('polys', null, 'Polygon')
    layer.fields.add(new gdal.FieldDefn('val', gdal.OFTInteger))

    let calls = 0
    gdal.polygonize({
      src: band,
      dst: layer,
      pixValField: 0,
      connectedness: 8,
      progress_cb: () => {
        calls += 1
      },
    })
    expect(calls).toBeGreaterThan(0)
    expect(layer.features.count()).toBe(2)
    for (const feature of layer.features) {
      expect(feature.geometry).toBeInstanceOf(gdal.Polygon)
    }

    source.close()
    destination.close()
  })
})

describe('the async twins', () => {
  it('answers the geometry twins', async () => {
    const point = gdal.fromWKT('POINT (1 2)')
    expect(await point.toWKTAsync()).toContain('POINT')
    expect(await point.toJSONAsync()).toMatchObject({ type: 'Point' })
    expect(await point.getAreaAsync()).toBe(0)
    expect(await point.getLengthAsync()).toBe(0)
    expect(await point.getGeometryTypeAsync()).toBe('Point')

    const envelope = await point.getEnvelopeAsync()
    expect(envelope.minX).toBe(1)
    expect(envelope.minY).toBe(2)

    const buffered = await point.bufferAsync(1)
    expect(buffered).toBeInstanceOf(gdal.Polygon)
    expect(await buffered.getAreaAsync()).toBeGreaterThan(0)

    const other = gdal.fromWKT('POINT (4 6)')
    expect(await point.distanceAsync(other)).toBeCloseTo(5, 6)
    expect(await point.disjointAsync(other)).toBe(true)
    expect(await point.overlapsAsync(other)).toBe(false)

    // The 3D box, and its async twin.
    const solid = gdal.fromWKT('POLYGON Z ((0 0 0, 10 0 0, 10 10 5, 0 10 5, 0 0 0))')
    const box = solid.getEnvelope3D()
    expect(box).toBeInstanceOf(gdal.Envelope3D)
    expect([box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ]).toEqual([0, 0, 0, 10, 10, 5])
    const boxAsync = await solid.getEnvelope3DAsync()
    expect(boxAsync.maxZ).toBe(5)

    // The static factories' async spellings.
    expect(await gdal.Geometry.fromWKTAsync('POINT (3 4)')).toBeInstanceOf(gdal.Point)
    expect((await gdal.SpatialReference.fromURLAsync('EPSG:4326')).authCode).toBe(4326)
  })

  it('answers dataset and layer srsAsync', async () => {
    const path = sampleRaster('ts-gap-srs.tif', 2, 2)
    const dataset = gdal.open(path)
    const srs = await dataset.srsAsync
    expect(srs).toBeInstanceOf(gdal.SpatialReference)
    expect(srs!.authCode).toBe(4326)
    dataset.close()
  })

  it('answers the band and dataset twins', async () => {
    const path = sampleRaster('ts-gap-twins.tif', 4, 4)
    const dataset = gdal.open(path, 'r+')
    const band = dataset.bands.get(1)!

    dataset.setMetadata(['AREA_OR_POINT=Area'])
    expect(await dataset.getMetadataAsync()).toMatchObject({ AREA_OR_POINT: 'Area' })
    await dataset.setMetadataAsync(['AREA_OR_POINT=Point'])
    expect(dataset.getMetadata().AREA_OR_POINT).toBe('Point')

    await band.fillAsync(5)
    expect(await band.getMetadataAsync()).toBeInstanceOf(Object)
    await band.setMetadataAsync(['BAND=yes'])
    expect(band.getMetadata().BAND).toBe('yes')

    dataset.close()
  })
})

describe('the mutable geometry builder', () => {
  it('builds a LineString through points', () => {
    const line = new gdal.LineString()
    expect(line).toBeInstanceOf(gdal.LineString)
    expect(line).toBeInstanceOf(gdal.SimpleCurve)
    line.points.add(0, 0, 0)
    line.points.add(10, 10, 0)
    line.points.add(10, 20, 0)
    expect(line.points.count()).toBe(3)
    expect(line.getLength()).toBeCloseTo(Math.sqrt(200) + 10, 6)

    expect(line.points.get(0)).toBeInstanceOf(gdal.Point)
    expect(line.points.get(0).x).toBe(0)
    expect(line.points.toArray()).toHaveLength(3)
    expect(line.points.map((point) => point.x)).toEqual([0, 10, 10])

    const seen: number[] = []
    line.points.forEach((point, index) => {
      expect(typeof index).toBe('number')
      seen.push(point.x!)
      if (index === 0) return false
    })
    expect(seen).toEqual([0])

    // The point-like forms `add` accepts: a Point, `{ x, y }`, an `[x, y]` array, and
    // an array of any of those.
    const other = new gdal.LineString()
    other.points.add(new gdal.Point(2, 3))
    other.points.add([
      { x: 4, y: 5 },
      [6, 7],
    ])
    expect(other.points.get(0).y).toBe(3)
    expect(other.points.get(2).x).toBe(6)

    // set / reverse / resize, all live on `line`.
    line.points.set(0, { x: 1, y: 2 })
    expect(line.points.get(0).x).toBe(1)
    line.points.reverse()
    expect(line.points.get(0).x).toBe(10)
    expect(line.points.get(2).x).toBe(1)
    line.points.resize(2)
    expect(line.points.count()).toBe(2)
    expect([...line.points]).toHaveLength(2)
  })

  it('builds a Polygon through rings, as real LinearRings', () => {
    const ring = new gdal.LinearRing()
    ring.points.add(0, 0, 0)
    ring.points.add(10, 0, 0)
    ring.points.add(10, 10, 0)
    ring.points.add(0, 10, 0)
    ring.points.add(0, 0, 0)
    expect(ring.getArea()).toBeCloseTo(100, 3)

    const polygon = new gdal.Polygon()
    polygon.rings.add(ring)
    expect(polygon.rings.count()).toBe(1)
    expect(polygon.rings.get(0)).toBeInstanceOf(gdal.LinearRing)
    expect(polygon.rings.get(0).points.get(2).y).toBe(10)
    expect(polygon.getArea()).toBeCloseTo(100, 3)

    const second = new gdal.LinearRing()
    second.points.add(1, 1, 0)
    second.points.add(2, 1, 0)
    second.points.add(2, 2, 0)
    second.points.add(1, 1, 0)
    polygon.rings.add([second])
    expect(polygon.rings.count()).toBe(2)
    expect(polygon.rings.map((r) => r.points.count())).toEqual([5, 4])

    expect(() => polygon.rings.add(new gdal.LineString())).toThrow(/must be a LinearRing/)
  })

  it('builds collections through children and curves', () => {
    const multi = new gdal.MultiPolygon()
    expect(multi.children).toBeInstanceOf(gdal.GeometryCollectionChildren)
    multi.children.add(new gdal.Polygon())
    multi.children.add([new gdal.Polygon()])
    expect(multi.children.count()).toBe(2)
    expect(multi.children.get(0)).toBeInstanceOf(gdal.Polygon)
    multi.children.remove(0)
    expect(multi.children.count()).toBe(1)
    expect(() => (multi.children.add as (value?: unknown) => void)()).toThrow(/geometry/)

    const arc = new gdal.CircularString()
    arc.points.add(-5, 0)
    arc.points.add(0, 2.5)
    arc.points.add(5, 0)
    expect(arc.getLength()).toBeCloseTo(11.5911, 3)

    const compound = new gdal.CompoundCurve()
    expect(compound.curves).toBeInstanceOf(gdal.CompoundCurveCurves)
    compound.curves.add(arc)
    expect(compound.curves.count()).toBe(1)
    expect(compound.curves.get(0)).toBeInstanceOf(gdal.CircularString)

    // GDAL refuses a curve that does not start where the last one ended.
    const broken = new gdal.CompoundCurve()
    broken.curves.add(arc)
    const stray = new gdal.LineString()
    stray.points.add(99, 99)
    stray.points.add(100, 100)
    expect(() => broken.curves.add(stray)).toThrow(/contiguous/)
  })

  it('closes rings, appends sub-line strings and empties', () => {
    const chain = gdal.fromWKT('LINESTRING (0 0, 0 1, 0 2)')
    const more = gdal.fromWKT('LINESTRING (0 2, 1 2, 2 2)') as gdal.LineString
    chain.addSubLineString(more)
    expect(chain.toWKT()).toBe('LINESTRING (0 0,0 1,0 2,0 2,1 2,2 2)')

    const trimmed = gdal.fromWKT('LINESTRING (0 0, 0 1, 0 2)')
    trimmed.addSubLineString(more, 1, 1)
    expect(trimmed.toWKT()).toBe('LINESTRING (0 0,0 1,0 2,1 2)')
    expect(() => trimmed.addSubLineString(more, 0, 9)).toThrow()

    const open = new gdal.LinearRing()
    open.points.add(0, 0)
    open.points.add(1, 0)
    open.points.add(1, 1)
    open.closeRings()
    expect(open.points.count()).toBe(4)

    const point = gdal.fromWKT('POINT (1 2)')
    point.empty()
    expect(point.isEmpty).toBe(true)
  })
})

describe('the last small gaps', () => {
  it('round-trips a CRS through XML', async () => {
    const wgs84 = gdal.SpatialReference.fromEPSG(4326)
    const back = gdal.SpatialReference.fromXML(wgs84.toXML())
    expect(back).toBeInstanceOf(gdal.SpatialReference)
    expect(back.authCode).toBe(4326)
    expect((await gdal.SpatialReference.fromXMLAsync(wgs84.toXML())).authCode).toBe(4326)
    expect(() => gdal.SpatialReference.fromXML('<not-a-crs/>')).toThrow()
  })

  it('answers the async fs pair', async () => {
    const path = sampleRaster('ts-gap-fs.tif', 2, 2)
    const stat = await gdal.fs.statAsync(path)
    expect(stat.size).toBeGreaterThan(0)
    await expect(gdal.fs.statAsync(`${path}.missing`)).rejects.toThrow()

    gdal.fs.mkdirRecursive('/vsimem/ts-gap-fs/a')
    gdal.fs.writeFile('/vsimem/ts-gap-fs/a/x.bin', Buffer.from([1]))
    const list = await gdal.fs.readDirAsync('/vsimem/ts-gap-fs/a')
    expect(list).toHaveLength(1)
    await expect(gdal.fs.readDirAsync('/vsimem/ts-gap-fs/missing')).rejects.toThrow()

    gdal.fs.unlink('/vsimem/ts-gap-fs/a/x.bin')
    gdal.fs.rmdir('/vsimem/ts-gap-fs/a')
    gdal.fs.rmdir('/vsimem/ts-gap-fs')
  })

  it('keeps a feature style readable, as the reference does', () => {
    const path = tmp('ts-gap-style.gpkg')
    const dataset = gdal.open(path, 'w', 'GPKG')
    const layer = dataset.layers.create('things', null, 'Point')
    layer.features.add(gdal.fromWKT('POINT (1 2)'), { name: 'a' })
    const feature = layer.features.first()!
    expect(feature.getStyleString()).toBeNull()

    feature.setStyleString('PEN(c:#FF0000,w:5px)')
    expect(feature.getStyleString()).toBe('PEN(c:#FF0000,w:5px)')
    // A fresh Feature for the same row sees it too — the style lives on the layer.
    expect(layer.features.get(feature.fid!)!.getStyleString()).toBe('PEN(c:#FF0000,w:5px)')

    feature.setStyleString(null)
    expect(feature.getStyleString()).toBeNull()
    dataset.close()
  })
})
