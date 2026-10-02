import { describe, expect, it } from 'vitest'

import gdal from '../compat/index.js'
import { native, ramp, tmp } from './helpers.js'

// The raster streams the pixel object carries, `calcAsync` over them, the two
// pieces it is built from, and the VRT pixel functions.
describe('streams, pixel-wise calc and pixel functions', () => {
  it('reads a band as a stream of the band\'s own samples', async () => {
    const path = tmp('ts-stream-read.tif')
    const dataset = gdal.open(path, 'w', 'GTiff', 4, 4, 1, 'GDT_Byte')
    const band = dataset.bands.get(1)!
    band.pixels.write(0, 0, 4, 4, ramp(4, 4))

    const samples: number[] = []
    for await (const chunk of band.pixels.createReadStream({ rows: 2 })) {
      samples.push(...(chunk as Uint8Array))
    }
    expect(samples.length).toBe(16)
    dataset.close()
  })

  it('writes a band from a stream', async () => {
    const path = tmp('ts-stream-write.tif')
    const dataset = gdal.open(path, 'w', 'GTiff', 4, 4, 1, 'GDT_Byte')
    const band = dataset.bands.get(1)!
    const writable = band.pixels.createWriteStream({ rows: 2 })
    await new Promise<void>((resolve, reject) => {
      writable.on('finish', resolve)
      writable.on('error', reject)
      writable.write(Uint8Array.from(ramp(4, 4)))
      writable.end()
    })
    expect(band.pixels.read(0, 0, 4, 4).length).toBe(16)
    dataset.close()
  })

  it('reads and writes a whole block', () => {
    const path = tmp('ts-stream-block.tif')
    const dataset = gdal.open(path, 'w', 'GTiff', 4, 4, 1, 'GDT_Byte')
    const band = dataset.bands.get(1)!
    band.pixels.write(0, 0, 4, 4, ramp(4, 4))
    const block = band.pixels.readBlock(0, 0)
    expect(block.length).toBeGreaterThan(0)
    expect(() => band.pixels.writeBlock(0, 0, block)).not.toThrow()
    dataset.close()
  })

  it('computes a band from several with calcAsync', async () => {
    const a = gdal.open(tmp('ts-calc-a.tif'), 'w', 'GTiff', 4, 1, 1, 'GDT_Float64')
    const b = gdal.open(tmp('ts-calc-b.tif'), 'w', 'GTiff', 4, 1, 1, 'GDT_Float64')
    const out = gdal.open(tmp('ts-calc-out.tif'), 'w', 'GTiff', 4, 1, 1, 'GDT_Float64')
    const bandA = a.bands.get(1)!
    const bandB = b.bands.get(1)!
    const bandOut = out.bands.get(1)!
    bandA.pixels.write(0, 0, 4, 1, new Float64Array([1, 2, 3, 4]))
    bandB.pixels.write(0, 0, 4, 1, new Float64Array([10, 20, 30, 40]))

    await gdal.calcAsync({ a: bandA, b: bandB }, bandOut, (x: number, y: number) => x + y)
    expect([...bandOut.pixels.read(0, 0, 4, 1)]).toEqual([11, 22, 33, 44])

    a.close()
    b.close()
    out.close()
  })

  it('muxes and transforms streams in lockstep', async () => {
    const a = gdal.open(tmp('ts-mux-a.tif'), 'w', 'GTiff', 4, 1, 1, 'GDT_Float64')
    const b = gdal.open(tmp('ts-mux-b.tif'), 'w', 'GTiff', 4, 1, 1, 'GDT_Float64')
    a.bands.get(1)!.pixels.write(0, 0, 4, 1, new Float64Array([1, 2, 3, 4]))
    b.bands.get(1)!.pixels.write(0, 0, 4, 1, new Float64Array([10, 20, 30, 40]))

    const mux = new gdal.RasterMuxStream({
      a: a.bands.get(1)!.pixels.createReadStream(),
      b: b.bands.get(1)!.pixels.createReadStream(),
    })
    const transform = new gdal.RasterTransform({
      fn: (x: number, y: number) => x + y,
      type: 'Float64',
    })

    const out: number[] = []
    await new Promise<void>((resolve, reject) => {
      mux.pipe(transform)
      transform.on('data', (chunk: Float64Array) => out.push(...chunk))
      transform.on('end', resolve)
      transform.on('error', reject)
    })
    expect(out).toEqual([11, 22, 33, 44])
    a.close()
    b.close()
  })

  it('registers a pixel function and reads a derived VRT band with it', () => {
    const path = tmp('ts-pixelfunc.tif')
    const source = native.createSync(path, { driver: 'GTiff', width: 4, height: 1, bandCount: 1, dataType: 'Float64' })
    source.band(0).writePixelsSync(Buffer.from(Float64Array.from([1, 2, 3, 4]).buffer))
    source.close()

    const sourceDataset = native.openSync(path)
    const band = sourceDataset.band(0)

    gdal.addPixelFunc('tsDouble', gdal.createPixelFunc((value: number) => value * 2))
    const vrt = gdal.wrapVRT({ bands: [{ sources: [band], pixelFunc: 'tsDouble' }] })

    const derived = native.openSync(vrt)
    const out = new Float64Array(Uint8Array.from(derived.band(0).readPixelsSync()).buffer)
    expect([...out]).toEqual([2, 4, 6, 8])

    derived.close()
    sourceDataset.close()
  })

  it('validates the pixel-function helpers', () => {
    expect(typeof gdal.toPixelFunc((sources: unknown, buffer: unknown) => ({ sources, buffer }))).toBe('function')
    expect(typeof gdal.createPixelFuncWithArgs((args: Record<string, string>) => Number(args.k))).toBe('function')
    expect(() => gdal.createPixelFunc(123 as never)).toThrow()
    expect(() => gdal.addPixelFunc('', () => {})).toThrow()
  })
})
