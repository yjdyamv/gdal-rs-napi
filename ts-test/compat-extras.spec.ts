import { describe, expect, it } from 'vitest'

import gdal from '../compat/index.js'
import { native, ramp, sampleRaster, sampleVector, tmp } from './helpers.js'

// The corners the area suites do not reach: the `…Async` / callback spellings, the
// whole `fs` surface, the `Driver` methods, and the error paths.
describe('module extras', () => {
  it('openAsync resolves and calls a callback', async () => {
    const path = sampleRaster('ts-extra-open.tif', 2, 2)
    const dataset = await gdal.openAsync(path)
    expect(dataset.rasterSize).toEqual({ x: 2, y: 2 })
    dataset.close()

    const viaCallback = await new Promise<gdal.Dataset>((resolve, reject) => {
      const returned = gdal.openAsync(path, 'r', (error, opened) => {
        if (error) reject(error)
        else resolve(opened!)
      })
      expect(returned).toBeUndefined()
    })
    expect(viaCallback).toBeInstanceOf(gdal.Dataset)
    viaCallback.close()
  })

  it('opens a thread-safe dataset and reports it', () => {
    const path = sampleRaster('ts-extra-ts.tif', 4, 4)
    const dataset = gdal.open(path, 'rs')
    expect(dataset.threadSafe).toBe(true)
    expect(dataset.bands.get(1)).toBeInstanceOf(gdal.RasterBand)
    dataset.close()
  })

  it('drives the whole fs surface', () => {
    const root = '/vsimem/ts-extra'
    gdal.fs.mkdir(root)
    gdal.fs.mkdirRecursive(`${root}/a`)
    gdal.fs.writeFile(`${root}/a/one.bin`, Buffer.from([1, 2]))
    gdal.fs.writeFile(`${root}/a/two.bin`, Buffer.from([3]))
    expect(gdal.fs.readDir(`${root}/a`).length).toBe(2)
    expect(gdal.fs.glob(`${root}/a/*.bin`).length).toBe(2)
    gdal.fs.copyFile(`${root}/a/one.bin`, `${root}/a/one-copy.bin`)
    gdal.fs.rename(`${root}/a/one-copy.bin`, `${root}/a/renamed.bin`)
    expect(gdal.fs.stat(`${root}/a/renamed.bin`)?.size).toBe(2)
    expect(gdal.fs.isLocal(root)).toBe(true)
    expect(gdal.fs.diskFreeSpace(root)).toBeGreaterThanOrEqual(0)
    gdal.fs.clearCurlCache()
    gdal.fs.unlink(`${root}/a/one.bin`)
    gdal.fs.unlink(`${root}/a/two.bin`)
    gdal.fs.unlink(`${root}/a/renamed.bin`)
    gdal.fs.rmdir(`${root}/a`)
    gdal.fs.rmdir(`${root}`)
    expect(gdal.fs.exists(root)).toBe(false)
  })

  it('deletes a dataset with an explicit driver', () => {
    const path = tmp('ts-extra-delete.tif')
    native
      .createSync(path, { driver: 'GTiff', width: 2, height: 2, bandCount: 1, dataType: 'Uint8' })
      .close()
    gdal.deleteDataset(path, 'GTiff')
    expect(gdal.fs.exists(path)).toBe(false)
  })
})

