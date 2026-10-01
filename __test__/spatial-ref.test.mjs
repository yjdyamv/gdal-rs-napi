import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gdal, tmp } from './helpers.mjs'

const wgs84 = () => gdal.SpatialRef.fromEpsg(4326)
const webMercator = () => gdal.SpatialRef.fromEpsg(3857)

test('fromEpsg exposes the authority, the units and the axis order', () => {
  const srs = wgs84()

  assert.equal(srs.authName, 'EPSG')
  assert.equal(srs.authCode, 4326)
  assert.equal(srs.authority, 'EPSG:4326')
  assert.match(srs.name, /WGS 84/)
  assert.equal(srs.isGeographic, true)
  assert.equal(srs.isProjected, false)
  assert.equal(srs.isCompound, false)
  assert.match(srs.angularUnit.name, /degree/i)

  // The order this binding promises, whichever way GDAL would default.
  assert.equal(srs.axisMapping, 'traditional')

  const area = srs.areaOfUse
  assert.ok(area === null || typeof area.west === 'number')
})

test('WKT, PROJJSON and proj4 round-trip', () => {
  const srs = wgs84()

  // The WKT it hands out is enough to build it again, and equality is by
  // definition rather than by spelling.
  assert.equal(gdal.SpatialRef.fromWkt(srs.wkt).equals(srs), true)

  assert.ok(typeof JSON.parse(srs.projJson).type === 'string')
  assert.match(srs.proj4, /^\+proj=longlat/)

  // fromDefinition is the general door, and takes AUTHORITY:CODE as well.
  const mercator = gdal.SpatialRef.fromDefinition('EPSG:3857')
  assert.equal(mercator.isProjected, true)
  assert.match(mercator.linearUnit.name, /metre/i)
  assert.equal(mercator.equals(webMercator()), true)
  assert.equal(mercator.equals(srs), false)
})

test('a CRS built from a PROJ string still describes itself', () => {
  const custom = gdal.SpatialRef.fromProj4('+proj=longlat +datum=WGS84 +no_defs')
  assert.match(custom.proj4, /^\+proj=longlat/)
  assert.equal(custom.isGeographic, true)
  assert.ok(custom.wkt.length > 0)

  // Nonsense is an error, not a CRS with empty fields.
  assert.throws(() => gdal.SpatialRef.fromWkt('this is not a wkt'))
})

test('identifyEpsg searches the CRS database', async () => {
  // The WKT says what the CRS is; finding its code means a database lookup,
  // which is why this one is a promise.
  assert.equal(await gdal.identifyEpsg(wgs84().wkt), 'EPSG:4326')

  // A description that cannot be parsed is an error; one that parses but matches
  // nothing is a null. Both are answers, and they are different answers.
  await assert.rejects(gdal.identifyEpsg('definitely not a CRS description'))
})

test('axis order is longitude,latitude by default — which is the whole point', () => {
  const berlin = [13.4, 52.5] // longitude, latitude

  const traditional = new gdal.CoordinateTransform(wgs84(), webMercator())
  const [tx, ty] = traditional.transformPoint(...berlin)

  // Read as (lon, lat) this is Berlin, and Berlin's northing is far larger than
  // its easting. Read as (lat, lon) — GDAL's own reading of EPSG:4326 — the two
  // would swap, which is precisely the silent mistake the default prevents.
  assert.ok(ty > tx, `northing ${ty} should exceed easting ${tx}`)

  const authority = new gdal.CoordinateTransform(
    wgs84().withAxisMapping('authority'),
    webMercator(),
  )
  const [ax, ay] = authority.transformPoint(...berlin)
  assert.ok(ax > ay, `with authority order, easting ${ax} should exceed northing ${ay}`)

  assert.throws(() => wgs84().withAxisMapping('lat-lon'), /unknown axis mapping/)
})

test('a transform round-trips, and the origin is exact', () => {
  const toMercator = new gdal.CoordinateTransform(wgs84(), webMercator())
  const toWgs84 = new gdal.CoordinateTransform(webMercator(), wgs84())

  assert.deepEqual(toMercator.transformPoint(0, 0), [0, 0])

  const [x, y] = toMercator.transformPoint(13.4, 52.5)
  const [lon, lat] = toWgs84.transformPoint(x, y)
  assert.ok(Math.abs(lon - 13.4) < 1e-9, `longitude came back as ${lon}`)
  assert.ok(Math.abs(lat - 52.5) < 1e-9, `latitude came back as ${lat}`)
})

