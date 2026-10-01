'use strict'

// A `gdal-async`-shaped adapter over the native binding, so that a program
// written against the other library runs after changing one import:
//
//     const gdal = require('gdal-rs-napi/compat')
//
// It is pure JavaScript on purpose. None of this adds capability — the native
// API has all of it — and the native API keeps its own conventions (0-based,
// `xxxSync()` / `xxx()`, `setX()`). What is translated here is exactly the three
// conventions that are load-bearing, plus the object shapes a port expects:
//
//   * **1-based indexing.** gdal-async counts bands, layers and fields from 1.
//     Every collection here rebases, and `get(n)` takes the gdal-async number.
//   * **`xxx()` blocking, `xxxAsync()` async.** The native binding spells those
//     `xxxSync()` and `xxx()`. Here `xxx()` blocks, as gdal-async's does, and
//     `xxxAsync()` returns a promise — or takes a node-style callback if one is
//     passed, which is gdal-async's second form.
//   * **Assignment for setters.** `band.noDataValue = x`, `dataset.geoTransform
//     = [...]`, `dataset.srs = srs`, where native spells them `setNoDataValue`,
//     `setGeoTransform`, `setProjection`.
//
// Coverage is a subset, and honestly so — see `PHASE1.md` (WS-7) for what is in the
// native binding but not reshaped here (the raster streams, `calcAsync`, the pixel
// functions, and the command-line programs and their `translate`/`warp` family). The
// test suite in `__test__/compat*.test.mjs` is what claims what works.

const native = require('../index.js')

// ---------------------------------------------------------------------------
// Conventions

/** gdal-async's two call shapes: a promise, or an err-first callback. */
function withCallback(promise, callback) {
  if (typeof callback === 'function') {
    promise.then(
      (value) => callback(null, value),
      (error) => callback(error),
    )
    return undefined
  }
  return promise
}

/** The trailing argument, when it is a callback. */
function takeCallback(args) {
  const last = args[args.length - 1]
  if (typeof last === 'function') {
    args.pop()
    return last
  }
  return undefined
}

// ---------------------------------------------------------------------------
// GDAL's numeric sample-type codes
//
// gdal-async reports `band.dataType` as one of these numbers and exposes the
// constants. They are stable ABI, so they are written out rather than derived —
// this is the compatibility layer's job, and the native API's strings are the
// reason it is a translation rather than a pass-through.

const GDT = {
  GDT_Unknown: 0,
  GDT_Byte: 1,
  GDT_UInt16: 2,
  GDT_Int16: 3,
  GDT_UInt32: 4,
  GDT_Int32: 5,
  GDT_Float32: 6,
  GDT_Float64: 7,
  GDT_CInt16: 8,
  GDT_CInt32: 9,
  GDT_CFloat32: 10,
  GDT_CFloat64: 11,
  GDT_UInt64: 12,
  GDT_Int64: 13,
  GDT_Int8: 14,
}

const NAME_BY_CODE = {
  0: 'Unknown',
  1: 'Uint8',
  2: 'Uint16',
  3: 'Int16',
  4: 'Uint32',
  5: 'Int32',
  6: 'Float32',
  7: 'Float64',
  12: 'Uint64',
  13: 'Int64',
  14: 'Int8',
}

const CODE_BY_NAME = Object.fromEntries(
  Object.entries(NAME_BY_CODE).map(([code, name]) => [name, Number(code)]),
)

const TYPED_ARRAY_BY_CODE = {
  1: Uint8Array,
  2: Uint16Array,
  3: Int16Array,
  4: Uint32Array,
  5: Int32Array,
  6: Float32Array,
  7: Float64Array,
  12: BigUint64Array,
  13: BigInt64Array,
  14: Int8Array,
}

/**
 * A gdal-async data type — a code, or the `gdal.GDT_*` name — as the native string.
 *
 * GDAL spells four of them differently from this binding (`Byte` is `Uint8` here), and
 * the native API takes *this* binding's spelling, so a `GDT_*` name goes through the
 * code table rather than being passed along.
 */
