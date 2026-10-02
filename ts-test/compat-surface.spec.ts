import { describe, expect, it } from 'vitest'

import gdal from '../compat/index.js'

// A smoke test that the whole declared module surface is really there. The typed
// usages elsewhere in `ts-test/` are what check the *shapes*; this is the check
// that nothing in `compat/index.d.ts` is declared but absent at runtime.
describe('the module surface', () => {
  const functions = [
    'open',
    'openAsync',
    'verbose',
    'quiet',
    'decToDMS',
    'info',
    'infoAsync',
    'toDataType',
    'fromDataType',
    'deleteDataset',
    'addPixelFunc',
    'toPixelFunc',
    'createPixelFunc',
    'createPixelFuncWithArgs',
    'wrapVRT',
    'calcAsync',
    'fromWKT',
    'fromWKB',
    'fromJSON',
    'fromObject',
    'geometryFromWKT',
    'geometryFromWKB',
    'geometryFromJSON',
    'translate',
    'translateAsync',
    'vectorTranslate',
    'vectorTranslateAsync',
    'warp',
    'warpAsync',
    'buildVRT',
    'buildVRTAsync',
    'dem',
    'demAsync',
    'checksumImage',
    'checksumImageAsync',
    'suggestedWarpOutput',
    'suggestedWarpOutputAsync',
    'reprojectImage',
    'reprojectImageAsync',
    'fillNodata',
    'fillNodataAsync',
    'sieveFilter',
    'sieveFilterAsync',
    'rasterize',
    'rasterizeAsync',
    'contourGenerate',
    'contourGenerateAsync',
    'polygonize',
    'polygonizeAsync',
  ] as const

  const classes = [
    'Geometry',
    'SimpleCurve',
    'Point',
    'LineString',
    'LinearRing',
    'CircularString',
    'CompoundCurve',
    'MultiCurve',
    'ColorTable',
    'Polygon',
    'MultiPoint',
    'MultiLineString',
    'MultiPolygon',
    'GeometryCollection',
    'SpatialReference',
    'CoordinateTransformation',
    'Envelope',
    'Envelope3D',
    'Dataset',
    'RasterBand',
    'Layer',
    'Feature',
    'FeatureFields',
    'FeatureDefn',
    'FieldDefn',
    'LayerFeatures',
    'LayerFields',
    'FeatureDefnFields',
    'DatasetBands',
    'DatasetLayers',
    'RasterBandPixels',
    'RasterBandOverviews',
    'RasterReadStream',
    'RasterWriteStream',
    'GDALDrivers',
    'Driver',
    'Group',
    'MDArray',
    'Attribute',
    'Dimension',
    'Dimensions',
    'GeometryCollectionChildren',
    'LineStringPoints',
    'PolygonRings',
    'CompoundCurveCurves',
    'RasterMuxStream',
    'RasterTransform',
  ] as const

  it('declares every function it exports', () => {
    for (const name of functions) {
      expect(gdal[name], `${name} is not exported`).toBeTypeOf('function')
    }
  })

  it('declares every class it exports', () => {
    for (const name of classes) {
      expect(gdal[name], `${name} is not exported`).toBeTypeOf('function')
    }
  })

  it('carries the GDAL numeric constants, read from the linked headers', () => {
    // A sample from each family; the values themselves are pinned by
    // `ts-test/native/compat-surface.spec.ts`.
    for (const name of [
      'GDT_Byte',
      'GDT_Float64',
      'OFTString',
      'OFTInteger64',
      'GCI_RedBand',
      'GRA_Bilinear',
      'GPI_RGB',
      'OJLeft',
      'CE_Failure',
      'wkbPoint',
      'wkbGeometryCollection',
      'GEDTC_STRING',
    ] as const) {
      expect(gdal[name], `${name} is not exported`).toBeTypeOf('number')
    }
  })

  it('exposes the sub-namespaces as objects', () => {
    expect(gdal.config).toBeTypeOf('object')
    expect(gdal.fs).toBeTypeOf('object')
    expect(gdal.vsimem).toBeTypeOf('object')
    expect(gdal.drivers).toBeTypeOf('object')
  })
})
