// @ts-nocheck
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { gdal, tmp } from '../helpers.js'

test('createLayer can declare the schema, so a type is chosen rather than inferred', () => {
  const path = tmp('declared-fields.gpkg')
  const dataset = gdal.createVectorSync(path, 'GPKG')

  const layer = dataset.createLayer({
    name: 'declared',
    geometryType: 'Point',
    fields: [
      { name: 'label', fieldType: 'String', width: 32 },
      { name: 'count', fieldType: 'Integer' },
      { name: 'ratio', fieldType: 'Real', width: 10, precision: 3 },
    ],
  })

  // A layer with a schema and no features: nothing had to be written to define it.
  assert.equal(layer.featureCount, 0)
  assert.deepEqual(
    layer.fields.map((field) => [field.name, field.fieldType]),
    [
      ['label', 'String'],
      ['count', 'Integer'],
      ['ratio', 'Real'],
    ],
  )

  const declared = Object.fromEntries(layer.fields.map((field) => [field.name, field]))
  assert.equal(declared.label.width, 32, 'the declared width is reported')
  // GeoPackage keeps the width but not the precision: SQLite has no fixed-point
  // numbers, so there is nothing for a precision to describe.
  assert.equal(typeof declared.ratio.precision, 'number')

  // `count: 5` would infer Integer64 and `ratio: 1.5` Real — the declared types
  // have to win, which is the whole point of declaring them.
  layer.createFeature(
    { type: 'Point', coordinates: [1, 2] },
    { label: 'a', count: 5, ratio: 1.5, extra: 'inferred' },
  )

  const [feature] = layer.featuresSync()
  assert.equal(feature.properties.count, 5)
  assert.equal(feature.properties.ratio, 1.5)

  const after = Object.fromEntries(layer.fields.map((field) => [field.name, field.fieldType]))
  assert.equal(after.count, 'Integer', 'writing a JS number did not widen it to Integer64')
  // An undeclared property is still added by inference, alongside the declared ones.
  assert.equal(after.extra, 'String')

  assert.throws(
    () => dataset.createLayer({ name: 'bad', fields: [{ name: 'x', fieldType: 'Currency' }] }),
    (error) => {
      assert.match(error.message, /unknown field type/)
      assert.match(error.message, /Integer64/, 'the alternatives are listed')
      return true
    },
  )

  dataset.close()
})

test('deleteFeature removes exactly the one asked for', () => {
  const path = tmp('delete-feature.gpkg')
  const dataset = gdal.createVectorSync(path, 'GPKG')
  const layer = dataset.createLayer({ name: 'places', geometryType: 'Point' })

  layer.createFeature({ type: 'Point', coordinates: [1, 2] }, { name: 'one' })
  layer.createFeature({ type: 'Point', coordinates: [3, 4] }, { name: 'two' })
  layer.createFeature({ type: 'Point', coordinates: [5, 6] }, { name: 'three' })

  const before = layer.featuresSync()
  assert.equal(before.length, 3)

  layer.deleteFeature(before[1].fid)

  const after = layer.featuresSync()
  assert.equal(after.length, 2)
  assert.deepEqual(
    after.map((feature) => feature.properties.name).sort(),
    ['one', 'three'],
  )

  // An id that is not there is an error rather than a shrug.
  assert.throws(() => layer.deleteFeature(999999))

  dataset.close()
})

test('deleteLayer drops a layer by name', () => {
  const path = tmp('delete-layer.gpkg')
  const dataset = gdal.createVectorSync(path, 'GPKG')
  dataset.createLayer({ name: 'keep', geometryType: 'Point' })
  dataset.createLayer({ name: 'drop', geometryType: 'Point' })
  assert.equal(dataset.layerCount, 2)

  dataset.deleteLayer('drop')
  assert.equal(dataset.layerCount, 1)
  assert.equal(dataset.layer(0).name, 'keep')

  assert.throws(() => dataset.deleteLayer('nope'), /no layer named/)

  dataset.close()
})

