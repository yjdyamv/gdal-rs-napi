// Setting a layer's CRS after the layer exists.
//
// The C API has no `OGR_L_SetSpatialRef` — a layer's CRS is its geometry field's — so
// this goes through `OGR_L_AlterGeomFieldDefn`, which asks the *driver*. That is why
// the answer depends on the format: one that can rewrite its schema does, and one that
// cannot says so rather than silently doing nothing.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gdal, tmp } from './helpers.mjs'

/** A one-layer vector dataset with a declared CRS. */
function created(name, driver, extension) {
  const dataset = gdal.createVectorSync(tmp(`${name}.${extension}`), driver)
  const layer = dataset.createLayer({ name: 'things', geometryType: 'Point', epsg: 4326 })
  return { dataset, layer }
}

/** The layer's CRS as its authority code, which is what the tests compare. */
const authority = (layer) => layer.spatialRef?.authority ?? null

test('a layer that can rewrite its schema takes a new CRS, and keeps it', () => {
  for (const [driver, extension] of [
    ['GPKG', 'gpkg'],
    ['ESRI Shapefile', 'shp'],
  ]) {
    const { dataset, layer } = created('layer-crs', driver, extension)
    assert.equal(authority(layer), 'EPSG:4326')

    layer.setSpatialRef('EPSG:3857')
    assert.equal(authority(layer), 'EPSG:3857', `${driver} took a WKT`)

    // A `SpatialRef` object is accepted too, and it is the same door.
    layer.setSpatialRef(gdal.SpatialRef.fromEpsg(32633))
    assert.equal(authority(layer), 'EPSG:32633', `${driver} took an object`)

    dataset.close()

    // Which is the point of going through the driver: it is in the file.
    const reopened = gdal.openSync(tmp(`layer-crs.${extension}`))
    assert.equal(authority(reopened.layer(0)), 'EPSG:32633', `${driver} persisted it`)
    reopened.close()
  }
})

test('a layer that cannot says which driver would not', () => {
  for (const [driver, extension] of [
    ['GeoJSON', 'geojson'],
    ['FlatGeobuf', 'fgb'],
  ]) {
    const { dataset, layer } = created('layer-crs-refused', driver, extension)
    assert.throws(
      () => layer.setSpatialRef('EPSG:3857'),
      new RegExp(`the ${driver} driver would not change this layer's CRS`),
    )
    dataset.close()
  }
})

test('a CRS GDAL cannot read is refused, and the old one is left alone', () => {
  const { dataset, layer } = created('layer-crs-nonsense', 'GPKG', 'gpkg')

  assert.throws(() => layer.setSpatialRef('not a CRS at all'), /could not read that CRS/)
  // The layer is untouched — the failure is at the call, not halfway through it.
  assert.equal(authority(layer), 'EPSG:4326')

  // The two forms are one door: a WKT and a `SpatialRef` land in the same place.
  layer.setSpatialRef(gdal.SpatialRef.fromEpsg(3857))
  assert.equal(authority(layer), 'EPSG:3857')
  layer.setSpatialRef(gdal.SpatialRef.fromEpsg(3857).wkt)
  assert.equal(authority(layer), 'EPSG:3857')

  dataset.close()
})
