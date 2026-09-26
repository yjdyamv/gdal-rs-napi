import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

export const gdal = createRequire(import.meta.url)('..')

/** A scratch directory that is removed when the test process exits. */
export const workdir = mkdtempSync(join(tmpdir(), 'gdal-rs-napi-'))
process.on('exit', () => rmSync(workdir, { recursive: true, force: true }))

export const tmp = (name) => join(workdir, name)

/** Sample bytes for a `width * height` raster, 0, 1, 2, ... wrapping at 256. */
export function ramp(width, height) {
  return Uint8Array.from({ length: width * height }, (_, i) => i % 256)
}

/** View a raw buffer of bytes as a typed array, copying first so a
 *  non-4-byte-aligned Buffer cannot make the view throw. */
export function asTypedArray(bytes, Ctor) {
  const copy = Uint8Array.from(bytes)
  return new Ctor(copy.buffer, copy.byteOffset, copy.byteLength / Ctor.BYTES_PER_ELEMENT)
}

export function bytesOf(typed) {
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength)
}