test('writes a GPKG through createVector + createLayer + createFeature', () => {
  const path = tmp('places.gpkg')
  const dataset = gdal.createVectorSync(path, 'GPKG')
  assert.equal(dataset.layerCount, 0, 'a fresh vector dataset has no layers yet')

  const layer = dataset.createLayer({ name: 'places', geometryType: 'Point', epsg: 4326 })
  assert.equal(layer.name, 'places')
  assert.equal(layer.geometryType, 'Point')
  assert.equal(layer.index, 0)
  assert.equal(dataset.layerCount, 1)

  layer.createFeature(
    { type: 'Point', coordinates: [10, 20] },
    { name: 'alpha', population: 120, height: 1.5, tags: ['a', 'b'] },
  )
  layer.createFeature({ type: 'Point', coordinates: [11, 21] }, { name: 'beta', population: 4500 })
  // No geometry, and a null for a field that already exists.
  layer.createFeature(null, { name: 'gamma', population: null })

  dataset.flushSync()
  dataset.close()

  const reopened = gdal.openSync(path)
  const read = reopened.layerByName('places')
  assert.equal(read.featureCount, 3)

  const fields = new Map(read.fields.map((field) => [field.name, field.fieldType]))
  assert.deepEqual([...fields.keys()].sort(), ['height', 'name', 'population', 'tags'])
  assert.equal(fields.get('name'), 'String')
  assert.equal(fields.get('population'), 'Integer64')
  assert.equal(fields.get('height'), 'Real')
  // A String, not a list field: see `inferred_field_type` — a driver without
  // list columns accepts a list request and then stores GDAL's internal
  // `(2:a,b)` form, so we never ask for one.
  assert.equal(fields.get('tags'), 'String')
  assert.match(read.spatialRefWkt, /WGS 84/, 'the layer CRS should survive the round-trip')

  const features = read.featuresSync()
  const byName = new Map(features.map((feature) => [feature.properties.name, feature]))

  assert.deepEqual(byName.get('alpha').geometry.coordinates, [10, 20])
  assert.equal(byName.get('alpha').properties.population, 120)
  assert.equal(byName.get('alpha').properties.height, 1.5)
  assert.deepEqual(byName.get('alpha').properties.tags, 'a,b')

  assert.equal(byName.get('gamma').geometry, null, 'a feature may have no geometry')
  assert.equal(byName.get('gamma').properties.population, null)

  reopened.close()
})

test('updates an existing feature without disturbing the rest of it', () => {
  const path = tmp('update.gpkg')
  const dataset = gdal.createVectorSync(path, 'GPKG')
  const layer = dataset.createLayer({ name: 'points', geometryType: 'Point' })
  layer.createFeature({ type: 'Point', coordinates: [1, 2] }, { name: 'one', population: 1 })
  dataset.flushSync()

  const [created] = layer.featuresSync()
  layer.updateFeature(created.fid, null, { population: 99 })

  const [updated] = layer.featuresSync()
  assert.equal(updated.properties.population, 99)
  assert.equal(updated.properties.name, 'one', 'unnamed fields are left alone')
  assert.deepEqual(updated.geometry.coordinates, [1, 2], 'a null geometry means "unchanged"')

  // Updating must not reshape the schema.
  assert.throws(
    () => layer.updateFeature(created.fid, null, { nope: 1 }),
    /no field named/,
  )
  assert.throws(() => layer.updateFeature(99_999, null, { population: 1 }), /no feature with id/)

  dataset.close()
})

test('accepts loose geometry type names and rejects nonsense', () => {
  const dataset = gdal.createVectorSync(tmp('types.gpkg'), 'GPKG')

  assert.equal(
    dataset.createLayer({ name: 'a', geometryType: 'multi polygon' }).geometryType,
    'MultiPolygon',
  )
  assert.equal(
    dataset.createLayer({ name: 'b', geometryType: 'LINESTRING' }).geometryType,
    'LineString',
  )
  assert.equal(dataset.createLayer({ name: 'c' }).geometryType, 'Unknown')

  assert.throws(
    () => dataset.createLayer({ name: 'd', geometryType: 'hypercube' }),
    /unknown geometry type/,
  )

  dataset.close()
})

test('the async create path mirrors the sync one', async () => {
  const path = tmp('async-vector.gpkg')
  const dataset = await gdal.createVector(path, 'GPKG')
  dataset.createLayer({ name: 'points', geometryType: 'Point' })
  dataset.layer(0).createFeature({ type: 'Point', coordinates: [5, 6] }, { name: 'async' })
  await dataset.flush()
  dataset.close()

  const reopened = await gdal.open(path)
  const [feature] = reopened.layer(0).featuresSync()
  assert.equal(feature.properties.name, 'async')
  assert.deepEqual(feature.geometry.coordinates, [5, 6])
  reopened.close()
})

