// Types for the `gdal-async`-shaped adapter.
//
// Hand-written on purpose. This layer exists to change conventions — 1-based
// indexing, `xxx()` / `xxxAsync()`, assignment for setters, the class family — so
// its shape is deliberately *not* the native binding's and cannot be generated
// from it. See `PHASE1.md` (WS-7) for what it covers and what it does not.
//
// The `ts-test/` suite is typed against this file, so a member that is declared
// here but absent at runtime (or the reverse) fails a test rather than a caller.

declare namespace gdal {
  type TypedArray =
    | Int8Array
    | Uint8Array
    | Uint8ClampedArray
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Float32Array
    | Float64Array
    | BigInt64Array
    | BigUint64Array

  /** The `xyz` shape the reference uses for a size — `{ x, y }`, `z` optional. */
  interface XYZ {
    x: number
    y: number
    z?: number
  }

  interface EnvelopeBounds {
    minX: number
    minY: number
    maxX: number
    maxY: number
  }

  /** GDAL's numeric sample-type codes. */
  const GDT_Unknown: number
  const GDT_Byte: number
  const GDT_Int8: number
  const GDT_UInt16: number
  const GDT_Int16: number
  const GDT_UInt32: number
  const GDT_Int32: number
  const GDT_UInt64: number
  const GDT_Int64: number
  const GDT_Float16: number
  const GDT_Float32: number
  const GDT_Float64: number
  const GDT_CInt16: number
  const GDT_CInt32: number
  const GDT_CFloat32: number
  const GDT_CFloat64: number
  const GDT_CFloat16: number
  /** Node v24's `Float16Array`, exported when the runtime has it. */
  const Float16Array:
    | {
        new (length: number): ArrayLike<number>
        from(arrayLike: ArrayLike<number>): ArrayLike<number>
      }
    | undefined

  /** GDAL's field-type, colour, palette, resampling and geometry codes. */
  const OFTInteger: number
  const OFTIntegerList: number
  const OFTInteger64: number
  const OFTInteger64List: number
  const OFTReal: number
  const OFTRealList: number
  const OFTString: number
  const OFTStringList: number
  const OFTWideString: number
  const OFTWideStringList: number
  const OFTBinary: number
  const OFTDate: number
  const OFTTime: number
  const OFTDateTime: number
  const OJUndefined: number
  const OJLeft: number
  const OJRight: number
  const GCI_Undefined: number
  const GCI_GrayIndex: number
  const GCI_PaletteIndex: number
  const GCI_RedBand: number
  const GCI_GreenBand: number
  const GCI_BlueBand: number
  const GCI_AlphaBand: number
  const GPI_Gray: number
  const GPI_RGB: number
  const GPI_CMYK: number
  const GPI_HLS: number
  const GRA_NearestNeighbour: number
  const GRA_Bilinear: number
  const GRA_Cubic: number
  const GRA_CubicSpline: number
  const GRA_Lanczos: number
  const GRA_Average: number
  const GRA_Mode: number
  const CE_None: number
  const CE_Debug: number
  const CE_Warning: number
  const CE_Failure: number
  const CE_Fatal: number
  const GEDTC_NUMERIC: number
  const GEDTC_STRING: number
  const GEDTC_COMPOUND: number
  const wkbUnknown: number
  const wkbPoint: number
  const wkbLineString: number
  const wkbPolygon: number
  const wkbMultiPoint: number
  const wkbMultiLineString: number
  const wkbMultiPolygon: number
  const wkbGeometryCollection: number
  const wkbCircularString: number
  const wkbCompoundCurve: number
  const wkbCurvePolygon: number
  const wkbMultiCurve: number
  const wkbMultiSurface: number
  const wkbCurve: number
  const wkbSurface: number
  const wkbPolyhedralSurface: number
  const wkbTIN: number
  const wkbTriangle: number

  // The families `gdal_sys` cannot hand over — GDAL spells them as C macros. The
  // string ones are the names `testCapability()` already accepts.
  const CPLE_None: number
  const CPLE_AppDefined: number
  const CPLE_OutOfMemory: number
  const CPLE_FileIO: number
  const CPLE_OpenFailed: number
  const CPLE_IllegalArg: number
  const CPLE_NotSupported: number
  const CPLE_AssertionFailed: number
  const CPLE_NoWriteAccess: number
  const CPLE_UserInterrupt: number
  const CPLE_ObjectNull: number
  const DCAP_CREATE: string
  const DCAP_CREATECOPY: string
  const DCAP_VIRTUALIO: string
  const OLCRandomRead: string
  const OLCSequentialWrite: string
  const OLCRandomWrite: string
  const OLCFastSpatialFilter: string
  const OLCFastFeatureCount: string
  const OLCFastGetExtent: string
  const OLCCreateField: string
  const OLCDeleteField: string
  const OLCReorderFields: string
  const OLCAlterFieldDefn: string
  const OLCTransactions: string
  const OLCDeleteFeature: string
  const OLCFastSetNextByIndex: string
  const OLCStringsAsUTF8: string
  const OLCIgnoreFields: string
  const OLCCreateGeomField: string
  const OLCCurveGeometries: string
  const OLCMeasuredGeometries: string
  const OLCZGeometries: string
  const ODsCCreateLayer: string
  const ODsCDeleteLayer: string
  const ODsCCreateGeomFieldAfterCreateLayer: string
  const ODsCTransactions: string
  const ODsCEmulatedTransactions: string
  const ODsCCurveGeometries: string
  const ODsCMeasuredGeometries: string
  const ODsCZGeometries: string
  const ODsCRandomLayerRead: string
  const ODsCRandomLayerWrite: string
  const ODsCAddFieldDomain: string
  const ODsCReadLayerMetadata: string
  const ODrCCreateDataSource: string
  const ODrCDeleteDataSource: string
  const DIM_HORIZONTAL_X: string
  const DIM_HORIZONTAL_Y: string
  const DIM_VERTICAL: string
  const DIM_TEMPORAL: string
  const DIM_PARAMETRIC: string
  const DIR_EAST: string
  const DIR_WEST: string
  const DIR_SOUTH: string
  const DIR_NORTH: string
  const DIR_UP: string
  const DIR_DOWN: string
  const DIR_FUTURE: string
  const DIR_PAST: string
  const GEDTC_String: string
  const GEDTC_Compound: string
  const wkbNone: number
  const wkbLinearRing: number
  const wkb25DBit: number
  const wkbPoint25D: number
  const wkbLineString25D: number
  const wkbPolygon25D: number
  const wkbMultiPoint25D: number
  const wkbMultiLineString25D: number
  const wkbMultiPolygon25D: number
  const wkbGeometryCollection25D: number
  const wkbLinearRing25D: number

