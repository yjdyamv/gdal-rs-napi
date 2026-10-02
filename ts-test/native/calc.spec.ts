// @ts-nocheck
// The pixel-wise layer over the raster streams: `RasterMuxStream` reads several bands
// in lockstep, `RasterTransform` applies a function to every pixel, and `calcAsync` is
// `gdal_calc.py` with a JS function in place of an expression string. All three are
// built in the shell (`index.js`); this is the shape gdal-async has.

import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'vitest'

import { bytesOf, gdal, tmp } from '../helpers.js'

/** A one-band raster, from values of `dataType`. */
function raster(name, width, height, dataType, values) {
  const dataset = gdal.createSync(tmp(name), {
    driver: 'GTiff',
    width,
    height,
    bandCount: 1,
    dataType,
  })
  const band = dataset.band(0)
  band.writeValues(0, 0, width, height, bytesOf(values))
  return { dataset, band }
}

/** The band's samples, read back as `Float64` so a comparison is about values. */
function samples(band) {
  const [width, height] = band.size
  const bytes = band.readAsSync('Float64', { x: 0, y: 0, width, height })
  return Array.from(new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8))
}

test('calcAsync computes a band from a pixel-wise function of several bands', async () => {
  const width = 4
  const height = 4
  const temperature = Float32Array.from({ length: width * height }, (_, i) => 20 + (i % 5))
  const dewpoint = Float32Array.from({ length: width * height }, (_, i) => 10 + (i % 3))
  const t = raster('calc-t.tif', width, height, 'Float32', temperature)
  const td = raster('calc-td.tif', width, height, 'Float32', dewpoint)
  const output = gdal.createSync(tmp('calc-out.tif'), {
    driver: 'GTiff',
    width,
    height,
    bandCount: 1,
    dataType: 'Float64',
  })

  const fractions = []
  await gdal.calcAsync(
    { t: t.band, td: td.band },
    output.band(0),
    (a, b) => 125 * (a - b),
    { onProgress: (fraction) => fractions.push(fraction) },
  )
  output.band(0).flushSync()

  assert.deepEqual(
    samples(output.band(0)),
    Array.from(temperature, (value, i) => 125 * (value - dewpoint[i])),
  )
  // A 4x4 GTiff is one block, so one chunk and one fraction — and it ends at 1.
  assert.ok(fractions.length >= 1)
  assert.equal(fractions.at(-1), 1)
  assert.ok(fractions.every((fraction) => fraction > 0 && fraction <= 1))

  t.dataset.close()
  td.dataset.close()
  output.close()
})

test('the inputs and the output all have to be the same size', async () => {
  const big = raster('calc-big.tif', 4, 4, 'Uint8', Uint8Array.from({ length: 16 }, (_, i) => i))
  const small = raster('calc-small.tif', 2, 2, 'Uint8', Uint8Array.from([1, 2, 3, 4]))
  const output = gdal.createSync(tmp('calc-size.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Uint8',
  })

  await assert.rejects(
    gdal.calcAsync({ big: big.band, small: small.band }, output.band(0), (a, b) => a + b),
    /same size as the output/,
  )

  big.dataset.close()
  small.dataset.close()
  output.close()
})

test('calcAsync refuses what it cannot run rather than half-running it', async () => {
  const { dataset, band } = raster('calc-bad.tif', 2, 2, 'Uint8', Uint8Array.from([1, 2, 3, 4]))

  await assert.rejects(gdal.calcAsync({ a: band }, band, undefined), /fn has to be a function/)
  await assert.rejects(gdal.calcAsync({ a: band }, {}, () => 1), /output has to be a RasterBand/)
  await assert.rejects(gdal.calcAsync({}, band, () => 1), /at least one input band/)
  await assert.rejects(gdal.calcAsync({ a: 1 }, band, () => 1), /every input has to be a RasterBand/)
  await assert.rejects(
    gdal.calcAsync({ a: band }, band, () => 1, { onProgress: 'no' }),
    /onProgress has to be a function/,
  )

  dataset.close()
})

test('convertNoData maps the missing value to NaN and back', async () => {
  const missing = raster('calc-nodata.tif', 2, 1, 'Float64', Float64Array.from([1, -9999]))
  missing.band.setNoDataValue(-9999)

  // Reading: the band's missing value arrives as NaN, which is what makes it usable
  // in arithmetic at all.
  assert.deepEqual(samples(missing.band), [1, -9999])
  const read = []
  for await (const chunk of missing.band.createReadStream({ convertNoData: true })) {
    read.push(...chunk)
  }
  assert.equal(read.length, 2)
  assert.equal(read[0], 1)
  assert.ok(Number.isNaN(read[1]))

  // Without it, the missing value is just a number.
  const plain = []
  for await (const chunk of missing.band.createReadStream()) plain.push(...chunk)
  assert.deepEqual(plain, [1, -9999])

  // Writing: NaN goes back as the band's missing value.
  const output = gdal.createSync(tmp('calc-nodata-out.tif'), {
    driver: 'GTiff',
    width: 2,
    height: 1,
    bandCount: 1,
    dataType: 'Float64',
  })
  output.band(0).setNoDataValue(-1)
  const stream = output.band(0).createWriteStream({ convertNoData: true })
  stream.end(Float64Array.from([1, NaN]))
  await once(stream, 'finish')
  output.band(0).flushSync()
  assert.deepEqual(samples(output.band(0)), [1, -1])

  missing.dataset.close()
  output.close()
})

