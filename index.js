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
  if (!descriptor) {
    throw new Error(`async-methods.js lists ${className}.${name}, but the binding does not have it`)
  }
  if (typeof descriptor.value === 'function') {
    Object.defineProperty(klass.prototype, name, {
      ...descriptor,
      value: function (...args) {
        return withCode(descriptor.value.apply(this, args))
      },
    })
    return
  }
  // The `xxxAsync` halves of the getters are getters themselves — a property that
  // hands back a promise, rather than a call that returns one — so there is nothing
  // to forward arguments to.
  if (typeof descriptor.get === 'function') {
    Object.defineProperty(klass.prototype, name, {
      ...descriptor,
      get() {
        return withCode(descriptor.get.call(this))
      },
    })
    return
  }
  throw new Error(`${className}.${name} is neither a method nor a getter`)
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

// Raster streams, and the pixel-wise layer built on them. napi cannot hand back a
// Node `Readable` / `Writable` from a `#[napi]` class, so — like the cursor's
// iterator above — they are built here over the native reads and writes.
//
// A chunk is a **typed array of the band's own sample type**, in object mode, which
// is the shape gdal-async's streams have and what makes `RasterMuxStream`,
// `RasterTransform` and `calcAsync` below possible. `rows` is the strip size and
// defaults to the band's block height, the strip GDAL reads anyway.
const { Readable, Transform, Writable } = require('node:stream')

/** Every sample type this binding has, as the typed array JS reads it as. */
const RASTER_TYPES = new Map([
  ['Uint8', Uint8Array],
  ['Int8', Int8Array],
  ['Uint16', Uint16Array],
  ['Int16', Int16Array],
  ['Uint32', Uint32Array],
  ['Int32', Int32Array],
  ['Uint64', BigUint64Array],
  ['Int64', BigInt64Array],
  ['Float32', Float32Array],
  ['Float64', Float64Array],
])

const RASTER_TYPE_NAMES = new Map([...RASTER_TYPES].map(([name, ctor]) => [ctor, name]))

/** The typed-array constructor a sample type is read and written as. */
function rasterTypeFor(dataType) {
  const ctor = RASTER_TYPES.get(dataType)
  if (!ctor) throw new Error(`no typed array for the ${dataType} sample type`)
  return ctor
}

/**
 * The constructor and sample type a stream's `type` names: a constructor (which is
 * how gdal-async spells it), a sample type name, or nothing for the band's own.
 */
function rasterStreamType(band, type) {
  if (type === undefined || type === null) {
    return { ctor: rasterTypeFor(band.dataType), dataType: band.dataType }
  }
  if (typeof type === 'string') return { ctor: rasterTypeFor(type), dataType: type }
  const dataType = RASTER_TYPE_NAMES.get(type)
  if (!dataType) {
    throw new TypeError('type must be a typed array constructor, or a sample type name')
  }
  return { ctor: type, dataType }
}

/**
 * The bytes napi handed back, as a typed array. The copy is not optional: a Buffer's
 * backing store is not aligned for a 2-, 4- or 8-byte view, and
 * `new Float64Array(bytes.buffer, bytes.byteOffset)` throws on one that is not.
 */
function rasterValues(bytes, ctor) {
  const copy = Uint8Array.from(bytes)
  if (ctor === Uint8Array) return copy
  return new ctor(copy.buffer, copy.byteOffset, copy.byteLength / ctor.BYTES_PER_ELEMENT)
}

/** A chunk as the band's own bytes, converting value by value when it is not. */
function rasterBytesFor(chunk, dataType) {
  const ctor = rasterTypeFor(dataType)
  const values = chunk instanceof ctor ? chunk : ctor.from(chunk)
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength)
}

/** A chunk with every `NaN` replaced by the band's missing value. */
function rasterWithoutNaN(chunk, noData) {
  const values = Float64Array.from(chunk)
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) values[i] = noData
  }
  return values
}

/** The window and strip a raster stream works on: the whole band by default. */
function rasterStreamWindow(band, options) {
  const [bandWidth, bandHeight] = band.size
  const [, blockHeight] = band.blockSize
  const x = options.x ?? 0
  const y = options.y ?? 0
  const width = options.width ?? bandWidth - x
  const height = options.height ?? bandHeight - y
  const rows = options.rows ?? blockHeight
  return { x, y, width, height, rows }
}