describe('driver extras', () => {
  it('answers metadata and creates, opens, copies and deletes', async () => {
    const driver = gdal.drivers.get('GTiff')!
    expect(driver).toBeInstanceOf(gdal.Driver)
    expect(driver.name).toBe('GTiff')
    expect(driver.description).toBeTypeOf('string')
    expect(driver.longName).toBeTypeOf('string')
    expect(String(driver)).toBe('GTiff')
    expect(driver.testCapability('DCAP_CREATE')).toBe(true)
    expect(driver.getMetadata().DMD_MIMETYPE).toBe('image/tiff')

    const path = tmp('ts-extra-driver.tif')
    const created = driver.create(path, 2, 2, 1, gdal.GDT_Byte)
    expect(created).toBeInstanceOf(gdal.Dataset)
    created.bands.get(1)!.pixels.write(0, 0, 2, 2, ramp(2, 2))
    created.close()

    const asyncPath = tmp('ts-extra-driver-async.tif')
    ;(await driver.createAsync(asyncPath, 2, 2, 1, gdal.GDT_Byte)).close()

    const opened = driver.open(path)
    expect(opened.rasterSize).toEqual({ x: 2, y: 2 })
    const asyncOpened = await driver.openAsync(path)
    asyncOpened.close()

    const copyPath = tmp('ts-extra-driver-copy.tif')
    driver.createCopy(copyPath, opened).close()
    ;(await driver.createCopyAsync(tmp('ts-extra-driver-copy-async.tif'), opened)).close()
    opened.close()

    const renamed = tmp('ts-extra-driver-renamed.tif')
    driver.copyFiles(renamed, copyPath)
    const renamedAgain = tmp('ts-extra-driver-renamed-2.tif')
    driver.rename(renamedAgain, renamed)
    driver.deleteDataset(renamedAgain)
    expect(gdal.fs.exists(renamedAgain)).toBe(false)

    driver.delete(path)
    expect(gdal.fs.exists(path)).toBe(false)
    driver.delete(asyncPath)
  })
})

describe('dataset and band extras', () => {
  it('builds overviews, runs dialects, and flushes both ways', async () => {
    const path = sampleRaster('ts-extra-overviews.tif', 512, 512)
    const dataset = gdal.open(path, 'r+')
    dataset.buildOverviews({ levels: [2, 4] })
    expect(dataset.bands.get(1)!.overviews.count()).toBe(2)
    await dataset.buildOverviewsAsync({ levels: [2, 4] })
    expect(dataset.bands.get(1)!.overviews.count()).toBe(2)

    expect(dataset.getMetadata()).toBeInstanceOf(Object)
    dataset.setMetadata(['AREA_OR_POINT=Area'])
    expect(dataset.getMetadata().AREA_OR_POINT).toBe('Area')

    dataset.flush()
    await dataset.flushAsync()
    dataset.close()

    await new Promise<void>((resolve, reject) => {
      const reopened = gdal.open(path, 'r+')
      reopened.flushAsync((error) => {
        reopened.close()
        if (error) reject(error)
        else resolve()
      })
    })
  })

  it('reads a window asynchronously and reports the cache', async () => {
    const path = sampleRaster('ts-extra-band.tif', 8, 4)
    const dataset = gdal.open(path, 'r+')
    const band = dataset.bands.get(1)!
    const tile = await new Promise<Uint8Array>((resolve, reject) => {
      band.pixels.readAsync(0, 0, 4, 2, (error: Error | null, values?: Uint8Array) => {
        if (error) reject(error)
        else resolve(values!)
      })
    })
    expect(tile.length).toBe(8)

    expect(band.getStatistics(true, false)).toBeNull()
    const computed = await band.computeStatisticsAsync(false, true)
    expect(computed?.min).toBe(0)

    band.description = 'elevation'
    expect(band.description).toBe('elevation')
    band.noDataValue = 255
    expect(band.noDataValue).toBe(255)
    band.setMetadata(['BAND=yes'])
    expect(band.getMetadata().BAND).toBe('yes')
    band.flush()
    await band.flushAsync()
    dataset.close()
  })

  it('gives a per-dataset mask', () => {
    const path = tmp('ts-extra-mask.tif')
    const dataset = gdal.open(path, 'w', 'GTiff', 4, 4, 2, 'GDT_Byte')
    const band = dataset.bands.get(1)!
    band.createMaskBand(true)
    expect(band.getMaskBand()).toBeTruthy()
    expect(band.getMaskFlags()).toBeTypeOf('number')
    dataset.close()
  })
})

