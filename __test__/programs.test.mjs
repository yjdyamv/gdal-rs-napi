import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'

import { bytesOf, gdal, ramp, tmp } from './helpers.mjs'

/** A single-band GTiff in EPSG:4326 — origin (0, 0), 1 unit per pixel, Y down. */
function georeferenced(path, width, height, originX = 0, epsg = 4326) {
  const dataset = gdal.createSync(path, { driver: 'GTiff', width, height, bandCount: 1 })
  dataset.band(0).writePixelsSync(bytesOf(ramp(width, height)))
  dataset.setGeoTransform([originX, 1, 0, height, 0, -1])
  dataset.setProjection(gdal.epsgToWkt(epsg))
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

test('demProcess() runs gdaldem, and gives back real relief', async () => {
  const source = tmp('dem-source.tif')
  // A hillshade needs a geotransform; slope and aspect want a CRS in metres, which
  // is why this fixture is projected rather than in degrees.
  georeferenced(source, 32, 32, 0, 3857)

  const dest = tmp('dem-hillshade.tif')
  const hillshade = gdal.demProcessSync(dest, source, 'hillshade', ['-az', '315', '-alt', '45'])
  assert.equal(hillshade.driver, 'GTiff')
  assert.equal(hillshade.width, 32)
  hillshade.close()

  const shaded = gdal.openSync(dest)
  const values = new Set(Array.from(shaded.band(0).readPixelsSync()))
  assert.ok(values.size > 1, 'a hillshade of a ramp should not be flat')
  shaded.close()

  // The same thing as a method on an open dataset, and off the event loop.
  const opened = gdal.openSync(source)
  const slope = await opened.demProcess(tmp('dem-slope.tif'), 'slope')
  assert.equal(slope.driver, 'GTiff')
  slope.close()
  opened.close()
})

test('a terrain algorithm that does not exist is refused, with the list', () => {
  const source = tmp('dem-bad.tif')
  georeferenced(source, 8, 8)

  const dataset = gdal.openSync(source)
  assert.throws(
    () => dataset.demProcessSync(tmp('dem-bad-out.tif'), 'slop'),
    (error) => {
      assert.match(error.message, /unknown terrain algorithm/)
      assert.match(error.message, /roughness/, 'the alternatives are listed')
      return true
    },
  )
  dataset.close()
})

test('vectorTranslate replaces the destination layer, and -append adds to it', () => {
  const first = tmp('translate-first.geojson')
  const second = tmp('translate-second.geojson')
  const dest = tmp('translate-dest.gpkg')

  writeFileSync(first, JSON.stringify(PLACES))
  writeFileSync(
    second,
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: { name: 'only' },
        },
      ],
    }),
  )

  const args = ['-f', 'GPKG', '-nln', 'places']
  const names = () => {
    const dataset = gdal.openSync(dest)
    const read = dataset
      .layer(0)
      .featuresSync()
      .map((feature) => feature.properties.name)
      .sort()
    dataset.close()
    return read
  }

  gdal.vectorTranslateSync(dest, [first], args).close()
  assert.deepEqual(names(), ['Berlin', 'Paris'])

  // With no flag, an existing layer is replaced — that is GDAL's default, and the
  // only way to tell it from "did nothing" is to feed it different data.
  gdal.vectorTranslateSync(dest, [second], args).close()
  assert.deepEqual(names(), ['only'])

  // `-append` is GDAL's own flag and asks for the other behaviour.
  gdal.vectorTranslateSync(dest, [second], [...args, '-append']).close()
  assert.deepEqual(names(), ['only', 'only'])

  // `-overwrite` is ogr2ogr's flag, not GDAL's: the wrapper drops the destination
  // file first. That is why it has to be asked for, and why it takes every layer
  // in the file with it.
  gdal.vectorTranslateSync(dest, [second], [...args, '-overwrite']).close()
  assert.deepEqual(names(), ['only'])
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
