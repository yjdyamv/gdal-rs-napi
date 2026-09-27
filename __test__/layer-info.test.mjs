import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gdal, tmp } from './helpers.mjs'

test('a layer tells you its FID column, its geometry column and its capabilities', () => {
  const dataset = gdal.createVectorSync(tmp('layer-info.gpkg'), 'GPKG')
  const layer = dataset.createLayer({ name: 'points', geometryType: 'Point' })

  // GPKG keeps feature ids in a column of its own, and names it.
  assert.equal(layer.fidColumn, 'fid')
  assert.equal(typeof layer.geomColumn, 'string')
  assert.ok(layer.geomColumn.length > 0)

  // Capabilities are asked with GDAL's own names, and a name it does not know is
  // `false` rather than an error.
  assert.equal(layer.testCapability('SequentialWrite'), true)
  assert.equal(layer.testCapability('NotACapability'), false)

  dataset.close()
})
