import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * The native binding the compatibility layer adapts. Kept loosely typed on
 * purpose: what the suite validates by type is `compat/index.d.ts`, not the
 * generated one for the binding.
 */
export const native = require('..') as Record<string, any>

/** The native binding, under the name the migrated suites import it by. */
export const gdal = native

/** A scratch directory unique to this test process. */
export const workdir = mkdtempSync(join(tmpdir(), 'gdal-rs-napi-ts-'))

export const tmp = (name: string): string => join(workdir, name)

/**
 * A second scratch directory for NetCDF fixtures: this build's netCDF writer keeps
 * the file open for the life of the process, so cleanup of `workdir` would fail on
 * Windows if the `.nc` lived there.
 */
export const mdScratch = mkdtempSync(join(tmpdir(), 'gdal-rs-napi-ts-md-'))

/** Sample bytes for a `width * height` raster: 0, 1, 2, … wrapping at 256. */
export function ramp(width: number, height: number): Uint8Array {
  return Uint8Array.from({ length: width * height }, (_, index) => index % 256)
}

/** View a raw buffer of bytes as a typed array, copying first so an unaligned
 *  `Buffer` cannot make the view throw. */
export function asTypedArray<T extends ArrayBufferView>(
  bytes: Uint8Array,
  Ctor: new (buffer: ArrayBufferLike, byteOffset: number, length: number) => T,
): T {
  const copy = Uint8Array.from(bytes)
  return new Ctor(copy.buffer, copy.byteOffset, copy.byteLength / (Ctor as any).BYTES_PER_ELEMENT)
}

export function bytesOf(typed: ArrayBufferView): Buffer {
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength)
}

/** A `width * height` raster as a GeoTIFF path, filled with `ramp`. */
export function sampleRaster(name: string, width = 8, height = 6): string {
  const path = tmp(name)
  const dataset = native.createSync(path, {
    driver: 'GTiff',
    width,
    height,
    bandCount: 1,
    dataType: 'Uint8',
  })
  dataset.band(0).writePixelsSync(Buffer.from(ramp(width, height)))
  dataset.setGeoTransform([0, 1, 0, height, 0, -1])
  dataset.setProjection(native.epsgToWkt(4326))
  dataset.close()
  return path
}

/** A GeoPackage with one layer (`things`) holding one point feature. */
export function sampleVector(name: string): string {
  const path = tmp(name)
  const dataset = native.createVectorSync(path, 'GPKG')
  dataset
    .createLayer({ name: 'things', geometryType: 'Point', epsg: 4326 })
    .createFeature({ type: 'Point', coordinates: [1, 2] }, { name: 'alpha', population: 120 })
  dataset.close()
  return path
}