function dataTypeName(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') {
    const name = NAME_BY_CODE[value]
    if (name === undefined) throw new Error(`unknown data type ${value}`)
    return name
  }
  const name = value.startsWith('GDT_') ? value.slice(4) : value
  if (CODE_BY_NAME[name] !== undefined) return name
  const code = GDT[`GDT_${name}`]
  if (code !== undefined && NAME_BY_CODE[code] !== undefined) return NAME_BY_CODE[code]
  return name
}

// ---------------------------------------------------------------------------
// Geometry
//
// gdal-async has a class per shape. The native binding has one `Geometry` whose
// accessors answer per shape, so the classes here are the native object wearing a
// different prototype: a `Point` *is* the native geometry, and `instanceof` holds
// because the prototype chain was swapped. That is the shape the compatibility
// layer exists to provide.

class Geometry {
  toWKT() {
    return this.toWkt()
  }

  toJSON() {
    return this.toJson()
  }

  toObject() {
    return this.toJson()
  }

  /** gdal-async calls it `getEnvelope`; native has `envelope()`. */
  getEnvelope() {
    const box = this.envelope()
    if (!box) return null
    return {
      minX: box.minX,
      minY: box.minY,
      maxX: box.maxX,
      maxY: box.maxY,
      // gdal-async's Envelope spells these the other way as well.
      minx: box.minX,
      miny: box.minY,
      maxx: box.maxX,
      maxy: box.maxY,
    }
  }

  /** gdal-async's `getArea` / `getLength`. */
  getArea() {
    return this.area()
  }

  getLength() {
    return this.length()
  }

  getGeometryType() {
    return this.type
  }
}

// Instances are native objects, so the native methods have to stay reachable
// underneath the adapter's.
Object.setPrototypeOf(Geometry.prototype, native.Geometry.prototype)

class Point extends Geometry {}
class LineString extends Geometry {}
class LinearRing extends Geometry {}
class Polygon extends Geometry {}
class MultiPoint extends Geometry {}
class MultiLineString extends Geometry {}
class MultiPolygon extends Geometry {}
class GeometryCollection extends Geometry {}

// gdal-async reports a `LinearRing` through `Polygon.rings`, not as a type of its
// own, so `LineString` is what a ring looks like from the outside.
const CLASS_BY_TYPE = {
  Point: Point,
  LineString: LineString,
  Polygon: Polygon,
  MultiPoint: MultiPoint,
  MultiLineString: MultiLineString,
  MultiPolygon: MultiPolygon,
  GeometryCollection: GeometryCollection,
}

/** Re-tag a native geometry as the class gdal-async would have handed back. */
function wrapGeometry(geometry) {
  if (!geometry) return null
  const klass = CLASS_BY_TYPE[geometry.type.replace(/ [ZM]+$/, '')] ?? Geometry
  Object.setPrototypeOf(geometry, klass.prototype)
  return geometry
}

const geometryFactories = {
  fromWKT: (wkt) => wrapGeometry(native.Geometry.fromWkt(wkt)),
  fromWKB: (wkb) => wrapGeometry(native.Geometry.fromWkb(wkb)),
  fromJSON: (json) => wrapGeometry(native.Geometry.fromJson(json)),
  fromObject: (json) => wrapGeometry(native.Geometry.fromJson(json)),
}

// ---------------------------------------------------------------------------
// SpatialReference

class SpatialReference {
  constructor(value) {
    if (value instanceof SpatialReference) {
      this._srs = value._srs
    } else if (typeof value === 'string') {
      this._srs = native.SpatialRef.fromDefinition(value)
    } else if (value && typeof value === 'object' && typeof value.wkt === 'string') {
      // A native `SpatialRef` already — `SpatialReference` wraps rather than copies.
      this._srs = value
    } else {
      throw new Error('a SpatialReference needs a WKT, PROJ or AUTHORITY:CODE string')
    }
  }

