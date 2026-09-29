// The layer schema: reading a field's full definition, and changing an existing
// layer's schema rather than only declaring it up front.
//
// GPKG is the driver used throughout because it is the one writable vector driver
// here that keeps every attribute below — `ESRI Shapefile` keeps almost none of
// them and refuses `addField` outright.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gdal, tmp } from './helpers.mjs'

/** A writable GeoPackage with one point layer, and the layer object. */
function pointLayer(name, options = {}) {
  const dataset = gdal.createVectorSync(tmp(name), 'GPKG')
  const layer = dataset.createLayer({
    name: 'things',
    geometryType: 'Point',
    epsg: 4326,
    fields: options.fields ?? [],
  })
  return { dataset, layer }
}

const TWO_FIELDS = [
  { name: 'name', fieldType: 'String', width: 12, nullable: false, defaultValue: 'anon' },
  { name: 'population', fieldType: 'Integer64', unique: true },
]

test('a field reports its whole definition, not just name and type', () => {
  const { dataset, layer } = pointLayer('schema-info.gpkg', { fields: TWO_FIELDS })

  const [name, population] = layer.fields
  assert.equal(name.name, 'name')
  assert.equal(name.fieldType, 'String')
  assert.equal(name.width, 12)
  assert.equal(name.nullable, false)
  assert.equal(name.unique, false)
  assert.equal(name.defaultValue, 'anon')
  assert.equal(name.justification, 'Undefined')

  assert.equal(population.name, 'population')
  assert.equal(population.fieldType, 'Integer64')
  assert.equal(population.nullable, true, "nullable is GDAL's default when not declared")
  assert.equal(population.unique, true)
  // `null`, not `undefined`: "no default" is a value, and the property is always
  // there to be read.
  assert.equal(population.defaultValue, null)
  assert.ok('defaultValue' in population)

  dataset.close()
})

test('field() looks one field up by name, or answers null', () => {
  const { dataset, layer } = pointLayer('schema-lookup.gpkg', { fields: TWO_FIELDS })

  assert.equal(layer.field('population').fieldType, 'Integer64')
  assert.equal(layer.field('name').width, 12)
  assert.equal(layer.field('nobody'), null)

  dataset.close()
})

test('justification rides along, and a bad one is refused before GDAL sees it', () => {
  const { dataset, layer } = pointLayer('schema-justify.gpkg', {
    fields: [{ name: 'amount', fieldType: 'Real', justification: 'Right' }],
  })
  assert.equal(layer.field('amount').justification, 'Right')

  // Compared the way every other name map here compares: case and separators are
  // ignored, and the alternatives are listed on failure.
  assert.throws(
    () => layer.addField({ name: 'x', fieldType: 'String', justification: 'sideways' }),
    /unknown justification.*Undefined, Left, Right/s,
  )

  dataset.close()
})

test('addField grows a layer that already exists', () => {
  const { dataset, layer } = pointLayer('schema-add.gpkg', { fields: TWO_FIELDS })

  // The question worth asking first, and the answer GPKG gives.
  assert.equal(layer.testCapability('CreateField'), true)

  const before = layer.fields.length
  layer.addField({ name: 'area', fieldType: 'Real', defaultValue: '0' })
  assert.equal(layer.fields.length, before + 1)
  assert.equal(layer.field('area').fieldType, 'Real')
  assert.equal(layer.field('area').defaultValue, '0')

  // A field added after the fact and one declared up front go through the same
  // builder, so they describe themselves identically.
  const declared = pointLayer('schema-add-declared.gpkg', {
    fields: [{ name: 'area', fieldType: 'Real', defaultValue: '0' }],
  })
  assert.deepEqual(layer.field('area'), declared.layer.field('area'))
  declared.dataset.close()

  dataset.close()
})