test('transformPointsSync handles a whole array at once', () => {
  const transform = new gdal.CoordinateTransform(wgs84(), webMercator())
  const points = new Float64Array([0, 0, 13.4, 52.5, 2.35, 48.85])

  const moved = transform.transformPointsSync(points)
  assert.equal(moved.length, points.length)
  assert.ok(moved instanceof Float64Array)

  // The batch has to agree with doing them one at a time.
  for (let index = 0; index < points.length; index += 2) {
    const [x, y] = transform.transformPoint(points[index], points[index + 1])
    assert.ok(Math.abs(moved[index] - x) < 1e-9, `x at ${index}`)
    assert.ok(Math.abs(moved[index + 1] - y) < 1e-9, `y at ${index}`)
  }

  assert.equal(transform.transformPointsSync(new Float64Array([])).length, 0)
  // Coordinates come in pairs; an odd count is a bug in the caller.
  assert.throws(() => transform.transformPointsSync(new Float64Array([1, 2, 3])), /pairs/)
})

test('transformPoints is the same array transform, off the event loop', async () => {
  const transform = new gdal.CoordinateTransform(wgs84(), webMercator())
  const points = new Float64Array([0, 0, 13.4, 52.5, 2.35, 48.85])

  const threaded = await transform.transformPoints(points)
  assert.ok(threaded instanceof Float64Array)
  assert.deepEqual(threaded, transform.transformPointsSync(points))

  // The threaded path rebuilds the transform from the two CRSes, so the axis order
  // has to survive that round trip — otherwise it answers for the wrong place, and
  // plausibly. Compare against the sync form, which never rebuilds.
  const authority = new gdal.CoordinateTransform(
    wgs84().withAxisMapping('authority'),
    webMercator(),
  )
  assert.deepEqual(await authority.transformPoints(points), authority.transformPointsSync(points))
  assert.notDeepEqual(
    await authority.transformPoints(points),
    threaded,
    'the two orders should not agree, or this proves nothing',
  )

  // A caller mistake is thrown at the call, not delivered as a rejection.
  assert.throws(() => transform.transformPoints(new Float64Array([1, 2, 3])), /pairs/)
})

test('transformBounds densifies, so the result contains the input', () => {
  const toMercator = new gdal.CoordinateTransform(wgs84(), webMercator())
  const toWgs84 = new gdal.CoordinateTransform(webMercator(), wgs84())

  const box = [13.0, 52.0, 13.8, 53.0] // a small box around Berlin
  const metres = toMercator.transformBounds(box)
  assert.equal(metres.length, 4)
  assert.ok(metres[0] > 1_000_000 && metres[1] > 6_000_000, `expected metres, got ${metres}`)

  // Densifying the edges means the box can only grow, never lose a corner.
  const back = toWgs84.transformBounds(metres)
  assert.ok(back[0] <= box[0] + 1e-6, `${back[0]} should not cut into ${box[0]}`)
  assert.ok(back[1] <= box[1] + 1e-6, `${back[1]} should not cut into ${box[1]}`)
  assert.ok(back[2] >= box[2] - 1e-6, `${back[2]} should not cut into ${box[2]}`)
  assert.ok(back[3] >= box[3] - 1e-6, `${back[3]} should not cut into ${box[3]}`)

  assert.throws(() => toMercator.transformBounds([0, 1, 2]), /4 numbers/)
  assert.throws(() => toMercator.transformBounds(box, -1), /negative/)
})

test('an impossible coordinate does not come back as a plausible number', () => {
  const transform = new gdal.CoordinateTransform(wgs84(), webMercator())

  // Latitude 100 does not exist: Mercator is undefined there. Whatever GDAL
  // decides, it must not be a usable-looking coordinate.
  let outcome
  try {
    outcome = transform.transformPoint(0, 100)
  } catch (error) {
    outcome = 'threw'
  }
  assert.ok(
    outcome === 'threw' || outcome.some((value) => !Number.isFinite(value)),
    `got ${JSON.stringify(outcome)}`,
  )
})

test('transformGeometry moves a whole geometry, not just points', () => {
  const toMercator = new gdal.CoordinateTransform(wgs84(), webMercator())

  const polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [13.0, 52.0],
        [13.8, 52.0],
        [13.8, 53.0],
        [13.0, 53.0],
        [13.0, 52.0],
      ],
    ],
  }

  const moved = toMercator.transformGeometry(polygon)
  assert.equal(moved.type, 'Polygon')
  assert.deepEqual(
    moved.coordinates.map((ring) => ring.length),
    [5],
    'the ring keeps its vertices',
  )

  // Same shape, metres instead of degrees.
  const [x, y] = moved.coordinates[0][0]
  assert.ok(x > 1_000_000 && y > 6_000_000, `expected metres, got ${x}, ${y}`)

  // And back again, to the corner we started from.
  const back = new gdal.CoordinateTransform(webMercator(), wgs84()).transformGeometry(moved)
  const [lon, lat] = back.coordinates[0][0]
  assert.ok(Math.abs(lon - 13.0) < 1e-9, `longitude came back as ${lon}`)
  assert.ok(Math.abs(lat - 52.0) < 1e-9, `latitude came back as ${lat}`)

  // Something that is not a geometry is an error, not an empty shape.
  assert.throws(() => toMercator.transformGeometry({ type: 'Nonsense' }))
})