  clone() {
    return new SpatialReference(this._srs)
  }

  toWKT() {
    return this._srs.wkt
  }

  toProj4() {
    return this._srs.proj4
  }

  getName() {
    return this._srs.name
  }

  getAuthorityName() {
    return this._srs.authName
  }

  getAuthorityCode() {
    const code = this._srs.authCode
    return code === null || code === undefined ? null : String(code)
  }

  isSame(other) {
    return this._srs.equals(other instanceof SpatialReference ? other._srs : other)
  }
}

function wrapSrs(srs) {
  return srs ? new SpatialReference(srs) : null
}

// ---------------------------------------------------------------------------
// Feature fields

class FeatureFields {
  constructor(feature) {
    this._feature = feature
  }

  /** The native `Feature` object, which is where field reads and writes go. */
  _fields() {
    return this._feature._layer._native.getFeature(this._feature._fid).fields
  }

  get names() {
    return this._fields().names()
  }

  get count() {
    return this._fields().count()
  }

  get(name) {
    return this._fields().get(name)
  }

  set(name, value) {
    this._fields().set(name, value)
    return this
  }

  has(name) {
    return this._fields().has(name)
  }

  toObject() {
    return this._fields().toObject()
  }

  toArray() {
    return this._fields().toArray()
  }

  forEach(callback) {
    for (const name of this.names) callback(this.get(name), name)
  }

  [Symbol.iterator]() {
    return this.names[Symbol.iterator]()
  }
}

// ---------------------------------------------------------------------------
// Feature

class Feature {
  constructor(layer, fid) {
    this._layer = layer
    this._fid = fid
    this.fields = new FeatureFields(this)
  }

  get fid() {
    return this._fid
  }

  /** The feature, straight from the layer — gdal-async's objects are live too. */
  _record() {
    return this._layer._native.feature(this._fid)
  }

  get geometry() {
    const record = this._record()
    if (!record || record.geometry === null) return null
    return wrapGeometry(native.Geometry.fromJson(record.geometry))
  }

  set geometry(value) {
    this._layer._native.updateFeature(this._fid, value === null ? null : unwrapGeometry(value), null)
  }
}

function unwrapGeometry(geometry) {
  return geometry && typeof geometry.toJson === 'function' ? geometry.toJson() : geometry
}

// ---------------------------------------------------------------------------
// Collections
//
// gdal-async counts from 1 everywhere; `get` takes that number and `at` (native)
// takes the 0-based one.

class Collection {
  constructor(items) {
    this._items = items
  }

  count() {
    return this._items.length
  }

  forEach(callback) {
    this._items.forEach((item, index) => callback(item, index + 1))
  }

  [Symbol.iterator]() {
    return this._items[Symbol.iterator]()
  }
}

class DriverCollection extends Collection {
  constructor() {
    super(native.drivers().map((driver) => driver))
  }

  get(nameOrIndex) {
    if (typeof nameOrIndex === 'number') return this._items[nameOrIndex - 1] ?? null
    return this._items.find((driver) => driver.name === nameOrIndex) ?? null
  }
}

class RasterBandCollection extends Collection {
  get(index) {
    return this._items[index - 1] ?? null
  }
}

class LayerCollection extends Collection {
  get(nameOrIndex) {
    if (typeof nameOrIndex === 'number') return this._items[nameOrIndex - 1] ?? null
    return this._items.find((layer) => layer.name === nameOrIndex) ?? null
  }
}

class FieldCollection extends Collection {
  get(nameOrIndex) {
    if (typeof nameOrIndex === 'number') return this._items[nameOrIndex - 1] ?? null
    return this._items.find((field) => field.name === nameOrIndex) ?? null
  }
}

