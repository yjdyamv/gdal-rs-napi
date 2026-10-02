import { describe, expect, it } from 'vitest'

import gdal from '../compat/index.js'
import { native } from './helpers.js'

// `SpatialReference` and `CoordinateTransformation`, under the reference's names.
describe('coordinate reference systems', () => {
  it('exposes the authority, the units and the axis order', () => {
    const wgs84 = gdal.SpatialReference.fromEPSG(4326)
    expect(wgs84).toBeInstanceOf(gdal.SpatialReference)
    expect(wgs84.authCode).toBe(4326)
    expect(wgs84.authName).toBe('EPSG')
    expect(wgs84.authority).toBe('EPSG:4326')
    expect(wgs84.name).toBeTruthy()
    expect(wgs84.isGeographic).toBe(true)
    expect(wgs84.isProjected).toBe(false)
    expect(wgs84.isCompound).toBe(false)
    expect(wgs84.isVertical).toBe(false)
    expect(wgs84.isGeocentric).toBe(false)
    expect(wgs84.isLocal).toBe(false)
    expect(wgs84.epsgTreatsAsLatLong).toBe(true)
    expect(wgs84.axisMapping).toBe('traditional')
    // A degree is π/180 radians, which is what the reference's unit factor is.
    expect(wgs84.getAngularUnits()).toBeCloseTo(Math.PI / 180, 12)
    expect(wgs84.getLinearUnits()).toBe(1)
    expect(wgs84.areaOfUse).toBeTypeOf('object')
  })

  it('serializes to WKT, PROJJSON, proj4 and XML', () => {
    const wgs84 = gdal.SpatialReference.fromEPSG(4326)
    expect(wgs84.toWKT()).toContain('GEOGCS')
    expect(wgs84.wkt).toContain('GEOGCS')
    expect(wgs84.toPrettyWKT()).toContain('\n')
    expect(wgs84.prettyWkt).toContain('\n')
    expect(wgs84.toProj4()).toContain('+proj=longlat')
    expect(wgs84.proj4).toContain('+proj=longlat')
    expect(wgs84.projJson).toContain('"type"')
    expect(wgs84.toXML()).toContain('<gml')
    expect(wgs84.getName()).toBeTruthy()
    expect(wgs84.getAuthorityName()).toBe('EPSG')
    expect(wgs84.getAuthorityCode()).toBe('4326')
    expect(typeof wgs84.getAttrValue('GEOGCS')).not.toBe('undefined')
  })

  it('compares by definition rather than by spelling', () => {
    const wgs84 = gdal.SpatialReference.fromEPSG(4326)
    expect(wgs84.isSame(gdal.SpatialReference.fromWKT(native.epsgToWkt(4326)))).toBe(true)
    expect(wgs84.equals(gdal.SpatialReference.fromEPSG(4326))).toBe(true)
    expect(wgs84.isSameGeogCS(gdal.SpatialReference.fromEPSG(32631))).toBe(true)
    expect(wgs84.isSameVertCS(wgs84)).toBe(false)
    expect(wgs84.validate()).toBe(true)
  })

  it('builds from each of the reference\'s doors', () => {
    expect(gdal.SpatialReference.fromWKT(native.epsgToWkt(4326)).authCode).toBe(4326)
    expect(gdal.SpatialReference.fromProj4('+proj=longlat +datum=WGS84 +no_defs').authCode).toBeNull()
    expect(gdal.SpatialReference.fromESRI(native.epsgToWkt(4326))).toBeInstanceOf(gdal.SpatialReference)
    expect(gdal.SpatialReference.fromURN('urn:ogc:def:crs:EPSG::4326').authCode).toBe(4326)
    expect(gdal.SpatialReference.fromUserInput('EPSG:4326').authCode).toBe(4326)
    expect(gdal.SpatialReference.fromURL('EPSG:4326').authCode).toBe(4326)
    expect(gdal.SpatialReference.fromCRSURL('EPSG:4326').authCode).toBe(4326)
    expect(gdal.SpatialReference.fromWMSAUTO('EPSG:4326').authCode).toBe(4326)
    expect(gdal.SpatialReference.fromMICoordSys('EPSG:4326').authCode).toBe(4326)
    expect(gdal.SpatialReference.fromEPSGA(4326).axisMapping).toBe('authority')
    expect(new gdal.SpatialReference(native.epsgToWkt(4326)).authCode).toBe(4326)
  })

  it('rewrites the definition in place', () => {
    const srs = gdal.SpatialReference.fromEPSG(4326)
    srs.morphToESRI()
    srs.morphFromESRI()
    expect(srs.authCode).toBe(4326)

    const identified = gdal.SpatialReference.fromProj4('+proj=longlat +datum=WGS84 +no_defs')
    identified.autoIdentifyEPSG()
    expect(typeof identified.toWKT()).toBe('string')

    const reset = gdal.SpatialReference.fromWKT(native.epsgToWkt(32631))
    reset.setWellKnownGeogCS('WGS84')
    expect(typeof reset.toWKT()).toBe('string')

    expect(srs.clone().authCode).toBe(4326)
    expect(srs.cloneGeogCS().authCode).toBe(4326)
    expect(srs.withAxisMapping('authority').axisMapping).toBe('authority')
  })

  it('transforms points and geometries', () => {
    const transform = new gdal.CoordinateTransformation(
      gdal.SpatialReference.fromEPSG(4326),
      gdal.SpatialReference.fromEPSG(3857),
    )
    const fromObject = transform.transformPoint({ x: 13.4, y: 52.5 })
    const fromArguments = transform.transformPoint(13.4, 52.5)
    expect(fromObject.x).toBeGreaterThan(1_000_000)
    expect(fromObject.x).toBe(fromArguments.x)
    expect(fromObject.y).toBe(fromArguments.y)

    const moved = transform.transformGeometry(gdal.fromWKT('POINT (13.4 52.5)'))
    expect(moved).toBeInstanceOf(gdal.Point)
    expect(moved.type).toBe('Point')
  })

  it('refuses a transformation from something that is not two CRSs', () => {
    expect(() => new gdal.CoordinateTransformation({} as never, {} as never)).toThrow()
  })
})
