// @ts-nocheck
// VRT pixel functions that run JavaScript: `addPixelFunc` registers one with GDAL,
// `createPixelFunc` builds one from a per-pixel function, and `wrapVRT` writes the VRT
// that uses it. The trampoline is in Rust (`src/pixel_func.rs`); the functions
// themselves live in the shell.
//
// The fixture is written, closed and **reopened read-only** before it is used as a VRT
// source. That is not ceremony: a file still open for update in this process reads back
// as zeros through a VRT — GDAL's own built-in pixel functions included — and that has
// nothing to do with this binding.

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { bytesOf, gdal, ramp, tmp } from '../helpers.js'

/** A one-band Float64 raster, closed and reopened read-only. */
function source(name, width, height, values) {
  const path = tmp(name)
  const created = gdal.createSync(path, {
    driver: 'GTiff',
    width,
    height,
    bandCount: 1,
    dataType: 'Float64',
  })
  created.band(0).writeValues(0, 0, width, height, bytesOf(values))
  created.flushSync()
  created.close()
  const dataset = gdal.openSync(path)
  return dataset.band(0)
}

/** A band's pixels as numbers, whatever its own sample type is. */
function pixels(band) {
  const [width, height] = band.size
  const bytes = band.readAsSync('Float64', { x: 0, y: 0, width, height })
  return Array.from(new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8))
}

test('a band knows the dataset it belongs to', () => {
  const band = source('pixel-dataset.tif', 2, 2, Float64Array.from([1, 2, 3, 4]))
  const dataset = band.dataset

  assert.equal(dataset.path, tmp('pixel-dataset.tif'))
  assert.deepEqual(dataset.rasterSize, { width: 2, height: 2 })
  // The same dataset, not a copy: closing it invalidates the band too.
  dataset.close()
})

test('a pixel function computes a derived VRT band, per pixel', () => {
  const width = 4
  const height = 2
  const temperature = source(
    'pixel-t.tif',
    width,
    height,
    Float64Array.from({ length: 8 }, (_, i) => 20 + i),
  )
  const dewpoint = source('pixel-td.tif', width, height, Float64Array.from({ length: 8 }, () => 10))

  assert.equal(
    gdal.addPixelFunc('espy', gdal.createPixelFunc((t, td) => 125 * (t - td))),
    'espy',
  )
  const xml = gdal.wrapVRT({
    bands: [{ sources: [temperature, dewpoint], pixelFunc: 'espy' }],
  })
  assert.match(xml, /<PixelFunctionType>espy<\/PixelFunctionType>/)
  assert.match(xml, /subClass="VRTDerivedRasterBand"/)
  assert.match(xml, /<SrcRect xOff="0" yOff="0" xSize="4" ySize="2"\/>/)
  assert.match(xml, /<SourceBand>1<\/SourceBand>/)

  const derived = gdal.openSync(xml)
  assert.deepEqual(derived.rasterSize, { width, height })
  assert.equal(derived.band(0).dataType, 'Float64')
  assert.deepEqual(pixels(derived.band(0)), [1250, 1375, 1500, 1625, 1750, 1875, 2000, 2125])
  // Read again: the trampoline is entered once per read, and the answer holds.
  assert.deepEqual(pixels(derived.band(0)), [1250, 1375, 1500, 1625, 1750, 1875, 2000, 2125])
  derived.close()

  temperature.dataset.close()
  dewpoint.dataset.close()
})

test('the VRT arguments reach the function, and GDAL can be asked for another type', () => {
  const band = source('pixel-args.tif', 4, 1, Float64Array.from([1, 2, 3, 4]))

  gdal.addPixelFunc(
    'shifted',
    gdal.createPixelFuncWithArgs((args, value) => Number(args.k) + value),
  )
  const derived = gdal.openSync(
    gdal.wrapVRT({
      bands: [{ sources: [band], pixelFunc: 'shifted', pixelFuncArgs: { k: 10 } }],
    }),
  )
  assert.deepEqual(pixels(derived.band(0)), [11, 12, 13, 14])
  derived.close()

  // A pixel function GDAL itself knows needs no registration at all, and
  // `sourceTransferType` decides what the sources are read as.
  const inv = gdal.openSync(
    gdal.wrapVRT({
      bands: [
        {
          sources: [band],
          pixelFunc: 'inv',
          pixelFuncArgs: { k: 1 },
          sourceTransferType: 'Float64',
        },
      ],
    }),
  )
  assert.deepEqual(pixels(inv.band(0)), [1, 0.5, 1 / 3, 0.25])
  inv.close()

  band.dataset.close()
})