class OverviewCollection extends Collection {
  get(index) {
    return this._items[index - 1] ?? null
  }
}

// ---------------------------------------------------------------------------
// Raster

class BandPixels {
  constructor(band) {
    this._band = band
  }

  get xSize() {
    return this._band.size[0]
  }

  get ySize() {
    return this._band.size[1]
  }

  get(x, y) {
    return this._band._native.getPixel(x, y)
  }

  set(x, y, value) {
    this._band._native.setPixel(x, y, value)
  }

  read(x, y, width, height, data, type) {
    const bytes = this._band._native.readPixelsSync({
      x,
      y,
      width,
      height,
      dataType: dataTypeName(type),
    })
    const code = type === undefined ? this._band.dataType : normalizeCode(type)
    const TypedArray = TYPED_ARRAY_BY_CODE[code] ?? Uint8Array
    const count = width * height

    if (data && ArrayBuffer.isView(data)) {
      data.set(new TypedArray(bytes.buffer, bytes.byteOffset, count))
      return data
    }
    // Copy out: the native buffer is a view onto memory we do not own.
    const copy = new ArrayBuffer(count * TypedArray.BYTES_PER_ELEMENT)
    new Uint8Array(copy).set(new Uint8Array(bytes.buffer, bytes.byteOffset, copy.byteLength))
    return new TypedArray(copy)
  }

  readAsync(x, y, width, height, data, type) {
    // The native read is synchronous behind the process-wide lock, so this is
    // gdal-async's signature rather than its concurrency — see PHASE1.md (WS-4).
    const args = [...arguments]
    const callback = takeCallback(args)
    const value = this.read(...args)
    return withCallback(Promise.resolve(value), callback)
  }

  write(x, y, width, height, data) {
    // Native takes the bytes first and the window second; gdal-async the other
    // way round.
    this._band._native.writePixelsSync(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      { x, y, width, height },
    )
  }
}

class RasterBand {
  constructor(nativeBand) {
    this._native = nativeBand
    this.pixels = new BandPixels(this)
  }

  get size() {
    return { xSize: this._native.size[0], ySize: this._native.size[1] }
  }

  get blockSize() {
    return { xSize: this._native.blockSize[0], ySize: this._native.blockSize[1] }
  }

  get dataType() {
    return CODE_BY_NAME[this._native.dataType] ?? GDT.GDT_Unknown
  }

  get colorInterpretation() {
    return this._native.colorInterpretation
  }

  get description() {
    return this._native.description
  }

  set description(value) {
    this._native.setDescription(value)
  }

  get noDataValue() {
    return this._native.noDataValue
  }

  set noDataValue(value) {
    this._native.setNoDataValue(value)
  }

  /** gdal-async's `getStatistics(allowApproximation, force)`. */
  getStatistics(allowApproximation = false, force = true) {
    const statistics = this._native.statisticsSync({ approx: allowApproximation, force })
    if (!statistics) return null
    return { min: statistics.min, max: statistics.max, mean: statistics.mean, stdDev: statistics.stdDev }
  }

  computeStatistics(allowApproximation, force) {
    const args = [...arguments]
    const callback = takeCallback(args)
    const promise = this._native
      .statistics({ approx: args[0] ?? false, force: args[1] ?? true })
      .then((statistics) =>
        statistics === null
          ? null
          : { min: statistics.min, max: statistics.max, mean: statistics.mean, stdDev: statistics.stdDev },
      )
    return withCallback(promise, callback)
  }

  fill(value) {
    this._native.fill(value)
  }

  get overviews() {
    return new OverviewCollection(this._native.overviews)
  }
}

function normalizeCode(type) {
  return typeof type === 'string' ? CODE_BY_NAME[type.replace('GDT_', '')] : type
}

// ---------------------------------------------------------------------------
// Vector

class LayerFeatures {
  constructor(layer) {
    this._layer = layer
    this._cursor = 0
  }

  count() {
    return this._layer._native.featuresSync().length
  }

