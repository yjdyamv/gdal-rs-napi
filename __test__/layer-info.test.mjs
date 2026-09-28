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

test('a transaction groups writes, and rolling back undoes them', () => {
  const dataset = gdal.createVectorSync(tmp('layer-transactions.gpkg'), 'GPKG')
  const layer = dataset.createLayer({ name: 'points', geometryType: 'Point' })

  // GPKG is transactional, which is what makes the grouping below mean anything.
  assert.equal(layer.testCapability('Transactions'), true)

  // GPKG creates its table lazily, on the first write — so the first write has to
  // happen *outside* the transaction. Made inside one, the `CREATE TABLE` is rolled
  // back with the features, and every later write fails with `no such table`.
  layer.createFeature({ type: 'Point', coordinates: [0, 0] })

  layer.startTransaction()
  layer.createFeature({ type: 'Point', coordinates: [1, 2] })
  layer.rollbackTransaction()
  // `featureCount` is `null` while the driver will not answer without a scan, which is
  // why the counting here goes through the features themselves.
  assert.equal(layer.featuresSync().length, 1)

  layer.startTransaction()
  layer.createFeature({ type: 'Point', coordinates: [3, 4] })
  layer.createFeature({ type: 'Point', coordinates: [5, 6] })
  layer.commitTransaction()
  assert.equal(layer.featuresSync().length, 3)

  dataset.close()
})