binding.RasterBand.prototype.createReadStream = function createReadStream(options = {}) {
  const band = this
  const { x, y, width, height, rows } = rasterStreamWindow(band, options)
  const { ctor, dataType } = rasterStreamType(band, options.type)
  const own = dataType === band.dataType
  // `convertNoData` needs a float array to have somewhere to put the NaN; on an
  // integer one the missing samples come back as 0 instead.
  const noData = options.convertNoData ? band.noDataValue : null
  let next = y
  return new Readable({
    objectMode: true,
    read() {
      if (next >= y + height) {
        this.push(null)
        return
      }
      const strip = Math.min(rows, y + height - next)
      try {
        const bytes = own
          ? band.readValues(x, next, width, strip)
          : band.readAsSync(dataType, { x, y: next, width, height: strip })
        const values = rasterValues(bytes, ctor)
        if (noData !== null) {
          for (let i = 0; i < values.length; i++) {
            if (values[i] === noData) values[i] = NaN
          }
        }
        next += strip
        this.push(values)
      } catch (error) {
        this.destroy(error)
      }
    },
  })
}

binding.RasterBand.prototype.createWriteStream = function createWriteStream(options = {}) {
  const band = this
  const { x, y, width, height, rows } = rasterStreamWindow(band, options)
  const rowBytes = width * binding.bytesPerSample(band.dataType)
  if (!(rowBytes > 0) || !(rows > 0)) {
    throw new Error('a raster write stream needs a width and a strip of at least one row')
  }
  const noData = options.convertNoData ? band.noDataValue : null
  const stripBytes = rowBytes * rows
  let pending = Buffer.alloc(0)
  let next = y
  return new Writable({
    objectMode: true,
    write(chunk, _encoding, callback) {
      try {
        const values = noData === null ? chunk : rasterWithoutNaN(chunk, noData)
        const bytes = rasterBytesFor(values, band.dataType)
        // Copied, not aliased: a chunk the caller passes may be reused by them, and
        // `pending` can outlive this call.
        pending = pending.length === 0 ? Buffer.from(bytes) : Buffer.concat([pending, bytes])
        while (pending.length >= stripBytes && next < y + height) {
          const strip = Math.min(rows, y + height - next)
          const stripByteCount = rowBytes * strip
          band.writeValues(x, next, width, strip, pending.subarray(0, stripByteCount))
          pending = pending.subarray(stripByteCount)
          next += strip
        }
        if (pending.length > 0 && next >= y + height) {
          // The window is full: anything left would be dropped, so it is refused.
          callback(new Error('a raster write stream cannot write past its window'))
          return
        }
        callback()
      } catch (error) {
        callback(error)
      }
    },
    final(callback) {
      try {
        if (pending.length > 0) {
          if (pending.length % rowBytes !== 0) {
            throw new Error(
              `a raster stream writes whole rows: ${pending.length} bytes left over for rows of ${rowBytes}`,
            )
          }
          const strip = pending.length / rowBytes
          band.writeValues(x, next, width, strip, pending)
          next += strip
        }
        callback()
      } catch (error) {
        callback(error)
      }
    },
  })
}

/**
 * Reads several raster read streams as one, in lockstep.
 *
 * The inputs are the object-mode streams `band.createReadStream()` hands back, keyed
 * by whatever name the pixel function knows them by. A chunk out is
 * `{ [name]: TypedArray }`, every array the same length: the smallest amount all the
 * inputs have buffered, which is what keeps the pixels in step. A chunk that is
 * exactly that length is passed through untouched (unless `blockOptimize` is `false`);
 * otherwise the pieces are joined, and a partly-consumed one is carried over.
 *
 * Inputs that end at different lengths are a mistake rather than a short answer, so
 * they destroy the stream with an error.
 */
class RasterMuxStream extends Readable {
  constructor(inputs, options = {}) {
    super({ ...options, objectMode: true })
    this.ids = Object.keys(inputs ?? {})
    if (this.ids.length === 0) {
      throw new TypeError('a RasterMuxStream needs at least one input')
    }
    this.blockOptimize = options.blockOptimize !== false
    this.inputs = {}
    this.queues = {}
    this.buffered = {}
    this.ended = new Set()
    this.handlers = {}
    this.flowing = true
    for (const id of this.ids) {
      const input = inputs[id]
      if (!(input instanceof Readable) || !input.readableObjectMode) {
        throw new TypeError('every input has to be an object-mode Readable')
      }
      this.inputs[id] = input
      this.queues[id] = []
      this.buffered[id] = 0
      this.handlers[id] = {
        data: (chunk) => this.received(id, chunk),
        end: () => this.inputEnded(id),
        error: (error) => this.destroy(error),
      }
      input.pause()
      input.on('data', this.handlers[id].data)
      input.on('end', this.handlers[id].end)
      input.on('error', this.handlers[id].error)
    }
  }