  /** Byte-order markers: the strings `MSB` (XDR) and `LSB` (NDR). */
  const wkbXDR: string
  const wkbNDR: string
  /** WKB flavour strings. */
  const wkbVariantIso: string
  const wkbVariantOgc: string
  const wkbVariantOldOgc: string
  /** Access modes (`GDALAccess`) and the raster-IO flag (`GDALRWFlag`). */
  const GA_Readonly: number
  const GA_Update: number
  const GF_Read: number
  const GF_Write: number
  /** Alternate spellings the reference uses. */
  const GRA_NearestNeighbor: string
  /** Driver metadata keys (`GDAL_DMD_*`). */
  const DMD_MIMETYPE: string
  const DMD_EXTENSION: string
  const DMD_LONGNAME: string
  const DMD_HELPTOPIC: string
  const DMD_CREATIONOPTIONLIST: string
  const DMD_CREATIONDATATYPES: string

  /** The reference's `gdal.algebra`: the band algebra as namespace functions. */
  const algebra: {
    abs(arg: RasterBand): RasterBand
    absAsync(arg: RasterBand): Promise<RasterBand>
    sqrt(arg: RasterBand): RasterBand
    sqrtAsync(arg: RasterBand): Promise<RasterBand>
    log(arg: RasterBand): RasterBand
    logAsync(arg: RasterBand): Promise<RasterBand>
    log10(arg: RasterBand): RasterBand
    log10Async(arg: RasterBand): Promise<RasterBand>
    not(arg: RasterBand): RasterBand
    notAsync(arg: RasterBand): Promise<RasterBand>
    add(arg1: RasterBand | number, arg2: RasterBand | number): RasterBand
    addAsync(arg1: RasterBand | number, arg2: RasterBand | number): Promise<RasterBand>
    sub(arg1: RasterBand | number, arg2: RasterBand | number): RasterBand
    subAsync(arg1: RasterBand | number, arg2: RasterBand | number): Promise<RasterBand>
    mul(arg1: RasterBand | number, arg2: RasterBand | number): RasterBand
    mulAsync(arg1: RasterBand | number, arg2: RasterBand | number): Promise<RasterBand>
    div(arg1: RasterBand | number, arg2: RasterBand | number): RasterBand
    divAsync(arg1: RasterBand | number, arg2: RasterBand | number): Promise<RasterBand>
    pow(arg1: RasterBand | number, arg2: RasterBand | number): RasterBand
    powAsync(arg1: RasterBand | number, arg2: RasterBand | number): Promise<RasterBand>
    lt(arg1: RasterBand | number, arg2: RasterBand | number): RasterBand
    ltAsync(arg1: RasterBand | number, arg2: RasterBand | number): Promise<RasterBand>
    lte(arg1: RasterBand | number, arg2: RasterBand | number): RasterBand
    lteAsync(arg1: RasterBand | number, arg2: RasterBand | number): Promise<RasterBand>
    gt(arg1: RasterBand | number, arg2: RasterBand | number): RasterBand
    gtAsync(arg1: RasterBand | number, arg2: RasterBand | number): Promise<RasterBand>
    gte(arg1: RasterBand | number, arg2: RasterBand | number): RasterBand
    gteAsync(arg1: RasterBand | number, arg2: RasterBand | number): Promise<RasterBand>
    eq(arg1: RasterBand | number, arg2: RasterBand | number): RasterBand
    eqAsync(arg1: RasterBand | number, arg2: RasterBand | number): Promise<RasterBand>
    notEq(arg1: RasterBand | number, arg2: RasterBand | number): RasterBand
    notEqAsync(arg1: RasterBand | number, arg2: RasterBand | number): Promise<RasterBand>
    and(arg1: RasterBand | number, arg2: RasterBand | number): RasterBand
    andAsync(arg1: RasterBand | number, arg2: RasterBand | number): Promise<RasterBand>
    or(arg1: RasterBand | number, arg2: RasterBand | number): RasterBand
    orAsync(arg1: RasterBand | number, arg2: RasterBand | number): Promise<RasterBand>
    min(...args: RasterBand[]): RasterBand
    minAsync(...args: RasterBand[]): Promise<RasterBand>
    max(...args: RasterBand[]): RasterBand
    maxAsync(...args: RasterBand[]): Promise<RasterBand>
    mean(...args: RasterBand[]): RasterBand
    meanAsync(...args: RasterBand[]): Promise<RasterBand>
    ifThenElse(arg1: RasterBand, arg2: RasterBand | number, arg3: RasterBand | number): RasterBand
    ifThenElseAsync(
      arg1: RasterBand,
      arg2: RasterBand | number,
      arg3: RasterBand | number,
    ): Promise<RasterBand>
    asType(arg: RasterBand, type: string): RasterBand
    asTypeAsync(arg: RasterBand, type: string): Promise<RasterBand>
  }

  class Geometry {
    readonly type: string
    readonly isEmpty: boolean
    readonly pointCount: number
    readonly coordinates: any
    readonly x: number | null
    readonly y: number | null
    readonly z: number | null
    readonly exteriorRing: number[][] | null
    readonly interiorRings: number[][][] | null

    static fromWKT(wkt: string): Geometry
    static fromWKB(wkb: Uint8Array): Geometry
    static fromGeoJson(json: any): Geometry
    static fromGeoJsonBuffer(buffer: Uint8Array): Geometry
    static fromWKTAsync(wkt: string): Promise<Geometry>
    static fromWKBAsync(wkb: Uint8Array): Promise<Geometry>
    static fromGeoJsonAsync(json: any): Promise<Geometry>
    static fromGeoJsonBufferAsync(buffer: Uint8Array): Promise<Geometry>
    /** An empty geometry from a WKB type code or a type name. */
    static create(type: number | string): Geometry
    /** The subclass name for a WKB type code. */
    static getName(type: number): string | null

    toWKT(): string
    toWKB(): Uint8Array
    toJSON(): any
    toObject(): any
    toGML(): string
    toKML(altitudeMode?: string): string
    getGeometryType(): string
    getEnvelope(): Envelope
    getEnvelope3D(): Envelope3D
    getEnvelopeAsync(): Promise<Envelope>
    getEnvelope3DAsync(): Promise<Envelope3D>
    getArea(): number
    getLength(): number
    envelope(): { minX: number; minY: number; maxX: number; maxY: number } | null
    area(): number
    length(): number
    /** The reference's editable point list, callable for the native `points()` array. */
    readonly points: LineStringPoints
    /** A polygon's rings, callable for the native `rings()` array. */
    readonly rings: PolygonRings
    /** A collection's parts, callable for the native `children()` array. */
    readonly children: GeometryCollectionChildren
    /** A compound curve's curves, callable for the native `children()` array. */
    readonly curves: CompoundCurveCurves