  get(fid) {
    const record = this._layer._native.feature(fid)
    return record ? new Feature(this._layer, fid) : null
  }

  first() {
    const [first] = this._layer._native.featuresSync()
    return first ? new Feature(this._layer, first.fid) : null
  }

  next() {
    const records = this._layer._native.featuresSync()
    const record = records[this._cursor]
    if (!record) return null
    this._cursor += 1
    return new Feature(this._layer, record.fid)
  }

  forEach(callback) {
    for (const record of this._layer._native.featuresSync()) {
      callback(new Feature(this._layer, record.fid))
    }
  }

  [Symbol.iterator]() {
    return this._layer._native.featuresSync().map((record) => new Feature(this._layer, record.fid))[Symbol.iterator]()
  }
}

class Layer {
  constructor(nativeLayer) {
    this._native = nativeLayer
    this.fields = new FieldCollection(nativeLayer.fields)
    this.features = new LayerFeatures(this)
  }

  get name() {
    return this._native.name
  }

  get geomType() {
    return this._native.geometryType
  }

  get srs() {
    return wrapSrs(this._native.spatialRef)
  }

  // Assigning a CRS to a layer that already exists — which the reference allows and
  // which the native binding routes through the *driver*. A format that cannot rewrite
  // its schema throws here rather than doing nothing.
  set srs(value) {
    this._native.setSpatialRef(value instanceof SpatialReference ? value._srs : value)
  }

  get extent() {
    const extent = this._native.extent
    if (!extent) return null
    const [minX, minY, maxX, maxY] = extent
    return { minX, minY, maxX, maxY }
  }

  /** The reference's name for `extent`, which is the one a port will look for. */
  getExtent() {
    return this.extent
  }

  setSpatialFilter(geometry) {
    this._native.setSpatialFilter(geometry === null ? null : unwrapGeometry(geometry))
  }

  setAttributeFilter(filter) {
    this._native.setAttributeFilter(filter)
  }

  flush() {}

  async flushAsync(callback) {
    return withCallback(Promise.resolve(), callback)
  }
}

// ---------------------------------------------------------------------------
// Dataset

class Dataset {
  constructor(nativeDataset) {
    this._native = nativeDataset
    this.bands = new RasterBandCollection(nativeDataset.bands().map((band) => new RasterBand(band)))
    this.layers = new LayerCollection(nativeDataset.layers().map((layer) => new Layer(layer)))
  }

  get description() {
    return this._native.description ?? this._native.path
  }

  get driver() {
    return this._native.driver
  }

  get rasterSize() {
    return { xSize: this._native.rasterSize.width, ySize: this._native.rasterSize.height }
  }

  get srs() {
    return wrapSrs(this._native.spatialRef)
  }

  set srs(value) {
    this._native.setProjection(value instanceof SpatialReference ? value._srs : value)
  }

  get geoTransform() {
    return this._native.geoTransform
  }

  set geoTransform(value) {
    this._native.setGeoTransform(value)
  }

  /**
   * The root group of the multidimensional model, or `null` when the file has none.
   *
   * The model only exists on a dataset opened for it, so this opens the same path a
   * second time in that mode the first time it is asked for, and keeps that handle —
   * `close()` releases it too.
   */
  get root() {
    if (this._model === undefined) {
      try {
        this._model = native.openSync(this._native.path, { multidimensional: true })
      } catch {
        this._model = null
      }
    }
    const root = this._model?.root
    return root ? new Group(root, this._model) : null
  }

  getFileList() {
    return this._native.getFileList()
  }

  flush() {
    this._native.flushSync()
  }

  flushAsync(callback) {
    return withCallback(this._native.flush(), callback)
  }

  close() {
    this._model?.close()
    this._model = undefined
    this._native.close()
  }
}