  /** How much every input has ready — the length of the next chunk out. */
  ready() {
    return Math.min(...this.ids.map((id) => this.buffered[id]))
  }

  received(id, chunk) {
    if (this.destroyed) return
    if (!ArrayBuffer.isView(chunk)) {
      this.destroy(new TypeError(`input ${id} has to emit typed arrays`))
      return
    }
    this.queues[id].push(chunk)
    this.buffered[id] += chunk.length
    this.drain()
  }

  /** Take `count` elements off one input's queue, joining pieces when it has to. */
  take(id, count) {
    const queue = this.queues[id]
    if (this.blockOptimize && queue[0].length === count) {
      this.buffered[id] -= count
      return queue.shift()
    }
    const joined = new queue[0].constructor(count)
    let filled = 0
    while (filled < count) {
      const head = queue[0]
      const take = Math.min(head.length, count - filled)
      joined.set(take === head.length ? head : head.subarray(0, take), filled)
      if (take === head.length) queue.shift()
      else queue[0] = head.subarray(take)
      filled += take
    }
    this.buffered[id] -= count
    return joined
  }

  drain() {
    if (this.destroyed || this.endedAll) return
    while (this.flowing) {
      const ready = this.ready()
      if (ready === 0) break
      const chunk = {}
      for (const id of this.ids) chunk[id] = this.take(id, ready)
      this.flowing = this.push(chunk)
    }
    this.settle()
  }

  /**
   * End once every input has, or refuse the ones that did not line up. Waiting for all
   * of them is what makes the answer certain: while one is still running, what is
   * buffered on another may yet be paired.
   */
  settle() {
    if (this.destroyed || this.endedAll) return
    if (this.ended.size < this.ids.length) return
    const left = Math.max(...this.ids.map((id) => this.buffered[id]))
    if (left > 0) {
      this.destroy(new Error('the inputs ended at different lengths'))
      return
    }
    this.endedAll = true
    this.push(null)
    for (const id of this.ids) {
      this.inputs[id].off('data', this.handlers[id].data)
      this.inputs[id].off('end', this.handlers[id].end)
    }
  }

  inputEnded(id) {
    this.ended.add(id)
    this.drain()
  }

  /** Backpressure: everything stops while a chunk is waiting, and starts again. */
  throttle() {
    for (const id of this.ids) {
      if (this.flowing) this.inputs[id].resume()
      else this.inputs[id].pause()
    }
  }

  _read() {
    this.flowing = true
    this.throttle()
    this.drain()
    this.throttle()
  }
}

/**
 * Applies a function to every pixel of a `RasterMuxStream` chunk — the elementwise
 * half of `calcAsync`, for when the arithmetic is not the whole job.
 *
 * Input chunks are `{ [name]: TypedArray }` and the output is one typed array of
 * `type`, so `fn` is called once per pixel with one argument per input, in the order
 * the keys came in. It runs on the JS thread, so it is the expensive part by
 * definition; keep it arithmetic.
 */
class RasterTransform extends Transform {
  constructor(options = {}) {
    super({ ...options, objectMode: true })
    if (typeof options.fn !== 'function') {
      throw new TypeError('a RasterTransform needs a fn')
    }
    this.fn = options.fn
    this.type =
      typeof options.type === 'string' ? rasterTypeFor(options.type) : (options.type ?? Float64Array)
    if (typeof this.type !== 'function') {
      throw new TypeError('type has to be a typed array constructor')
    }
  }

  _transform(chunk, _encoding, callback) {
    const ids = Object.keys(chunk)
    const length = chunk[ids[0]].length
    const out = new this.type(length)
    // One reusable argument array rather than a freshly built one per pixel, and no
    // generated code: the keys come from the caller, and `new Function` on them
    // would be an injection as much as a shortcut.
    const args = new Array(ids.length)
    try {
      for (let i = 0; i < length; i++) {
        for (let k = 0; k < ids.length; k++) args[k] = chunk[ids[k]][i]
        out[i] = this.fn(...args)
      }
      callback(null, out)
    } catch (error) {
      callback(error)
    }
  }
}