    // The mutable builder, inherited from the native class.
    addPoint(x: number, y: number, z?: number): void
    setPoint(index: number, x: number, y: number, z?: number): void
    resizePoints(count: number): void
    addGeometry(geometry: Geometry): void
    removeGeometry(index: number): void
    closeRings(): void
    addSubLineString(line: LineString, start?: number, end?: number): void
    empty(): void

    clone(): Geometry
    flattenTo2D(): Geometry
    segmentize(maxLength: number): Geometry
    swapXY(): Geometry
    transform(from: SpatialReference, to: SpatialReference): Geometry
    transform(transformation: CoordinateTransformation): Geometry
    /** Refuses: a geometry here carries no source CRS — use `transform(from, to)`. */
    transformTo(srs: SpatialReference): never
    isRing(): boolean
    isValid(): boolean
    isSimple(): boolean
    intersects(other: Geometry): boolean
    contains(other: Geometry): boolean
    within(other: Geometry): boolean
    crosses(other: Geometry): boolean
    touches(other: Geometry): boolean
    overlaps(other: Geometry): boolean
    disjoint(other: Geometry): boolean
    equals(other: Geometry): boolean
    distance(other: Geometry): number
    buffer(distance: number, quadSegments?: number): Geometry
    centroid(): Geometry
    convexHull(): Geometry
    concaveHull(ratio: number, allowHoles?: boolean): Geometry
    simplify(tolerance: number): Geometry
    simplifyPreserveTopology(tolerance: number): Geometry
    union(other: Geometry): Geometry
    intersection(other: Geometry): Geometry
    difference(other: Geometry): Geometry
    symDifference(other: Geometry): Geometry
    makeValid(): Geometry
    boundary(): Geometry
    pointOnSurface(): Geometry
    unaryUnion(): Geometry
    unionCascaded(): Geometry
    normalize(): Geometry
    setPrecision(gridSize: number): Geometry

    /** The class a numeric `wkb*` type stands for, or `null` for `wkbUnknown`. */
    static getConstructor(wkbType: number): typeof Geometry | null
    /** This geometry's numeric `wkb*` type — `gdal.Point.wkbType`'s instance side. */
    readonly wkbType: number
    /** The WKB serialization's size in bytes. */
    readonly wkbSize: number
    /** 2 or 3, according to whether the coordinates carry a Z. M does not count. */
    readonly coordinateDimension: number
    /** Topological dimension: 0 for a point, 1 for a line, 2 for a surface. */
    readonly dimension: number

    // The reference's `…Async` spellings. They are shape, not concurrency: the native
    // call still blocks where it has to.
    toWKTAsync(): Promise<string>
    toWKBAsync(): Promise<Uint8Array>
    toJSONAsync(): Promise<any>
    toObjectAsync(): Promise<any>
    toGMLAsync(): Promise<string>
    toKMLAsync(altitudeMode?: string): Promise<string>
    getAreaAsync(): Promise<number>
    getLengthAsync(): Promise<number>
    getGeometryTypeAsync(): Promise<string>
    bufferAsync(distance: number, quadSegments?: number): Promise<Geometry>
    centroidAsync(): Promise<Geometry>
    convexHullAsync(): Promise<Geometry>
    boundaryAsync(): Promise<Geometry>
    makeValidAsync(): Promise<Geometry>
    normalizeAsync(): Promise<Geometry>
    distanceAsync(other: Geometry): Promise<number>
    disjointAsync(other: Geometry): Promise<boolean>
    overlapsAsync(other: Geometry): Promise<boolean>
    unionAsync(other: Geometry): Promise<Geometry>
    intersectionAsync(other: Geometry): Promise<Geometry>
    differenceAsync(other: Geometry): Promise<Geometry>
    simplifyAsync(tolerance: number): Promise<Geometry>
    simplifyPreserveTopologyAsync(tolerance: number): Promise<Geometry>
    flattenTo2DAsync(): Promise<Geometry>
    transformAsync(transformation: CoordinateTransformation): Promise<Geometry>
    transformAsync(from: SpatialReference, to: SpatialReference): Promise<Geometry>
    transformToAsync(srs: SpatialReference): Promise<never>
    closeRingsAsync(): Promise<void>
    emptyAsync(): Promise<void>
    intersectsAsync(other: Geometry): Promise<boolean>
    containsAsync(other: Geometry): Promise<boolean>
    withinAsync(other: Geometry): Promise<boolean>
    crossesAsync(other: Geometry): Promise<boolean>
    touchesAsync(other: Geometry): Promise<boolean>
    equalsAsync(other: Geometry): Promise<boolean>
    isEmptyAsync(): Promise<boolean>
    isValidAsync(): Promise<boolean>
    isSimpleAsync(): Promise<boolean>
    isRingAsync(): Promise<boolean>
  }

  /** The base of the line-like shapes, in the reference's hierarchy. */
  class SimpleCurve extends Geometry {
    constructor()
    static wkbType: number
  }
  class Point extends Geometry {
    constructor(x?: number, y?: number, z?: number)
    static wkbType: number
  }
  class LineString extends SimpleCurve {
    constructor()
    static wkbType: number
  }
  class LinearRing extends LineString {
    constructor()
    static wkbType: number
  }
  class CircularString extends SimpleCurve {
    constructor()
    static wkbType: number
  }
  class Polygon extends Geometry {
    constructor()
    static wkbType: number
  }
  class MultiPoint extends Geometry {
    constructor()
    static wkbType: number
  }
  class MultiLineString extends Geometry {
    constructor()
    static wkbType: number
  }
  class MultiPolygon extends Geometry {
    constructor()
    static wkbType: number
  }
  class GeometryCollection extends Geometry {
    constructor()
    static wkbType: number
  }
  class CompoundCurve extends Geometry {
    constructor()
    static wkbType: number
  }
  class MultiCurve extends GeometryCollection {
    constructor()
    static wkbType: number
  }

  /** A band's palette, in the reference's shape. */
  interface ColorTableEntry {
    c1: number
    c2: number
    c3: number
    c4: number
  }
  class ColorTable {
    constructor(interpretation?: number | string, entries?: ColorTableEntry[])
    readonly interpretation: number
    /** The band this table belongs to, or `null` for a standalone one. */
    readonly band: RasterBand | null
    count(): number
    get(index: number): ColorTableEntry | undefined
    set(index: number, color: ColorTableEntry): void
    clone(): ColorTable
    isSame(other: ColorTable): boolean
    ramp(start: number, startColor: ColorTableEntry, end: number, endColor: ColorTableEntry): void
    toArray(): ColorTableEntry[]
    forEach(callback: (color: ColorTableEntry, index: number) => void): void
    map<U>(callback: (color: ColorTableEntry, index: number) => U): U[]
    [Symbol.iterator](): Iterator<ColorTableEntry>
  }

