// The band metadata writers: `setScale`, `setOffset`, `setUnitType`,
// `setDescription`, `setCategoryNames`, `setDefaultHistogram` — the counterparts
// of the getters that have been read-only until now.
//
// They are exercised against a GTiff because that is the format this binding both
// writes and reads back, and because its band metadata goes through GDAL's PAM
// layer, which is the same road a `.aux.xml` sidecar takes.
//
// The colour table is the exception to that, and the tests say so: GTiff keeps its
// palette in the TIFF ColorMap tag, which is 8 bits per channel and always 256
// entries, so the 16-bit round trip is pinned on MEM and VRT instead.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'

import { bytesOf, gdal, tmp } from './helpers.mjs'

/** A writable one-band GTiff to hang band metadata on. */
function writableBand(name, options = {}) {
  const dataset = gdal.createSync(tmp(name), {
    driver: 'GTiff',
    width: options.width ?? 2,
    height: options.height ?? 2,
    bandCount: 1,
    dataType: options.dataType ?? 'Float32',
  })
  return { dataset, band: dataset.band(0) }
}

test('band metadata setters write values the getters read back', () => {
  const path = tmp('band-metadata-write.tif')
  const { dataset, band } = writableBand('band-metadata-write.tif')

  // Nothing is set on a freshly created band.
  assert.equal(band.scale, null)
  assert.equal(band.offset, null)
  assert.equal(band.unitType, null)
  assert.equal(band.description, null)
  assert.deepEqual(band.categoryNames, [])

  band.setScale(2.5)
  band.setOffset(10)
  band.setUnitType('metre')
  band.setDescription('my band')
  band.setCategoryNames(['water', 'land'])

  assert.equal(band.scale, 2.5)
  assert.equal(band.offset, 10)
  assert.equal(band.unitType, 'metre')
  assert.equal(band.description, 'my band')
  assert.deepEqual(band.categoryNames, ['water', 'land'])

  dataset.flushSync()
  dataset.close()

  // Reopened read-only, the values come off the file rather than out of memory.
  const reopened = gdal.openSync(path)
  const persisted = reopened.band(0)
  assert.equal(persisted.scale, 2.5)
  assert.equal(persisted.offset, 10)
  assert.equal(persisted.unitType, 'metre')
  assert.equal(persisted.description, 'my band')
  assert.deepEqual(persisted.categoryNames, ['water', 'land'])
  reopened.close()
})

test('unit, description and categories clear; scale and offset have no unset', () => {
  const { dataset, band } = writableBand('band-metadata-clear.tif')

  band.setUnitType('metre')
  band.setDescription('label')
  band.setCategoryNames(['a', 'b'])
  band.setUnitType(null)
  band.setDescription(null)
  band.setCategoryNames([])

  assert.equal(band.unitType, null)
  assert.equal(band.description, null)
  assert.deepEqual(band.categoryNames, [])

  // GDAL's scale and offset setters take a number and nothing else: there is no
  // null pointer to pass, so 0 is a value like any other rather than a way back
  // to `null`. The getter has to say 0.
  band.setScale(0)
  band.setOffset(0)
  assert.equal(band.scale, 0)
  assert.equal(band.offset, 0)

  dataset.close()
})

test('a NUL byte in a band string is refused rather than truncated', () => {
  const { dataset, band } = writableBand('band-metadata-nul.tif')

  assert.throws(() => band.setUnitType('met\0re'), /NUL byte/)
  assert.throws(() => band.setDescription('a\0b'), /NUL byte/)
  assert.throws(() => band.setCategoryNames(['ok', 'not\0ok']), /NUL byte/)

  // The failed calls left nothing behind.
  assert.equal(band.unitType, null)
  assert.equal(band.description, null)
  assert.deepEqual(band.categoryNames, [])

  dataset.close()
})

