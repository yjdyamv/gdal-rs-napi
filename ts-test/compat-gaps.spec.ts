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