  function fromWKT(wkt: string): Geometry
  function fromWKB(wkb: Uint8Array): Geometry
  function fromJSON(json: any): Geometry
  function fromObject(json: any): Geometry
  const geometryFromWKT: typeof fromWKT
  const geometryFromWKB: typeof fromWKB
  const geometryFromJSON: typeof fromJSON

  class Envelope {
    constructor(bounds?: Partial<EnvelopeBounds>)
    minX: number
    minY: number
    maxX: number
    maxY: number
    isEmpty(): boolean
    merge(x: Envelope | number, y?: number): this
    intersects(other: Envelope): boolean
    contains(other: Envelope): boolean
    intersect(other: Envelope): this
    toPolygon(): Polygon
  }

  class Envelope3D extends Envelope {
    constructor(bounds?: Partial<EnvelopeBounds> & { minZ?: number; maxZ?: number })
    minZ: number
    maxZ: number
    merge(x: Envelope3D | number, y?: number, z?: number): this
    contains(other: Envelope3D): boolean
    intersects(other: Envelope3D): boolean
  }

  class SpatialReference {
    constructor(wktOrDefinition: string | SpatialReference)
    static fromEPSG(code: number): SpatialReference
    static fromWKT(wkt: string): SpatialReference
    static fromProj4(proj4: string): SpatialReference
    static fromESRI(esriWkt: string): SpatialReference
    static fromEPSGA(code: number): SpatialReference
    static fromURN(urn: string): SpatialReference
    static fromURL(url: string): SpatialReference
    static fromCRSURL(url: string): SpatialReference
    static fromUserInput(definition: string): SpatialReference
    static fromWMSAUTO(definition: string): SpatialReference
    static fromMICoordSys(definition: string): SpatialReference
    /** A CRS in XML — the form `toXML()` produces. */
    static fromXML(xml: string): SpatialReference
    static fromEPSGAsync(code: number): Promise<SpatialReference>
    static fromWKTAsync(wkt: string): Promise<SpatialReference>
    static fromProj4Async(proj4: string): Promise<SpatialReference>
    static fromESRIAsync(esriWkt: string): Promise<SpatialReference>
    static fromEPSGAAsync(code: number): Promise<SpatialReference>
    static fromURNAsync(urn: string): Promise<SpatialReference>
    static fromURLAsync(url: string): Promise<SpatialReference>
    static fromCRSURLAsync(url: string): Promise<SpatialReference>
    static fromUserInputAsync(definition: string): Promise<SpatialReference>
    static fromWMSAUTOAsync(definition: string): Promise<SpatialReference>
    static fromMICoordSysAsync(definition: string): Promise<SpatialReference>
    static fromXMLAsync(xml: string): Promise<SpatialReference>

    readonly wkt: string
    readonly prettyWkt: string
    readonly proj4: string
    readonly projJson: string
    readonly name: string | null
    readonly authName: string | null
    readonly authCode: number | null
    readonly authority: string | null
    readonly axisMapping: string
    readonly areaOfUse: any
    readonly linearUnit: { name: string; factor: number } | null
    readonly angularUnit: { name: string; factor: number } | null
    readonly isGeographic: boolean
    readonly isProjected: boolean
    readonly isCompound: boolean
    readonly isVertical: boolean
    readonly isGeocentric: boolean
    readonly isLocal: boolean
    readonly epsgTreatsAsLatLong: boolean
    /** The reference's capitalisation of the same question. */
    readonly EPSGTreatsAsLatLong: boolean
    readonly EPSGTreatsAsNorthingEasting: boolean

    clone(): SpatialReference
    toWKT(): string
    toPrettyWKT(): string
    toProj4(): string
    toXML(): string
    getName(): string | null
    getAuthorityName(): string | null
    getAuthorityCode(): string | null
    getAngularUnits(): number
    getLinearUnits(): number
    getAttrValue(name: string, child?: number): string | null
    isSame(other: SpatialReference): boolean
    isSameGeogCS(other: SpatialReference): boolean
    isSameVertCS(other: SpatialReference): boolean
    equals(other: SpatialReference): boolean
    validate(): boolean
    autoIdentifyEPSG(): void
    cloneGeogCS(): SpatialReference
    setWellKnownGeogCS(name: string): void
    morphToESRI(): void
    morphFromESRI(): void
    withAxisMapping(mapping: string): SpatialReference
  }

  class CoordinateTransformation {
    constructor(source: SpatialReference, target: SpatialReference)
    transformPoint(point: { x: number; y: number; z?: number }): { x: number; y: number; z: number }
    transformPoint(x: number, y: number, z?: number): { x: number; y: number; z: number }
    transformGeometry(geometry: Geometry): Geometry
  }

  class Driver {
    readonly name: string
    readonly description: string
    readonly longName: string
    testCapability(name: string): boolean
    getMetadata(domain?: string): Record<string, string>
    toString(): string
    create(path: string, xSize: number, ySize: number, bandCount: number, dataType: number | string, options?: object): Dataset
    createAsync(path: string, xSize: number, ySize: number, bandCount: number, dataType: number | string, options?: object): Promise<Dataset>
    createCopy(path: string, source: Dataset, options?: object): Dataset
    createCopyAsync(path: string, source: Dataset, options?: object): Promise<Dataset>
    open(path: string, mode?: string): Dataset
    openAsync(path: string, mode?: string): Promise<Dataset>
    deleteDataset(path: string): void
    delete(path: string): void
    copyFiles(newName: string, oldName: string): void
    rename(newName: string, oldName: string): void
  }

  class Collection<T> {
    count(): number
    countAsync(callback?: (error: Error | null, count?: number) => void): Promise<number> | undefined
    getAsync(key?: any, callback?: (error: Error | null, item?: T | null) => void): Promise<T | null> | undefined
    forEach(callback: (item: T, index: number) => void): void
    map<U>(callback: (item: T, index: number) => U): U[]
    [Symbol.iterator](): Iterator<T>
    [Symbol.asyncIterator](): AsyncIterator<T>
  }

  class GDALDrivers extends Collection<Driver> {
    get(nameOrIndex: string | number): Driver | null
    getNames(): string[]
  }
  /** The reference's name for the driver collection. */
  class DriverCollection extends GDALDrivers {}

  class DatasetBands extends Collection<RasterBand> {
    readonly ds: Dataset
    get(index: number): RasterBand | null
    /** The dataset's envelope, as the reference's `Envelope`. */
    getEnvelope(): Envelope | null
    /** Add a band — GDAL's `GDALAddBand`. */
    create(dataType: number | string, options?: object): RasterBand
    createAsync(dataType: number | string, options?: object): Promise<RasterBand>
  }