test('defaultHistogram stores what histogramSync computed', () => {
  const path = tmp('band-histogram-write.tif')
  const { dataset, band } = writableBand('band-histogram-write.tif')
  band.writePixelsSync(bytesOf(new Float32Array([0, 1, 2, 3])))

  // A computed histogram is not a *stored* one, so nothing is there yet.
  assert.equal(band.defaultHistogram(), null)

  const computed = band.histogramSync({ min: 0, max: 4, buckets: 4 })
  assert.deepEqual(computed, { min: 0, max: 4, counts: [1, 1, 1, 1] })

  band.setDefaultHistogram(computed)
  assert.deepEqual(band.defaultHistogram(), computed)

  dataset.flushSync()
  dataset.close()

  const reopened = gdal.openSync(path)
  assert.deepEqual(reopened.band(0).defaultHistogram(), computed)
  reopened.close()
})

test('defaultHistogram(force) computes one when nothing is stored', () => {
  const { dataset, band } = writableBand('band-histogram-force.tif')
  band.writePixelsSync(bytesOf(new Float32Array([0, 1, 2, 3])))

  // Off by default, because forcing it reads the whole band.
  assert.equal(band.defaultHistogram(), null)

  // Forced, GDAL computes one itself — and picks the range, which is padded
  // rather than exactly the data's min/max, so only the shape is asserted.
  const forced = band.defaultHistogram(true)
  assert.ok(forced.counts.length > 0)
  assert.ok(forced.min < forced.max)
  assert.ok(forced.min <= 0 && forced.max >= 3, `range ${forced.min}..${forced.max} covers 0..3`)

  dataset.close()
})

test('setDefaultHistogram rejects what GDAL could not act on', () => {
  const { dataset, band } = writableBand('band-histogram-bad.tif')

  assert.throws(
    () => band.setDefaultHistogram({ min: 0, max: 1, counts: [] }),
    /at least one bucket/,
  )
  assert.throws(
    () => band.setDefaultHistogram({ min: 1, max: 1, counts: [1] }),
    /finite and increasing/,
  )
  assert.throws(
    () => band.setDefaultHistogram({ min: 0, max: Number.NaN, counts: [1] }),
    /finite and increasing/,
  )
  assert.throws(
    () => band.setDefaultHistogram({ min: 0, max: Number.POSITIVE_INFINITY, counts: [1] }),
    /finite and increasing/,
  )

  dataset.close()
})

test('setColorTable round-trips a palette the getter reads back', () => {
  // MEM is the writable driver here that keeps a colour table exactly, which makes
  // it the place to pin the shape: the components are unsigned 16-bit, so 65000 has
  // to come back as 65000 — not as the negative number a signed `short` would give,
  // and not clamped.
  const dataset = gdal.createSync('', { driver: 'MEM', width: 2, height: 2, bandCount: 1 })
  const band = dataset.band(0)

  // A band with no table says so twice: no entries, and no interpretation to read
  // them by.
  assert.equal(band.colorTable, null)
  assert.equal(band.paletteInterpretation, null)

  const table = [
    { c1: 65000, c2: 1, c3: 2, c4: 65535 },
    { c1: 3, c2: 4, c3: 5, c4: 6 },
  ]
  band.setColorTable(table)

  assert.deepEqual(band.colorTable, table)
  assert.equal(band.paletteInterpretation, 'Rgba')
  // Writing a table is what makes GDAL call the band paletted. That is the band's
  // own claim about its samples, a separate thing from the table's interpretation,
  // and only one of the two moved.
  assert.equal(band.colorInterpretation, 'PaletteIndex')

  // What the getter hands out is what the setter accepts, so a copy is a copy.
  band.setColorTable(band.colorTable, band.paletteInterpretation)
  assert.deepEqual(band.colorTable, table)

  dataset.close()
})