// ---------------------------------------------------------------------------
// The multidimensional model
//
// gdal-async's Group / MDArray / Attribute / Dimension, and the six collections that
// hang off them. GDAL only builds the model when a dataset is opened *for* it, so
// `Dataset.root` opens the same path a second time in that mode and keeps that handle
// alive for as long as the wrappers are used.

/** The typed array an array's samples come back as — the read is a byte buffer. */
function typedArrayFor(dataType) {
  const ctor = TYPED_ARRAY_BY_CODE[CODE_BY_NAME[dataType]]
  if (!ctor) throw new TypeError(`${dataType} has no typed array to read into`)
  return ctor
}

/** Copy first: bytes from the binding are not aligned for a 2-, 4- or 8-byte view. */
function typedOf(bytes, ctor) {
  const copy = Uint8Array.from(bytes)
  return new ctor(copy.buffer, copy.byteOffset, copy.byteLength / ctor.BYTES_PER_ELEMENT)
}

/** A collection of named things — the shape all six of them share. */
class NamedCollection extends Collection {
  constructor(items, names) {
    super(items)
    this.names = names
  }

  get(nameOrIndex) {
    if (typeof nameOrIndex === 'number') return this._items[nameOrIndex - 1] ?? null
    return this._items.find((item) => item.name === nameOrIndex) ?? null
  }

  getNames() {
    return [...this.names]
  }

  map(callback) {
    return this._items.map((item, index) => callback(item, index + 1))
  }

  async *[Symbol.asyncIterator]() {
    for (const item of this._items) yield item
  }
}

class GroupArrays extends NamedCollection {}
class GroupGroups extends NamedCollection {}
class GroupAttributes extends NamedCollection {}
class GroupDimensions extends NamedCollection {}
class ArrayAttributes extends NamedCollection {}
class ArrayDimensions extends NamedCollection {}

class Attribute {
  constructor(native) {
    this._native = native
  }

  /** The attribute's own name, which is what the collection looks it up by. */
  get name() {
    return this._native.name
  }

  get description() {
    return this._native.name
  }

  get dataType() {
    return this._native.dataType
  }

  get value() {
    return this._native.value
  }
}

class Dimension {
  constructor(native) {
    this._native = native
  }

  get name() {
    return this._native.name
  }

  get description() {
    return this._native.name
  }

  get size() {
    return this._native.size
  }

  get type() {
    return this._native.typeName
  }

  get direction() {
    return this._native.direction
  }
}

class MDArray {
  constructor(native, dataset) {
    this._native = native
    this.ds = dataset
    this.attributes = new ArrayAttributes(
      native.attributes().map((attribute) => new Attribute(attribute)),
      native.attributes().map((attribute) => attribute.name),
    )
    this.dimensions = new ArrayDimensions(
      native.dimensions().map((dimension) => new Dimension(dimension)),
      native.dimensions().map((dimension) => dimension.name),
    )
  }

  /** The array's own name; `description` is the full one, e.g. `/group/Band1`. */
  get name() {
    return this._native.name
  }

  get description() {
    return this._native.fullName
  }

  get dataType() {
    return this._native.dataType
  }

  /** How many samples the whole array holds, over every dimension. */
  get length() {
    return this._native.shape.reduce((total, size) => total * size, 1)
  }

  get noDataValue() {
    return this._native.noDataValue
  }

  get offset() {
    return this._native.offset
  }

  get scale() {
    return this._native.scale
  }

  get unitType() {
    return this._native.unit
  }

  get srs() {
    return wrapSrs(this._native.srs)
  }

  /** A hyperslab, as a typed array of the array's own type. */
  read(start, count) {
    const bytes = this._native.read({
      start: start ? Array.from(start) : undefined,
      count: count ? Array.from(count) : undefined,
    })
    return typedOf(bytes, typedArrayFor(this._native.dataType))
  }

  asDataset() {
    return new Dataset(this._native.asDataset())
  }

  getMask() {
    return new MDArray(this._native.getMask(), this.ds)
  }