describe('vector extras', () => {
  it('drives the async feature spellings and the collection iterators', async () => {
    const path = sampleVector('ts-extra-vector.gpkg')
    const dataset = gdal.open(path, 'r+')
    const layer = dataset.layers.get(1)!

    // `next()` walks a materialised list, `forEach` visits every feature.
    layer.features.next()
    let visited = 0
    layer.features.forEach(() => {
      visited += 1
    })
    expect(visited).toBe(1)

    await layer.features.addAsync(gdal.fromWKT('POINT (7 7)'), { name: 'async' })
    expect(layer.features.count()).toBe(2)
    const added = [...layer.features].find((feature) => feature.fields.get('name') === 'async')!
    layer.features.setAsync(added.fid!, gdal.fromWKT('POINT (8 8)'))
    await layer.features.removeAsync(added.fid!)
    expect(layer.features.count()).toBe(1)

    // The fields collection's own iterators.
    const names: string[] = []
    layer.fields.forEach((field) => names.push(field.name))
    expect(names).toContain('name')

    const feature = layer.features.first()!
    const visitedFields: string[] = []
    feature.fields.forEach((_value: unknown, name: string) => visitedFields.push(name))
    expect(visitedFields.length).toBeGreaterThan(0)
    expect([...feature.fields].length).toBeGreaterThan(0)

    await layer.flushAsync()
    dataset.close()
  })

  it('copies and drops asynchronously', async () => {
    const source = gdal.open(sampleVector('ts-extra-copy-src.gpkg'))
    const target = gdal.open(tmp('ts-extra-copy-dst.gpkg'), 'w', 'GPKG')
    await target.layers.copyAsync(source.layers.get(1)!, 'copied')
    expect(target.layers.get('copied')).toBeInstanceOf(gdal.Layer)
    source.close()
    target.close()
  })
})

describe('error paths', () => {
  it('refuses what the reference refuses', () => {
    expect(() => gdal.createPixelFunc(123 as never)).toThrow()
    expect(() => gdal.addPixelFunc('', () => {})).toThrow()
    expect(() => gdal.wrapVRT({ bands: [] })).toThrow()
    expect(() => gdal.wrapVRT({ bands: [{ sources: [] }] })).toThrow()
    expect(() => new gdal.CoordinateTransformation({} as never, {} as never)).toThrow()
    expect(() => gdal.fromWKT('NOT A GEOMETRY')).toThrow()
  })

  it('registers and applies a pixel function through wrapVRT', () => {
    const path = tmp('ts-extra-pixelfunc.tif')
    const source = native.createSync(path, { driver: 'GTiff', width: 2, height: 1, bandCount: 1, dataType: 'Float64' })
    source.band(0).writePixelsSync(Buffer.from(Float64Array.from([1, 2]).buffer))
    source.close()

    const sourceDataset = native.openSync(path)
    gdal.addPixelFunc('tsShift', gdal.createPixelFuncWithArgs((args: Record<string, string>, value: number) => value + Number(args.k)))
    const vrt = gdal.wrapVRT({
      bands: [{ sources: [sourceDataset.band(0)], pixelFunc: 'tsShift', pixelFuncArgs: { k: '10' } }],
    })
    const derived = native.openSync(vrt)
    const out = new Float64Array(Uint8Array.from(derived.band(0).readPixelsSync()).buffer)
    expect([...out]).toEqual([11, 12])
    derived.close()
    sourceDataset.close()
  })

  it('refuses a calcAsync over bands of different sizes', async () => {
    const a = gdal.open(tmp('ts-extra-calc-a.tif'), 'w', 'GTiff', 4, 1, 1, 'GDT_Float64')
    const b = gdal.open(tmp('ts-extra-calc-b.tif'), 'w', 'GTiff', 2, 1, 1, 'GDT_Float64')
    await expect(
      gdal.calcAsync({ a: a.bands.get(1)! }, b.bands.get(1)!, (value: number) => value),
    ).rejects.toThrow()
    a.close()
    b.close()
  })

  it('refuses a mux with no inputs and a transform with no fn', () => {
    expect(() => new gdal.RasterMuxStream({})).toThrow()
    expect(() => new gdal.RasterTransform({} as never)).toThrow()
  })
})