test('the palette interpretation says what the entry components mean', () => {
  const dataset = gdal.createSync('', { driver: 'MEM', width: 1, height: 1, bandCount: 1 })
  const band = dataset.band(0)

  band.setColorTable([{ c1: 10, c2: 20, c3: 30, c4: 40 }], 'CMYK')
  assert.equal(band.paletteInterpretation, 'Cmyk')
  assert.deepEqual(band.colorTable, [{ c1: 10, c2: 20, c3: 30, c4: 40 }])

  // Gray uses one component, so the getter reports the rest as zero — and the same
  // quad goes straight back in, which is what keeps the round trip exact for the
  // interpretations that carry fewer than four numbers.
  band.setColorTable([{ c1: 7, c2: 20, c3: 30, c4: 40 }], 'Gray')
  assert.equal(band.paletteInterpretation, 'Gray')
  assert.deepEqual(band.colorTable, [{ c1: 7, c2: 0, c3: 0, c4: 0 }])

  // A name nothing answers to is refused here rather than by GDAL, and says which
  // names exist — and the failed call left the table alone.
  assert.throws(
    () => band.setColorTable([], 'nope'),
    (error) => {
      assert.equal(error.code, 'GDAL_BAD_ARGUMENT')
      assert.match(error.message, /Gray, Rgba, Cmyk, Hls/)
      return true
    },
  )
  assert.equal(band.paletteInterpretation, 'Gray')

  dataset.close()
})

test('a colour table survives a file where the format can hold one', () => {
  // VRT keeps the 16-bit components in its own XML — as signed shorts, which is why
  // the file says -536 where the API says 65000 — so it is the writable format here
  // that carries a palette through a file exactly.
  const path = tmp('palette.vrt')
  const table = [
    { c1: 65000, c2: 1, c3: 2, c4: 65535 },
    { c1: 3, c2: 4, c3: 5, c4: 6 },
  ]
  const dataset = gdal.createSync(path, { driver: 'VRT', width: 2, height: 2, bandCount: 1 })
  dataset.band(0).setColorTable(table)
  dataset.close()

  const reopened = gdal.openSync(path)
  assert.deepEqual(reopened.band(0).colorTable, table)
  assert.equal(reopened.band(0).paletteInterpretation, 'Rgba')
  reopened.close()

  // And the getter works on a table this binding never wrote: the same two entries,
  // spelled the way the VRT driver spells them in XML.
  const written = tmp('palette-written.vrt')
  writeFileSync(
    written,
    `<?xml version="1.0"?>
<VRTDataset rasterXSize="2" rasterYSize="2">
  <VRTRasterBand dataType="Byte" band="1">
    <ColorInterp>Palette</ColorInterp>
    <ColorTable>
      <Entry c1="-536" c2="1" c3="2" c4="-1" />
      <Entry c1="3" c2="4" c3="5" c4="6" />
    </ColorTable>
  </VRTRasterBand>
</VRTDataset>
`,
  )
  const fromFile = gdal.openSync(written)
  assert.deepEqual(fromFile.band(0).colorTable, table)
  fromFile.close()
})

test('a driver that stores less quantises the table rather than refusing it', () => {
  // GTiff keeps its colour map in the TIFF ColorMap tag: 8 bits per channel, always
  // 256 entries, no alpha. So a GTiff palette comes back quantised and padded rather
  // than as it went in — the driver's answer, and worth knowing before deciding where
  // a palette should live.
  const path = tmp('palette-quantised.tif')
  const written = gdal.createSync(path, { driver: 'GTiff', width: 2, height: 2, bandCount: 1 })
  written.band(0).setColorTable([
    { c1: 1, c2: 2, c3: 3, c4: 255 },
    { c1: 200, c2: 100, c3: 50, c4: 255 },
  ])
  written.close()

  const dataset = gdal.openSync(path)
  const table = dataset.band(0).colorTable
  assert.equal(table.length, 256)
  assert.deepEqual(table.slice(0, 2), [
    { c1: 1, c2: 2, c3: 3, c4: 255 },
    { c1: 200, c2: 100, c3: 50, c4: 255 },
  ])
  // There is no alpha channel in a TIFF colour map, so every entry reports one.
  assert.ok(table.every((entry) => entry.c4 === 255))

  // A read-only handle does not fail either: GDAL's PAM layer writes a `.aux.xml`
  // sidecar next to the raster, the same road `setStatistics` takes.
  dataset.band(0).setColorTable([{ c1: 9, c2: 9, c3: 9, c4: 9 }])
  assert.deepEqual(dataset.band(0).colorTable, [{ c1: 9, c2: 9, c3: 9, c4: 9 }])
  assert.ok(dataset.getFileList().some((file) => file.endsWith('.aux.xml')))

  dataset.close()
})