/**
 * Computes an output band as a pixel-wise function of several input bands — the
 * `gdal_calc.py` idea, with a JS function instead of an expression string.
 *
 * ```js
 * const output = gdal.createSync('base.tif', { width, height, dataType: 'Float64' })
 * await gdal.calcAsync(
 *   { t: temperature, td: dewpoint },
 *   output.band(0),
 *   (t, td) => 125 * (t - td),
 *   { convertNoData: true },
 * )
 * ```
 *
 * Every band has to be the same size, and `fn` takes one argument per input, in the
 * order they were given. The pixels are read and written as `output.dataType`, so
 * `convertInput` decides whether the *inputs* are converted to it first — which is
 * what an integer output needs to have a `NaN` to put a missing sample in.
 *
 * `fn` runs on the JS thread, one call per pixel: it is the bottleneck and nothing
 * here can change that. What is off the event loop is the reading and the writing.
 */
async function calcAsync(inputs, output, fn, options = {}) {
  if (typeof fn !== 'function') throw new TypeError('fn has to be a function')
  if (!(output instanceof binding.RasterBand)) {
    throw new TypeError('output has to be a RasterBand')
  }
  const ids = Object.keys(inputs ?? {})
  if (ids.length === 0) throw new TypeError('calcAsync needs at least one input band')
  for (const id of ids) {
    if (!(inputs[id] instanceof binding.RasterBand)) {
      throw new TypeError('every input has to be a RasterBand')
    }
  }
  const onProgress = options.onProgress
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new TypeError('onProgress has to be a function')
  }

  const [width, height] = output.size
  for (const id of ids) {
    const [inputWidth, inputHeight] = inputs[id].size
    if (inputWidth !== width || inputHeight !== height) {
      throw new RangeError('every band has to be the same size as the output')
    }
  }

  const convertNoData = options.convertNoData ?? false
  const convertInput = options.convertInput ?? false
  const streams = {}
  for (const id of ids) {
    streams[id] = inputs[id].createReadStream({
      convertNoData,
      type: convertInput ? output.dataType : undefined,
    })
  }

  const mux = new RasterMuxStream(streams)
  const transform = new RasterTransform({ type: rasterTypeFor(output.dataType), fn })
  const out = output.createWriteStream({ convertNoData })
  const total = width * height
  let processed = 0

  return new Promise((resolve, reject) => {
    const stop = (error) => {
      mux.destroy()
      transform.destroy()
      out.destroy()
      reject(error)
    }
    mux.on('error', reject)
    transform.on('error', reject)
    out.on('error', reject)
    out.on('finish', resolve)
    if (onProgress) {
      mux.on('data', (chunk) => {
        processed += chunk[ids[0]].length
        try {
          onProgress(processed / total)
        } catch (error) {
          stop(error)
        }
      })
    }
    mux.pipe(transform).pipe(out)
  })
}

// ---- VRT pixel functions -------------------------------------------------
//
// A derived VRT band computes its pixels from its sources through a function GDAL
// calls while it reads. `addPixelFunc` gives it one written in JavaScript.
//
// The trampoline is in Rust (`src/pixel_func.rs`) and needs no looking at here,
// except for one thing: GDAL calls back with a bare function pointer and no name, so
// each registration owns a *slot* in a fixed pool, and the slot is all the trampoline
// knows. The function itself lives in this map, and the global below is what the
// trampoline calls to reach it.

/** slot → the function registered there. */
const pixelFuncs = new Map()
/** name → slot, so a name cannot be taken twice. */
const pixelFuncSlots = new Map()

/**
 * What the Rust trampoline calls. Not part of the API: it is reached by property name
 * from C, which is why it is a global rather than a local.
 */
globalThis.__gdalRsNapiPixelFunc = function pixelFuncDispatch(slot, sources, buffer, args) {
  const fn = pixelFuncs.get(slot)
  if (!fn) throw new Error(`no pixel function is registered in slot ${slot}`)
  fn(sources, buffer, args)
}

