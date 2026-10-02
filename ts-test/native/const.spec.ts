// @ts-nocheck
// `gdal.const` freezes the string vocabularies the binding already reads and
// writes. The value of a constant is only that it is the spelling the runtime
// uses, so every test here checks a constant *against the runtime* rather than
// against the table — a table that agreed only with itself would be worthless.

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { gdal, tmp } from '../helpers.js'

const { const: k } = gdal

/** Every value of a vocabulary, as an array. */
const values = (vocabulary) => Object.values(vocabulary)

test('the constant tables are frozen, so a name cannot be reassigned', () => {
  assert.equal(Object.isFrozen(k), true)
  for (const [name, vocabulary] of Object.entries(k)) {
    assert.equal(Object.isFrozen(vocabulary), true, `${name} is frozen`)
  }
})

test('a vocabulary whose names are already canonical reads key === value', () => {
  // `DataType.Uint8 === 'Uint8'`: the key and the value are the same name, so a
  // reader never has to look up which casing is the value. Resampling is the
  // exception — its values are lowercase GDAL tokens.
  for (const name of [
    'DataType',
    'FieldType',
    'Justification',
    'GeometryType',
    'ColorInterpretation',
    'SqlDialect',
  ]) {
    for (const [key, value] of Object.entries(k[name])) {
      assert.equal(value, key, `${name}.${key}`)
    }
  }
})

test('every DataType is the one a band reports back', () => {
  for (const name of values(k.DataType)) {
    if (name === k.DataType.Unknown) continue // receivable, never requestable
    const dataset = gdal.createSync('', {
      driver: 'MEM',
      width: 2,
      height: 2,
      bandCount: 1,
      dataType: name,
    })
    assert.equal(dataset.band(0).dataType, name)
    dataset.close()
  }

  // `Unknown` is what an unrepresentable band type reports; asking for it is not
  // an error, it just leaves GDAL's default in place.
  const fallback = gdal.createSync('', {
    driver: 'MEM',
    width: 1,
    height: 1,
    dataType: k.DataType.Unknown,
  })
  assert.equal(fallback.band(0).dataType, k.DataType.Uint8)
  fallback.close()
})

test('every FieldType and Justification round-trips through a layer schema', () => {
  const path = tmp('const-schema.gpkg')
  const dataset = gdal.createVectorSync(path, 'GPKG')

  const fields = values(k.FieldType).map((fieldType, index) => ({
    name: `f${index}`,
    fieldType,
  }))
  const layer = dataset.createLayer({ name: 'things', geometryType: k.GeometryType.Point, fields })

  for (const [index, fieldType] of values(k.FieldType).entries()) {
    assert.equal(layer.field(`f${index}`).fieldType, fieldType)
  }

  for (const justification of values(k.Justification)) {
    layer.addField({ name: `j${justification}`, fieldType: k.FieldType.String, justification })
    assert.equal(layer.field(`j${justification}`).justification, justification)
  }

  dataset.close()
})

test('every GeometryType is the one a layer reports back', () => {
  const path = tmp('const-geometry.gpkg')
  const dataset = gdal.createVectorSync(path, 'GPKG')

  const layer = dataset.createLayer({ name: 'things', geometryType: k.GeometryType.MultiPolygon })
  assert.equal(layer.geometryType, k.GeometryType.MultiPolygon)

  dataset.close()

  // The whole vocabulary is accepted as input, and every one round-trips — a
  // fresh layer each time, because a layer's type is fixed at creation.
  for (const geometryType of values(k.GeometryType)) {
    const scratch = gdal.createVectorSync(tmp(`const-geometry-${geometryType}.gpkg`), 'GPKG')
    const created = scratch.createLayer({ name: 'things', geometryType })
    assert.equal(created.geometryType, geometryType)
    scratch.close()
  }
})

test('ColorInterpretation names what a band actually reports', () => {
  const path = tmp('const-color.tif')
  const rgb = gdal.createSync(path, {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 3,
    dataType: k.DataType.Uint8,
  })
  const reported = [0, 1, 2].map((index) => rgb.band(index).colorInterpretation)
  assert.deepEqual(reported, [
    k.ColorInterpretation.RedBand,
    k.ColorInterpretation.GreenBand,
    k.ColorInterpretation.BlueBand,
  ])
  rgb.close()

  // A single band has no colour to carry, which GDAL reports as GrayIndex.
  const gray = gdal.createSync(tmp('const-color-gray.tif'), {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 1,
    dataType: k.DataType.Uint8,
  })
  assert.equal(gray.band(0).colorInterpretation, k.ColorInterpretation.GrayIndex)
  gray.close()
})

test('Resampling is what a pixel read accepts — nearest is "nearestneighbour"', () => {
  const path = tmp('const-resampling.tif')
  const dataset = gdal.createSync(path, {
    driver: 'GTiff',
    width: 8,
    height: 8,
    bandCount: 1,
    dataType: k.DataType.Uint8,
  })
  const band = dataset.band(0)
  band.fill(1)

  for (const name of values(k.Resampling)) {
    assert.doesNotThrow(() => band.readPixelsSync({ outWidth: 4, outHeight: 4, resampling: name }))
  }

  // The overview-only spellings are not read kernels, so they are refused — and
  // `nearest` in particular must not be silently accepted as `nearestneighbour`.
  for (const notAResampling of ['nearest', k.OverviewResampling.Rms, k.OverviewResampling.None]) {
    assert.throws(
      () => band.readPixelsSync({ resampling: notAResampling }),
      /unknown resampling/,
    )
  }

  dataset.close()
})

test('OverviewResampling is what buildOverviews accepts — nearest is "nearest"', () => {
  for (const name of values(k.OverviewResampling)) {
    const dataset = gdal.createSync(tmp(`const-overview-${name}.tif`), {
      driver: 'GTiff',
      width: 16,
      height: 16,
      bandCount: 1,
      dataType: k.DataType.Uint8,
    })
    assert.doesNotThrow(() => dataset.buildOverviewsSync({ levels: [2], resampling: name }))
    dataset.close()
  }

  // `nearestneighbour` is the read spelling and is not an overview kernel.
  const dataset = gdal.createSync(tmp('const-overview-reject.tif'), {
    driver: 'GTiff',
    width: 16,
    height: 16,
    bandCount: 1,
  })
  assert.throws(
    () => dataset.buildOverviewsSync({ levels: [2], resampling: k.Resampling.NearestNeighbour }),
    /unknown overview resampling/,
  )
  dataset.close()
})

test('SqlDialect names the dialects executeSql takes', () => {
  const path = tmp('const-dialect.gpkg')
  const dataset = gdal.createVectorSync(path, 'GPKG')
  dataset.createLayer({ name: 'things', geometryType: k.GeometryType.Point })

  for (const dialect of values(k.SqlDialect)) {
    assert.doesNotThrow(() => dataset.executeSql('SELECT * FROM things', dialect))
  }

  dataset.close()
})
