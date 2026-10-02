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

    toWKT(): string
    toWKB(): Uint8Array
    toJSON(): any
    toObject(): any
    toGML(): string
    toKML(altitudeMode?: string): string
    getGeometryType(): string
    getEnvelope(): { minX: number; minY: number; maxX: number; maxY: number } | null
    getEnvelope3D(): any
    getArea(): number
    getLength(): number
    envelope(): { minX: number; minY: number; maxX: number; maxY: number } | null
    area(): number
    length(): number
    points(): number[][] | null
    rings(): number[][][] | null
    children(): Geometry[] | null
    clone(): Geometry
    flattenTo2D(): Geometry
    segmentize(maxLength: number): Geometry
    swapXY(): Geometry
    transform(from: SpatialReference, to: SpatialReference): Geometry
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
  }

  class Point extends Geometry {}
  class LineString extends Geometry {}
  class LinearRing extends Geometry {}
  class Polygon extends Geometry {}
  class MultiPoint extends Geometry {}
  class MultiLineString extends Geometry {}
  class MultiPolygon extends Geometry {}
  class GeometryCollection extends Geometry {}

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
    get(index: number): RasterBand | null
  }

  class BandPixels {
    readonly xSize: number
    readonly ySize: number
    get(x: number, y: number): number
    set(x: number, y: number, value: number): void
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
  }

  interface BandStatistics {
    min: number
    max: number
    mean: number
    stdDev: number
  }

  class RasterBand {
    readonly pixels: BandPixels
    readonly size: XYZ
    readonly blockSize: XYZ
    readonly dataType: number
    readonly colorInterpretation: string
    readonly overviews: RasterBandOverviews
    readonly categoryNames: string[]
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
    asMDArray(): MDArray
    getMaskBand(): RasterBand
    getMaskFlags(): number
    createMaskBand(perDataset?: boolean): void
    getMetadata(domain?: string): Record<string, string>
    setMetadata(values: Record<string, unknown> | string[], domain?: string): boolean
    flush(): void
    flushAsync(callback?: (error: Error | null) => void): Promise<void> | undefined
  }

  class FeatureFields {
    readonly names: string[]
    readonly count: number
    getNames(): string[]
    get(name: string): any
    set(name: string, value: any): this
    has(name: string): boolean
    toObject(): Record<string, any>
    toArray(): any[]
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
  }

  class FeatureDefn {
    readonly name: string
    readonly geomType: string
    readonly geomIgnored: boolean
    readonly styleIgnored: boolean
    readonly fields: FieldCollection
  }

  class LayerFeatures extends Collection<Feature> {
    readonly layer: Layer
    get(fid: number): Feature | null
    first(): Feature | null
    next(): Feature | null
    add(feature: Feature | Geometry | any, properties?: Record<string, any>): Feature | null
    addAsync(feature: Feature | Geometry | any, properties?: Record<string, any>): Promise<Feature | null>
    set(fid: number, feature: Feature | Geometry | any): Feature | Geometry
    set(feature: Feature): Feature
    setAsync(fid: number, feature: Feature | Geometry | any): Promise<Feature | Geometry>
    remove(fid: number): void
    removeAsync(fid: number): Promise<void>
  }

  class FieldCollection extends Collection<any> {
    readonly layer: Layer
    get(name: string): any | null
    get(index: number): any | null
    getNames(): string[]
    indexOf(name: string): number
    add(definition: object): any
    remove(name: string): void
    reorder(names: string[]): void
  }
  /** The reference's name for the field collection. */
  class LayerFields extends FieldCollection {}

  class DatasetLayers extends Collection<Layer> {
    get(name: string): Layer | null
    get(index: number): Layer | null
    create(name: string, srs?: SpatialReference | string, geomType?: string, options?: object): Layer
    createAsync(name: string, srs?: SpatialReference | string, geomType?: string, options?: object): Promise<Layer>
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
    readonly threadSafe: boolean
    readonly root: Group | null
    /** Assignment, where the native binding has `setProjection`. */
    srs: SpatialReference | string | null
    /** Assignment, where the native binding has `setGeoTransform`. */
    geoTransform: number[] | null
    getFileList(): string[]
    getGCPProjection(): string | null
    getMetadata(domain?: string): Record<string, string>
    setMetadata(values: Record<string, unknown> | string[], domain?: string): boolean
    executeSQL(sql: string, dialect?: string): any[]
    executeSQLAsync(sql: string, dialect?: string): Promise<any[]>
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

  // ---- streams and pixel-wise calc -----------------------------------------

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
  function decToDMS(angle: number, axis: string, precision?: number): string
  function info(): any
  function infoAsync(): Promise<any>
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
}

export = gdal