test('datasets and layers hand out their CRS as an object', () => {
  const path = tmp('spatial-ref-raster.tif')
  const created = gdal.createSync(path, { driver: 'GTiff', width: 4, height: 4, bandCount: 1 })
  created.setProjection(gdal.epsgToWkt(4326))
  created.close()

  const dataset = gdal.openSync(path)
  assert.equal(dataset.spatialRef.equals(wgs84()), true)
  assert.equal(dataset.spatialRef.authority, 'EPSG:4326')
  dataset.close()

  // No projection, no object — not an empty one pretending otherwise.
  const mem = gdal.createSync('', { driver: 'MEM', width: 2, height: 2, bandCount: 1 })
  assert.equal(mem.spatialRef, null)
  mem.close()

  const vector = tmp('spatial-ref-vector.gpkg')
  const layers = gdal.createVectorSync(vector, 'GPKG')
  layers.createLayer({ name: 'places', geometryType: 'Point', wkt: gdal.epsgToWkt(4326) })
  assert.equal(layers.layer(0).spatialRef.equals(wgs84()), true)

  // A CRS given two ways is ambiguity, not redundancy.
  assert.throws(
    () => layers.createLayer({ name: 'both', epsg: 4326, wkt: gdal.epsgToWkt(4326) }),
    /not both/,
  )
  layers.close()
})

test('setProjection takes a SpatialRef as well as a WKT string', () => {
  const path = tmp('set-projection.tif')
  const dataset = gdal.createSync(path, {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 1,
  })

  // The string form, unchanged.
  dataset.setProjection(gdal.epsgToWkt(4326))
  assert.equal(dataset.spatialRef.equals(wgs84()), true)

  // ... and a SpatialRef, which is the object `dataset.spatialRef` hands back —
  // passed as-is instead of through its `wkt`.
  dataset.setProjection(webMercator())
  assert.equal(dataset.spatialRef.authCode, 3857)
  assert.equal(dataset.spatialRef.equals(webMercator()), true)

  dataset.close()
})

test('a CoordinateTransform can be told how to choose its operation', () => {
  // Massachusetts and the Netherlands have no precise transformation between
  // them, so GDAL falls back to a ballpark one — and says nothing.
  const massachusetts = gdal.SpatialRef.fromEpsg(6491)
  const netherlands = gdal.SpatialRef.fromEpsg(28992)
  assert.doesNotThrow(() => new gdal.CoordinateTransform(massachusetts, netherlands))

  // Forbidding the fallback turns that into a failure rather than an
  // approximation nobody was told about.
  assert.throws(
    () => new gdal.CoordinateTransform(massachusetts, netherlands, { ballpark: false }),
    /OCTNewCoordinateTransformation|transform/i,
  )

  // A pipeline is used *instead of* the computed operation — and it has to do its
  // own axis handling. GDAL hands a named operation the coordinates in the source
  // CRS's **authority** order (latitude, longitude for EPSG:4326), not in the
  // longitude,latitude order the rest of this binding speaks; hence the explicit
  // `axisswap`, after which the hand-written pipeline agrees with the computed one
  // to the last digit.
  const computed = new gdal.CoordinateTransform(wgs84(), gdal.SpatialRef.fromEpsg(32633))
  const utmByHand = new gdal.CoordinateTransform(wgs84(), gdal.SpatialRef.fromEpsg(32633), {
    pipeline:
      '+proj=pipeline +step +proj=axisswap +order=2,1 +step +proj=unitconvert +xy_in=deg +xy_out=rad +step +proj=utm +zone=33 +ellps=WGS84',
  })
  assert.deepEqual(utmByHand.transformPoint(13.4, 52.5), computed.transformPoint(13.4, 52.5))
  assert.ok(computed.transformPoint(13.4, 52.5)[0] > 380_000, 'and that is metres, not degrees')

  // Without the swap the pipeline still runs — it just runs on the other order,
  // which is the trap this option carries.
  const unswapped = new gdal.CoordinateTransform(wgs84(), gdal.SpatialRef.fromEpsg(32633), {
    pipeline: '+proj=noop',
  })
  assert.deepEqual(unswapped.transformPoint(13.4, 52.5), [52.5, 13.4], 'coordinates arrive swapped')

  // A URN naming an operation works the same way. (This one is defined in the
  // other direction, so a usable transform wants `reverse` — which is why the
  // assertion is that GDAL took the option, not that the numbers came out.)
  const nad27 = gdal.SpatialRef.fromEpsg(4267)
  assert.doesNotThrow(
    () =>
      new gdal.CoordinateTransform(nad27, wgs84(), {
        pipeline: 'urn:ogc:def:coordinateOperation:EPSG::8599',
      }),
  )

  // An accuracy floor and an area to choose by are both accepted.
  const utm = new gdal.CoordinateTransform(wgs84(), gdal.SpatialRef.fromEpsg(32633), {
    accuracy: 0,
    areaOfInterest: [12, 50, 14, 52],
  })
  assert.equal(utm.transformPoint(13.4, 52.5).length, 2)

  // What can be checked here is checked here rather than handed to GDAL.
  assert.throws(
    () => new gdal.CoordinateTransform(nad27, wgs84(), { reverse: true }),
    /reverse.*pipeline/,
  )
  assert.throws(
    () => new gdal.CoordinateTransform(nad27, wgs84(), { accuracy: -1 }),
    /accuracy target/,
  )
  assert.throws(
    () => new gdal.CoordinateTransform(nad27, wgs84(), { areaOfInterest: [1, 2] }),
    /four numbers/,
  )
})

