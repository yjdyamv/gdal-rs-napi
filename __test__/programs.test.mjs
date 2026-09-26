import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'

import { bytesOf, gdal, ramp, tmp } from './helpers.mjs'

/** A single-band GTiff in EPSG:4326 — origin (0, 0), 1 unit per pixel, Y down. */
function georeferenced(path, width, height, originX = 0) {
  const dataset = gdal.createSync(path, { driver: 'GTiff', width, height, bandCount: 1 })
  dataset.band(0).writePixelsSync(bytesOf(ramp(width, height)))
  dataset.setGeoTransform([originX, 1, 0, height, 0, -1])
  dataset.setProjection(gdal.epsgToWkt(4326))
  dataset.close()
}

/** Two points, plus an attribute, so the vector path has something to move. */
const PLACES = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [13.4, 52.5] },
      properties: { name: 'Berlin', population: 3600000 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [2.35, 48.85] },
      properties: { name: 'Paris', population: 2100000 },
    },
  ],
}

test('translate() writes a real COG from the command-line arguments', () => {
  const source = tmp('translate-source.tif')
  const dest = tmp('translate-out.tif')
  georeferenced(source, 8, 8)

  const out = gdal.translateSync(dest, source, ['-of', 'COG', '-co', 'COMPRESS=DEFLATE'])
  assert.equal(out.driver, 'GTiff')
  assert.equal(out.width, 8)
  assert.equal(out.height, 8)
  assert.equal(out.metadata('IMAGE_STRUCTURE').COMPRESSION, 'DEFLATE')
  assert.deepEqual(Array.from(out.band(0).readPixelsSync()), Array.from(ramp(8, 8)))
  out.close()

  // GDAL hands back the dataset it just wrote; `LAYOUT` only appears once the
  // driver re-opens a finished COG, so the proof that this really is one is a
  // reopen.
  const reopened = gdal.openSync(dest)
  assert.equal(reopened.metadata('IMAGE_STRUCTURE').LAYOUT, 'COG')
  assert.equal(reopened.metadata('IMAGE_STRUCTURE').COMPRESSION, 'DEFLATE')
  assert.deepEqual(Array.from(reopened.band(0).readPixelsSync()), Array.from(ramp(8, 8)))
  reopened.close()

  // The same operation through an already-open dataset.
  const viaMethod = tmp('translate-method.tif')
  const opened = gdal.openSync(source)
  opened.translateSync(viaMethod, ['-of', 'COG']).close()
  opened.close()

  const viaMethodReopened = gdal.openSync(viaMethod)
  assert.equal(viaMethodReopened.metadata('IMAGE_STRUCTURE').LAYOUT, 'COG')
  viaMethodReopened.close()
})

test('translate() runs off the event loop too', async () => {
  const source = tmp('async-source.tif')
  georeferenced(source, 4, 4)

  const out = await gdal.translate(tmp('async-out.tif'), source, ['-of', 'GTiff'])
  assert.equal(out.driver, 'GTiff')
  assert.equal(out.width, 4)
  out.close()
})

test('an empty destination plus -of MEM gives an in-memory dataset', () => {
  const source = tmp('mem-source.tif')
  georeferenced(source, 4, 4)

  const out = gdal.translateSync('', source, ['-of', 'MEM'])
  assert.equal(out.driver, 'MEM')
  assert.equal(out.path, '')
  assert.equal(out.width, 4)
  assert.deepEqual(Array.from(out.band(0).readPixelsSync()), Array.from(ramp(4, 4)))
  out.close()
})

test('a rejected argument list comes back with the arguments in it', async () => {
  const source = tmp('badargs-source.tif')
  georeferenced(source, 4, 4)

  assert.throws(
    () => gdal.translateSync(tmp('badargs-out.tif'), source, ['-not-a-real-option']),
    (error) => {
      assert.equal(error.code, 'GDAL_BAD_ARGUMENT')
      assert.match(error.message, /gdal_translate rejected these arguments/)
      assert.match(error.message, /-not-a-real-option/)
      return true
    },
  )

  // On the thread pool the code cannot survive — `napi::Task` fixes the error
  // type — so it is prefixed into the message instead. See the README.
  await assert.rejects(
    gdal.translate(tmp('badargs-out.tif'), source, ['-not-a-real-option']),
    /\[GDAL_BAD_ARGUMENT\] .*gdal_translate rejected/,
  )
})

test('warp() reprojects into another CRS', () => {
  const source = tmp('warp-source.tif')
  georeferenced(source, 8, 8)

  const opened = gdal.openSync(source)
  const warped = opened.warpSync(tmp('warp-3857.tif'), ['-t_srs', 'EPSG:3857', '-r', 'cubic'])
  assert.match(warped.projection, /Pseudo-Mercator|3857/i)

  // Degrees in, metres out: the pixel size proves the reprojection really ran
  // rather than the arguments being quietly ignored.
  const [originX, pixelWidth] = warped.geoTransform
  assert.ok(Math.abs(pixelWidth) > 100, `expected a metric pixel size, got ${pixelWidth}`)
  assert.ok(Number.isFinite(originX))
  assert.equal(warped.bandCount, 1)

  warped.close()
  opened.close()
})

test('warp() merges several sources side by side', () => {
  const left = tmp('mosaic-left.tif')
  const right = tmp('mosaic-right.tif')
  georeferenced(left, 4, 4, 0)
  georeferenced(right, 4, 4, 4)

  const merged = gdal.warpSync(tmp('mosaic.tif'), [left, right], [])
  assert.equal(merged.width, 8, 'two 4-pixel tiles 4 units apart should sit side by side')
  assert.equal(merged.height, 4)

  // Both tiles hold the same ramp, so each output row must be that row of the
  // ramp twice — which also proves the tile starting at x=4 landed on the right
  // rather than overwriting the left.
  const pixels = Array.from(merged.band(0).readPixelsSync())
  const tile = ramp(4, 4)
  for (let row = 0; row < 4; row += 1) {
    const tileRow = Array.from(tile.slice(row * 4, row * 4 + 4))
    assert.deepEqual(pixels.slice(row * 8, row * 8 + 8), [...tileRow, ...tileRow], `row ${row}`)
  }

  merged.close()
})

test('vectorTranslate() runs ogr2ogr, schema and all', () => {
  const source = tmp('places.geojson')
  const dest = tmp('places.gpkg')
  writeFileSync(source, JSON.stringify(PLACES))

  const translated = gdal.vectorTranslateSync(dest, [source], ['-f', 'GPKG', '-nln', 'places'])
  assert.equal(translated.driver, 'GPKG')
  assert.equal(translated.layerCount, 1)

  const layer = translated.layer(0)
  assert.equal(layer.name, 'places', '-nln should have named the layer')

  const features = layer.featuresSync()
  assert.equal(features.length, 2)
  assert.deepEqual(
    features.map((feature) => feature.properties.name).sort(),
    ['Berlin', 'Paris'],
  )

  const berlin = features.find((feature) => feature.properties.name === 'Berlin')
  assert.equal(berlin.properties.population, 3600000)
  assert.equal(berlin.geometry.type, 'Point')
  assert.deepEqual(berlin.geometry.coordinates, [13.4, 52.5])

  translated.close()
})
