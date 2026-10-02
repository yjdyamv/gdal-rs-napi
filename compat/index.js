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
// typed suite in `ts-test/compat-*.spec.ts` (and `ts-test/native/compat*.spec.ts`)
// is what claims what works.

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

// The rest of gdal-async's constant vocabulary — the families `gdal_sys` cannot hand
// over, because GDAL spells them as C *macros* or unnamed enums that never reach the
// Rust side (`OLC*`, `ODsC*`, `ODrC*`, `DIM_*`, `DIR_*`, `CPLE_*`, `wkb25DBit`).
// `src/constants.rs` reads everything it *can* out of the headers and says why these
// are absent; the values here are the reference's own, and the string families are
// the very names `testCapability()` already accepts, so they are the frozen API
// rather than a guess. `numericConstants()` still wins wherever the two overlap.
const GDAL_CONSTANTS = {
  // CPL error numbers (`cpl_error.h`).
  CPLE_None: 0,
  CPLE_AppDefined: 1,
  CPLE_OutOfMemory: 2,
  CPLE_FileIO: 3,
  CPLE_OpenFailed: 4,
  CPLE_IllegalArg: 5,
  CPLE_NotSupported: 6,
  CPLE_AssertionFailed: 7,
  CPLE_NoWriteAccess: 8,
  CPLE_UserInterrupt: 9,
  CPLE_ObjectNull: 10,
  // Driver capabilities (`GDAL_DCAP_*`).
  DCAP_CREATE: 'DCAP_CREATE',
  DCAP_CREATECOPY: 'DCAP_CREATECOPY',
  DCAP_VIRTUALIO: 'DCAP_VIRTUALIO',
  // Layer capabilities (`OLC*`) — the strings `layer.testCapability` takes.
  OLCRandomRead: 'RandomRead',
  OLCSequentialWrite: 'SequentialWrite',
  OLCRandomWrite: 'RandomWrite',
  OLCFastSpatialFilter: 'FastSpatialFilter',
  OLCFastFeatureCount: 'FastFeatureCount',
  OLCFastGetExtent: 'FastGetExtent',
  OLCCreateField: 'CreateField',
  OLCDeleteField: 'DeleteField',
  OLCReorderFields: 'ReorderFields',
  OLCAlterFieldDefn: 'AlterFieldDefn',
  OLCTransactions: 'Transactions',
  OLCDeleteFeature: 'DeleteFeature',
  OLCFastSetNextByIndex: 'FastSetNextByIndex',
  OLCStringsAsUTF8: 'StringsAsUTF8',
  OLCIgnoreFields: 'IgnoreFields',
  OLCCreateGeomField: 'CreateGeomField',
  OLCCurveGeometries: 'CurveGeometries',
  OLCMeasuredGeometries: 'MeasuredGeometries',
  OLCZGeometries: 'ZGeometries',
  // Datasource capabilities (`ODsC*`) — what `dataset.testCapability` takes.
  ODsCCreateLayer: 'CreateLayer',
  ODsCDeleteLayer: 'DeleteLayer',
  ODsCCreateGeomFieldAfterCreateLayer: 'CreateGeomFieldAfterCreateLayer',
  ODsCTransactions: 'Transactions',
  ODsCEmulatedTransactions: 'EmulatedTransactions',
  ODsCCurveGeometries: 'CurveGeometries',
  ODsCMeasuredGeometries: 'MeasuredGeometries',
  ODsCZGeometries: 'ZGeometries',
  ODsCRandomLayerRead: 'RandomLayerRead',
  ODsCRandomLayerWrite: 'RandomLayerWrite',
  ODsCAddFieldDomain: 'AddFieldDomain',
  ODsCReadLayerMetadata: 'ReadLayerMetadata',
  // The dataset-flavoured driver capabilities.
  ODrCCreateDataSource: 'CreateDataSource',
  ODrCDeleteDataSource: 'DeleteDataSource',
  // Multidimensional dimension types (`GDAL_DIM_TYPE_*`).
  DIM_HORIZONTAL_X: 'HORIZONTAL_X',
  DIM_HORIZONTAL_Y: 'HORIZONTAL_Y',
  DIM_VERTICAL: 'VERTICAL',
  DIM_TEMPORAL: 'TEMPORAL',
  DIM_PARAMETRIC: 'PARAMETRIC',
  // Dimension directions.
  DIR_EAST: 'EAST',
  DIR_WEST: 'WEST',
  DIR_SOUTH: 'SOUTH',
  DIR_NORTH: 'NORTH',
  DIR_UP: 'UP',
  DIR_DOWN: 'DOWN',
  DIR_FUTURE: 'FUTURE',
  DIR_PAST: 'PAST',
  // Extended data type classes — the reference spells the two string ones with a
  // capital S / C, beside the numeric `GEDTC_STRING` / `GEDTC_COMPOUND`.
  GEDTC_String: 'String',
  GEDTC_Compound: 'Compound',
  // The Z bit and the codes that are not enum members `gdal_sys` binds. GDAL's
  // `wkb25DBit` is a signed `int`, so the 2.5D codes are negative JS numbers and
  // `gdal.wkbPoint | gdal.wkb25DBit` is how the reference builds one.
  wkb25DBit: -2147483648,
  wkbNone: 100,
  wkbLinearRing: 101,
}

