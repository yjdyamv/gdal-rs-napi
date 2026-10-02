// @ts-nocheck
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { gdal, tmp } from '../helpers.js'

// Four corners of a small raster, in WGS 84 — the classic way to georeference a
// scan with ground control points rather than a geotransform.
const CORNERS = [
  { id: '1', info: 'SW', pixel: 0, line: 0, x: 6.0, y: 47.0, z: 0 },
  { id: '2', info: 'SE', pixel: 8, line: 0, x: 7.0, y: 47.0, z: 0 },
  { id: '3', info: 'NW', pixel: 0, line: 8, x: 6.0, y: 46.0, z: 0 },
]

test('GCPs round-trip, with the CRS they are expressed in', () => {
  const dataset = gdal.createSync(tmp('gcps.tif'), {
    driver: 'GTiff',
    width: 8,
    height: 8,
    bandCount: 1,
    dataType: 'Uint8',
  })

  // Nothing set yet.
  assert.equal(dataset.gcpCount, 0)
  assert.deepEqual(dataset.getGCPs(), [])
  assert.equal(dataset.gcpProjection, null)

  dataset.setGCPs(CORNERS, gdal.epsgToWkt(4326))

  assert.equal(dataset.gcpCount, 3)
  assert.deepEqual(dataset.getGCPs(), CORNERS)
  assert.match(dataset.gcpProjection, /WGS 84/)

  dataset.close()
})

test('GCPs survive being written to a file', () => {
  const path = tmp('gcps-persisted.tif')
  const created = gdal.createSync(path, {
    driver: 'GTiff',
    width: 8,
    height: 8,
    bandCount: 1,
    dataType: 'Uint8',
  })
  created.setGCPs(CORNERS, gdal.epsgToWkt(4326))
  created.close()

  const reopened = gdal.openSync(path)
  assert.equal(reopened.gcpCount, 3)
  // GTiff keeps a GCP's id and coordinates; `info` is not part of the TIFF GCP
  // tag, so it does not survive the file — which is the format's answer, not a bug
  // here. The in-memory round trip above is what pins `info`.
  const identity = ({ id, pixel, line, x, y, z }) => ({ id, pixel, line, x, y, z })
  assert.deepEqual(reopened.getGCPs().map(identity), CORNERS.map(identity))
  assert.match(reopened.gcpProjection, /WGS 84/)
  reopened.close()
})