test('a mux pairs its inputs up chunk by chunk, whatever sizes they come in', async () => {
  const left = raster('mux-left.tif', 4, 4, 'Uint8', Uint8Array.from({ length: 16 }, (_, i) => i))
  const right = raster('mux-right.tif', 4, 4, 'Uint8', Uint8Array.from({ length: 16 }, (_, i) => 100 + i))

  // One input in two-row strips and the other in one-row ones: the mux has to join the
  // small pieces so both sides of a chunk are the same length.
  const mux = new gdal.RasterMuxStream(
    {
      left: left.band.createReadStream({ rows: 2 }),
      right: right.band.createReadStream({ rows: 1 }),
    },
  )
  const chunks = []
  for await (const chunk of mux) chunks.push(chunk)

  assert.ok(chunks.length >= 1)
  for (const chunk of chunks) {
    assert.equal(chunk.left.length, chunk.right.length)
    assert.equal(chunk.left.length % 4, 0)
  }
  assert.deepEqual(
    chunks.flatMap((chunk) => [...chunk.left]),
    Array.from({ length: 16 }, (_, i) => i),
  )
  assert.deepEqual(
    chunks.flatMap((chunk) => [...chunk.right]),
    Array.from({ length: 16 }, (_, i) => 100 + i),
  )

  left.dataset.close()
  right.dataset.close()
})

test('a mux refuses inputs that end at different lengths', async () => {
  const tall = raster('mux-tall.tif', 2, 4, 'Uint8', Uint8Array.from({ length: 8 }, (_, i) => i))
  const short = raster('mux-short.tif', 2, 2, 'Uint8', Uint8Array.from([1, 2, 3, 4]))

  const mux = new gdal.RasterMuxStream({
    tall: tall.band.createReadStream({ rows: 1 }),
    short: short.band.createReadStream({ rows: 1 }),
  })
  await assert.rejects(
    (async () => {
      for await (const _chunk of mux) void _chunk
    })(),
    /ended at different lengths/,
  )

  tall.dataset.close()
  short.dataset.close()
})

test('a mux and a transform are what calcAsync is made of', async () => {
  const width = 4
  const height = 2
  const left = raster('hand-left.tif', width, height, 'Float32', Float32Array.from({ length: 8 }, (_, i) => i))
  const right = raster('hand-right.tif', width, height, 'Float32', Float32Array.from({ length: 8 }, () => 2))
  const output = gdal.createSync(tmp('hand-out.tif'), {
    driver: 'GTiff',
    width,
    height,
    bandCount: 1,
    dataType: 'Float64',
  })

  const mux = new gdal.RasterMuxStream({
    left: left.band.createReadStream(),
    right: right.band.createReadStream(),
  })
  const transform = new gdal.RasterTransform({ fn: (a, b) => a * b, type: 'Float64' })
  const out = output.band(0).createWriteStream()
  await new Promise((resolve, reject) => {
    out.on('finish', resolve)
    mux.on('error', reject)
    transform.on('error', reject)
    out.on('error', reject)
    mux.pipe(transform).pipe(out)
  })
  output.band(0).flushSync()

  assert.deepEqual(samples(output.band(0)), [0, 2, 4, 6, 8, 10, 12, 14])

  assert.throws(() => new gdal.RasterTransform({}), /needs a fn/)
  assert.throws(() => new gdal.RasterMuxStream({}), /at least one input/)
  // An input has to be object mode: a stream of bytes has no pixel counts to pair up.
  assert.throws(
    () => new gdal.RasterMuxStream({ a: new Readable({ read() {} }) }),
    /object-mode/,
  )

  left.dataset.close()
  right.dataset.close()
  output.close()
})

test('a read stream is object mode and hands back typed arrays', async () => {
  const { dataset, band } = raster('typed.tif', 3, 2, 'Uint8', Uint8Array.from([1, 2, 3, 4, 5, 6]))

  const stream = band.createReadStream({ rows: 1 })
  assert.equal(stream.readableObjectMode, true)
  for await (const chunk of stream) {
    assert.ok(chunk instanceof Uint8Array)
    assert.deepEqual([...chunk], [1, 2, 3])
    break
  }

  // `type` asks for another sample type — a constructor, or a sample type name.
  const converted = []
  for await (const chunk of band.createReadStream({ rows: 2, type: Float64Array })) {
    assert.ok(chunk instanceof Float64Array)
    converted.push(...chunk)
  }
  assert.deepEqual(converted, [1, 2, 3, 4, 5, 6])

  const named = []
  for await (const chunk of band.createReadStream({ rows: 2, type: 'Float64' })) {
    assert.ok(chunk instanceof Float64Array)
    named.push(...chunk)
  }
  assert.deepEqual(named, converted)

  assert.throws(() => band.createReadStream({ type: 'NotAType' }), /no typed array/)
  assert.throws(() => band.createReadStream({ type: 7 }), /typed array constructor/)

  dataset.close()
})