test('toPixelFunc takes GDAL‘s own shape, typed arrays and all', () => {
  const band = source('pixel-raw.tif', 4, 1, Float64Array.from([1, 2, 3, 4]))

  let seen
  gdal.addPixelFunc(
    'double',
    gdal.toPixelFunc((sources, buffer, args) => {
      seen = {
        count: sources.length,
        kind: sources[0].constructor.name,
        outKind: buffer.constructor.name,
        length: buffer.length,
        args,
      }
      for (let i = 0; i < buffer.length; i++) buffer[i] = sources[0][i] * 2
    }),
  )

  const derived = gdal.openSync(gdal.wrapVRT({ bands: [{ sources: [band], pixelFunc: 'double' }] }))
  assert.deepEqual(pixels(derived.band(0)), [2, 4, 6, 8])
  assert.deepEqual(seen, {
    count: 1,
    kind: 'Float64Array',
    outKind: 'Float64Array',
    length: 4,
    args: undefined,
  })
  derived.close()
  band.dataset.close()
})

test('the sources keep their own sample type', () => {
  const path = tmp('pixel-u8.tif')
  const created = gdal.createSync(path, {
    driver: 'GTiff',
    width: 4,
    height: 1,
    bandCount: 1,
    dataType: 'Uint8',
  })
  created.band(0).writeValues(0, 0, 4, 1, bytesOf(Uint8Array.from([1, 2, 3, 4])))
  created.flushSync()
  created.close()
  const band = gdal.openSync(path).band(0)

  let kind
  gdal.addPixelFunc(
    'asFloat',
    gdal.toPixelFunc((sources, buffer) => {
      kind = sources[0].constructor.name
      for (let i = 0; i < buffer.length; i++) buffer[i] = sources[0][i] + 0.5
    }),
  )
  const derived = gdal.openSync(gdal.wrapVRT({ bands: [{ sources: [band], pixelFunc: 'asFloat' }] }))
  assert.deepEqual(pixels(derived.band(0)), [1.5, 2.5, 3.5, 4.5])
  assert.equal(kind, 'Uint8Array')
  derived.close()
  band.dataset.close()
})

test('a JavaScript pixel function is refused off the JS thread', async () => {
  const band = source('pixel-async.tif', 4, 1, Float64Array.from([1, 2, 3, 4]))
  gdal.addPixelFunc(
    'asyncRefused',
    gdal.toPixelFunc((sources, buffer) => {
      for (let i = 0; i < buffer.length; i++) buffer[i] = sources[0][i]
    }),
  )
  const derived = gdal.openSync(
    gdal.wrapVRT({ bands: [{ sources: [band], pixelFunc: 'asyncRefused' }] }),
  )

  // The synchronous read is the one that can call back into JavaScript; the
  // thread-pool one is refused, with the reason, rather than deadlocking.
  await assert.rejects(derived.band(0).readPixels(), /worker thread/)
  assert.deepEqual(pixels(derived.band(0)), [1, 2, 3, 4])

  derived.close()
  band.dataset.close()
})

test('what a pixel function cannot be', () => {
  assert.throws(() => gdal.addPixelFunc('', () => {}), /needs a name/)
  assert.throws(() => gdal.addPixelFunc('nonsense', 7), /has to be a function/)
  assert.throws(() => gdal.createPixelFunc('not a function'), /needs a function/)
  assert.throws(() => gdal.createPixelFuncWithArgs(), /needs a function/)
  assert.throws(() => gdal.toPixelFunc(1), /has to be a function/)
  // A name is taken for good, because GDAL cannot unregister one.
  gdal.addPixelFunc('taken', () => {})
  assert.throws(() => gdal.addPixelFunc('taken', () => {}), /already registered/)

  assert.throws(() => gdal.wrapVRT(), /bands array/)
  assert.throws(() => gdal.wrapVRT({ bands: [] }), /bands array/)
  assert.throws(() => gdal.wrapVRT({ bands: [{ sources: [] }] }), /source RasterBand/)
})

test('wrapVRT carries the frame and refuses a band with nothing to combine with', () => {
  const band = source('pixel-frame.tif', 4, 2, Float64Array.from(ramp(4, 2)))
  band.dataset.setGeoTransform([0, 1, 0, 0, 0, -1])

  const xml = gdal.wrapVRT({ bands: [{ sources: [band] }] })
  assert.match(xml, /rasterXSize="4" rasterYSize="2"/)
  assert.match(xml, /<GeoTransform>0, 1, 0, 0, 0, -1<\/GeoTransform>/)
  // No pixel function means a plain VRT band, which is a copy of its source.
  assert.doesNotMatch(xml, /VRTDerivedRasterBand/)
  const copied = gdal.openSync(xml)
  assert.deepEqual(pixels(copied.band(0)), [...ramp(4, 2)])
  copied.close()

  // Two sources and nothing to say how to combine them is a mistake, not a VRT.
  assert.throws(
    () => gdal.wrapVRT({ bands: [{ sources: [band, band] }] }),
    /needs a pixel function/,
  )
  band.dataset.close()
})
