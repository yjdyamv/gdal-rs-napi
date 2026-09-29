'use strict'

// The napi CLI generates `binding.js` / `binding.d.ts` and the platform packages
// only ever contain the `.node` binary — extra runtime data has to live in the
// root package. So this shell exists purely to point PROJ/GDAL at the data files
// shipped under `assets/` before handing over to the generated binding.
const path = require('node:path')
const binding = require('./binding.js')
const asyncMethods = require('./async-methods.js')

binding.configureDataPaths({
  proj: process.env.PROJ_DATA || path.join(__dirname, 'assets', 'proj'),
  gdal: process.env.GDAL_DATA || path.join(__dirname, 'assets', 'gdal'),
})

// `gdal.const` freezes the string vocabularies the binding already reads and
// writes, so `fieldType: gdal.const.FieldType.Integer64` and the literal
// `'Integer64'` are the same request and a typo stops being a runtime surprise.
//
// These are strings, not GDAL's numeric enum codes. The surface returns and
// accepts names (`band.dataType === 'Float32'`, `resampling: 'average'`), so a
// numeric constant would be a second vocabulary this API neither returns nor
// accepts — the opposite of the stability this is for. The codes belong to the
// `gdal-async` compatibility layer, where that shape is the target.
//
// A constant table needs nothing from GDAL, so it lives here rather than
// crossing the FFI boundary. `__test__/const.test.mjs` asserts each value is the
// spelling the runtime actually uses, so the two cannot drift.
//
// Two resampling vocabularies exist because GDAL has two: a pixel read (and a
// warp) takes `Resampling`, where nearest is `nearestneighbour`, while building
// overviews takes `OverviewResampling`, where it is `nearest` and `rms` and
// `none` exist. `none` is not a kernel — it is how a pyramid is deleted.
const freeze = (vocabulary) => Object.freeze(vocabulary)

binding.const = Object.freeze({
  DataType: freeze({
    Unknown: 'Unknown',
    Uint8: 'Uint8',
    Int8: 'Int8',
    Uint16: 'Uint16',
    Int16: 'Int16',
    Uint32: 'Uint32',
    Int32: 'Int32',
    Uint64: 'Uint64',
    Int64: 'Int64',
    Float32: 'Float32',
    Float64: 'Float64',
  }),
  FieldType: freeze({
    Integer: 'Integer',
    IntegerList: 'IntegerList',
    Integer64: 'Integer64',
    Integer64List: 'Integer64List',
    Real: 'Real',
    RealList: 'RealList',
    String: 'String',
    StringList: 'StringList',
    WideString: 'WideString',
    WideStringList: 'WideStringList',
    Binary: 'Binary',
    Date: 'Date',
    Time: 'Time',
    DateTime: 'DateTime',
  }),
  Justification: freeze({ Undefined: 'Undefined', Left: 'Left', Right: 'Right' }),
  GeometryType: freeze({
    Unknown: 'Unknown',
    None: 'None',
    Point: 'Point',
    LineString: 'LineString',
    Polygon: 'Polygon',
    MultiPoint: 'MultiPoint',
    MultiLineString: 'MultiLineString',
    MultiPolygon: 'MultiPolygon',
    GeometryCollection: 'GeometryCollection',
  }),
  ColorInterpretation: freeze({
    Undefined: 'Undefined',
    GrayIndex: 'GrayIndex',
    PaletteIndex: 'PaletteIndex',
    RedBand: 'RedBand',
    GreenBand: 'GreenBand',
    BlueBand: 'BlueBand',
    AlphaBand: 'AlphaBand',
    HueBand: 'HueBand',
    SaturationBand: 'SaturationBand',
    LightnessBand: 'LightnessBand',
    CyanBand: 'CyanBand',
    MagentaBand: 'MagentaBand',
    YellowBand: 'YellowBand',
    BlackBand: 'BlackBand',
    YCbCrSpaceYBand: 'YCbCrSpaceYBand',
    YCbCrSpaceCbBand: 'YCbCrSpaceCbBand',
    YCbCrSpaceCrBand: 'YCbCrSpaceCrBand',
  }),
  Resampling: freeze({
    NearestNeighbour: 'nearestneighbour',
    Bilinear: 'bilinear',
    Cubic: 'cubic',
    CubicSpline: 'cubicspline',
    Lanczos: 'lanczos',
    Average: 'average',
    Mode: 'mode',
    Gauss: 'gauss',
  }),
  OverviewResampling: freeze({
    Nearest: 'nearest',
    Average: 'average',
    Rms: 'rms',
    Gauss: 'gauss',
    Bilinear: 'bilinear',
    Cubic: 'cubic',
    CubicSpline: 'cubicspline',
    Lanczos: 'lanczos',
    AverageMagphase: 'average_magphase',
    Mode: 'mode',
    None: 'none',
  }),
  SqlDialect: freeze({ OGRSQL: 'OGRSQL', SQLITE: 'SQLITE' }),
})

// An async failure carries no `err.code`: napi pins a `Task`'s error type to
// `Status`, so the binding puts its stable token at the *front of the message*
// instead — `[GDAL_CPL_FAILURE] ...`. Turn that prefix back into a field, so the
// async surface offers the same token the sync one does and a caller can branch
// on either without matching text. The prefix stays in the message, so nothing
// that already matched on it breaks.
//
// `async-methods.js` is the list of what to wrap, and a test checks it against
// the generated declarations, so a new async method cannot go uncovered.
const CODE_PREFIX = /^\[([A-Z][A-Z0-9_]*)\]\s+/

function withCode(promise) {
  return promise.catch((error) => {
    // napi already sets a `code` on a rejected `Task` — the *status* name, which
    // is always `GenericFailure`, since a `Task`'s error type is fixed. So a
    // prefix is what says "this one has a real token", and it wins.
    const match = error instanceof Error ? CODE_PREFIX.exec(error.message) : null
    if (match) error.code = match[1]
    throw error
  })
}

function wrapFunction(name) {
  const original = binding[name]
  if (typeof original !== 'function') {
    throw new Error(`async-methods.js lists ${name}, but the binding does not export it`)
  }
  binding[name] = function (...args) {
    return withCode(original.apply(this, args))
  }
}

function wrapMethod(className, name) {
  const klass = binding[className]
  const descriptor = klass && Object.getOwnPropertyDescriptor(klass.prototype, name)
  if (!descriptor || typeof descriptor.value !== 'function') {
    throw new Error(`async-methods.js lists ${className}.${name}, but the binding does not have it`)
  }
  Object.defineProperty(klass.prototype, name, {
    ...descriptor,
    value: function (...args) {
      return withCode(descriptor.value.apply(this, args))
    },
  })
}

for (const name of asyncMethods.functions) wrapFunction(name)
for (const [className, names] of Object.entries(asyncMethods.methods)) {
  for (const name of names) wrapMethod(className, name)
}

// `for await (const feature of layer.openCursor())` — the natural way to read a
// paged source. napi cannot put `Symbol.asyncIterator` on a generated class (its
// `AsyncGenerator` support is unreachable from a dependent crate), so the shell
// adds it, over the same `read()` a manual loop already calls and stopping on an
// empty batch the same way that loop does. Each yielded item is one feature
// record, not a batch.
binding.FeatureCursor.prototype[Symbol.asyncIterator] = async function* () {
  for (;;) {
    const batch = await this.read()
    if (batch.length === 0) return
    yield* batch
  }
}

module.exports = binding