test('addField refuses a type it does not know, and names the ones it does', () => {
  const { dataset, layer } = pointLayer('schema-add-bad.gpkg', { fields: TWO_FIELDS })

  assert.throws(
    () => layer.addField({ name: 'x', fieldType: 'Nonsense' }),
    /unknown field type.*Integer, IntegerList, Integer64/s,
  )
  assert.throws(
    () => layer.addField({ name: 'bad\0name', fieldType: 'String' }),
    /NUL byte/,
  )
  assert.equal(layer.fields.length, 2, 'nothing was added by the failed calls')

  dataset.close()
})

test('deleteField drops one field by name', () => {
  const { dataset, layer } = pointLayer('schema-delete.gpkg', {
    fields: [
      { name: 'name', fieldType: 'String', width: 12 },
      { name: 'note', fieldType: 'String' },
    ],
  })

  layer.deleteField('note')
  assert.deepEqual(layer.fields.map((f) => f.name), ['name'])
  assert.equal(layer.field('note'), null)

  // A name that is not there is an error, and the message lists what is.
  assert.throws(() => layer.deleteField('note'), /no field named "note".*name/s)

  dataset.close()
})

test('a driver that cannot drop a field says so instead of half-doing it', () => {
  const { dataset, layer } = pointLayer('schema-delete-unique.gpkg', { fields: TWO_FIELDS })

  // GeoPackage is SQLite underneath, and SQLite refuses to drop a column a UNIQUE
  // index depends on. That is the driver's answer, passed through — the schema is
  // left alone rather than quietly diverging from the file.
  assert.throws(() => layer.deleteField('population'), /cannot drop UNIQUE column/)
  assert.deepEqual(layer.fields.map((f) => f.name), ['name', 'population'])

  // The field that carries no index goes.
  layer.deleteField('name')
  assert.deepEqual(layer.fields.map((f) => f.name), ['population'])

  dataset.close()
})

test('reorderFields permutes the schema', () => {
  const { dataset, layer } = pointLayer('schema-reorder.gpkg', { fields: TWO_FIELDS })

  layer.reorderFields(['population', 'name'])
  assert.deepEqual(layer.fields.map((f) => f.name), ['population', 'name'])
  // The definitions travel with their fields.
  assert.equal(layer.field('name').width, 12)
  assert.equal(layer.field('population').unique, true)

  dataset.close()
})

test('reorderFields has to name every field exactly once', () => {
  const { dataset, layer } = pointLayer('schema-reorder-bad.gpkg', { fields: TWO_FIELDS })

  // A partial list is rejected here rather than handed to GDAL, whose own answer
  // is to build a malformed schema.
  assert.throws(
    () => layer.reorderFields(['name']),
    /has to name every field, and the layer has 2/,
  )
  assert.throws(
    () => layer.reorderFields(['name', 'name']),
    /named twice/,
  )
  assert.throws(
    () => layer.reorderFields(['name', 'nobody']),
    /no field named "nobody"/,
  )

  // The failed calls left the schema alone.
  assert.deepEqual(layer.fields.map((f) => f.name), ['name', 'population'])

  dataset.close()
})

test('features() is the same read as featuresSync(), off the event loop', async () => {
  const { dataset, layer } = pointLayer('schema-features.gpkg', { fields: TWO_FIELDS })

  for (let index = 0; index < 5; index += 1) {
    layer.createFeature(
      { type: 'Point', coordinates: [index, index] },
      { name: `p${index}`, population: index * 10 },
    )
  }

  const sync = layer.featuresSync()
  const async_ = await layer.features()
  assert.equal(async_.length, 5)
  // The two run the same body, so they have to agree exactly — not merely in count.
  assert.deepEqual(async_, sync)
  assert.equal(async_[0].properties.name, 'p0')
  // The geometry survived the round trip, so the comparison above is of real
  // features rather than of five empty ones.
  assert.deepEqual(async_[2].geometry, { type: 'Point', coordinates: [2, 2] })

  dataset.close()
})