test('the CRS extras: XML, validation, the geographic base and the ESRI dialect', () => {
  const utm = gdal.SpatialRef.fromEpsg(32633)

  // A third serialization beside wkt and projJson, and a validation pass.
  assert.ok(utm.toXML().length > 0)
  assert.equal(utm.validate(), true)

  // The geographic CRS underneath a UTM zone is WGS 84 — a new object, not a view.
  const geog = utm.cloneGeogCS()
  assert.equal(geog.isGeographic, true)
  assert.match(geog.name, /WGS 84/)

  // The order the EPSG authority reads each one in.
  assert.equal(gdal.SpatialRef.fromEpsg(4326).epsgTreatsAsLatLong, true)
  assert.equal(utm.epsgTreatsAsLatLong, false)

  // ESRI's dialect: morph out, and read it back in.
  const esri = gdal.SpatialRef.fromEpsg(32633)
  esri.morphToESRI()
  const back = gdal.SpatialRef.fromESRI(esri.wkt)
  assert.equal(back.isProjected, true)
  assert.equal(back.equals(gdal.SpatialRef.fromEpsg(32633)), true)

  // And a well-known geographic reset, in place: it sets the GEOGCS, so a NAD27
  // CRS becomes WGS 84.
  const nad = gdal.SpatialRef.fromEpsg(4267)
  nad.setWellKnownGeogCS('WGS84')
  assert.equal(nad.isGeographic, true)
  assert.match(nad.name, /WGS 84/)
})

test('the CRS tail: geocentric, local, same-geog and named attributes', () => {
  const wgs84 = gdal.SpatialRef.fromEpsg(4326)
  const merc = gdal.SpatialRef.fromEpsg(3857)
  const utm = gdal.SpatialRef.fromEpsg(32633)

  assert.equal(wgs84.isGeocentric, false)
  assert.equal(wgs84.isLocal, false)

  // Two CRSes that share WGS 84 share a geographic basis, however they project.
  assert.equal(merc.isSameGeogCS(utm), true)
  assert.equal(merc.isSameGeogCS(wgs84), true)
  // Neither has a vertical component, so that comparison is false.
  assert.equal(merc.isSameVertCS(utm), false)

  // Named attributes are the WKT nodes, by name and child index.
  assert.match(merc.getAttrValue('PROJCS'), /Mercator/)
  assert.equal(merc.getAttrValue('NOPE'), null)

  // `autoIdentifyEPSG` works out the code where GDAL can and leaves the CRS alone
  // where it cannot — neither case throws. On one that already knows its code it is
  // a no-op; on a hand-written WGS 84 GEOGCS GDAL does *not* identify it here, so no
  // authority is set, which is the honest answer to pin.
  const known = gdal.SpatialRef.fromEpsg(4326)
  known.autoIdentifyEPSG()
  assert.equal(known.authCode, 4326)

  const hand = gdal.SpatialRef.fromWkt(
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,' +
      'AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],' +
      'PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],' +
      'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]]]',
  )
  assert.equal(hand.authority, null)
  assert.doesNotThrow(() => hand.autoIdentifyEPSG())
})
