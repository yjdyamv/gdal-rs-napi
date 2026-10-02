import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import gdal from '../compat/index.js'
import { mdScratch, native, ramp, tmp } from './helpers.js'

// The multidimensional model, on a NetCDF fixture — the one multidimensional
// format this build can also write. The `.nc` lives outside `workdir` because the
// netCDF writer holds it open for the life of the process.
let fixtures: { raster: string; netcdf: string }

beforeAll(async () => {
  const raster = tmp('ts-md-source.tif')
  const created = gdal.open(raster, 'w', 'GTiff', 4, 3, 1, 'GDT_Byte')
  created.bands.get(1)!.pixels.write(0, 0, 4, 3, ramp(4, 3))
  created.close()
  const netcdf = join(mdScratch, 'ts-md.nc')
  await native.translate(netcdf, raster, ['-of', 'netCDF'])
  fixtures = { raster, netcdf }
})

describe('the multidimensional model', () => {
  it('hands out the root group and its four collections', () => {
    const dataset = gdal.open(fixtures.netcdf)
    const root = dataset.root!
    expect(root).toBeInstanceOf(gdal.Group)
    expect(root.description).toBe('/')
    expect(root.arrays).toBeInstanceOf(gdal.GroupArrays)
    expect(root.arrays.getNames()).toEqual(['Band1'])
    expect(root.arrays.count()).toBe(1)
    expect(root.arrays.get('Band1')?.description).toBe('/Band1')
    expect(root.arrays.get(2)).toBeNull()
    expect(root.groups.getNames()).toEqual([])
    expect(root.dimensions.getNames()).toEqual(['x', 'y'])
    expect(root.attributes.getNames()).toContain('GDAL')

    expect([...root.arrays].length).toBe(1)
    expect(root.arrays.map((array) => array.description)).toEqual(['/Band1'])
    dataset.close()
  })

  it('reads an array, its attributes, a view and a mask', () => {
    const dataset = gdal.open(fixtures.netcdf)
    const array = dataset.root!.arrays.get('Band1')!
    expect(array).toBeInstanceOf(gdal.MDArray)
    expect(array.dataType).toBe('Uint8')
    expect(array.length).toBe(12)
    expect(array.noDataValue).toBeNull()
    expect(array.srs).toBeNull()
    expect(array.dimensions.get('y')?.size).toBe(3)

    expect([...array.read()]).toEqual([8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3])
    expect([...array.read([1, 1], [2, 2])]).toEqual([5, 6, 1, 2])

    expect(array.attributes).toBeInstanceOf(gdal.ArrayAttributes)
    expect(array.attributes.get('long_name')?.value).toBe('GDAL Band Number 1')
    expect(array.attributes.get('long_name')?.dataType).toBe('String')

    expect([...array.getView('[0,:]').read()]).toEqual([8, 9, 10, 11])
    expect([...array.getMask().read()]).toEqual(new Array(12).fill(1))

    const asDataset = array.asDataset()
    expect(asDataset.rasterSize).toEqual({ x: 3, y: 4 })
    expect(asDataset.bands.count()).toBe(1)
    asDataset.close()
    dataset.close()
  })

  it('answers null for a raster with no multidimensional model', () => {
    const geotiff = gdal.open(fixtures.raster)
    expect(geotiff.root).toBeNull()
    geotiff.close()
    const dataset = gdal.open(fixtures.netcdf)
    expect(dataset.root).not.toBeNull()
    dataset.close()
  })
})
