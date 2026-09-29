export * from './binding'

/**
 * The frozen string vocabularies the binding reads and writes, as `gdal.const`.
 *
 * Each value is the exact spelling the runtime uses, so passing one where a
 * string is expected is the same as passing the literal — and a misspelling is
 * caught here rather than at the call. These are names, not GDAL's numeric enum
 * codes; see `docs/API-STABILITY.md`.
 */
export interface GdalConstants {
  /** `band.dataType`, `create({ dataType })`. A requested `Unknown` leaves GDAL's default. */
  readonly DataType: {
    readonly Unknown: 'Unknown'
    readonly Uint8: 'Uint8'
    readonly Int8: 'Int8'
    readonly Uint16: 'Uint16'
    readonly Int16: 'Int16'
    readonly Uint32: 'Uint32'
    readonly Int32: 'Int32'
    readonly Uint64: 'Uint64'
    readonly Int64: 'Int64'
    readonly Float32: 'Float32'
    readonly Float64: 'Float64'
  }
  /** `FieldInfo.fieldType`, `FieldDefinition.fieldType`. */
  readonly FieldType: {
    readonly Integer: 'Integer'
    readonly IntegerList: 'IntegerList'
    readonly Integer64: 'Integer64'
    readonly Integer64List: 'Integer64List'
    readonly Real: 'Real'
    readonly RealList: 'RealList'
    readonly String: 'String'
    readonly StringList: 'StringList'
    readonly WideString: 'WideString'
    readonly WideStringList: 'WideStringList'
    readonly Binary: 'Binary'
    readonly Date: 'Date'
    readonly Time: 'Time'
    readonly DateTime: 'DateTime'
  }
  /** `FieldInfo.justification`, `FieldDefinition.justification`. */
  readonly Justification: {
    readonly Undefined: 'Undefined'
    readonly Left: 'Left'
    readonly Right: 'Right'
  }
  /** `layer.geometryType`, `createLayer({ geometryType })`. */
  readonly GeometryType: {
    readonly Unknown: 'Unknown'
    readonly None: 'None'
    readonly Point: 'Point'
    readonly LineString: 'LineString'
    readonly Polygon: 'Polygon'
    readonly MultiPoint: 'MultiPoint'
    readonly MultiLineString: 'MultiLineString'
    readonly MultiPolygon: 'MultiPolygon'
    readonly GeometryCollection: 'GeometryCollection'
  }
  /** `band.colorInterpretation`. */
  readonly ColorInterpretation: {
    readonly Undefined: 'Undefined'
    readonly GrayIndex: 'GrayIndex'
    readonly PaletteIndex: 'PaletteIndex'
    readonly RedBand: 'RedBand'
    readonly GreenBand: 'GreenBand'
    readonly BlueBand: 'BlueBand'
    readonly AlphaBand: 'AlphaBand'
    readonly HueBand: 'HueBand'
    readonly SaturationBand: 'SaturationBand'
    readonly LightnessBand: 'LightnessBand'
    readonly CyanBand: 'CyanBand'
    readonly MagentaBand: 'MagentaBand'
    readonly YellowBand: 'YellowBand'
    readonly BlackBand: 'BlackBand'
    readonly YCbCrSpaceYBand: 'YCbCrSpaceYBand'
    readonly YCbCrSpaceCbBand: 'YCbCrSpaceCbBand'
    readonly YCbCrSpaceCrBand: 'YCbCrSpaceCrBand'
  }
  /** `readPixels({ resampling })`, `reprojectImage`, `warp`. Note `NearestNeighbour`. */
  readonly Resampling: {
    readonly NearestNeighbour: 'nearestneighbour'
    readonly Bilinear: 'bilinear'
    readonly Cubic: 'cubic'
    readonly CubicSpline: 'cubicspline'
    readonly Lanczos: 'lanczos'
    readonly Average: 'average'
    readonly Mode: 'mode'
    readonly Gauss: 'gauss'
  }
  /** `buildOverviews({ resampling })`. Note `Nearest`, and `None` deletes the pyramid. */
  readonly OverviewResampling: {
    readonly Nearest: 'nearest'
    readonly Average: 'average'
    readonly Rms: 'rms'
    readonly Gauss: 'gauss'
    readonly Bilinear: 'bilinear'
    readonly Cubic: 'cubic'
    readonly CubicSpline: 'cubicspline'
    readonly Lanczos: 'lanczos'
    readonly AverageMagphase: 'average_magphase'
    readonly Mode: 'mode'
    readonly None: 'none'
  }
  /** `executeSql(sql, dialect)`. */
  readonly SqlDialect: {
    readonly OGRSQL: 'OGRSQL'
    readonly SQLITE: 'SQLITE'
  }
}

declare const constants: GdalConstants

export { constants as const }

/**
 * A cursor pages a layer, and the natural way to read a paged source is
 *
 * ```js
 * for await (const feature of layer.openCursor()) { … }
 * ```
 *
 * The iterator is added by the shell (`index.js`) rather than generated, because
 * napi cannot put `Symbol.asyncIterator` on a `#[napi]` class — its
 * `AsyncGenerator` support is unreachable from a dependent crate. So the
 * declaration is hand-written here, alongside the other hand-written exports. It
 * yields feature records, one at a time; `read()` is still the batch-at-a-time
 * call, and `readSync()` the blocking one.
 */
declare module './binding' {
  interface FeatureCursor {
    [Symbol.asyncIterator](): AsyncIterator<FeatureRecord>
  }
}