/**
 * Register `fn` with GDAL under `name`, so a VRT whose `<PixelFunctionType>` is
 * `name` computes its pixels with it.
 *
 * `fn` has GDAL's own shape — `(sources, buffer, args)`, where `sources` is an array
 * of typed arrays, one per source band, `buffer` is the output band's array and
 * `args` is the VRT's `<PixelFunctionArguments>` as strings. Writing into `buffer`
 * is what the band reads back. `createPixelFunc` is the friendlier way to get one.
 *
 * GDAL cannot unregister a pixel function, so a name and its slot last for the life
 * of the process, and there are 32 of them.
 */
function addPixelFunc(name, fn) {
  if (typeof name !== 'string' || name === '') {
    throw new TypeError('a pixel function needs a name')
  }
  if (typeof fn !== 'function') {
    throw new TypeError('a pixel function has to be a function')
  }
  if (pixelFuncSlots.has(name)) {
    throw new Error(`a pixel function called ${name} is already registered`)
  }
  const slot = binding.registerPixelFunc(name)
  pixelFuncs.set(slot, fn)
  pixelFuncSlots.set(name, slot)
  return name
}

/**
 * A function in the shape `addPixelFunc` takes. A JavaScript function already is one
 * — this validates it, and is the name `createPixelFunc` is built on.
 */
function toPixelFunc(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('a pixel function has to be a function')
  }
  return fn
}

/** The JavaScript values of one pixel, one per source, in order. */
function pixelArguments(sources, index, into) {
  for (let k = 0; k < sources.length; k++) into[k] = sources[k][index]
  return into
}

/**
 * A pixel function from a function of *one pixel*: `fn` is called with one argument
 * per source band, in the order they were given to `wrapVRT`, and what it returns is
 * written into the output band.
 *
 * The values are whatever the arrays hold — the sources are read as the band's own
 * sample type unless the VRT asks for another — so `fn` sees numbers.
 */
function createPixelFunc(fn) {
  if (typeof fn !== 'function') throw new TypeError('createPixelFunc needs a function')
  return function pixelFunc(sources, buffer) {
    const args = new Array(sources.length)
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] = fn(...pixelArguments(sources, i, args))
    }
  }
}

/**
 * The same, with the VRT's `<PixelFunctionArguments>` passed first:
 * `(args, a, b) => args.k * (a + b)`. GDAL hands those over as strings, so a number
 * has to be converted.
 */
function createPixelFuncWithArgs(fn) {
  if (typeof fn !== 'function') throw new TypeError('createPixelFuncWithArgs needs a function')
  return function pixelFunc(sources, buffer, args) {
    const values = new Array(sources.length)
    const staticArgs = args ?? {}
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] = fn(staticArgs, ...pixelArguments(sources, i, values))
    }
  }
}

/**
 * GDAL's spelling of a sample type for the VRT vocabulary. Its XML predates this
 * binding's names for the same four types, so `Uint8` has to be written `Byte`, and a
 * VRT that says `Uint8` is refused outright.
 */
const VRT_TYPES = new Map([
  ['Uint8', 'Byte'],
  ['Uint16', 'UInt16'],
  ['Uint32', 'UInt32'],
  ['Uint64', 'UInt64'],
])

function vrtType(dataType) {
  return VRT_TYPES.get(dataType) ?? dataType
}