// The 2.5D forms, derived the way GDAL does it: `base | wkb25DBit`.
for (const [name, code] of Object.entries(native.numericConstants())) {
  if (!name.startsWith('wkb') || code >= 100 || ['wkbUnknown', 'wkbNone', 'wkbLinearRing'].includes(name)) {
    continue
  }
  GDAL_CONSTANTS[`${name}25D`] = code | GDAL_CONSTANTS.wkb25DBit
}
GDAL_CONSTANTS.wkbLinearRing25D = GDAL_CONSTANTS.wkbLinearRing | GDAL_CONSTANTS.wkb25DBit

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

  toWKB() {
    return this.toWkb()
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

class SimpleCurve extends Geometry {}
class Point extends Geometry {}
class LineString extends SimpleCurve {}
class LinearRing extends LineString {}
class CircularString extends SimpleCurve {}
class Polygon extends Geometry {}
class MultiPoint extends Geometry {}
class MultiLineString extends Geometry {}
class MultiPolygon extends Geometry {}
class GeometryCollection extends Geometry {}
class CompoundCurve extends Geometry {}
class MultiCurve extends GeometryCollection {}

// gdal-async reports a `LinearRing` through `Polygon.rings`, not as a type of its
// own, so `LineString` is what a ring looks like from the outside. The curve types are
// here so a `COMPOUNDCURVE (…)` / `MULTICURVE (…)` parsed from WKT is re-tagged as the
// reference's class; what the binding does *not* carry is the reference's mutable
// builder (`points.add`, `curves.add`, `addSubLineString`) — a geometry here is a
// value, and those are recorded as out of reach rather than faked.
const CLASS_BY_TYPE = {
  Point: Point,
  LineString: LineString,
  CircularString: CircularString,
  CompoundCurve: CompoundCurve,
  Polygon: Polygon,
  MultiPoint: MultiPoint,
  MultiLineString: MultiLineString,
  MultiPolygon: MultiPolygon,
  GeometryCollection: GeometryCollection,
  MultiCurve: MultiCurve,
}

/** Re-tag a native geometry as the class gdal-async would have handed back. */
function wrapGeometry(geometry) {
  if (!geometry) return null
  const klass = CLASS_BY_TYPE[geometry.type.replace(/ [ZM]+$/, '')] ?? Geometry
  Object.setPrototypeOf(geometry, klass.prototype)
  return geometry
}

// `Geometry.getConstructor(wkbType)` and the `wkbType` property, class-level and
// instance-level. The codes are the same `wkb*` numbers the numeric table carries,
// with `LinearRing` (101) the one `gdal_sys` does not bind.
const WKB_TYPE_BY_NAME = {
  Unknown: 0,
  Point: 1,
  LineString: 2,
  Polygon: 3,
  MultiPoint: 4,
  MultiLineString: 5,
  MultiPolygon: 6,
  GeometryCollection: 7,
  CircularString: 8,
  CompoundCurve: 9,
  CurvePolygon: 10,
  MultiCurve: 11,
  MultiSurface: 12,
  LinearRing: 101,
}

const WKB_CLASS_BY_CODE = {
  1: Point,
  2: LineString,
  3: Polygon,
  4: MultiPoint,
  5: MultiLineString,
  6: MultiPolygon,
  7: GeometryCollection,
  8: CircularString,
  9: CompoundCurve,
  11: MultiCurve,
  101: LinearRing,
}

/** The wkb code of a class, so `gdal.Point.wkbType` and `new gdal.Point().wkbType` agree. */
function assignWkbType(klass, name) {
  klass.wkbType = WKB_TYPE_BY_NAME[name]
}

for (const [name, klass] of Object.entries({
  SimpleCurve,
  Point,
  LineString,
  LinearRing,
  CircularString,
  Polygon,
  MultiPoint,
  MultiLineString,
  MultiPolygon,
  GeometryCollection,
  CompoundCurve,
  MultiCurve,
})) {
  if (WKB_TYPE_BY_NAME[name] !== undefined) assignWkbType(klass, name)
}

Geometry.getConstructor = (wkbType) => WKB_CLASS_BY_CODE[wkbType] ?? null

Object.defineProperty(Geometry.prototype, 'wkbType', {
  configurable: true,
  get() {
    return WKB_TYPE_BY_NAME[this.type.replace(/ [ZM]+$/, '')] ?? 0
  },
})


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

  /** The field names — the reference's method spelling of `names`. */
  getNames() {
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

/**
 * A layer's (or feature's) schema, as the reference spells it: `name`, `geomType`
 * and a `fields` collection. Built from the native `Layer.defn` snapshot, so a
 * later `addField` does not change an object already handed out.
 */
class FeatureDefn {
  constructor(defn, layer) {
    this.name = defn.name
    this.geomType = defn.geometryType
    this.geomIgnored = defn.geometryType === 'None'
    this.styleIgnored = true
    this.fields = new FieldCollection(defn.fields, layer)
  }
}

// The numeric `OFT*` codes, back to the field-type names this binding speaks, so a
// `new FieldDefn('name', gdal.OFTInteger64)` — the shape the reference's tests use —
// lands on the same vocabulary a string would.
const FIELD_TYPE_BY_CODE = (() => {
  const byCode = {}
  for (const [name, value] of Object.entries(native.numericConstants())) {
    if (name.startsWith('OFT')) byCode[value] = name.slice(3)
  }
  return byCode
})()

/**
 * A field definition, as the reference constructs one. `new gdal.FieldDefn(name,
 * type)` is what `layer.fields.add` and `layers.create({ fields: [...] })` take;
 * `type` is this binding's field-type name, or one of the numeric `OFT*` constants
 * the reference hands it.
 */
class FieldDefn {
  constructor(name, type) {
    this.name = name
    this.type = typeof type === 'number' ? FIELD_TYPE_BY_CODE[type] ?? 'String' : type ?? 'String'
    this.width = 0
    this.precision = 0
    this.nullable = true
    this.unique = false
    this.defaultValue = null
    this.justification = 'Undefined'
    this.ignored = false
  }

  /** The native `FieldDefinition` request this stands for. */
  toObject() {
    return {
      name: this.name,
      fieldType: this.type,
      // 0 means "not said", which is what the native request reads as leaves-alone.
      width: this.width || undefined,
      precision: this.precision || undefined,
      nullable: this.nullable,
      unique: this.unique,
      defaultValue: this.defaultValue ?? undefined,
      justification: this.justification,
    }
  }
}

/** A `FieldDefn` or a plain field object, as the native request. */
function toFieldDefinition(field) {
  return field instanceof FieldDefn ? field.toObject() : field
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

  map(callback) {
    return this._items.map((item, index) => callback(item, index + 1))
  }

  [Symbol.iterator]() {
    return this._items[Symbol.iterator]()
  }
}

/**
 * A GDAL driver in the reference's shape. The native class spells the blocking
 * forms `createSync` / `openSync` / `createCopySync`, while the reference spells
 * them `create` / `open` / `createCopy` and reserves `…Async` for the pool — so
 * this is the adapter between the two, and `deleteDataset` is the native `delete`.
 */
class Driver {
  constructor(nativeDriver) {
    this._native = nativeDriver
  }

  get name() {
    return this._native.name
  }

  get description() {
    return this._native.description
  }

  get longName() {
    return this._native.longName
  }

  toString() {
    return this._native.name
  }

  testCapability(name) {
    return this._native.testCapability(name)
  }

  getMetadata(domain) {
    return this._native.metadata(domain)
  }

  create(path, xSize, ySize, bandCount, dataType, options) {
    return new Dataset(
      this._native.createSync(path, {
        width: xSize,
        height: ySize,
        bandCount,
        dataType: dataTypeName(dataType),
        options,
      }),
    )
  }

  createAsync(path, xSize, ySize, bandCount, dataType, options, callback) {
    const cb = typeof options === 'function' ? options : callback
    const creation = typeof options === 'function' ? undefined : options
    return withCallback(
      Promise.resolve().then(() => this.create(path, xSize, ySize, bandCount, dataType, creation)),
      cb,
    )
  }

  open(path, mode) {
    return new Dataset(this._native.openSync(path, { update: mode === 'r+' }))
  }

  openAsync(path, mode, options, callback) {
    const cb = typeof options === 'function' ? options : callback
    return withCallback(Promise.resolve().then(() => this.open(path, mode)), cb)
  }

  createCopy(path, source, options) {
    return new Dataset(this._native.createCopySync(path, source._native, options))
  }

  createCopyAsync(path, source, options, callback) {
    const cb = typeof options === 'function' ? options : callback
    const copyOptions = typeof options === 'function' ? undefined : options
    return withCallback(Promise.resolve().then(() => this.createCopy(path, source, copyOptions)), cb)
  }

  deleteDataset(path) {
    this._native.delete(path)
  }

  /** Alias of `deleteDataset`, under this binding's own spelling. */
  delete(path) {
    this._native.delete(path)
  }

  rename(newName, oldName) {
    this._native.rename(newName, oldName)
  }

  copyFiles(newName, oldName) {
    this._native.copyFiles(newName, oldName)
  }
}

class DriverCollection extends Collection {
  constructor() {
    super(native.drivers().map((driver) => new Driver(driver)))
  }

  get(nameOrIndex) {
    if (typeof nameOrIndex === 'number') return this._items[nameOrIndex - 1] ?? null
    return this._items.find((driver) => driver.name === nameOrIndex) ?? null
  }

  getNames() {
    return this._items.map((driver) => driver.name)
  }
}

class RasterBandCollection extends Collection {
  get(index) {
    return this._items[index - 1] ?? null
  }
}

class LayerCollection extends Collection {
  constructor(items, ds) {
    super(items)
    this.ds = ds
  }

  get(nameOrIndex) {
    if (typeof nameOrIndex === 'number') return this._items[nameOrIndex - 1] ?? null
    return this._items.find((layer) => layer.name === nameOrIndex) ?? null
  }

  /**
   * Create a layer — `dataset.layers.create(name, srs, geomType, options)`. `srs` is
   * a `SpatialReference` (or a WKT string), `geomType` one of this binding's geometry
   * type names, and `options` the driver's layer creation options.
   */
  create(name, srs, geomType, options) {
    const request = { name, geometryType: geomType ?? undefined }
    if (srs instanceof SpatialReference) request.wkt = srs.toWKT()
    // A bare `EPSG:4326` is resolved to WKT: the native layer creation only takes
    // a WKT string, and an authority code is a definition, not a WKT.
    else if (typeof srs === 'string') request.wkt = new SpatialReference(srs).toWKT()
    if (options) {
      // `fields` is the schema rather than a layer creation option, and the native
      // request takes it in its own slot — `gdal.FieldDefn`s and plain objects alike.
      const { fields, ...rest } = options
      if (fields) request.fields = fields.map(toFieldDefinition)
      request.options = rest
    }
    const layer = new Layer(this.ds._native.createLayer(request), this.ds)
    this._items.push(layer)
    return layer
  }

  createAsync(name, srs, geomType, options, callback) {
    const cb = typeof options === 'function' ? options : callback
    const creation = typeof options === 'function' ? undefined : options
    return withCallback(Promise.resolve().then(() => this.create(name, srs, geomType, creation)), cb)
  }

  /** Copy an existing layer from another dataset into this one. */
  copy(source, name, options) {
    const layer = new Layer(this.ds._native.copyLayer(source._native, name, options), this.ds)
    this._items.push(layer)
    return layer
  }

  copyAsync(source, name, options, callback) {
    const cb = typeof options === 'function' ? options : callback
    const copyOptions = typeof options === 'function' ? undefined : options
    return withCallback(Promise.resolve().then(() => this.copy(source, name, copyOptions)), cb)
  }

  /** Drop a layer, by name or 1-based index — the reference deletes by name too. */
  remove(nameOrIndex) {
    const layer = typeof nameOrIndex === 'number' ? this._items[nameOrIndex - 1] : this.get(nameOrIndex)
    if (!layer) throw new Error(`no layer ${nameOrIndex}`)
    this.ds._native.deleteLayer(layer.name)
    // Deleting a layer shifts every later index, and a `Layer` here holds a
    // position rather than a handle — so the survivors are re-fetched rather than
    // left pointing at the wrong one.
    this._items = this.ds._native.layers().map((nativeLayer) => new Layer(nativeLayer, this.ds))
  }

  removeAsync(nameOrIndex, callback) {
    const cb = typeof nameOrIndex === 'function' ? nameOrIndex : callback
    const which = typeof nameOrIndex === 'function' ? undefined : nameOrIndex
    return withCallback(Promise.resolve().then(() => this.remove(which)), cb)
  }
}

class FieldCollection extends Collection {
  constructor(items, layer) {
    super(items)
    this.layer = layer
  }

  get(nameOrIndex) {
    if (typeof nameOrIndex === 'number') return this._items[nameOrIndex - 1] ?? null
    return this._items.find((field) => field.name === nameOrIndex) ?? null
  }

  /** The field names, in schema order. */
  getNames() {
    return this._items.map((field) => field.name)
  }

  /** 1-based index of a field, or `-1` — the reference's `indexOf`. */
  indexOf(name) {
    const index = this._items.findIndex((field) => field.name === name)
    return index < 0 ? -1 : index + 1
  }

  /**
   * Add a field. `definition` is the `FieldDefinition` object `createLayer` takes
   * (`{ name, fieldType, width?, precision?, nullable?, unique?, defaultValue?,
   * justification? }`), and the added field is answered back.
   */
  add(definition) {
    this.layer._native.addField(toFieldDefinition(definition))
    const added = this.layer._native.fields.at(-1)
    this._items.push(added)
    return added
  }

  /** Drop a field by name. */
  remove(name) {
    this.layer._native.deleteField(name)
    const index = this._items.findIndex((field) => field.name === name)
    if (index >= 0) this._items.splice(index, 1)
  }

  /** Reorder the schema to exactly `names`, each field once. */
  reorder(names) {
    this.layer._native.reorderFields(names)
    this._items = names.map((name) => this._items.find((field) => field.name === name))
  }
}

class OverviewCollection extends Collection {
  get(index) {
    return this._items[index - 1] ?? null
  }

  /** The first level at or below `samples` across, or the smallest one. */
  getBySampleCount(samples) {
    return this._items.find((overview) => overview.size[0] <= samples) ?? this._items.at(-1) ?? null
  }
}

// ---------------------------------------------------------------------------
// Raster

class BandPixels {
  constructor(band) {
    this._band = band
  }

  get xSize() {
    return this._band.size.x
  }

  get ySize() {
    return this._band.size.y
  }

  get(x, y) {
    return this._band._native.getPixel(x, y)
  }

  set(x, y, value) {
    this._band._native.setPixel(x, y, value)
  }

  read(x, y, width, height, data, type) {
    const window = { x, y, width, height }
    // A requested `type` has to go through `readAsSync`: the native reader takes no
    // per-call type option, so putting `dataType` in the window would be ignored — the
    // bytes would come back in the band's own type and then be reinterpreted as the
    // requested one, at the wrong length.
    const bytes =
      type === undefined
        ? this._band._native.readPixelsSync(window)
        : this._band._native.readAsSync(dataTypeName(type), window)
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

  /** A Node `Readable` of the band's samples, as the native stream makes it. */
  createReadStream(options) {
    return this._band._native.createReadStream(options)
  }

  /** A Node `Writable` that consumes the band's samples. */
  createWriteStream(options) {
    return this._band._native.createWriteStream(options)
  }

  /** The block holding `(x, y)`, clipped to the band. */
  readBlock(x, y) {
    return this._band._native.readBlock(x, y)
  }

  writeBlock(x, y, data) {
    this._band._native.writeBlock(x, y, data)
  }
}

// The numeric `GPI_*` palette interpretations and this binding's strings are one
// another: GDAL's `GPI_RGB` is what `band.paletteInterpretation` spells `Rgba`.
const PALETTE_NAME_BY_GPI = { 0: 'Gray', 1: 'Rgba', 2: 'Cmyk', 3: 'Hls' }
const PALETTE_GPI_BY_NAME = { Gray: 0, Rgba: 1, Cmyk: 2, Hls: 3 }

/**
 * A band's palette, in the reference's shape: an indexable table of `{ c1, c2, c3,
 * c4 }` entries with `count`, `get`, `set`, `interpretation`, `clone`, `isSame`,
 * `ramp` and an iterator. Built over this binding's `band.colorTable` array and
 * `setColorTable`, so it adds no capability — it is the other spelling.
 *
 * A table read from a band is **read-only** (the reference's getter answers one that
 * refuses `set`, because a write has to go back through the band); one built with
 * `new ColorTable(...)` or handed back by `clone()` is writable.
 */
class ColorTable {
  constructor(interpretation = PALETTE_GPI_BY_NAME.Rgba, entries, readOnly = false) {
    this._interpretation =
      typeof interpretation === 'string'
        ? (PALETTE_GPI_BY_NAME[interpretation] ?? PALETTE_GPI_BY_NAME.Rgba)
        : interpretation
    this._entries = (entries ?? []).map((entry) => ({ c1: entry.c1, c2: entry.c2, c3: entry.c3, c4: entry.c4 }))
    this._readOnly = readOnly
  }

  get interpretation() {
    return this._interpretation
  }

  count() {
    return this._entries.length
  }

  get(index) {
    const entry = this._entries[index]
    return entry ? { c1: entry.c1, c2: entry.c2, c3: entry.c3, c4: entry.c4 } : undefined
  }

  set(index, color) {
    if (this._readOnly) {
      throw new Error('this color table is read-only; assign it back to the band to change it')
    }
    this._entries[index] = { c1: color.c1, c2: color.c2, c3: color.c3, c4: color.c4 }
  }

  clone() {
    return new ColorTable(this._interpretation, this._entries)
  }

  isSame(other) {
    if (!(other instanceof ColorTable) || other._interpretation !== this._interpretation) return false
    if (other._entries.length !== this._entries.length) return false
    return this._entries.every((entry, index) => {
      const theirs = other._entries[index]
      return entry.c1 === theirs.c1 && entry.c2 === theirs.c2 && entry.c3 === theirs.c3 && entry.c4 === theirs.c4
    })
  }

  /**
   * Fill the table from `start` to `end` with a linear ramp between two colours —
   * the reference's `ramp(start, startColor, end, endColor)`.
   */
  ramp(start, startColor, end, endColor) {
    if (this._readOnly) {
      throw new Error('this color table is read-only; assign it back to the band to change it')
    }
    const span = end - start
    for (let index = start; index <= end; index++) {
      const t = span === 0 ? 0 : (index - start) / span
      const mix = (from, to) => Math.round(from + (to - from) * t)
      this._entries[index] = {
        c1: mix(startColor.c1, endColor.c1),
        c2: mix(startColor.c2, endColor.c2),
        c3: mix(startColor.c3, endColor.c3),
        c4: mix(startColor.c4, endColor.c4),
      }
    }
  }

  /** The entries as plain objects, for the `forEach`/`map` shape collections use. */
  toArray() {
    return this._entries.map((entry) => ({ ...entry }))
  }

  [Symbol.iterator]() {
    return this.toArray()[Symbol.iterator]()
  }
}

/** The `ColorTable` a band's native table becomes, or `undefined` when there is none. */
function colorTableFromNative(band) {
  const entries = band.colorTable
  // `null` is "no table at all"; an **empty** array is a table with no entries, which
  // is what GDAL answers after an empty one is written — and what `isSame` compares.
  if (entries === null || entries === undefined) return undefined
  const interpretation = PALETTE_GPI_BY_NAME[band.paletteInterpretation] ?? PALETTE_GPI_BY_NAME.Rgba
  return new ColorTable(interpretation, entries, true)
}

class RasterBand {
  constructor(nativeBand) {
    this._native = nativeBand
    this.pixels = new BandPixels(this)
  }

  get size() {
    // The reference's `size` is the `xyz` interface — `{ x, y }` — not `{ xSize, ySize }`.
    return { x: this._native.size[0], y: this._native.size[1] }
  }

  get blockSize() {
    return { x: this._native.blockSize[0], y: this._native.blockSize[1] }
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
    // Plain copy, for the reason the fields collection is copied: `band.overviews`
    // is a collection wrapper whose own `map` / `forEach` read a snapshot.
    return new OverviewCollection([...this._native.overviews])
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

  /** The layer this view belongs to — the reference's back-reference. */
  get layer() {
    return this._layer
  }

  /**
   * Add a feature. `feature` is a `Feature`, a `Geometry`, or the GeoJSON object
   * `createFeature` takes; a plain `Feature` also carries its own fields across.
   * The native `createFeature` does not report the new id, so a `Feature` passed in
   * is answered back and a bare geometry answers `null`.
   */
  add(feature, properties) {
    if (feature instanceof Feature) {
      this._layer._native.createFeature(
        unwrapGeometry(feature.geometry ?? undefined) ?? null,
        feature.fields.toObject(),
      )
      return feature
    }
    this._layer._native.createFeature(unwrapGeometry(feature) ?? null, properties ?? null)
    return null
  }

  addAsync(feature, properties, callback) {
    const cb = typeof properties === 'function' ? properties : callback
    const props = typeof properties === 'function' ? undefined : properties
    return withCallback(Promise.resolve().then(() => this.add(feature, props)), cb)
  }

  /**
   * Overwrite a feature by id: `set(feature)` uses the feature's own id, and
   * `set(fid, feature)` names it. Like `add`, a plain geometry is accepted.
   */
  set(fid, feature) {
    const id = typeof fid === 'number' ? fid : fid.fid
    const value = typeof fid === 'number' ? feature : fid
    const geometry = value instanceof Feature ? value.geometry : value
    const properties = value instanceof Feature ? value.fields.toObject() : undefined
    this._layer._native.updateFeature(id, unwrapGeometry(geometry ?? undefined) ?? null, properties ?? null)
    return value
  }

  setAsync(fid, feature, callback) {
    const cb = typeof feature === 'function' ? feature : callback
    const value = typeof feature === 'function' ? undefined : feature
    return withCallback(Promise.resolve().then(() => (value === undefined ? this.set(fid) : this.set(fid, value))), cb)
  }

  /** Remove a feature by id — the native `deleteFeature`. */
  remove(fid) {
    this._layer._native.deleteFeature(fid)
  }

  removeAsync(fid, callback) {
    return withCallback(Promise.resolve().then(() => this.remove(fid)), callback)
  }
}

class Layer {
  constructor(nativeLayer, ds) {
    this._native = nativeLayer
    this._ds = ds
    // `nativeLayer.fields` is the shell's *collection wrapper* — an array with its
    // own `map` / `forEach` reading a frozen snapshot. Copying it into a plain array
    // is what lets `add` / `remove` / `reorder` mutate the view and stay truthful.
    this.fields = new FieldCollection([...nativeLayer.fields], this)
    this.features = new LayerFeatures(this)
  }

  /** The parent dataset — the reference's back-reference, or `null`. */
  get ds() {
    return this._ds ?? null
  }

  /** The FID column, or `null` when GDAL generates ids. */
  get fidColumn() {
    return this._native.fidColumn
  }

  /** The geometry column, or `null` for a layer with no geometry. */
  get geomColumn() {
    return this._native.geomColumn
  }

  /** The layer's schema, as a `FeatureDefn`. */
  get defn() {
    return new FeatureDefn(this._native.defn, this)
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

  /** The spatial filter in force, as a `Geometry`, or `null`. */
  getSpatialFilter() {
    const filter = this._native.getSpatialFilter()
    return filter ? wrapGeometry(filter) : null
  }

  /** Whether the layer can do `name`, using GDAL's own `OLC*` capability names. */
  testCapability(name) {
    return this._native.testCapability(name)
  }

  /** Write the layer's pending changes to disk. */
  flush() {
    this._native.flushSync()
  }

  flushAsync(callback) {
    return withCallback(this._native.flush(), callback)
  }
}

// ---------------------------------------------------------------------------
// Dataset

class Dataset {
  constructor(nativeDataset) {
    this._native = nativeDataset
    this.bands = new RasterBandCollection(nativeDataset.bands().map((band) => new RasterBand(band)))
    // A thread-safe dataset (`open(path, 'rs' | 'rt')`) is a read-only raster with no
    // vector side at all, and asking it for layers throws. It gets an empty collection
    // rather than taking the whole constructor down with it.
    const layers = nativeDataset.threadSafe ? [] : nativeDataset.layers()
    this.layers = new LayerCollection(
      layers.map((layer) => new Layer(layer, this)),
      this,
    )
  }

  get description() {
    return this._native.description ?? this._native.path
  }

  get driver() {
    return new Driver(this._native.driver)
  }

  /** Whether this handle is read concurrently — only `open(path, 'rs' | 'rt')`. */
  get threadSafe() {
    return this._native.threadSafe
  }

  get rasterSize() {
    // The `xyz` interface, as the reference spells it.
    return { x: this._native.rasterSize.width, y: this._native.rasterSize.height }
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
    const driver = list?.[0]
    if (driver === undefined) throw new Error('creating a dataset needs a driver name')
    // No raster size means a vector dataset — `GDALCreate` with no dimensions, which
    // is `createVector` here and not `create`.
    if (xSize === undefined || ySize === undefined) {
      return new Dataset(native.createVectorSync(path, driver))
    }
    return new Dataset(
      native.createSync(path, {
        driver,
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

// ---- the reference's names for what these classes already do ------------------
//
// Added here rather than in the class bodies above because it is one list, from one
// source: `scripts/compat-coverage.mjs` reads gdal-async's own tests and reports the
// members they reach for that this module does not answer — the same method, under
// the other naming convention. The *shapes* are read off those tests, not assumed.

/** `setMetadata` takes an object or an array of `key=value` strings, and answers true. */
function setMetadata(target, values, domain) {
  if (Array.isArray(values)) {
    for (const entry of values) {
      const [key, ...rest] = String(entry).split('=')
      target.setMetadataItem(key, rest.join('='), domain)
    }
  } else if (values && typeof values === 'object') {
    for (const [key, value] of Object.entries(values)) target.setMetadataItem(key, String(value), domain)
  } else {
    throw new TypeError('setMetadata takes an object or an array of "key=value" strings')
  }
  return true
}

Object.assign(Dataset.prototype, {
  /** The same read as `metadata()`, under the reference's name. */
  getMetadata(domain) {
    return this._native.metadata(domain)
  },

  setMetadata(values, domain) {
    return setMetadata(this._native, values, domain)
  },

  /** `executeSQL` is how the reference spells it — capitals and all. */
  executeSQL(sql, dialect) {
    return this._native.executeSql(sql, dialect)
  },

  /** A dataset's capability question — GDAL's own names (`CreateLayer`, `DeleteLayer`). */
  testCapability(name) {
    return this._native.testCapability(name)
  },

  /**
   * The same query under the reference's async name. The native query is
   * synchronous, so this is the reference's *shape* rather than its concurrency —
   * like the rest of this adapter's `xxxAsync` pairs. (The native binding has no
   * `executeSqlAsync`, which is what this used to forward to.)
   */
  executeSQLAsync(sql, dialect, callback) {
    const cb = typeof dialect === 'function' ? dialect : callback
    if (typeof dialect === 'function') dialect = undefined
    return withCallback(Promise.resolve().then(() => this._native.executeSql(sql, dialect)), cb)
  },

  /** A getter here, a getter-shaped call there. */
  getGCPProjection() {
    return this._native.gcpProjection
  },

  /** `buildOverviews` blocks in the reference, so both names have to exist. */
  buildOverviews(options) {
    return this._native.buildOverviewsSync(options)
  },

  buildOverviewsAsync(options) {
    return this._native.buildOverviews(options)
  },
})

Object.assign(RasterBand.prototype, {
  getMetadata(domain) {
    return this._native.metadata(domain)
  },

  /**
   * The read side has always been here; the write side needed a binding addition
   * (`RasterBand.setMetadataItem`, which the reference's tests use and this binding did
   * not have), so this is the reference's name over a call that now exists.
   */
  setMetadata(values, domain) {
    return setMetadata(this._native, values, domain)
  },

  /**
   * `computeStatistics(allowApproximation, force)` is **synchronous** in the reference,
   * with `computeStatisticsAsync` beside it — this class had the promise under the
   * plain name, which is a shape a port would trip over. Fixed here rather than left
   * as found, because the whole point of the exercise is that the reference's tests are
   * the specification.
   */
  computeStatistics(allowApproximation, force) {
    return this._native.statisticsSync({ approx: allowApproximation, force })
  },

  computeStatisticsAsync(allowApproximation, force) {
    return this._native.statistics({ approx: allowApproximation, force })
  },

  // The mask is the one band-shaped thing this adapter deliberately does not wrap (the
  // notes in WS-7 say why), so these answer the native band — everything a caller does
  // with a mask band goes to the same native object either way.
  getMaskBand() {
    return this._native.mask
  },

  getMaskFlags() {
    // The reference reports GDAL's `GMF_*` bitmask; this binding spells the same
    // flags as booleans, so they are folded back into the number here.
    const flags = this._native.maskFlags
    return (flags.allValid ? 1 : 0) | (flags.perDataset ? 2 : 0) | (flags.alpha ? 4 : 0) | (flags.noData ? 8 : 0)
  },

  createMaskBand(perDataset) {
    return this._native.createMask(perDataset)
  },
})

// The read-only band values the reference carries as properties. Each is a
// passthrough to the native getter, and each answers the same shape (`scale` and
// the rest are `number | null`, `unitType` a `string | null`).
Object.defineProperties(RasterBand.prototype, {
  scale: { configurable: true, get() { return this._native.scale } },
  offset: { configurable: true, get() { return this._native.offset } },
  unitType: { configurable: true, get() { return this._native.unitType } },
  minimum: { configurable: true, get() { return this._native.minimum } },
  maximum: { configurable: true, get() { return this._native.maximum } },
  id: { configurable: true, get() { return this._native.id } },
  readOnly: { configurable: true, get() { return this._native.readOnly } },
  hasArbitraryOverviews: {
    configurable: true,
    get() { return this._native.hasArbitraryOverviews },
  },
  categoryNames: { configurable: true, get() { return this._native.categoryNames } },
  // The reference's palette: a `ColorTable` object on the getter (read-only), and an
  // assignment on the setter that writes the whole table back — `null` clears it.
  colorTable: {
    configurable: true,
    get() {
      return colorTableFromNative(this._native)
    },
    set(value) {
      if (value === null || value === undefined) {
        this._native.clearColorTable()
        return
      }
      if (!(value instanceof ColorTable)) {
        throw new TypeError('colorTable must be a gdal.ColorTable')
      }
      this._native.setColorTable(value._entries, PALETTE_NAME_BY_GPI[value._interpretation])
    },
  },
  // The async twin the reference carries; the read is cheap, the promise is for the
  // same shape its `colourTableAsync` has.
  colorTableAsync: {
    configurable: true,
    get() {
      return Promise.resolve(colorTableFromNative(this._native))
    },
  },
})

Object.assign(RasterBand.prototype, {
  /** The band as a 2D `MDArray`. */
  asMDArray() {
    return this._native.asMDArray()
  },

  /** Save this band's changes to disk. */
  flush() {
    this._native.flushSync()
  },

  flushAsync(callback) {
    return withCallback(this._native.flush(), callback)
  },
})

Object.assign(Layer.prototype, {
  getMetadata(domain) {
    return this._native.metadata(domain)
  },
})

Object.assign(SpatialReference, {
  /** `fromEPSG` — the reference's capitalisation of the same door. */
  fromEPSG(code) {
    return new SpatialReference(native.SpatialRef.fromEpsg(code))
  },

  fromWKT(wkt) {
    return new SpatialReference(native.SpatialRef.fromWkt(wkt))
  },

  fromProj4(proj4) {
    return new SpatialReference(native.SpatialRef.fromProj4(proj4))
  },

  fromESRI(esriWkt) {
    return new SpatialReference(native.SpatialRef.fromESRI(esriWkt))
  },

  /** The same code, read in the authority's axis order rather than GIS's. */
  fromEPSGA(code) {
    return new SpatialReference(native.SpatialRef.fromEpsg(code).withAxisMapping('authority'))
  },

  /**
   * The reference splits the general door into one name per flavour — a URN, a CRS URL,
   * a WMS `AUTO:` string, a MapInfo coordinate system. They all land on the same
   * `OSRSetFromUserInput`, which is what `fromDefinition` is, so they are aliases here
   * rather than five implementations.
   */
  fromURN(urn) {
    return new SpatialReference(native.SpatialRef.fromDefinition(urn))
  },

  fromURL(url) {
    return new SpatialReference(native.SpatialRef.fromDefinition(url))
  },

  fromCRSURL(url) {
    return new SpatialReference(native.SpatialRef.fromDefinition(url))
  },

  fromUserInput(definition) {
    return new SpatialReference(native.SpatialRef.fromDefinition(definition))
  },

  fromWMSAUTO(definition) {
    return new SpatialReference(native.SpatialRef.fromDefinition(definition))
  },

  fromMICoordSys(definition) {
    return new SpatialReference(native.SpatialRef.fromDefinition(definition))
  },
})

Object.assign(SpatialReference.prototype, {
  /** The unit accessors: this binding reports the unit, the reference its factor. */
  getAngularUnits() {
    return this._srs.angularUnit?.factor ?? 1
  },

  getLinearUnits() {
    return this._srs.linearUnit?.factor ?? 1
  },

  toPrettyWKT() {
    return this._srs.prettyWkt
  },

  toXML() {
    return this._srs.toXML()
  },

  autoIdentifyEPSG() {
    return this._srs.autoIdentifyEPSG()
  },

  validate() {
    return this._srs.validate()
  },

  equals(other) {
    return this._srs.equals(other._srs ?? other)
  },

  isSameGeogCS(other) {
    return this._srs.isSameGeogCS(other._srs ?? other)
  },

  isSameVertCS(other) {
    return this._srs.isSameVertCS(other._srs ?? other)
  },

  cloneGeogCS() {
    return new SpatialReference(this._srs.cloneGeogCS())
  },

  setWellKnownGeogCS(name) {
    return this._srs.setWellKnownGeogCS(name)
  },

  getAttrValue(key, child) {
    return this._srs.getAttrValue(key, child)
  },

  morphToESRI() {
    return this._srs.morphToESRI()
  },

  morphFromESRI() {
    return this._srs.morphFromESRI()
  },

  withAxisMapping(mapping) {
    return new SpatialReference(this._srs.withAxisMapping(mapping))
  },
})

// The read-only flags and values are getters on both sides, so they need a forward
// rather than a rename — and this wrapper is composition rather than inheritance, so
// without the forward they are simply absent. `isVectical` is not among them: it is a
// typo in the reference's suite.
for (const name of [
  'isGeographic',
  'isProjected',
  'isCompound',
  'isVertical',
  'isGeocentric',
  'isLocal',
  'epsgTreatsAsLatLong',
  'wkt',
  'prettyWkt',
  'proj4',
  'projJson',
  'name',
  'authName',
  'authCode',
  'authority',
  'axisMapping',
  'areaOfUse',
  'linearUnit',
  'angularUnit',
]) {
  Object.defineProperty(SpatialReference.prototype, name, {
    configurable: true,
    get() {
      return this._srs[name]
    },
  })
}

/** `/vsimem/name`, whether the caller passed a bare name or the whole path. */
function vsimemPath(name) {
  const path = String(name)
  return path.startsWith('/vsimem/') ? path : `/vsimem/${path}`
}

/**
 * gdal-async's `vsimem`: GDAL's memory file system, which the reference's own tests use
 * as the dumping ground for fixture bytes — 76 of the calls in that suite are
 * `release()`, with a `set()` before them.
 *
 * This binding spells the same thing as `fs` calls on `/vsimem/` paths, so this is the
 * reference's name over those rather than a second implementation.
 */
const vsimem = {
  /** `set(buffer, filename?)` — copies the bytes in, and answers the path. */
  set(data, filename) {
    const path = vsimemPath(filename ?? `gdal-rs-napi-${Date.now()}-${vsimemCounter++}.bin`)
    native.fs.writeFile(path, Buffer.isBuffer(data) ? data : Buffer.from(data))
    return path
  },

  /**
   * `release(filename)` — frees the memory file. Idempotent: the reference's tests call
   * it from a `finally`, and freeing something already freed is not worth an exception
   * here for the same reason a second `close()` is not.
   */
  release(filename) {
    const path = vsimemPath(filename)
    if (native.fs.stat(path)) native.fs.unlink(path)
  },

  /** `copy(from, to)` — GDAL's own copy inside the memory file system. */
  copy(from, to) {
    native.fs.copyFile(vsimemPath(from), vsimemPath(to))
  },
}

let vsimemCounter = 0

/**
 * gdal-async's `Envelope`: a bounding box as an object, which is what its
 * `geometry.getEnvelope()` answers. This binding reports an envelope as four numbers
 * in a flat array, so this class is the shape in between — and every rule below was
 * read out of the reference's own `api_envelope.test.ts` rather than guessed:
 *
 * * an envelope with **all four components zero** counts as empty, which is how that
 *   suite defines it (a degenerate box at the origin is as empty as `{0,0,0,0}`);
 * * `merge()` expands **in place**, from either an `x, y` pair or another envelope;
 * * `intersects()` counts envelopes that merely **touch**;
 * * `intersect()` is in place too, and leaves an all-zero — empty — envelope when the
 *   two do not overlap; an empty one takes the other when the other spans the origin.
 */
class Envelope {
  constructor(bounds = {}) {
    this.minX = bounds.minX ?? 0
    this.maxX = bounds.maxX ?? 0
    this.minY = bounds.minY ?? 0
    this.maxY = bounds.maxY ?? 0
  }

  isEmpty() {
    return this.minX === 0 && this.maxX === 0 && this.minY === 0 && this.maxY === 0
  }

  merge(x, y) {
    const other = x instanceof Envelope ? x : new Envelope({ minX: x, maxX: x, minY: y, maxY: y })
    if (other.isEmpty()) return this
    if (this.isEmpty()) return Object.assign(this, other)
    this.minX = Math.min(this.minX, other.minX)
    this.maxX = Math.max(this.maxX, other.maxX)
    this.minY = Math.min(this.minY, other.minY)
    this.maxY = Math.max(this.maxY, other.maxY)
    return this
  }

  intersects(other) {
    return !(
      other.minX > this.maxX ||
      other.maxX < this.minX ||
      other.minY > this.maxY ||
      other.maxY < this.minY
    )
  }

  contains(other) {
    return (
      other.minX >= this.minX &&
      other.maxX <= this.maxX &&
      other.minY >= this.minY &&
      other.maxY <= this.maxY
    )
  }

  intersect(other) {
    if (!this.intersects(other)) return Object.assign(this, new Envelope())
    if (this.isEmpty()) return Object.assign(this, other)
    this.minX = Math.max(this.minX, other.minX)
    this.maxX = Math.min(this.maxX, other.maxX)
    this.minY = Math.max(this.minY, other.minY)
    this.maxY = Math.min(this.maxY, other.maxY)
    return this
  }

  /** The box as a `Polygon`, which is what the reference hands back here. */
  toPolygon() {
    const { minX, minY, maxX, maxY } = this
    return geometryFactories.fromWKT(
      `POLYGON ((${minX} ${minY}, ${maxX} ${minY}, ${maxX} ${maxY}, ${minX} ${maxY}, ${minX} ${minY}))`,
    )
  }
}

/** The same box with Z, which is what a 3D geometry's envelope answers. */
class Envelope3D extends Envelope {
  constructor(bounds = {}) {
    super(bounds)
    this.minZ = bounds.minZ ?? 0
    this.maxZ = bounds.maxZ ?? 0
  }

  isEmpty() {
    return super.isEmpty() && this.minZ === 0 && this.maxZ === 0
  }

  merge(x, y, z) {
    if (x instanceof Envelope3D) {
      super.merge(x)
      this.minZ = Math.min(this.minZ, x.minZ)
      this.maxZ = Math.max(this.maxZ, x.maxZ)
      return this
    }
    super.merge(x, y)
    if (z !== undefined) {
      this.minZ = Math.min(this.minZ, z)
      this.maxZ = Math.max(this.maxZ, z)
    }
    return this
  }

  contains(other) {
    return super.contains(other) && other.minZ >= this.minZ && other.maxZ <= this.maxZ
  }

  intersects(other) {
    return super.intersects(other) && !(other.minZ > this.maxZ || other.maxZ < this.minZ)
  }
}

// The reference's static doors on `Geometry` itself. Its tests call
// `gdal.Geometry.fromWKB(...)` and `fromGeoJson(...)`, where this binding spells the
// same work `fromWkb` / `fromJson`; `fromGeoJsonBuffer` is the same thing with the
// GeoJSON arriving as bytes, which is the shape a file read hands back. Each answers a
// wrapped geometry, so `instanceof gdal.Point` holds like it does at the factories.
Object.assign(Geometry, {
  fromWKT: (wkt) => geometryFactories.fromWKT(wkt),
  fromWKB: (wkb) => geometryFactories.fromWKB(wkb),
  fromGeoJson: (json) => wrapGeometry(native.Geometry.fromJson(json)),
  fromGeoJsonBuffer: (buffer) =>
    wrapGeometry(native.Geometry.fromJson(JSON.parse(Buffer.from(buffer).toString('utf8')))),
})

// A geometry's envelope is the other half of the class above: the reference answers an
// `Envelope` object, this binding a flat array. `nativeGeometry` is the prototype the
// adapter is chained to, so calling *through* it is what reaches the real method
// rather than the override — `this.envelope()` here would be this very function.
const nativeGeometry = native.Geometry.prototype

Object.assign(Geometry.prototype, {
  envelope() {
    // This binding answers `{ minX, minY, maxX, maxY }` already — the same four field
    // names the reference's class carries — so the shape in between is a construction
    // rather than a translation, and `null` (an empty geometry) is the empty box.
    const bounds = nativeGeometry.envelope.call(this)
    return bounds ? new Envelope(bounds) : new Envelope()
  },

  /** The reference's other spelling of the same thing, and the one its tests use. */
  getEnvelope() {
    return this.envelope()
  },

  /** The 3D box, as the reference's `Envelope3D`; the empty box for an empty geometry. */
  getEnvelope3D() {
    const bounds = nativeGeometry.envelope3d.call(this)
    return bounds ? new Envelope3D(bounds) : new Envelope3D()
  },
})

Object.assign(Feature.prototype, {
  getGeometry() {
    return this.geometry
  },

  setGeometry(geometry) {
    this.geometry = geometry
  },
})

// The reference's `feature.defn` — the schema this feature belongs to.
Object.defineProperty(Feature.prototype, 'defn', {
  configurable: true,
  get() {
    return new FeatureDefn(this._layer._native.defn, this._layer)
  },
})

// The operations that build a new geometry have to be re-wrapped, because the adapter's
// own classes are **not** in the native chain: `wrapGeometry` is applied at the
// factories, so a result that came out of an operation would be tagged as the main
// entry point's class rather than this layer's — `buffer(1) instanceof gdal.Polygon`
// was false, and only `fromWKT(...)` was true. One list, the same one the main entry
// point re-tags, so the two layers agree about which shapes exist.
const maybeWrapGeometry = (value) =>
  Array.isArray(value) ? value.map(wrapGeometry) : wrapGeometry(value)

for (const name of [
  'boundary',
  'buffer',
  'centroid',
  'children',
  'clone',
  'concaveHull',
  'convexHull',
  'difference',
  'flattenTo2D',
  'intersection',
  'makeValid',
  'normalize',
  'pointOnSurface',
  'segmentize',
  'setPrecision',
  'simplify',
  'simplifyPreserveTopology',
  'swapXY',
  'symDifference',
  'unaryUnion',
  'union',
  'unionCascaded',
]) {
  const original = nativeGeometry[name]
  if (typeof original !== 'function') continue
  Object.defineProperty(Geometry.prototype, name, {
    configurable: true,
    writable: true,
    value(...args) {
      return maybeWrapGeometry(original.apply(this, args))
    },
  })
}

/** A `SpatialReference` wrapper as the native one the native methods expect. */
function unwrapSpatialRef(value) {
  return value instanceof SpatialReference ? value._srs : value
}

// `transform` names two CRSs, and a caller hands it this adapter's
// `SpatialReference` wrappers — the native method wants the native ones, so it is
// unwrapped here rather than in the generic re-wrap loop above.
Object.defineProperty(Geometry.prototype, 'transform', {
  configurable: true,
  writable: true,
  value(from, to) {
    return wrapGeometry(
      nativeGeometry.transform.call(this, unwrapSpatialRef(from), unwrapSpatialRef(to)),
    )
  },
})

let driversCollection = null

const Gdal = {
  ...geometryFactories,
  ...GDT,
  // ... and then the same names again, from `gdal_sys` on the Rust side. The hand-
  // written `GDT` table above predates that door and is kept only because the pixel
  // code maps names through it; where the two disagree, the one read out of the
  // headers this build links is the one that wins.
  ...native.numericConstants(),
  // The families `gdal_sys` cannot hand over — the `OLC*` / `ODsC*` / `ODrC*` strings,
  // `DIM_*`, `DIR_*`, `CPLE_*`, `wkb25DBit` and the 2.5D codes.
  ...GDAL_CONSTANTS,

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
  SimpleCurve,
  Point,
  LineString,
  LinearRing,
  CircularString,
  Polygon,
  MultiPoint,
  MultiLineString,
  MultiPolygon,
  GeometryCollection,
  CompoundCurve,
  MultiCurve,
  ColorTable,
  SpatialReference,
  Envelope,
  Envelope3D,

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
  FeatureDefnFields: FieldCollection,
  DatasetBands: RasterBandCollection,
  DatasetLayers: LayerCollection,
  RasterBandPixels: BandPixels,
  RasterBandOverviews: OverviewCollection,
  GDALDrivers: DriverCollection,
  /** `dataset.driver` is a wrapper here too, under the reference's method names. */
  Driver,
  CoordinateTransformation,
  // The multidim collection aliases the reference's tests name.
  Dimensions: GroupDimensions,
  GeometryCollectionChildren: Collection,

  // Re-exports: the main entry point already answers these, under its own name or the
  // same one. Nothing is reimplemented here.
  config: native.config,
  fs: native.fs,
  vsimem,
  /**
   * The reference's `info(dataset, args)` is `gdalinfo`'s report for a dataset.
   * Called with no dataset it is this binding's build info, which is what the native
   * entry point answers — kept because that is the shape the rest of the surface
   * already has.
   */
  info(dataset, args) {
    if (dataset === undefined) return native.info()
    return native.gdalinfo(dataset._native, args)
  },

  infoAsync(dataset, args, callback) {
    const cb = typeof args === 'function' ? args : callback
    const cliArgs = typeof args === 'function' ? undefined : args
    const value = dataset === undefined ? native.info() : native.gdalinfo(dataset._native, cliArgs)
    return withCallback(Promise.resolve(value), cb)
  },
  toDataType: (value) => native.toDataType(value),
  fromDataType: (value) => native.fromDataType(value),
  wrapVRT: (descriptor) => native.wrapVRT(descriptor),
  addPixelFunc: (name, fn) => native.addPixelFunc(name, fn),
  toPixelFunc: (fn) => native.toPixelFunc(fn),
  createPixelFunc: (fn) => native.createPixelFunc(fn),
  createPixelFuncWithArgs: (fn) => native.createPixelFuncWithArgs(fn),
  calcAsync: (inputs, output, fn, options) =>
    native.calcAsync(
      // Unwrap this adapter's bands, which the native `calcAsync` would not
      // recognise as `RasterBand`s; a native band is passed straight through.
      Object.fromEntries(Object.entries(inputs ?? {}).map(([name, band]) => [name, band?._native ?? band])),
      output?._native ?? output,
      fn,
      options,
    ),
  RasterMuxStream: native.RasterMuxStream,
  RasterTransform: native.RasterTransform,
  // The named stream classes `band.createReadStream()` / `createWriteStream()` build.
  RasterReadStream: native.RasterReadStream,
  RasterWriteStream: native.RasterWriteStream,

  /**
   * `gdal.deleteDataset(path, driver?)` — the reference's module-level delete. The
   * driver is what actually does the deleting here, so without a name this asks the
   * file's own driver, which is the same choice GDAL would make.
   */
  deleteDataset(path, driver) {
    let name = driver
    if (!name) {
      // No driver named: the file knows which one it is, so ask it before deleting.
      const dataset = open(path)
      try {
        name = dataset.driver.name
      } finally {
        dataset.close()
      }
    }
    native.driver(name).delete(path)
  },

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

// ---- gdal-async's module-level utilities -----------------------------------
//
// The reference spells each command-line tool as one function taking the same
// `args` array of CLI options this binding's own program entry points take, so
// most of these are a single native call with the sources mapped from `Dataset`
// objects to the paths the native module-level entries open. The four the
// reference has that are **not** here — `polygonize`, `contourGenerate`,
// `rasterize` and `info` — are the ones whose mapping is not mechanical: the
// first two pass field *indexes* where this binding takes names, and the latter
// two have no native counterpart (this binding has no `gdalinfo` wrapper, and
// `gdal.rasterize` burns a whole vector source where the native
// `Dataset.rasterize` takes geometries).

/** The native progress callback from the reference's `options.progress_cb`. */
function utilProgress(options) {
  const callback = options?.progress_cb
  if (typeof callback !== 'function') return undefined
  return (update) => callback(update.complete, update.message)
}

/** A `Dataset` or a path, as the path the native module-level entries open. */
function sourcePath(source) {
  if (typeof source === 'string') return source
  return source?._native?.path || source?._native?.description
}

const wrapDataset = (dataset) => new Dataset(dataset)

function translate(destination, source, args) {
  return wrapDataset(source._native.translateSync(destination, args))
}

function translateAsync(destination, source, args, options, callback) {
  const cb = typeof options === 'function' ? options : callback
  const util = typeof options === 'function' ? undefined : options
  return withCallback(
    source._native.translate(destination, args, utilProgress(util)).then(wrapDataset),
    cb,
  )
}

function vectorTranslate(destination, source, args) {
  return wrapDataset(source._native.vectorTranslateSync(destination, args))
}

function vectorTranslateAsync(destination, source, args, options, callback) {
  const cb = typeof options === 'function' ? options : callback
  const util = typeof options === 'function' ? undefined : options
  return withCallback(
    source._native.vectorTranslate(destination, args, utilProgress(util)).then(wrapDataset),
    cb,
  )
}

function warp(dstPath, dstDataset, sources, args) {
  if (dstDataset !== null && dstDataset !== undefined) {
    throw new TypeError('gdal.warp cannot write into an existing destination dataset — use reprojectImage')
  }
  return wrapDataset(native.warpSync(dstPath, sources.map(sourcePath), args))
}

function warpAsync(dstPath, dstDataset, sources, args, options, callback) {
  const cb = typeof options === 'function' ? options : callback
  const util = typeof options === 'function' ? undefined : options
  if (dstDataset !== null && dstDataset !== undefined) {
    return withCallback(
      Promise.reject(new TypeError('gdal.warp cannot write into an existing destination dataset — use reprojectImage')),
      cb,
    )
  }
  return withCallback(
    native.warp(dstPath, sources.map(sourcePath), args, utilProgress(util)).then(wrapDataset),
    cb,
  )
}

function buildVRT(dstPath, sources, args) {
  return wrapDataset(native.buildVrtSync(dstPath, sources.map(sourcePath), args))
}

function buildVRTAsync(dstPath, sources, args, callback) {
  const cb = typeof args === 'function' ? args : callback
  const cliArgs = typeof args === 'function' ? undefined : args
  return withCallback(native.buildVrt(dstPath, sources.map(sourcePath), cliArgs).then(wrapDataset), cb)
}

function dem(dstPath, source, mode, args, colorFile) {
  return wrapDataset(source._native.demProcessSync(dstPath, mode, args, colorFile))
}

function demAsync(dstPath, source, mode, args, colorFile, options, callback) {
  const cb = typeof options === 'function' ? options : callback
  const util = typeof options === 'function' ? undefined : options
  return withCallback(
    source._native.demProcess(dstPath, mode, args, colorFile, utilProgress(util)).then(wrapDataset),
    cb,
  )
}

function checksumImage(source, x, y, width, height) {
  return source._native.checksumSync({ x, y, width, height })
}

function checksumImageAsync(source, x, y, width, height, callback) {
  const cb = typeof height === 'function' ? height : callback
  const box = typeof height === 'function' ? { x, y, width } : { x, y, width, height }
  return withCallback(source._native.checksum(box), cb)
}

function suggestedWarpOutput(options) {
  const result = options.src._native.suggestedWarpOutputSync({
    srcWkt: options.s_srs?.wkt,
    dstWkt: options.t_srs?.wkt,
    maxError: options.maxError,
  })
  return { rasterSize: { x: result.width, y: result.height }, geoTransform: result.geoTransform }
}

function suggestedWarpOutputAsync(options, callback) {
  const cb = typeof options === 'function' ? options : callback
  const opts = typeof options === 'function' ? undefined : options
  return withCallback(
    opts.src._native
      .suggestedWarpOutput({ srcWkt: opts.s_srs?.wkt, dstWkt: opts.t_srs?.wkt, maxError: opts.maxError })
      .then((result) => ({
        rasterSize: { x: result.width, y: result.height },
        geoTransform: result.geoTransform,
      })),
    cb,
  )
}

function reprojectImage(options) {
  options.src._native.reprojectImageSync(options.dst._native, {
    srcWkt: options.s_srs?.wkt,
    dstWkt: options.t_srs?.wkt,
    resampling: options.resampling,
    maxError: options.maxError,
    memoryLimit: options.memoryLimit,
  })
}

function reprojectImageAsync(options, callback) {
  const cb = typeof options === 'function' ? options : callback
  const opts = typeof options === 'function' ? undefined : options
  return withCallback(
    opts.src._native.reprojectImage(opts.dst._native, {
      srcWkt: opts.s_srs?.wkt,
      dstWkt: opts.t_srs?.wkt,
      resampling: opts.resampling,
      maxError: opts.maxError,
      memoryLimit: opts.memoryLimit,
    }),
    cb,
  )
}

function fillNodata(options) {
  options.src._native.fillNoDataSync({
    maxDistance: options.searchDist,
    smoothingIterations: options.smoothingIterations,
  })
}

function fillNodataAsync(options, callback) {
  const cb = typeof options === 'function' ? options : callback
  const opts = typeof options === 'function' ? undefined : options
  return withCallback(
    opts.src._native.fillNoData({
      maxDistance: opts.searchDist,
      smoothingIterations: opts.smoothingIterations,
    }),
    cb,
  )
}

function sieveFilter(options) {
  if (options.dst && options.dst !== options.src) {
    throw new TypeError('gdal.sieveFilter works in place — pass `src` and leave `dst` out (or equal to `src`)')
  }
  options.src._native.sieveFilterSync({
    threshold: options.threshold,
    connectedness: options.connectedness,
  })
}

function sieveFilterAsync(options, callback) {
  const cb = typeof options === 'function' ? options : callback
  const opts = typeof options === 'function' ? undefined : options
  return withCallback(Promise.resolve().then(() => sieveFilter(opts)), cb)
}

/**
 * `gdal_rasterize <args> source destination` — the geometries of a vector source
 * burned into a raster. `destination` is a path (a raster to create or overwrite);
 * `args` are gdal_rasterize's own — `-b`, `-burn`, `-a`, `-l`, `-tr`, `-te`, `-ts`,
 * `-init`, `-at`, ...
 */
function rasterize(destination, source, args) {
  if (typeof destination !== 'string') {
    throw new TypeError('gdal.rasterize needs a destination path — a dataset argument is not supported')
  }
  return wrapDataset(native.rasterizeSync(destination, sourcePath(source), args))
}

function rasterizeAsync(destination, source, args, options, callback) {
  const cb = typeof options === 'function' ? options : callback
  const util = typeof options === 'function' ? undefined : options
  if (typeof destination !== 'string') {
    return withCallback(
      Promise.reject(
        new TypeError('gdal.rasterize needs a destination path — a dataset argument is not supported'),
      ),
      cb,
    )
  }
  return withCallback(
    native.rasterize(destination, sourcePath(source), args, utilProgress(util)).then(wrapDataset),
    cb,
  )
}

/** The field a reference option names by **index**, as this binding's name. */
function fieldNameAt(layer, index) {
  const field = layer._native.defn.fields[index]
  if (!field) throw new RangeError(`no field at index ${index}`)
  return field.name
}

/**
 * `gdal.contourGenerate({ src, dst, offset, interval, fixedLevels, idField, elevField })`
 * — the reference's object form of `band.contourGenerateSync`. Two shape differences
 * are bridged here: the reference names the two fields by **index** where this binding
 * takes a name, and its `progress_cb` has no native counterpart for contouring, so it
 * is called once when the lines are written.
 */
function contourGenerate(options) {
  const request = {
    levels: options.fixedLevels,
    interval: options.interval,
    base: options.offset,
  }
  if (options.elevField !== undefined) request.elevField = fieldNameAt(options.dst, options.elevField)
  if (options.idField !== undefined) request.idField = fieldNameAt(options.dst, options.idField)
  options.src._native.contourGenerateSync(options.dst._native, request)
  if (typeof options.progress_cb === 'function') options.progress_cb()
}

function contourGenerateAsync(options, callback) {
  const cb = typeof options === 'function' ? options : callback
  const opts = typeof options === 'function' ? undefined : options
  return withCallback(Promise.resolve().then(() => contourGenerate(opts)), cb)
}

/**
 * `gdal.polygonize({ src, dst, pixValField, connectedness })` — the reference's object
 * form of `band.polygonizeSync`, with `pixValField` an index and the same single
 * `progress_cb` call.
 */
function polygonize(options) {
  const request = { connectedness: options.connectedness }
  if (options.pixValField !== undefined) request.fieldName = fieldNameAt(options.dst, options.pixValField)
  options.src._native.polygonizeSync(options.dst._native, request)
  if (typeof options.progress_cb === 'function') options.progress_cb()
}

function polygonizeAsync(options, callback) {
  const cb = typeof options === 'function' ? options : callback
  const opts = typeof options === 'function' ? undefined : options
  return withCallback(Promise.resolve().then(() => polygonize(opts)), cb)
}

Object.assign(Gdal, {
  FeatureDefn,
  FieldDefn,
  translate,
  translateAsync,
  vectorTranslate,
  vectorTranslateAsync,
  warp,
  warpAsync,
  buildVRT,
  buildVRTAsync,
  dem,
  demAsync,
  checksumImage,
  checksumImageAsync,
  suggestedWarpOutput,
  suggestedWarpOutputAsync,
  reprojectImage,
  reprojectImageAsync,
  fillNodata,
  fillNodataAsync,
  sieveFilter,
  sieveFilterAsync,
  rasterize,
  rasterizeAsync,
  contourGenerate,
  contourGenerateAsync,
  polygonize,
  polygonizeAsync,
})

// ---- async twins -----------------------------------------------------------
//
// The reference gives most of its blocking methods an `…Async` twin. This binding
// spells the asynchronous form as the plain call, so the adapter's `xxx()` blocks and
// `xxxAsync()` is the promise — the same translation the rest of the layer makes. The
// twins are *shape*, not concurrency: the native call still runs where it had to, on
// the JS thread. They exist because the reference's code calls them by name.

/**
 * Define `<name>Async` on `prototype` for each blocking method. A name that already
 * has an async form is left alone, and a trailing node-style callback is honoured the
 * way every other `…Async` here honours one.
 */
function addAsyncTwins(prototype, names) {
  for (const name of names) {
    if (typeof prototype[name] !== 'function' || typeof prototype[`${name}Async`] === 'function') continue
    Object.defineProperty(prototype, `${name}Async`, {
      configurable: true,
      writable: true,
      value(...args) {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
        const run = () => prototype[name].apply(this, args)
        return withCallback(Promise.resolve().then(run), callback)
      },
    })
  }
}

addAsyncTwins(Geometry.prototype, [
  'toWKT', 'toWKB', 'toJSON', 'toObject', 'toGML', 'toKML',
  'getEnvelope', 'getEnvelope3D', 'getArea', 'getLength', 'getGeometryType',
  'boundary', 'buffer', 'centroid', 'convexHull', 'difference', 'disjoint',
  'flattenTo2D', 'intersection', 'makeValid', 'normalize', 'overlaps',
  'pointOnSurface', 'setPrecision', 'simplify', 'simplifyPreserveTopology',
  'swapXY', 'symDifference', 'unaryUnion', 'union', 'distance',
])
addAsyncTwins(RasterBand.prototype, ['getMetadata', 'setMetadata', 'fill'])
addAsyncTwins(Dataset.prototype, ['getMetadata', 'setMetadata'])
addAsyncTwins(Layer.prototype, ['getMetadata', 'setMetadata'])
addAsyncTwins(Driver.prototype, ['getMetadata'])
addAsyncTwins(LayerFeatures.prototype, ['count', 'get'])
addAsyncTwins(FieldCollection.prototype, ['get', 'getNames', 'indexOf'])
addAsyncTwins(SpatialReference.prototype, [
  'toWKT', 'toProj4', 'getName', 'getAuthorityName', 'getAuthorityCode', 'getAttrValue', 'isSame', 'equals',
])

/**
 * The same for a class's **statics** — the reference's `fromWKTAsync` / `fromURLAsync`
 * and the rest. `klass[name]` is called with `klass` as the receiver, since these are
 * factories rather than instance methods.
 */
function addStaticAsyncTwins(klass, names) {
  for (const name of names) {
    if (typeof klass[name] !== 'function' || typeof klass[`${name}Async`] === 'function') continue
    Object.defineProperty(klass, `${name}Async`, {
      configurable: true,
      writable: true,
      value(...args) {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
        return withCallback(Promise.resolve().then(() => klass[name].apply(klass, args)), callback)
      },
    })
  }
}

addStaticAsyncTwins(Geometry, ['fromWKT', 'fromWKB', 'fromGeoJson', 'fromGeoJsonBuffer'])
addStaticAsyncTwins(SpatialReference, [
  'fromEPSG', 'fromWKT', 'fromProj4', 'fromESRI', 'fromEPSGA', 'fromURN',
  'fromURL', 'fromCRSURL', 'fromUserInput', 'fromWMSAUTO', 'fromMICoordSys',
])

// `dataset.srsAsync` / `layer.srsAsync` — the reference's promise-shaped CRS read. A
// getter, not a call, so no `addAsyncTwins`: the native read is cheap and the promise
// is the reference's shape.
for (const prototype of [Dataset.prototype, Layer.prototype]) {
  Object.defineProperty(prototype, 'srsAsync', {
    configurable: true,
    get() {
      return Promise.resolve(this.srs)
    },
  })
}

module.exports = Gdal
