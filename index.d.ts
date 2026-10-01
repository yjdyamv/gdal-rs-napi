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

  /**
   * Raster streams, also added by the shell — napi cannot hand back a Node
   * `Readable` or `Writable` from a `#[napi]` class either. Reading yields the band's
   * own bytes a strip at a time; writing consumes them the same way.
   */
  interface RasterBand {
    createReadStream(options?: RasterStreamOptions): import('node:stream').Readable
    createWriteStream(options?: RasterStreamOptions): import('node:stream').Writable
  }
}

/**
 * The window and strip a raster stream works on. Every field is optional: the whole
 * band, in strips the height of its own block.
 */
export interface RasterStreamOptions {
  x?: number
  y?: number
  width?: number
  height?: number
  rows?: number
  /**
   * The typed array the reads come back as — a constructor (`Float64Array`) or a
   * sample type name (`'Float64'`). Default: the band's own type.
   */
  type?: ((length: number) => ArrayBufferView) | string
  /**
   * Read the band's missing value as `NaN` (reading), and `NaN` as the missing value
   * (writing). Needs a float type to have somewhere to put the `NaN`: on an integer
   * one a missing sample is `0`, as it is without this.
   */
  convertNoData?: boolean
}

/** How a `RasterMuxStream` pairs its inputs up. */
export interface RasterMuxStreamOptions {
  /**
   * Hand a buffered chunk straight through when it is exactly the length being
   * published. Default `true`; `false` always joins into a fresh array.
   */
  blockOptimize?: boolean
}

/**
 * Reads several raster read streams as one, in lockstep — the input half of
 * `calcAsync`, useful on its own when the transformation is not arithmetic.
 *
 * Each chunk out is `{ [name]: TypedArray }`, every array the same length: the
 * smallest amount all the inputs have buffered. Inputs that end at different lengths
 * destroy the stream with an error rather than answering short.
 */
export declare class RasterMuxStream extends import('node:stream').Readable {
  constructor(
    inputs: Record<string, import('node:stream').Readable>,
    options?: RasterMuxStreamOptions,
  )
}

/** What a `RasterTransform` applies, and as what. */
export interface RasterTransformOptions {
  /** Called once per pixel, with one argument per input, in the order they came in. */
  fn: (...pixels: number[]) => number
  /** The typed array to write into — a constructor, or a sample type name. */
  type?: ((length: number) => ArrayBufferView) | string
}

/**
 * Applies `fn` to every pixel of a `RasterMuxStream` chunk, one typed array out per
 * object in. `fn` runs on the JS thread, so this is the expensive half by definition.
 */
export declare class RasterTransform extends import('node:stream').Transform {
  constructor(options: RasterTransformOptions)
}

/** Options for `calcAsync` — the semantics are `gdal_calc.py`'s. */
export interface CalcOptions {
  /**
   * Read the inputs' missing values as `NaN`, and write the `NaN`s back as the
   * output band's missing value. The output band needs one set for the second half.
   */
  convertNoData?: boolean
  /**
   * Convert the inputs to the output's sample type before `fn` sees them. What an
   * integer output needs for `convertNoData` to have anywhere to put a `NaN`.
   */
  convertInput?: boolean
  /** Called with the fraction done, from 0 to 1. Returning nothing is all it does. */
  onProgress?: (progress: number) => void
}

/**
 * Computes an output band as a pixel-wise function of several input bands — the
 * `gdal_calc.py` idea, with a JS function rather than an expression string.
 *
 * ```js
 * await gdal.calcAsync(
 *   { t: temperature, td: dewpoint },
 *   output.band(0),
 *   (t, td) => 125 * (t - td),
 *   { convertNoData: true },
 * )
 * ```
 *
 * Every band has to be the output's size, and `fn` takes one argument per input, in
 * the order given. `fn` runs on the JS thread, once per pixel; the reading and the
 * writing are what goes through the streams.
 */
export declare function calcAsync(
  inputs: Record<string, import('./binding').RasterBand>,
  output: import('./binding').RasterBand,
  fn: (...pixels: number[]) => number,
  options?: CalcOptions,
): Promise<void>