test('writing to a read-only dataset fails instead of silently doing nothing', () => {
  const path = tmp('readonly.gpkg')
  const created = gdal.createVectorSync(path, 'GPKG')
  const writable = created.createLayer({ name: 'points', geometryType: 'Point' })
  writable.createFeature({ type: 'Point', coordinates: [1, 1] }, { name: 'alpha', population: 10 })
  created.close()

  const reopened = gdal.openSync(path) // read-only by default
  const layer = reopened.layer(0)

  assert.throws(() =>
    layer.createFeature({ type: 'Point', coordinates: [2, 2] }, { name: 'nope' }),
  )

  // An update is refused too, and says so rather than reporting success. This is
  // the case the `gdal` crate cannot catch for us: its `set_feature` calls
  // `OGR_L_SetFeature` and returns `Ok(())` whatever GDAL said, so a read-only
  // write looked like it worked — GDAL's warning on stderr was the only trace.
  const [feature] = layer.featuresSync()
  assert.throws(
    () => layer.updateFeature(feature.fid, null, { population: 99 }),
    (error) => {
      assert.match(error.message, /read-only|unsupported/i)
      return true
    },
  )

  // And nothing was written.
  assert.equal(layer.feature(feature.fid).properties.population, 10)
  assert.equal(layer.featuresSync().length, 1)

  reopened.close()
})

test('a declared list field is a list only on drivers that have one', () => {
  /** A layer with one declared `StringList`, written once and read back. */
  const roundTrip = (driver, extension) => {
    const path = tmp(`list-field-${extension}.${extension}`)
    const dataset = gdal.createVectorSync(path, driver)
    const layer = dataset.createLayer({
      name: 'things',
      geometryType: 'Point',
      fields: [{ name: 'tags', fieldType: 'StringList' }],
    })
    layer.createFeature({ type: 'Point', coordinates: [0, 0] }, { tags: ['a', 'b'] })
    dataset.close()

    const reopened = gdal.openSync(path)
    const stored = reopened.layer(0).featuresSync()[0].properties.tags
    reopened.close()
    return stored
  }

  // GeoJSON and SQLite have a real list column, and it round-trips as an array.
  assert.deepEqual(roundTrip('GeoJSON', 'geojson'), ['a', 'b'])
  assert.deepEqual(roundTrip('SQLite', 'sqlite'), ['a', 'b'])

  // GPKG does not. It accepts the declaration, warns that the type "is not
  // handled natively. Falling back to String.", and stores a scalar column — so a
  // list value lands as GDAL's internal `(2:a,b)` text, which is neither the
  // value nor usable as one. This is why `createFeature`'s inference writes
  // comma-joined `String` text for an array rather than declaring a list column:
  // the joined text is at least the value.
  assert.equal(roundTrip('GPKG', 'gpkg'), '(2:a,b)')

  // A driver that cannot take one fails at the write, loudly, rather than
  // storing something surprising.
  const path = tmp('list-field-flatgeobuf.fgb')
  const dataset = gdal.createVectorSync(path, 'FlatGeobuf')
  const layer = dataset.createLayer({
    name: 'things',
    geometryType: 'Point',
    fields: [{ name: 'tags', fieldType: 'StringList' }],
  })
  assert.throws(
    () => layer.createFeature({ type: 'Point', coordinates: [0, 0] }, { tags: ['a', 'b'] }),
    /Missing implementation for OGRFieldType/,
  )
  dataset.close()
})

test('copyLayer moves a layer into another dataset, schema and features', () => {
  const source = gdal.createVectorSync(tmp('copy-source.gpkg'), 'GPKG')
  const sourceLayer = source.createLayer({ name: 'places', geometryType: 'Point' })
  sourceLayer.createFeature({ type: 'Point', coordinates: [1, 2] }, { name: 'one' })
  sourceLayer.createFeature({ type: 'Point', coordinates: [3, 4] }, { name: 'two' })

  const target = gdal.createVectorSync(tmp('copy-target.gpkg'), 'GPKG')
  const copied = target.copyLayer(sourceLayer, 'places')

  assert.equal(copied.name, 'places')
  assert.equal(copied.featureCount, 2)
  assert.deepEqual(
    copied
      .featuresSync()
      .map((feature) => feature.properties.name)
      .sort(),
    ['one', 'two'],
  )

  // The two handles have to be different datasets: a self-copy would need both
  // per-dataset locks at once, which is what the guard refuses.
  assert.throws(() => target.copyLayer(copied, 'again'), /already in/)

  target.close()
  source.close()
})
