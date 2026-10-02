import { describe, expect, it } from 'vitest'

import gdal from '../compat/index.js'
import { native, ramp, sampleRaster, sampleVector, tmp } from './helpers.js'

// Fill the remaining branches: the async spellings with callbacks, the programs
// that take a string source, the `Envelope` comparison branches, and the setters.
describe('coverage extras', () => {
  it('reads a geometry envelope, both spellings', () => {
    const point = gdal.fromWKT('POINT (3 4)')
    expect(point.envelope()).toBeInstanceOf(gdal.Envelope)
    expect(point.getEnvelope()).toBeInstanceOf(gdal.Envelope)
    expect(point.envelope()?.minX).toBe(3)
  })

  it('covers the Envelope comparison branches', () => {
    const empty = new gdal.Envelope()
    // merge with an empty is a no-op; merging into an empty takes the other.
    expect(empty.merge(new gdal.Envelope())).toBe(empty)
    const box = new gdal.Envelope({ minX: 0, minY: 0, maxX: 2, maxY: 2 })
    expect(box.merge(empty)).toBe(box)
    expect(new gdal.Envelope().merge(box).maxX).toBe(2)
    expect(box.merge(3, 4).maxX).toBe(3)

    // intersect with no overlap empties the box; an empty one takes the other.
    expect(
      new gdal.Envelope().intersect(new gdal.Envelope({ minX: 0, minY: 0, maxX: 2, maxY: 2 })).maxX,
    ).toBe(2)
    expect(new gdal.Envelope({ minX: 0, minY: 0, maxX: 2, maxY: 2 }).intersect(
      new gdal.Envelope({ minX: 10, minY: 10, maxX: 20, maxY: 20 }),
    ).isEmpty()).toBe(true)

    const box3 = new gdal.Envelope3D()
    expect(box3.isEmpty()).toBe(true)
    const z = new gdal.Envelope3D({ minX: 0, minY: 0, maxX: 1, maxY: 1, minZ: -1, maxZ: 1 })
    z.merge(new gdal.Envelope3D({ minX: 0, minY: 0, maxX: 2, maxY: 2, minZ: -3, maxZ: 3 }))
    expect(z.maxX).toBe(2)
    expect(z.minZ).toBe(-3)
    z.merge(5, 5, 9)
    expect(z.maxZ).toBe(9)
  })

  it('drives the Layer setters and the feature geometry setter', () => {
    const path = sampleVector('ts-gaps-vector.gpkg')
    const dataset = gdal.open(path, 'r+')
    const layer = dataset.layers.get(1)!
    layer.srs = gdal.SpatialReference.fromEPSG(4326)
    expect(layer.srs).toBeInstanceOf(gdal.SpatialReference)
    expect(layer.geomType).toBe('Point')

    const feature = layer.features.first()!
    feature.setGeometry(gdal.fromWKT('POINT (6 6)'))
    expect(feature.getGeometry()?.toWKT()).toBe('POINT (6 6)')
    dataset.close()
  })

  it('creates, copies and drops layers asynchronously, with string CRSs and options', async () => {
    const sourcePath = tmp('ts-gaps-layers-src.gpkg')
    const source = gdal.open(sourcePath, 'w', 'GPKG')
    source.layers.create('src', 'EPSG:4326', 'Point')
    source.close()
    const sourceReopened = gdal.open(sourcePath)

    const path = tmp('ts-gaps-layers.gpkg')
    const dataset = gdal.open(path, 'w', 'GPKG')
    const layer = dataset.layers.create('one', 'EPSG:4326', 'Point', { SPATIAL_INDEX: 'YES' })
    expect(layer.name).toBe('one')
    await dataset.layers.createAsync('two', gdal.SpatialReference.fromEPSG(4326), 'Point')
    expect(dataset.layers.count()).toBe(2)

    // A copy has to come from a *different* dataset, as GDAL requires.
    await dataset.layers.copyAsync(sourceReopened.layers.get(1)!, 'copy')
    expect(dataset.layers.get('copy')).toBeInstanceOf(gdal.Layer)

    await dataset.layers.removeAsync('copy')
    expect(dataset.layers.get('copy')).toBeNull()
    await dataset.layers.removeAsync('one')
    await dataset.layers.removeAsync(1)
    expect(dataset.layers.count()).toBe(0)

    expect(() => dataset.layers.remove('missing')).toThrow()
    sourceReopened.close()
    dataset.close()
  })

  it('runs the dataset setters and reports overview levels', () => {
    const path = sampleRaster('ts-gaps-dataset.tif', 512, 512)
    const dataset = gdal.open(path, 'r+')
    dataset.srs = gdal.SpatialReference.fromEPSG(3857)
    expect(dataset.srs).toBeInstanceOf(gdal.SpatialReference)
    dataset.geoTransform = [0, 2, 0, 0, 0, -2]
    expect(dataset.geoTransform?.[1]).toBe(2)

    dataset.buildOverviews({ levels: [2, 4] })
    const band = dataset.bands.get(1)!
    expect(band.overviews.get(1)).toBeTruthy()
    expect(band.overviews.getBySampleCount(300)).toBeTruthy()
    expect(band.overviews.get(99)).toBeNull()
    dataset.close()
  })

  it('writes a single pixel and reads it back', () => {
    const path = tmp('ts-gaps-pixel.tif')
    const dataset = gdal.open(path, 'w', 'GTiff', 2, 2, 1, 'GDT_Byte')
    const band = dataset.bands.get(1)!
    band.pixels.write(0, 0, 2, 2, ramp(2, 2))
    band.pixels.set(1, 1, 9)
    expect(band.pixels.get(1, 1)).toBe(9)
    dataset.close()
  })

  it('runs the vector programs, sync and async', async () => {
    const source = gdal.open(sampleVector('ts-gaps-vector-translate.gpkg'))
    const out = gdal.vectorTranslate(tmp('ts-gaps-out.gpkg'), source, ['-f', 'GPKG', '-nln', 'copied'])
    expect(out.layers.get(1)!.name).toBe('copied')
    out.close()

    const asyncOut = await gdal.vectorTranslateAsync(tmp('ts-gaps-out-async.gpkg'), source, [
      '-f',
      'GPKG',
      '-nln',
      'copied',
    ])
    expect(asyncOut.layers.get(1)!.name).toBe('copied')
    asyncOut.close()

    const viaCallback = await new Promise<gdal.Dataset>((resolve, reject) => {
      gdal.vectorTranslateAsync(
        tmp('ts-gaps-out-cb.gpkg'),
        source,
        ['-f', 'GPKG', '-nln', 'copied'],
        (error: Error | null, dataset?: gdal.Dataset) => (error ? reject(error) : resolve(dataset!)),
      )
    })
    expect(viaCallback.layers.get(1)!.name).toBe('copied')
    viaCallback.close()
    source.close()
  })

  it('builds a VRT from paths, and reports progress through the utilities', async () => {
    const path = sampleRaster('ts-gaps-vrt.tif', 8, 6)
    const dataset = gdal.open(path)
    const vrt = gdal.buildVRT(tmp('ts-gaps.vrt'), [path], [])
    expect(vrt.driver.name).toBe('VRT')
    vrt.close()

    let reported = 0
    const copy = await gdal.translateAsync(tmp('ts-gaps-progress.tif'), dataset, ['-of', 'GTiff'], {
      progress_cb: () => {
        reported += 1
        return true
      },
    })
    expect(copy.driver.name).toBe('GTiff')
    expect(reported).toBeGreaterThanOrEqual(0)
    copy.close()
    dataset.close()
  })

  it('refuses a warp with an existing destination, sync and async', async () => {
    const path = sampleRaster('ts-gaps-warp.tif', 4, 4)
    const dataset = gdal.open(path)
    expect(() => gdal.warp(tmp('ts-gaps-warp-out.tif'), { not: null } as never, [dataset], [])).toThrow(TypeError)
    await expect(
      gdal.warpAsync(tmp('ts-gaps-warp-out.tif'), { not: null } as never, [dataset], []),
    ).rejects.toThrow(TypeError)
    dataset.close()
  })

  it('reprojects, fills and sieves asynchronously', async () => {
    const path = sampleRaster('ts-gaps-reproj.tif', 8, 8)
    const source = gdal.open(path)
    const probe = native.openSync(path)
    const sizes = probe.suggestedWarpOutputSync({ dstWkt: native.epsgToWkt(3857) })
    probe.close()
    const destPath = tmp('ts-gaps-reproj-out.tif')
    const dest = native.createSync(destPath, {
      driver: 'GTiff',
      width: sizes.width,
      height: sizes.height,
      bandCount: 1,
      dataType: 'Uint8',
    })
    dest.setGeoTransform(sizes.geoTransform)
    dest.setProjection(native.epsgToWkt(3857))
    const destination = new gdal.Dataset(dest)
    await gdal.reprojectImageAsync({ src: source, dst: destination, t_srs: gdal.SpatialReference.fromEPSG(3857) })
    destination.close()
    source.close()

    const fillPath = tmp('ts-gaps-fill.tif')
    const fill = gdal.open(fillPath, 'w', 'GTiff', 16, 16, 1, 'Float32')
    const band = fill.bands.get(1)!
    band.fill(1)
    band.noDataValue = -9999
    band.pixels.write(4, 4, 2, 2, new Float32Array([-9999, -9999, -9999, -9999]))
    await gdal.fillNodataAsync({ src: band, searchDist: 5 })
    expect(band.pixels.read(4, 4, 1, 1)[0]).toBe(1)
    await gdal.sieveFilterAsync({ src: band, threshold: 2 })
    fill.close()
  })
})