  getView(expression) {
    return new MDArray(this._native.getView(expression), this.ds)
  }
}

class Group {
  constructor(native, dataset) {
    this._native = native
    this.ds = dataset
    const arrayNames = native.arrayNames()
    const groupNames = native.groupNames()
    this.arrays = new GroupArrays(
      arrayNames.map((name) => new MDArray(native.openArray(name), dataset)),
      arrayNames,
    )
    this.groups = new GroupGroups(
      groupNames.map((name) => new Group(native.openGroup(name), dataset)),
      groupNames,
    )
    this.attributes = new GroupAttributes(
      native.attributes().map((attribute) => new Attribute(attribute)),
      native.attributes().map((attribute) => attribute.name),
    )
    this.dimensions = new GroupDimensions(
      native.dimensions().map((dimension) => new Dimension(dimension)),
      native.dimensions().map((dimension) => dimension.name),
    )
  }

  get name() {
    return this._native.name
  }

  get description() {
    return this._native.fullName
  }
}

// ---------------------------------------------------------------------------
// Module

function open(path, mode = 'r', drivers, xSize, ySize, bandCount, dataType, creationOptions) {
  // gdal-async takes one driver name or a list of them, and it creates in `"w"`.
  const list = typeof drivers === 'string' ? [drivers] : drivers
  if (mode === 'w') {
    return new Dataset(
      native.createSync(path, {
        driver: list?.[0],
        width: xSize,
        height: ySize,
        bandCount,
        dataType: dataTypeName(dataType),
        options: creationOptions,
      }),
    )
  }
  if (mode === 'rs' || mode === 'rt') {
    return new Dataset(native.openThreadSafeSync(path))
  }
  // The key is *omitted* rather than set to `undefined` when there is no driver list:
  // napi reads a present-but-undefined option as an array and refuses it.
  const options = list === undefined ? {} : { drivers: list }
  if (mode === 'r+') {
    options.update = true
  }
  return new Dataset(native.openSync(path, options))
}

function openAsync(...args) {
  const callback = takeCallback(args)
  const [path, mode = 'r', drivers] = args

  const opened =
    mode === 'rs' || mode === 'rt'
      ? Promise.resolve(native.openThreadSafeSync(path))
      : native.open(path, {
          update: mode === 'r+' || mode === 'w',
          ...(drivers === undefined ? {} : { drivers }),
        })

  return withCallback(
    opened.then((dataset) => new Dataset(dataset)),
    callback,
  )
}

/**
 * gdal-async's `CoordinateTransformation`: built from two `SpatialReference`s and
 * asked for a point or a geometry.
 *
 * Two words against the main entry point's one — `CoordinateTransform` — and this is
 * the layer where the reference's names live, so both are reachable; the work is the
 * same native transform underneath. The *shapes* are the reference's, read off its own
 * tests rather than guessed: `transformPoint` takes either an `{ x, y }` object or
 * `x, y, z` arguments and answers `{ x, y, z }`, and `transformGeometry` answers a
 * geometry object, where the call it wraps answers GeoJSON.
 */
class CoordinateTransformation {
  constructor(source, target) {
    if (!(source instanceof SpatialReference) || !(target instanceof SpatialReference)) {
      throw new TypeError('a CoordinateTransformation needs two SpatialReference objects')
    }
    this._native = new native.CoordinateTransform(source._srs, target._srs)
  }

  transformPoint(x, y, z) {
    const point = typeof x === 'object' && x !== null ? x : { x, y, z }
    const [tx, ty, tz] = this._native.transformPoint(point.x, point.y)
    return { x: tx, y: ty, z: tz }
  }

  transformGeometry(geometry) {
    return wrapGeometry(native.Geometry.fromJson(this._native.transformGeometry(unwrapGeometry(geometry))))
  }
}

let driversCollection = null