/** Text or attribute for XML: the five characters that cannot stand as themselves. */
function xmlEscape(value, attribute = false) {
  const text = String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return attribute ? text.replace(/"/g, '&quot;') : text
}

function xmlElement(name, attributes, children) {
  const written = Object.entries(attributes ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ` ${key}="${xmlEscape(value, true)}"`)
    .join('')
  if (children === undefined) return `<${name}${written}/>`
  return `<${name}${written}>${children}</${name}>`
}

function xmlText(name, value) {
  return xmlElement(name, undefined, xmlEscape(value))
}

function xmlMetadata(metadata) {
  const keys = Object.keys(metadata ?? {})
  if (keys.length === 0) return ''
  return xmlElement(
    'Metadata',
    undefined,
    keys.map((key) => xmlElement('MDI', { key }, xmlEscape(metadata[key]))).join(''),
  )
}

/** The path a VRT has to name to read a source band back. */
function sourcePath(dataset) {
  const files = dataset.getFileList()
  const path = files.length > 0 ? files[0] : dataset.path
  // Forward slashes: a VRT is read by GDAL's own XML parser, and a Windows path's
  // backslashes do not survive it intact.
  return path.replaceAll('\\', '/')
}

/**
 * Writes a VRT dataset that reads `desc.bands` from their sources, applying a pixel
 * function to each band that names one.
 *
 * ```js
 * gdal.addPixelFunc('espy', gdal.createPixelFunc((t, td) => 125 * (t - td)))
 * const dataset = gdal.openSync(gdal.wrapVRT({
 *   bands: [{ sources: [temperature, dewpoint], pixelFunc: 'espy' }],
 * }))
 * ```
 *
 * Returns the VRT as XML text, which is a dataset name GDAL understands — that is
 * what gdal-async returns too, and it means nothing is written to disk. The pixel
 * function may be one of GDAL's own (`inv`, `sum`, `diff`, `mul`, …) or one this
 * process registered.
 *
 * Every source band has to be from a dataset that can be read back by path.
 */
function wrapVRT(descriptor) {
  const bands = descriptor?.bands
  if (!Array.isArray(bands) || bands.length === 0) {
    throw new TypeError('a VRT descriptor needs a bands array')
  }
  const first = bands[0]?.sources?.[0]
  if (!first?.dataset) {
    throw new TypeError('every band needs at least one source RasterBand')
  }

  const frame = first.dataset
  // `Dataset.rasterSize` is `{ width, height }`; a band's own `size` is an array.
  const { width, height } = frame.rasterSize
  const root = []
  const srs = frame.spatialRef
  if (srs) {
    root.push(xmlText('SRS', srs.authority ?? srs.wkt))
  }
  const geoTransform = frame.geoTransform
  if (geoTransform) {
    root.push(xmlText('GeoTransform', geoTransform.join(', ')))
  }
  const frameMetadata = xmlMetadata(frame.metadata())
  if (frameMetadata) root.push(frameMetadata)

  let index = 1
  for (const band of bands) {
    const sources = band?.sources
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new TypeError('every band needs at least one source RasterBand')
    }
    if (!band.pixelFunc && sources.length > 1) {
      throw new TypeError('a band with more than one source needs a pixel function to combine them')
    }
    const first = sources[0]
    const body = []
    const description = band.description ?? first.description
    if (description) body.push(xmlText('Description', description))
    if (band.pixelFunc) body.push(xmlText('PixelFunctionType', band.pixelFunc))
    if (band.pixelFuncArgs) body.push(xmlElement('PixelFunctionArguments', band.pixelFuncArgs))
    if (band.sourceTransferType) {
      body.push(xmlText('SourceTransferType', vrtType(band.sourceTransferType)))
    }
    const metadata = xmlMetadata(first.metadata())
    if (metadata) body.push(metadata)
    for (const source of sources) {
      // The source's whole extent onto the band's whole extent. GDAL can work this
      // out for itself, but saying it is what its own VRT writer does, and an
      // explicit rectangle leaves no room for a source to be read as covering
      // nothing.
      const [sourceWidth, sourceHeight] = source.size
      body.push(
        xmlElement('SimpleSource', undefined, [
          xmlElement('SourceFilename', { relativeToVRT: 0 }, xmlEscape(sourcePath(source.dataset))),
          xmlText('SourceBand', source.id),
          xmlElement('SrcRect', { xOff: 0, yOff: 0, xSize: sourceWidth, ySize: sourceHeight }),
          xmlElement('DstRect', { xOff: 0, yOff: 0, xSize: width, ySize: height }),
        ].join('')),
      )
    }
    root.push(
      xmlElement(
        'VRTRasterBand',
        {
          dataType: vrtType(band.dataType ?? first.dataType),
          band: index,
          subClass: band.pixelFunc ? 'VRTDerivedRasterBand' : undefined,
        },
        body.join(''),
      ),
    )
    index += 1
  }

  return `<?xml version="1.0"?>\n${xmlElement(
    'VRTDataset',
    { rasterXSize: width, rasterYSize: height },
    root.join(''),
  )}`
}

binding.addPixelFunc = addPixelFunc
binding.toPixelFunc = toPixelFunc
binding.createPixelFunc = createPixelFunc
binding.createPixelFuncWithArgs = createPixelFuncWithArgs
binding.wrapVRT = wrapVRT

binding.RasterMuxStream = RasterMuxStream
binding.RasterTransform = RasterTransform
binding.calcAsync = calcAsync

module.exports = binding