  class BandPixels {
    readonly xSize: number
    readonly ySize: number
    /** The band this pixel view belongs to. */
    readonly band: RasterBand
    get(x: number, y: number): number
    set(x: number, y: number, value: number): void
    getAsync(x: number, y: number, callback?: (error: Error | null, value?: number) => void): Promise<number> | undefined
    setAsync(x: number, y: number, value: number, callback?: (error: Error | null) => void): Promise<void> | undefined
    /** The size of the block holding `(x, y)`, clipped to the band's edge. */
    clampBlock(x: number, y: number): XYZ
    clampBlockAsync(x: number, y: number, callback?: (error: Error | null, size?: XYZ) => void): Promise<XYZ> | undefined
    read(x: number, y: number, width: number, height: number, data?: ArrayBufferView, type?: number | string): any
    readAsync(
      x: number,
      y: number,
      width: number,
      height: number,
      callback: (error: Error | null, values?: any) => void,
    ): void
    write(x: number, y: number, width: number, height: number, data: ArrayBufferView): void
    createReadStream(options?: object): any
    createWriteStream(options?: object): any
    readBlock(x: number, y: number): Buffer
    writeBlock(x: number, y: number, data: ArrayBufferView): void
  }
  /** The reference's name for the pixel accessors. */
  class RasterBandPixels extends BandPixels {}

  class RasterBandOverviews extends Collection<unknown> {
    get(index: number): unknown | null
    getBySampleCount(samples: number): unknown | null
    getBySampleCountAsync(samples: number): Promise<unknown | null>
  }

  interface BandStatistics {
    min: number
    max: number
    mean: number
    stdDev: number
  }

  class RasterBand {
    readonly pixels: BandPixels
    /** The dataset this band belongs to. */
    readonly ds: Dataset | null
    readonly size: XYZ
    readonly blockSize: XYZ
    readonly sizeAsync: Promise<XYZ>
    readonly blockSizeAsync: Promise<XYZ>
    readonly dataType: number
    readonly dataTypeAsync: Promise<number>
    readonly colorInterpretation: string
    readonly colorInterpretationAsync: Promise<string>
    readonly descriptionAsync: Promise<string | null>
    readonly unitTypeAsync: Promise<string | null>
    readonly noDataValueAsync: Promise<number | null>
    readonly scaleAsync: Promise<number | null>
    readonly offsetAsync: Promise<number | null>
    readonly minimumAsync: Promise<number | null>
    readonly maximumAsync: Promise<number | null>
    readonly idAsync: Promise<number>
    readonly readOnlyAsync: Promise<boolean>
    readonly hasArbitraryOverviewsAsync: Promise<boolean>
    readonly categoryNamesAsync: Promise<string[]>
    readonly overviews: RasterBandOverviews
    readonly categoryNames: string[]
    /** The palette, as a `ColorTable` object; assign one (or `null` to clear). */
    colorTable: ColorTable | null | undefined
    readonly colorTableAsync: Promise<ColorTable | undefined>
    readonly id: number | null
    readonly minimum: number | null
    readonly maximum: number | null
    readonly offset: number | null
    readonly scale: number | null
    readonly unitType: string | null
    readonly readOnly: boolean
    readonly hasArbitraryOverviews: boolean
    description: string | null
    /** Assignment, where the native binding has `setNoDataValue`. */
    noDataValue: number | null
    getStatistics(allowApproximation?: boolean, force?: boolean): BandStatistics | null
    computeStatistics(
      allowApproximation?: boolean,
      force?: boolean,
      callback?: (error: Error | null, statistics?: BandStatistics | null) => void,
    ): Promise<BandStatistics | null> | BandStatistics | null | undefined
    computeStatisticsAsync(allowApproximation?: boolean, force?: boolean): Promise<BandStatistics | null>
    fill(value: number): void
    fillAsync(value: number): Promise<void>
    asMDArray(): MDArray
    getMaskBand(): RasterBand
    getMaskFlags(): number
    createMaskBand(perDataset?: boolean): void
    getMetadata(domain?: string): Record<string, string>
    getMetadataAsync(domain?: string): Promise<Record<string, string>>
    setMetadata(values: Record<string, unknown> | string[], domain?: string): boolean
    setMetadataAsync(values: Record<string, unknown> | string[], domain?: string): Promise<boolean>
    flush(): void
    flushAsync(callback?: (error: Error | null) => void): Promise<void> | undefined
    /** Convert to another sample type, as a band of a new in-memory dataset. */
    asType(dataType: number | string): RasterBand
    asTypeAsync(dataType: number | string): Promise<RasterBand>
    setStatistics(min: number, max: number, mean: number, stdDev: number): void
    setStatistics(statistics: BandStatistics): void
    add(other: RasterBand | number): RasterBand
    sub(other: RasterBand | number): RasterBand
    mul(other: RasterBand | number): RasterBand
    div(other: RasterBand | number): RasterBand
    pow(other: RasterBand | number): RasterBand
    abs(): RasterBand
    sqrt(): RasterBand
    log(): RasterBand
    log10(): RasterBand
    eq(other: RasterBand | number): RasterBand
    notEq(other: RasterBand | number): RasterBand
    lt(other: RasterBand | number): RasterBand
    lte(other: RasterBand | number): RasterBand
    gt(other: RasterBand | number): RasterBand
    gte(other: RasterBand | number): RasterBand
    and(other: RasterBand | number): RasterBand
    or(other: RasterBand | number): RasterBand
    not(): RasterBand
    ifThenElse(thenValue: RasterBand | number, elseValue: RasterBand | number): RasterBand
    addAsync(other: RasterBand | number): Promise<RasterBand>
    subAsync(other: RasterBand | number): Promise<RasterBand>
    mulAsync(other: RasterBand | number): Promise<RasterBand>
    divAsync(other: RasterBand | number): Promise<RasterBand>
    powAsync(other: RasterBand | number): Promise<RasterBand>
    absAsync(): Promise<RasterBand>
    sqrtAsync(): Promise<RasterBand>
    logAsync(): Promise<RasterBand>
    log10Async(): Promise<RasterBand>
    eqAsync(other: RasterBand | number): Promise<RasterBand>
    notEqAsync(other: RasterBand | number): Promise<RasterBand>
    ltAsync(other: RasterBand | number): Promise<RasterBand>
    lteAsync(other: RasterBand | number): Promise<RasterBand>
    gtAsync(other: RasterBand | number): Promise<RasterBand>
    gteAsync(other: RasterBand | number): Promise<RasterBand>
    andAsync(other: RasterBand | number): Promise<RasterBand>
    orAsync(other: RasterBand | number): Promise<RasterBand>
    notAsync(): Promise<RasterBand>
    ifThenElseAsync(thenValue: RasterBand | number, elseValue: RasterBand | number): Promise<RasterBand>
  }

