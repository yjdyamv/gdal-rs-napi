// @ts-nocheck
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { gdal, tmp } from '../helpers.js'

test('executeSql reads rows through GDAL, and a query is not a layer', () => {
  const path = tmp('execute-sql.gpkg')
  const dataset = gdal.createVectorSync(path, 'GPKG')
  const layer = dataset.createLayer({ name: 'places', geometryType: 'Point', epsg: 4326 })

  // GPKG creates its table lazily on the first write, and a SELECT needs the table
  // to exist — so the features have to be written before the query, not after.
  layer.createFeature({ type: 'Point', coordinates: [1, 2] }, { name: 'alpha', population: 120 })
  layer.createFeature({ type: 'Point', coordinates: [3, 4] }, { name: 'beta', population: 4500 })
  layer.createFeature(null, { name: 'gamma', population: null })
  dataset.flushSync()

  // A query answers with records, each the same shape a feature has.
  const filtered = dataset.executeSql(
    'SELECT name, population FROM places WHERE population > 1000',
  )
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].properties.name, 'beta')
  assert.equal(filtered[0].properties.population, 4500)
  assert.equal(filtered[0].geometry, null, 'the geometry was not selected, so there is none')

  // `SELECT *` brings the geometry along, and a NULL field is still null.
  const all = dataset.executeSql('SELECT * FROM places')
  assert.equal(all.length, 3)
  const byName = new Map(all.map((row) => [row.properties.name, row]))
  assert.deepEqual(byName.get('alpha').geometry.coordinates, [1, 2])
  assert.equal(byName.get('gamma').properties.population, null)
  assert.equal(byName.get('gamma').geometry, null)

  dataset.close()
})

test('executeSql takes a dialect, and the SQLite one can reshape the database', () => {
  const path = tmp('execute-sql-dialect.gpkg')
  const dataset = gdal.createVectorSync(path, 'GPKG')
  const layer = dataset.createLayer({ name: 'places', geometryType: 'Point' })
  layer.createFeature({ type: 'Point', coordinates: [1, 2] }, { name: 'alpha' })
  dataset.flushSync()

  const rows = dataset.executeSql('SELECT name FROM places', 'SQLITE')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].properties.name, 'alpha')

  // A statement with no result set is an empty array, not an error — and the table
  // it made is there for the next query.
  assert.deepEqual(dataset.executeSql('CREATE TABLE note (body TEXT)', 'SQLITE'), [])
  assert.deepEqual(dataset.executeSql('SELECT * FROM note', 'SQLITE'), [])

  // GDAL falls back to its default dialect for a name it does not know, and warns
  // rather than failing — the warning is not an error, so the rows still come back.
  assert.equal(dataset.executeSql('SELECT name FROM places', 'NOSUCHDIALECT').length, 1)

  // Bad SQL, on the other hand, throws rather than returning nothing.
  assert.throws(() => dataset.executeSql('SELECT * FROM nowhere'))

  dataset.close()
})

test('executeSql works on a reopened dataset', () => {
  const path = tmp('execute-sql-reopen.gpkg')
  const created = gdal.createVectorSync(path, 'GPKG')
  const layer = created.createLayer({ name: 'points', geometryType: 'Point' })
  layer.createFeature({ type: 'Point', coordinates: [5, 6] }, { name: 'kept' })
  created.close()

  const reopened = gdal.openSync(path)
  const rows = reopened.executeSql('SELECT name FROM points')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].properties.name, 'kept')
  reopened.close()
})
