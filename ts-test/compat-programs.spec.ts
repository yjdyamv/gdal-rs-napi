import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import gdal from '../compat/index.js'

const scratch = mkdtempSync(join(tmpdir(), 'gdal-rs-napi-ts-programs-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A one-point GeoJSON layer, with a name field declared by `FieldDefn`. */
function vector(name: string): string {
  const path = join(scratch, name)
  const dataset = gdal.open(path, 'w', 'GeoJSON')
  const layer = dataset.layers.create('pts', gdal.SpatialReference.fromEPSG(4326)!, 'Point', {
    fields: [new gdal.FieldDefn('name', gdal.OFTString)],
  })
  layer.features.add(gdal.fromWKT('POINT (2.5 2.5)'), { name: 'a' })
  dataset.close()
  return path
}

describe('gdalinfo', () => {
  it('answers the report for an open dataset, and passes its own flags through', () => {
    const path = join(scratch, 'info.tif')
    const created = gdal.open(path, 'w', 'GTiff', 4, 4, 1, gdal.GDT_Byte)
    created.bands.get(1)!.fill(1)
    created.close()

    const dataset = gdal.open(path)
    expect(gdal.info(dataset)).toContain('Driver: GTiff/GeoTIFF')
    expect(gdal.info(dataset)).toContain('Size is 4, 4')

    const json = JSON.parse(gdal.info(dataset, ['-json']))
    expect(json.size).toEqual([4, 4])
    dataset.close()
  })

  it('still answers the build info when called with no dataset', () => {
    expect(gdal.info()).toBeTypeOf('object')
  })
})

describe('rasterize', () => {
  it('burns a vector source into a raster', () => {
    const source = vector('burn.geojson')
    const sourceDataset = gdal.open(source)
    const out = gdal.rasterize(join(scratch, 'burn.tif'), sourceDataset, [
      '-burn',
      '7',
      '-tr',
      '1',
      '1',
      '-te',
      '0',
      '0',
      '4',
      '4',
    ])
    sourceDataset.close()

    const band = out.bands.get(1)!
    expect(band.size).toEqual({ x: 4, y: 4 })
    expect(band.pixels.get(0, 0)).toBe(0)

    const burned: string[] = []
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        if (band.pixels.get(x, y) === 7) burned.push(`${x},${y}`)
      }
    }
    expect(burned.length).toBeGreaterThan(0)
    out.close()
  })

  it('refuses a dataset destination, synchronously and through the async door', async () => {
    const source = vector('refuse.geojson')
    const dataset = gdal.open(source)
    // A dataset destination is a runtime refusal rather than a type, so the guard is
    // reached through a loose alias that the declarations deliberately do not type.
    const loose = gdal as unknown as {
      rasterize(destination: unknown, source: unknown, args: string[]): unknown
      rasterizeAsync(destination: unknown, source: unknown, args: string[]): Promise<unknown>
    }
    expect(() => loose.rasterize(dataset, dataset, [])).toThrow(/destination path/)
    await expect(loose.rasterizeAsync(dataset, dataset, [])).rejects.toThrow(/destination path/)
    dataset.close()
  })
})

describe('FieldDefn', () => {
  it('declares fields with a type name or an OFT code', () => {
    const dataset = gdal.open(join(scratch, 'fields.geojson'), 'w', 'GeoJSON')
    const layer = dataset.layers.create('things', undefined, 'Point', {
      fields: [new gdal.FieldDefn('name', gdal.OFTString), new gdal.FieldDefn('count', 'Integer64')],
    })

    expect(layer.fields.getNames()).toEqual(['name', 'count'])
    expect(layer.fields.get(1).fieldType).toBe('String')
    expect(layer.fields.get(2).fieldType).toBe('Integer64')

    // A `FieldDefn` grows it afterwards too, and a numeric code is accepted there.
    const added = layer.fields.add(new gdal.FieldDefn('pop', gdal.OFTInteger))
    expect(added.fieldType).toBe('Integer')
    expect(layer.fields.getNames()).toContain('pop')

    // It also reaches the layer's `defn`, so a port can read the schema back.
    expect(layer.defn.name).toBe('things')
    expect(layer.defn.fields.getNames()).toContain('name')
    dataset.close()
  })
})