  class FeatureFields {
    /** The feature this view belongs to. */
    readonly feature: Feature
    readonly names: string[]
    readonly count: number
    getNames(): string[]
    get(name: string): any
    set(name: string, value: any): this
    has(name: string): boolean
    toObject(): Record<string, any>
    toArray(): any[]
    indexOf(name: string): number
    map<U>(callback: (value: any, name: string) => U): U[]
    toJSON(): string
    reset(values?: Record<string, any>): void
    forEach(callback: (value: any, name: string) => void): void
    [Symbol.iterator](): Iterator<string>
  }

  class Feature {
    readonly fid: number | null
    readonly fields: FeatureFields
    readonly defn: FeatureDefn
    geometry: Geometry | null
    getGeometry(): Geometry | null
    setGeometry(geometry: Geometry | null): void
    /** OGR's style string, or `null` — which drivers keep one is the driver's answer. */
    getStyleString(): string | null
    setStyleString(style: string | null): void
    equals(other: Feature): boolean
    /** A second handle on the same row — a feature here is live, not a copy. */
    clone(): Feature
    destroy(): void
    setFrom(other: Feature | Record<string, any>, indexMap?: number[], forgiving?: boolean): void
  }

  class FeatureDefn {
    readonly name: string
    readonly geomType: string
    readonly geomIgnored: boolean
    readonly styleIgnored: boolean
    readonly fields: FieldCollection
    clone(): FeatureDefn
  }

  /**
   * A field definition, as the reference builds one: `new FieldDefn(name, type)`.
   * `type` is this binding's field-type name, or one of the numeric `OFT*` codes.
   * `layer.fields.add` and `layers.create({ fields: [...] })` take it.
   */
  class FieldDefn {
    constructor(name: string, type?: string | number)
    name: string
    type: string
    width: number
    precision: number
    nullable: boolean
    unique: boolean
    defaultValue: string | null
    justification: string
    ignored: boolean
    toObject(): Record<string, any>
  }

  class LayerFeatures extends Collection<Feature> {
    readonly layer: Layer
    get(fid: number): Feature | null
    first(): Feature | null
    last(): Feature | null
    next(): Feature | null
    previous(): Feature | null
    firstAsync(callback?: (error: Error | null, feature?: Feature | null) => void): Promise<Feature | null> | undefined
    nextAsync(callback?: (error: Error | null, feature?: Feature | null) => void): Promise<Feature | null> | undefined
    add(feature: Feature | Geometry | any, properties?: Record<string, any>): Feature | null
    addAsync(feature: Feature | Geometry | any, properties?: Record<string, any>): Promise<Feature | null>
    set(fid: number, feature: Feature | Geometry | any): Feature | Geometry
    set(feature: Feature): Feature
    setAsync(fid: number, feature: Feature | Geometry | any): Promise<Feature | Geometry>
    remove(fid: number): void
    removeAsync(fid: number): Promise<void>
  }

  class FieldCollection extends Collection<any> {
    static fromJSON(object: Record<string, any>): FieldCollection
    static fromObject(object: Record<string, any>): FieldCollection
    readonly layer: Layer
    /** The `FeatureDefn` this collection is the field list of, when it is one. */
    readonly featureDefn: FeatureDefn | null
    get(name: string): any | null
    get(index: number): any | null
    getNames(): string[]
    indexOf(name: string): number
    add(definition: FieldDefn | object): any
    remove(name: string): void
    reorder(names: string[]): void
  }
  /** The reference's name for the field collection. */
  class LayerFields extends FieldCollection {}

  class DatasetLayers extends Collection<Layer> {
    readonly ds: Dataset
    get(name: string): Layer | null
    get(index: number): Layer | null
    create(
      name: string,
      srs?: SpatialReference | string | null,
      geomType?: string,
      options?: { fields?: Array<FieldDefn | object>; [key: string]: any },
    ): Layer
    createAsync(
      name: string,
      srs?: SpatialReference | string | null,
      geomType?: string,
      options?: { fields?: Array<FieldDefn | object>; [key: string]: any },
    ): Promise<Layer>
    copy(source: Layer, name: string, options?: object): Layer
    copyAsync(source: Layer, name: string, options?: object): Promise<Layer>
    remove(nameOrIndex: string | number): void
    removeAsync(nameOrIndex: string | number): Promise<void>
  }

  class Layer {
    readonly ds: Dataset | null
    readonly name: string
    readonly geomType: string
    readonly defn: FeatureDefn
    readonly fidColumn: string | null
    readonly geomColumn: string | null
    /** Assignment, where the native binding has `setSpatialRef`. */
    srs: SpatialReference | string | null
    readonly srsAsync: Promise<SpatialReference | null>
    readonly extent: { minX: number; minY: number; maxX: number; maxY: number } | null
    readonly fields: FieldCollection
    readonly features: LayerFeatures
    setSpatialFilter(geometry: Geometry | Record<string, unknown> | null): void
    getSpatialFilter(): Geometry | null
    setAttributeFilter(filter: string | null): void
    testCapability(name: string): boolean
    getExtent(): { minX: number; minY: number; maxX: number; maxY: number } | null
    getMetadata(domain?: string): Record<string, string>
    flush(): void
    flushAsync(callback?: (error: Error | null) => void): Promise<void> | undefined
  }

  class Dataset {
    constructor(nativeDataset: any)
    readonly bands: DatasetBands
    readonly layers: DatasetLayers
    readonly description: string
    readonly driver: Driver
    readonly rasterSize: XYZ
    readonly rasterSizeAsync: Promise<XYZ>
    readonly geoTransformAsync: Promise<number[] | null>
    readonly threadSafe: boolean
    readonly root: Group | null
    /** Assignment, where the native binding has `setProjection`. */
    srs: SpatialReference | string | null
    readonly srsAsync: Promise<SpatialReference | null>
    /** Assignment, where the native binding has `setGeoTransform`. */
    geoTransform: number[] | null
    getFileList(): string[]
    getGCPProjection(): string | null
    /** The dataset's bounding box as the reference's `Envelope`, or `null`. */
    getEnvelope(): Envelope | null
    getGCPs(): Array<{ id: string; info: string; pixel: number; line: number; x: number; y: number; z: number }>
    setGCPs(
      gcps: Array<{ id: string; info?: string; pixel: number; line: number; x: number; y: number; z?: number }>,
      projection?: string | null,
    ): void
    getMetadata(domain?: string): Record<string, string>
    getMetadataAsync(domain?: string): Promise<Record<string, string>>
    setMetadata(values: Record<string, unknown> | string[], domain?: string): boolean
    setMetadataAsync(values: Record<string, unknown> | string[], domain?: string): Promise<boolean>
    executeSQL(sql: string, dialect?: string): any[]
    executeSQLAsync(sql: string, dialect?: string): Promise<any[]>
    /** A datasource capability question, in GDAL's own names. */
    testCapability(name: string): boolean
    buildOverviews(options?: object): void
    buildOverviewsAsync(options?: object): Promise<void>
    flush(): void
    flushAsync(callback?: (error: Error | null) => void): Promise<void> | undefined
    close(): void
  }

