// Raster streams — built in the shell (`index.js`) over the chunked reads and writes,
// because napi cannot hand back a Node `Readable`/`Writable` from a `#[napi]` class.
// A chunk is the band's own bytes; `rows` is the strip size, defaulting to the band's
// block height.

import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'

import { bytesOf, gdal, ramp, tmp } from './helpers.mjs'

/** A Uint8 GTiff holding `0, 1, 2, …` over `width * height`. */
function withRamp(name, width, height) {
  const dataset = gdal.createSync(tmp(name), {
    driver: 'GTiff',
    width,
    height,
    bandCount: 1,
    dataType: 'Uint8',
  })
  const band = dataset.band(0)
  band.writeValues(0, 0, width, height, bytesOf(ramp(width, height)))
  return { dataset, band }
}

test('a band reads as a stream, one strip at a time', async () => {
  const { dataset, band } = withRamp('stream-read.tif', 4, 6)

  const chunks = []
  for await (const chunk of band.createReadStream({ rows: 2 })) {
    chunks.push(Buffer.from(chunk))
  }

  // Three two-row strips, each in the band's own bytes.
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [8, 8, 8],
  )
  assert.deepEqual([...Buffer.concat(chunks)], [...ramp(4, 6)])

  dataset.close()
})

test('a read stream can be narrowed to a window', async () => {
  const { dataset, band } = withRamp('stream-read-window.tif', 4, 6)

  const chunks = []
  for await (const chunk of band.createReadStream({ x: 1, y: 1, width: 2, height: 3, rows: 1 })) {
    chunks.push(Buffer.from(chunk))
  }

  // Rows 1..3 of columns 1..2, of the `0, 1, 2, …` ramp.
  assert.deepEqual([...Buffer.concat(chunks)], [5, 6, 9, 10, 13, 14])

  dataset.close()
})

test('a band writes as a stream, reassembling strips from odd reads', async () => {
  const path = tmp('stream-write.tif')
  const dataset = gdal.createSync(path, {
    driver: 'GTiff',
    width: 4,
    height: 6,
    bandCount: 1,
    dataType: 'Uint8',
  })
  const band = dataset.band(0)

  const values = ramp(4, 6)
  const stream = band.createWriteStream({ rows: 2 })
  // Five bytes at a time: not a strip, and not even a whole row, so the stream has
  // to hold the leftover itself.
  for (let offset = 0; offset < values.length; offset += 5) {
    stream.write(Buffer.from(values.subarray(offset, offset + 5)))
  }
  stream.end()
  await once(stream, 'finish')

  assert.deepEqual([...band.readValues(0, 0, 4, 6)], [...values])

  dataset.close()
})

test('a raster write stream refuses what it cannot place', async () => {
  const dataset = gdal.createSync(tmp('stream-write-bad.tif'), {
    driver: 'GTiff',
    width: 4,
    height: 4,
    bandCount: 1,
    dataType: 'Uint8',
  })
  const band = dataset.band(0)

  // Half a row, with nothing to complete it.
  const short = band.createWriteStream({ rows: 2 })
  short.end(Buffer.from([1, 2, 3]))
  await assert.rejects(once(short, 'finish'), /whole rows/)

  // More than the window can hold.
  const tooMuch = band.createWriteStream({ rows: 2 })
  tooMuch.end(Buffer.alloc(4 * 4 + 1))
  await assert.rejects(once(tooMuch, 'finish'), /past its window/)

  dataset.close()
})