const Gdal = {
  ...geometryFactories,
  ...GDT,

  open,
  openAsync,

  // gdal-async's `drivers` is one collection for the life of the process, so this
  // is cached rather than rebuilt per access.
  get drivers() {
    driversCollection ??= new DriverCollection()
    return driversCollection
  },

  get version() {
    return native.version().gdal
  },

  get lastError() {
    return native.lastError()
  },

  /** gdal-async's log-level switches — GDAL's own `CPL_DEBUG` in both directions. */
  verbose() {
    native.verbose()
  },

  quiet() {
    native.quiet()
  },

  /** gdal-async's decimal-degrees-to-DMS helper, straight through to `CPLDecToDMS`. */
  decToDMS(angle, axis, precision) {
    return native.decToDMS(angle, axis, precision)
  },

  Geometry,
  Point,
  LineString,
  LinearRing,
  Polygon,
  MultiPoint,
  MultiLineString,
  MultiPolygon,
  GeometryCollection,
  SpatialReference,

  // The multidimensional model and its collections.
  Group,
  MDArray,
  Attribute,
  Dimension,
  GroupArrays,
  GroupGroups,
  GroupAttributes,
  GroupDimensions,
  ArrayAttributes,
  ArrayDimensions,

  /** gdal-async's `geometryFromWKT`-style helpers, spelled as they are there. */
  geometryFromWKT: geometryFactories.fromWKT,
  geometryFromWKB: geometryFactories.fromWKB,
  geometryFromJSON: geometryFactories.fromJSON,

  // ---- what the reference's own test suite reaches for -------------------------
  //
  // Derived, not guessed: `scripts/compat-coverage.mjs` reads gdal-async's ~60 test
  // files and reports every `gdal.<name>` they use that this module does not answer.
  // The class constructors are the half that matters most, because
  // `assert.instanceOf(dataset, gdal.Dataset)` is how those tests ask "did I get the
  // right kind of thing" — 262 times across the suite — and an adapter whose objects
  // are not instances of anything *named* fails every one of them. These are the
  // classes this module already builds objects from, exported under the reference's
  // names; the collections and the pixel object are renamed rather than new.
  Dataset,
  RasterBand,
  Layer,
  Feature,
  FeatureFields,
  LayerFeatures,
  LayerFields: FieldCollection,
  DatasetBands: RasterBandCollection,
  DatasetLayers: LayerCollection,
  RasterBandPixels: BandPixels,
  RasterBandOverviews: OverviewCollection,
  GDALDrivers: DriverCollection,
  /** `dataset.driver` is the native object here rather than a wrapper, so this is it. */
  Driver: native.Driver,
  CoordinateTransformation,

  // Re-exports: the main entry point already answers these, under its own name or the
  // same one. Nothing is reimplemented here.
  config: native.config,
  fs: native.fs,
  info: () => native.info(),
  infoAsync: () => native.infoAsync(),
  toDataType: (value) => native.toDataType(value),
  fromDataType: (value) => native.fromDataType(value),
  wrapVRT: (descriptor) => native.wrapVRT(descriptor),
  addPixelFunc: (name, fn) => native.addPixelFunc(name, fn),
  toPixelFunc: (fn) => native.toPixelFunc(fn),
  createPixelFunc: (fn) => native.createPixelFunc(fn),
  createPixelFuncWithArgs: (fn) => native.createPixelFuncWithArgs(fn),
  calcAsync: (inputs, output, fn, options) => native.calcAsync(inputs, output, fn, options),
  RasterMuxStream: native.RasterMuxStream,
  RasterTransform: native.RasterTransform,

  /** Whether this build is self-contained — the same answer as `bundled` there. */
  get bundled() {
    return native.bundled
  },

  /** The blocking-call warning, forwarded in both directions. */
  get eventLoopWarning() {
    return native.eventLoopWarning
  },

  set eventLoopWarning(value) {
    native.eventLoopWarning = value
  },
}

module.exports = Gdal