  // ---- multidimensional model ----------------------------------------------

  class Attribute {
    readonly name: string
    readonly description: string
    readonly dataType: string
    readonly value: any
  }

  class Dimension {
    readonly name: string
    readonly description: string
    readonly size: number
    readonly type: string
    readonly direction: string | null
  }

  class MDArray {
    readonly ds: any
    readonly name: string
    readonly description: string
    readonly dataType: string
    readonly length: number
    readonly noDataValue: number | null
    readonly offset: number | null
    readonly scale: number | null
    readonly unitType: string | null
    readonly srs: SpatialReference | null
    readonly attributes: ArrayAttributes
    readonly dimensions: ArrayDimensions
    read(start?: number[], count?: number[]): TypedArray
    asDataset(): Dataset
    getMask(): MDArray
    getView(expression: string): MDArray
  }

  class Group {
    readonly ds: any
    readonly name: string
    readonly description: string
    readonly arrays: GroupArrays
    readonly groups: GroupGroups
    readonly attributes: GroupAttributes
    readonly dimensions: GroupDimensions
  }

  class GroupArrays extends Collection<MDArray> {
    readonly names: string[]
    get(name: string): MDArray | null
    get(index: number): MDArray | null
    getNames(): string[]
  }
  class GroupGroups extends Collection<Group> {
    readonly names: string[]
    get(name: string): Group | null
    get(index: number): Group | null
    getNames(): string[]
  }
  class GroupAttributes extends Collection<Attribute> {
    readonly names: string[]
    get(name: string): Attribute | null
    get(index: number): Attribute | null
    getNames(): string[]
  }
  class GroupDimensions extends Collection<Dimension> {
    readonly names: string[]
    get(name: string): Dimension | null
    get(index: number): Dimension | null
    getNames(): string[]
  }
  class ArrayAttributes extends Collection<Attribute> {
    readonly names: string[]
    get(name: string): Attribute | null
    get(index: number): Attribute | null
    getNames(): string[]
  }
  class ArrayDimensions extends Collection<Dimension> {
    readonly names: string[]
    get(name: string): Dimension | null
    get(index: number): Dimension | null
    getNames(): string[]
  }
  /** The reference's name for a group's dimension collection. */
  class Dimensions extends GroupDimensions {}
  /** The reference's name for a `FeatureDefn`'s field collection. */
  class FeatureDefnFields extends FieldCollection {}
  /**
   * The reference's point list. Callable for the native `points()` array (this
   * binding's spelling), with `add` / `set` / `get` and the rest over native
   * `addPoint` / `setPoint`.
   */
  interface LineStringPoints {
    (): number[][] | null
    count(): number
    get(index: number): Point
    add(x: number, y: number, z?: number): void
    add(
      point:
        | Point
        | { x: number; y: number; z?: number }
        | Array<Point | { x: number; y: number; z?: number } | number[]>,
    ): void
    set(index: number, x: number, y: number, z?: number): void
    set(index: number, point: Point | { x: number; y: number; z?: number }): void
    resize(count: number): void
    reverse(): void
    forEach(callback: (point: Point, index: number) => unknown): void
    map<T>(callback: (point: Point, index: number) => T): T[]
    toArray(): Point[]
    [Symbol.iterator](): Iterator<Point>
  }
  class LineStringPoints {}

  /** The reference's ring list. Callable for the native `rings()` array. */
  interface PolygonRings {
    (): number[][][] | null
    count(): number
    get(index: number): LinearRing
    add(ring: LinearRing | LinearRing[]): void
    forEach(callback: (ring: LinearRing, index: number) => unknown): void
    map<T>(callback: (ring: LinearRing, index: number) => T): T[]
    toArray(): LinearRing[]
    [Symbol.iterator](): Iterator<LinearRing>
  }
  class PolygonRings {}

  /** The reference's child list. Callable for the native `children()` array. */
  interface GeometryCollectionChildren {
    (): Geometry[] | null
    count(): number
    get(index: number): Geometry
    add(child: Geometry | Geometry[]): void
    remove(index: number): void
    forEach(callback: (child: Geometry, index: number) => unknown): void
    map<T>(callback: (child: Geometry, index: number) => T): T[]
    toArray(): Geometry[]
    [Symbol.iterator](): Iterator<Geometry>
  }
  class GeometryCollectionChildren {}

  /** A compound curve's curves. Callable for the native `children()` array. */
  interface CompoundCurveCurves {
    (): Geometry[] | null
    count(): number
    get(index: number): SimpleCurve
    add(curve: SimpleCurve | SimpleCurve[]): void
    forEach(callback: (curve: SimpleCurve, index: number) => unknown): void
    map<T>(callback: (curve: SimpleCurve, index: number) => T): T[]
    toArray(): SimpleCurve[]
    [Symbol.iterator](): Iterator<SimpleCurve>
  }
  class CompoundCurveCurves {}

  // ---- streams and pixel-wise calc -----------------------------------------

  /** The object-mode `Readable` a `band.pixels.createReadStream()` answers. */
  class RasterReadStream extends import('node:stream').Readable {}
  /** The object-mode `Writable` a `band.pixels.createWriteStream()` answers. */
  class RasterWriteStream extends import('node:stream').Writable {}

  class RasterMuxStream {
    constructor(inputs: Record<string, any>, options?: object)
    pipe(destination: any): any
    on(event: string, listener: (...args: any[]) => void): this
  }

  class RasterTransform {
    constructor(options: { fn: (...args: any[]) => number; type?: string | (new (length: number) => TypedArray) })
    pipe(destination: any): any
    on(event: string, listener: (...args: any[]) => void): this
  }

  // ---- module-level API -----------------------------------------------------

