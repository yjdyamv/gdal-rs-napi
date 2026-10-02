// @ts-nocheck
// The binding's own capability probe: `apiVersion` and `features()`, the pair a
// caller branches on instead of calling a method and catching the `TypeError`.

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { gdal } from '../helpers.js'

test('apiVersion names the binding, and features() probes what it can do', () => {
  // The binding's own version, distinct from `version().gdal`.
  assert.match(gdal.apiVersion, /^\d+\.\d+\.\d+/)
  assert.notEqual(gdal.apiVersion, gdal.version().gdal)

  const features = gdal.features()
  assert.equal(features.geos, gdal.diagnostics().geosAvailable)
  assert.equal(typeof features.threadSafe, 'boolean')

  // The multidimensional model is in — `Dataset.root` and the `Group` / `MDArray` /
  // `Attribute` / `Dimension` classes that hang off it.
  assert.equal(features.multidimensional, true)
  assert.equal(typeof gdal.MDArray, 'function')
  // Raster streams are in — built in the JavaScript shell, but part of the surface.
  assert.equal(features.streams, true)
  assert.equal(typeof gdal.RasterBand.prototype.createReadStream, 'function')
  assert.equal(typeof gdal.RasterBand.prototype.createWriteStream, 'function')
})
