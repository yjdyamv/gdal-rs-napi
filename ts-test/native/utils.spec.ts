// @ts-nocheck
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { gdal } from '../helpers.js'

test('decToDMS renders degrees the way GDAL does', () => {
  // `CPLDecToDMS`: 45.5° is 45°30'00", and the hemisphere comes from the sign.
  // It pads the number with a leading space, so the match allows for it.
  const lat = gdal.decToDMS(45.5, 'Lat')
  assert.match(lat, /^\s*45d30'/)
  assert.match(lat, /N$/)

  const west = gdal.decToDMS(-122.25, 'Long')
  assert.match(west, /^\s*122d15'/)
  assert.match(west, /W$/)

  // The precision is the decimal places on the seconds — three here, two above.
  assert.match(gdal.decToDMS(45.5, 'Lat', 3), /0\.000"/)
})

test('verbose and quiet flip GDAL debug logging without throwing', () => {
  // They set `CPL_DEBUG`, which `config.get` reads straight back.
  gdal.verbose()
  assert.equal(gdal.config.get('CPL_DEBUG'), 'ON')

  gdal.quiet()
  assert.equal(gdal.config.get('CPL_DEBUG'), 'OFF')
})
