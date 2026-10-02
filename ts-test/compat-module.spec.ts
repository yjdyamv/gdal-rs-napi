import { describe, expect, it } from 'vitest'

import gdal from '../compat/index.js'
import { native, tmp } from './helpers.js'

// The module-level surface: the global switches, the metadata helpers, the
// configuration store, the virtual file system and the driver registry.
describe('the module-level API', () => {
  it('reports the versions this build links', () => {
    expect(gdal.version).toMatch(/^GDAL \d/)
    expect(gdal.bundled).toBe(native.bundled)
  })

  it('answers info() and infoAsync() with the same build', async () => {
    expect(gdal.info().releaseName).toBe(native.info().releaseName)
    expect((await gdal.infoAsync()).releaseName).toBe(native.info().releaseName)
  })

  it('converts between sample-type names and codes', () => {
    expect(gdal.toDataType('Float32')).toBe(native.toDataType('Float32'))
    expect(gdal.fromDataType(native.toDataType('Float32'))).toBe('Float32')
  })

  it('turns GDAL debug logging on and off', () => {
    gdal.verbose()
    expect(gdal.config.get('CPL_DEBUG')).toBe('ON')
    gdal.quiet()
    expect(gdal.config.get('CPL_DEBUG')).toBe('OFF')
  })

  it('reads and writes GDAL configuration, and tells unset from empty', () => {
    gdal.config.set('GDAL_TS_NAPI_TEST', 'value')
    expect(gdal.config.get('GDAL_TS_NAPI_TEST')).toBe('value')
    expect(gdal.config.get('GDAL_TS_NAPI_ABSENT')).toBeNull()
    expect(gdal.config.get('GDAL_TS_NAPI_ABSENT', 'fallback')).toBe('fallback')
    gdal.config.set('GDAL_TS_NAPI_TEST', null)
    expect(gdal.config.get('GDAL_TS_NAPI_TEST')).toBeNull()
  })

  it('renders a decimal degree as DMS', () => {
    expect(gdal.decToDMS(45.5, 'Lat')).toContain('N')
    expect(gdal.decToDMS(45.5, 'Long', 0)).toContain('E')
  })

  it('lists the drivers as a collection, keyed by name and index', () => {
    expect(gdal.drivers.count()).toBeGreaterThan(100)
    expect(gdal.drivers.get('GTiff')?.name).toBe('GTiff')
    expect(gdal.drivers.get(1)?.name).toBeTypeOf('string')
    expect(gdal.drivers.getNames()).toContain('GTiff')
    expect([...gdal.drivers].length).toBe(gdal.drivers.count())
    expect(gdal.drivers.map((driver) => driver.name)).toContain('GTiff')
  })

  it('reports the last error, or null', () => {
    const error = gdal.lastError
    expect(error === null || 'message' in (error as object)).toBe(true)
  })

  it('drives the in-memory file system through `vsimem` and `fs`', () => {
    const path = gdal.vsimem.set(Buffer.from('hello'), 'ts-vsimem.bin')
    expect(path).toBe('/vsimem/ts-vsimem.bin')
    expect(gdal.fs.exists(path)).toBe(true)
    expect(gdal.fs.stat(path)?.size).toBe(5)
    expect(gdal.fs.readFile(path).toString()).toBe('hello')

    gdal.vsimem.copy('ts-vsimem.bin', '/vsimem/ts-vsimem-copy.bin')
    expect(gdal.fs.readFile('/vsimem/ts-vsimem-copy.bin').toString()).toBe('hello')

    gdal.vsimem.release('ts-vsimem.bin')
    gdal.vsimem.release('ts-vsimem.bin')
    gdal.vsimem.release('/vsimem/ts-vsimem-copy.bin')
    expect(gdal.fs.exists(path)).toBe(false)
  })

  it('deletes a dataset through its own driver', () => {
    const path = tmp('ts-delete.tif')
    native
      .createSync(path, { driver: 'GTiff', width: 2, height: 2, bandCount: 1, dataType: 'Uint8' })
      .close()
    gdal.deleteDataset(path)
    expect(gdal.fs.exists(path)).toBe(false)
  })

  it('forwards the event-loop warning switch', () => {
    const before = gdal.eventLoopWarning
    gdal.eventLoopWarning = 100
    expect(gdal.eventLoopWarning).toBe(100)
    expect(native.eventLoopWarning).toBe(100)
    gdal.eventLoopWarning = false
    expect(gdal.eventLoopWarning).toBe(false)
    gdal.eventLoopWarning = before
  })
})