test('setSpatialFilter narrows by an arbitrary geometry, and null clears it', () => {
  const { dataset, layer } = pointLayer('schema-spatial.gpkg', { fields: TWO_FIELDS })

  layer.createFeature({ type: 'Point', coordinates: [1, 2] }, { name: 'inside' })
  layer.createFeature({ type: 'Point', coordinates: [100, 100] }, { name: 'outside' })
  assert.equal(layer.featuresSync().length, 2)

  const box = {
    type: 'Polygon',
    coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
  }
  layer.setSpatialFilter(box)
  const inside = layer.featuresSync()
  assert.equal(inside.length, 1, 'only the point within 0..10 survives')
  assert.equal(inside[0].properties.name, 'inside')

  // It composes with the attribute filter the way both are documented to.
  layer.setSpatialFilter(null)
  assert.equal(layer.featuresSync().length, 2, 'null means clear')

  // A malformed geometry is thrown by the call rather than reaching GDAL as a
  // null geometry — which would silently *clear* the filter instead of failing.
  // GDAL prints its own warning to stderr while refusing.
  assert.throws(
    () => layer.setSpatialFilter({ type: 'Nonsense' }),
    (error) =>
      error.code === 'GDAL_BAD_ARGUMENT' &&
      /Unsupported geometry type/.test(error.message),
  )
  assert.equal(layer.featuresSync().length, 2, 'the failed call left the filter cleared')

  dataset.close()
})

test('getFeature reads and writes through the layer, with no save() to forget', () => {
  const { dataset, layer } = pointLayer('feature-object.gpkg', { fields: TWO_FIELDS })
  layer.createFeature({ type: 'Point', coordinates: [1, 2] }, { name: 'alpha', population: 10 })
  const [record] = layer.featuresSync()

  const feature = layer.getFeature(record.fid)
  assert.equal(feature.fid, record.fid)
  assert.deepEqual(feature.geometry, { type: 'Point', coordinates: [1, 2] })

  assert.equal(feature.fields.get('population'), 10)
  assert.equal(feature.fields.has('name'), true)
  assert.equal(feature.fields.has('nobody'), false)
  assert.deepEqual(feature.fields.names(), ['name', 'population'])
  assert.equal(feature.fields.count(), 2)
  assert.deepEqual(feature.fields.toObject(), { name: 'alpha', population: 10 })
  assert.deepEqual(feature.fields.toArray(), ['alpha', 10])

  // `toObject` is the same record `feature(fid)` returns, plain data and all.
  assert.deepEqual(feature.toObject(), record)

  // A write goes straight through — there is no in-memory copy to persist.
  feature.fields.set('population', 11)
  assert.equal(layer.feature(record.fid).properties.population, 11)

  feature.setGeometry({ type: 'Point', coordinates: [3, 4] })
  assert.deepEqual(layer.feature(record.fid).geometry, { type: 'Point', coordinates: [3, 4] })

  // An unknown field is an error that names what the feature does have.
  assert.throws(() => feature.fields.get('nobody'), /no field named "nobody".*name, population/s)

  // An id that is not there is null, not an error.
  assert.equal(layer.getFeature(9999), null)

  dataset.close()
})

test('layer.defn groups the schema, and Feature.defn agrees with it', () => {
  const { dataset, layer } = pointLayer('feature-defn.gpkg', { fields: TWO_FIELDS })
  layer.createFeature({ type: 'Point', coordinates: [0, 0] }, { name: 'a', population: 1 })

  const defn = layer.defn
  assert.equal(defn.name, 'things')
  assert.equal(defn.geometryType, 'Point')
  assert.equal(defn.fieldCount, 2)
  assert.deepEqual(defn.fields.map((field) => field.name), ['name', 'population'])
  // The grouped columns are the ones the flat accessors report.
  assert.equal(defn.fidColumn, layer.fidColumn)
  assert.equal(defn.geometryColumn, layer.geomColumn)

  const [record] = layer.featuresSync()
  assert.deepEqual(layer.getFeature(record.fid).defn, defn)

  dataset.close()
})