  const bundled: boolean
  let eventLoopWarning: boolean | number
  const config: {
    get(key: string, defaultValue?: string): string | null
    set(key: string, value: string | null): void
  }
  const fs: {
    readFile(path: string): Buffer
    writeFile(path: string, data: Buffer | Uint8Array): void
    exists(path: string): boolean
    stat(path: string): { size: number; isFile: boolean; isDirectory: boolean; modifiedMs: number } | null
    mkdir(path: string): void
    mkdirRecursive(path: string): void
    rmdir(path: string): void
    rmdirRecursive(path: string): void
    unlink(path: string): void
    rename(from: string, to: string): void
    copyFile(from: string, to: string): void
    readDir(path: string, recursive?: boolean): string[]
    glob(pattern: string): string[]
    diskFreeSpace(path: string): number
    isLocal(path: string): boolean
    clearCurlCache(): void
    /** The reference's async pair — a promise, rejecting when the path is absent. */
    statAsync(
      path: string,
      follow?: boolean,
    ): Promise<{ size: number; isFile: boolean; isDirectory: boolean; modifiedMs: number }>
    readDirAsync(path: string, recursive?: boolean): Promise<string[]>
  }
  const vsimem: {
    set(data: Buffer | Uint8Array, filename?: string): string
    release(filename: string): void
    copy(from: string, to: string): void
  }

  const drivers: DriverCollection
  const version: string
  const lastError: { class: number; number: number; message: string } | null

  function open(
    path: string | Buffer,
    mode?: string,
    drivers?: string | string[],
    xSize?: number,
    ySize?: number,
    bandCount?: number,
    dataType?: number | string,
    creationOptions?: object | string[],
  ): Dataset
  function openAsync(
    path: string | Buffer,
    callback: (error: Error | null, dataset?: Dataset) => void,
  ): void
  function openAsync(
    path: string | Buffer,
    mode: string,
    callback: (error: Error | null, dataset?: Dataset) => void,
  ): void
  function openAsync(
    path: string | Buffer,
    mode?: string,
    drivers?: string | string[],
    xSize?: number,
    ySize?: number,
    bandCount?: number,
    dataType?: number | string,
    creationOptions?: object | string[],
    callback?: (error: Error | null, dataset?: Dataset) => void,
  ): Promise<Dataset>
  function verbose(): void
  function quiet(): void
  function setPROJSearchPaths(paths: string | string[]): void
  function decToDMS(angle: number, axis: string, precision?: number): string
  /** `gdalinfo`: the report for `dataset`, or the build info with no dataset. */
  function info(): any
  function info(dataset: Dataset, args?: string[]): string
  function infoAsync(dataset?: Dataset, args?: string[]): Promise<any>
  function toDataType(value: number | string): string
  function fromDataType(value: string): number
  function deleteDataset(path: string, driver?: string): void

  function addPixelFunc(name: string, fn: (...args: any[]) => any): string
  function toPixelFunc(fn: (...args: any[]) => any): (...args: any[]) => any
  function createPixelFunc(fn: (...pixels: number[]) => number): (...args: any[]) => any
  function createPixelFuncWithArgs(fn: (args: Record<string, string>, ...pixels: number[]) => number): (...args: any[]) => any
  function wrapVRT(descriptor: { bands: Array<{ sources: RasterBand[]; pixelFunc?: string; pixelFuncArgs?: object; dataType?: string; sourceTransferType?: string; description?: string }> }): string
  function calcAsync(
    inputs: Record<string, RasterBand>,
    output: RasterBand,
    fn: (...pixels: number[]) => number,
    options?: { convertNoData?: boolean; convertInput?: boolean; onProgress?: (fraction: number) => void },
  ): Promise<void>

  // The command-line tools the reference exposes as module functions. `args` are
  // the tool's own CLI options, as they are on the native entry point.
  function translate(destination: string, source: Dataset, args?: string[]): Dataset
  function translateAsync(destination: string, source: Dataset, args?: string[], options?: object): Promise<Dataset>
  function vectorTranslate(destination: string, source: Dataset, args?: string[]): Dataset
  function vectorTranslateAsync(destination: string, source: Dataset, args?: string[], options?: object): Promise<Dataset>
  function warp(dstPath: string, dstDataset: null, sources: Dataset[], args?: string[]): Dataset
  function warpAsync(dstPath: string, dstDataset: null, sources: Dataset[], args?: string[], options?: object): Promise<Dataset>
  function buildVRT(dstPath: string, sources: Array<Dataset | string>, args?: string[]): Dataset
  function buildVRTAsync(dstPath: string, sources: Array<Dataset | string>, args?: string[]): Promise<Dataset>
  function dem(dstPath: string, source: Dataset, mode: string, args?: string[], colorFile?: string): Dataset
  function demAsync(dstPath: string, source: Dataset, mode: string, args?: string[], colorFile?: string, options?: object): Promise<Dataset>
  function checksumImage(source: RasterBand, x: number, y: number, width: number, height: number): number
  function checksumImageAsync(source: RasterBand, x: number, y: number, width: number, height: number): Promise<number>
  function suggestedWarpOutput(options: { src: Dataset; s_srs?: SpatialReference; t_srs?: SpatialReference; maxError?: number }): { rasterSize: { x: number; y: number }; geoTransform: number[] }
  function suggestedWarpOutputAsync(options: object): Promise<{ rasterSize: { x: number; y: number }; geoTransform: number[] }>
  function reprojectImage(options: { src: Dataset; dst: Dataset; s_srs?: SpatialReference; t_srs?: SpatialReference; resampling?: string; maxError?: number; memoryLimit?: number }): void
  function reprojectImageAsync(options: object): Promise<void>
  function fillNodata(options: { src: RasterBand; searchDist: number; smoothingIterations?: number }): void
  function fillNodataAsync(options: object): Promise<void>
  function sieveFilter(options: { src: RasterBand; dst?: RasterBand; threshold: number; connectedness?: number }): void
  function sieveFilterAsync(options: object): Promise<void>
  function rasterize(destination: string, source: Dataset, args?: string[]): Dataset
  function rasterizeAsync(destination: string, source: Dataset, args?: string[], options?: object): Promise<Dataset>

  /** `gdal.contourGenerate` — the reference's object form of `band.contourGenerateSync`. */
  function contourGenerate(options: {
    src: RasterBand
    dst: Layer
    offset?: number
    interval?: number
    fixedLevels?: number[]
    idField?: number
    elevField?: number
    progress_cb?: () => void
  }): void
  function contourGenerateAsync(options: object, callback?: (error: Error | null) => void): Promise<void>
  /** `gdal.polygonize` — the reference's object form of `band.polygonizeSync`. */
  function polygonize(options: {
    src: RasterBand
    dst: Layer
    pixValField?: number
    connectedness?: number
    progress_cb?: () => void
  }): void
  function polygonizeAsync(options: object, callback?: (error: Error | null) => void): Promise<void>
}

export = gdal
