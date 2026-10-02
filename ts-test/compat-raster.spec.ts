import { describe, expect, it } from 'vitest'

import gdal from '../compat/index.js'
import { native, ramp, sampleRaster, tmp } from './helpers.js'

// `Dataset`, `RasterBand`, the pixel object and the module-level raster tools.
describe('raster', () => {
  it('opens a dataset and reports it the reference\'s way', () => {
    const path = sampleRaster('ts-raster.tif', 8, 6)
    const dataset = gdal.open(path)
    expect(dataset).toBeInstanceOf(gdal.Dataset)
    expect(dataset.rasterSize).toEqual({ x: 8, y: 6 })
    expect(dataset.driver).toBeInstanceOf(gdal.Driver)
    expect(dataset.description).toBeTruthy()
    expect(dataset.geoTransform?.[1]).toBe(1)
    expect(dataset.srs).toBeInstanceOf(gdal.SpatialReference)
    expect(dataset.getFileList().length).toBe(1)
    expect(dataset.threadSafe).toBe(false)
    expect(dataset.root).toBeNull()
    expect(dataset.getGCPProjection()).toBeNull()

    const band = dataset.bands.get(1)!
    expect(band).toBeInstanceOf(gdal.RasterBand)
    expect(band.size).toEqual({ x: 8, y: 6 })
    expect(band.blockSize.x).toBeGreaterThan(0)
    expect(band.dataType).toBe(gdal.GDT_Byte)
    expect(band.colorInterpretation).toBe('GrayIndex')
    expect(band.id).toBe(1)
    expect(band.readOnly).toBe(true)
    expect(band.hasArbitraryOverviews).toBe(false)
    expect(band.unitType).toBeNull()
    expect(band.scale).toBeNull()
    expect(band.offset).toBeNull()
    expect(band.minimum).toBeNull()
    expect(band.maximum).toBeNull()
    expect(band.categoryNames).toEqual([])
    expect(band.overviews).toBeInstanceOf(gdal.RasterBandOverviews)
    expect(band.overviews.count()).toBe(0)
    expect(band.getMaskFlags()).toBeTypeOf('number')
    dataset.close()
  })

  it('reads samples and statistics through the pixel object', () => {
    const path = sampleRaster('ts-raster-pixels.tif', 8, 6)
    const dataset = gdal.open(path)
    const band = dataset.bands.get(1)!
    expect(band.pixels.xSize).toBe(8)
    expect(band.pixels.ySize).toBe(6)
    expect(band.pixels.get(0, 0)).toBe(0)
    expect(band.pixels.get(1, 0)).toBe(1)
    expect(band.pixels.read(0, 0, 8, 6).length).toBe(48)

    const statistics = band.getStatistics(false, true)
    expect(statistics?.min).toBe(0)
    expect(statistics?.max).toBe(47)
    expect(band.computeStatistics(false, true)).toHaveProperty('min')
    dataset.close()
  })

  it('writes a raster and reads it back', async () => {
    const path = tmp('ts-raster-write.tif')
    const dataset = gdal.open(path, 'w', 'GTiff', 4, 3, 1, 'GDT_Byte')
    const band = dataset.bands.get(1)!
    band.pixels.write(0, 0, 4, 3, ramp(4, 3))
    expect(band.pixels.get(0, 0)).toBe(0)
    band.setMetadata({ BAND: 'yes' })
    expect(band.getMetadata().BAND).toBe('yes')
    dataset.setMetadata({ DATASET: 'yes' })
    expect(dataset.getMetadata().DATASET).toBe('yes')
    dataset.flush()
    await dataset.flushAsync()
    dataset.close()

    const reopened = gdal.open(path)
    expect(reopened.bands.get(1)!.pixels.read(0, 0, 4, 3).length).toBe(12)
    reopened.close()
  })

  it('gives a band a mask and reads it as a band', () => {
    const path = tmp('ts-raster-mask.tif')
    const dataset = gdal.open(path, 'w', 'GTiff', 4, 4, 1, 'GDT_Byte')
    const band = dataset.bands.get(1)!
    band.createMaskBand()
    expect(band.getMaskBand()).toBeTruthy()
    expect(band.asMDArray()).toBeTruthy()
    dataset.close()
  })

  it('runs the module-level tools, sync and async', async () => {
    const path = sampleRaster('ts-raster-util.tif', 8, 6)
    const dataset = gdal.open(path)

    const copy = gdal.translate(tmp('ts-raster-util-copy.tif'), dataset, ['-of', 'GTiff', '-co', 'COMPRESS=DEFLATE'])
    expect(copy.driver.name).toBe('GTiff')
    expect(copy.rasterSize).toEqual({ x: 8, y: 6 })
    copy.close()

    const asyncCopy = await gdal.translateAsync(tmp('ts-raster-util-async.tif'), dataset, ['-of', 'GTiff'])
    expect(asyncCopy.driver.name).toBe('GTiff')
    asyncCopy.close()

    const vrt = gdal.buildVRT(tmp('ts-raster-util.vrt'), [dataset], [])
    expect(vrt.driver.name).toBe('VRT')
    vrt.close()
    const asyncVrt = await gdal.buildVRTAsync(tmp('ts-raster-util-async.vrt'), [dataset], [])
    expect(asyncVrt.driver.name).toBe('VRT')
    asyncVrt.close()

    const suggested = gdal.suggestedWarpOutput({ src: dataset, t_srs: gdal.SpatialReference.fromEPSG(3857) })
    expect(suggested.rasterSize.x).toBeGreaterThan(0)
    expect(suggested.geoTransform.length).toBe(6)
    const suggestedAsync = await gdal.suggestedWarpOutputAsync({
      src: dataset,
      t_srs: gdal.SpatialReference.fromEPSG(3857),
    })
    expect(suggestedAsync.rasterSize.x).toBe(suggested.rasterSize.x)

    const warped = gdal.warp(tmp('ts-raster-util-3857.tif'), null, [dataset], ['-t_srs', 'EPSG:3857'])
    expect(warped.driver.name).toBe('GTiff')
    warped.close()
    const warpedAsync = await gdal.warpAsync(tmp('ts-raster-util-3857-async.tif'), null, [dataset], ['-t_srs', 'EPSG:3857'])
    expect(warpedAsync.driver.name).toBe('GTiff')
    warpedAsync.close()

    const hillshade = gdal.dem(tmp('ts-raster-hillshade.tif'), dataset, 'hillshade', [])
    expect(hillshade.driver.name).toBe('GTiff')
    hillshade.close()
    const hillshadeAsync = await gdal.demAsync(tmp('ts-raster-hillshade-async.tif'), dataset, 'hillshade', [])
    expect(hillshadeAsync.driver.name).toBe('GTiff')
    hillshadeAsync.close()

    expect(gdal.checksumImage(dataset.bands.get(1)!, 0, 0, 8, 6)).toBeTypeOf('number')
    expect(await gdal.checksumImageAsync(dataset.bands.get(1)!, 0, 0, 8, 6)).toBeTypeOf('number')
    dataset.close()
  })

  it('reprojects one dataset into another', () => {
    const path = sampleRaster('ts-raster-reproj.tif', 8, 8)
    const source = gdal.open(path)
    const probe = native.openSync(path)
    const sizes = probe.suggestedWarpOutputSync({ dstWkt: native.epsgToWkt(3857) })
    probe.close()

    const destPath = tmp('ts-raster-reproj-out.tif')
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
    gdal.reprojectImage({ src: source, dst: destination, t_srs: gdal.SpatialReference.fromEPSG(3857) })
    destination.close()
    source.close()

    const reopened = gdal.open(destPath)
    expect(reopened.bands.get(1)!.size.x).toBe(sizes.width)
    reopened.close()
  })

  it('fills no-data and sieves in place', () => {
    const path = tmp('ts-raster-fill.tif')
    const dataset = gdal.open(path, 'w', 'GTiff', 16, 16, 1, 'Float32')
    const band = dataset.bands.get(1)!
    band.fill(1)
    band.noDataValue = -9999
    band.pixels.write(4, 4, 2, 2, new Float32Array([-9999, -9999, -9999, -9999]))
    gdal.fillNodata({ src: band, searchDist: 5 })
    expect(band.pixels.read(4, 4, 1, 1)[0]).toBe(1)
    gdal.sieveFilter({ src: band, threshold: 2 })
    gdal.sieveFilter({ src: band, dst: band, threshold: 2 })
    dataset.close()
  })

  it('refuses to sieve into a different destination band, since it works in place', () => {
    const path = tmp('ts-raster-sieve-refuse.tif')
    const dataset = gdal.open(path, 'w', 'GTiff', 4, 4, 2, 'GDT_Byte')
    const first = dataset.bands.get(1)!
    const second = dataset.bands.get(2)
    expect(() => gdal.sieveFilter({ src: first!, dst: second!, threshold: 2 })).toThrow(TypeError)
    dataset.close()
  })
})
