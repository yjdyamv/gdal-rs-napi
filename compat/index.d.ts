// Types for the `gdal-async`-shaped adapter.
//
// Hand-written on purpose. This layer exists to change conventions — 1-based
// indexing, `xxx()` / `xxxAsync()`, assignment for setters, the class family — so
// its shape is deliberately *not* the native binding's and cannot be generated
// from it. See `PHASE1.md` (WS-7) for what it covers and what it does not.

declare namespace gdal {
  /** GDAL's numeric sample-type codes, as `gdal-async` exposes them. */
  const GDT_Unknown: number
  const GDT_Byte: number
  const GDT_UInt16: number
  const GDT_Int16: number
  const GDT_UInt32: number
  const GDT_Int32: number
  const GDT_Float32: number
  const GDT_Float64: number
  const GDT_UInt64: number
  const GDT_Int64: number
  const GDT_Int8: number

  class Geometry {
    readonly type: string
    readonly isEmpty: boolean
    readonly pointCount: number
    readonly coordinates: any
    readonly x: number | null
    readonly y: number | null
    readonly z: number | null

    toWKT(): string
    toJSON(): any
    toObject(): any
    getGeometryType(): string
    getEnvelope(): { minX: number; minY: number; maxX: number; maxY: number } | null
    getArea(): number
    getLength(): number
    envelope(): { minX: number; minY: number; maxX: number; maxY: number } | null
    area(): number
    length(): number
    points(): number[][] | null
    rings(): number[][][] | null
    children(): Geometry[] | null
    clone(): Geometry
    transform(from: SpatialReference, to: SpatialReference): Geometry
  }

  class Point extends Geometry {}
  class LineString extends Geometry {}
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

  class SpatialReference {
    constructor(wktOrDefinition: string | SpatialReference)
    clone(): SpatialReference
    toWKT(): string
    toProj4(): string
    getName(): string | null
    getAuthorityName(): string | null
    getAuthorityCode(): string | null
    isSame(other: SpatialReference): boolean
  }

  class Driver {
    readonly name: string
    readonly description: string
    readonly longName: string
    testCapability(name: string): boolean
    create(path: string, xSize: number, ySize: number, bandCount: number, dataType: number, options?: object): Dataset
    open(path: string, mode?: string): Dataset
    delete(path: string): void
  }

  class Collection<T> {
    count(): number
    forEach(callback: (item: T, index: number) => void): void
    [Symbol.iterator](): Iterator<T>
  }

  class DriverCollection extends Collection<Driver> {
    get(name: string): Driver | null
    get(index: number): Driver | null
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
  }

  class RasterBand {
    readonly pixels: BandPixels
    readonly size: { xSize: number; ySize: number }
    readonly blockSize: { xSize: number; ySize: number }
    readonly dataType: number
    readonly colorInterpretation: string
    readonly overviews: Collection<unknown>
    description: string | null
    /** Assignment, where the native binding has `setNoDataValue`. */
    noDataValue: number | null
    getStatistics(allowApproximation?: boolean, force?: boolean): BandStatistics | null
    computeStatistics(
      allowApproximation?: boolean,
      force?: boolean,
      callback?: (error: Error | null, statistics?: BandStatistics | null) => void,
    ): Promise<BandStatistics | null> | undefined
    fill(value: number): void
  }

  interface BandStatistics {
    min: number
    max: number
    mean: number
    stdDev: number
  }

  class FeatureFields {
    readonly names: string[]
    readonly count: number
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
    geometry: Geometry | null
  }

  class LayerFeatures extends Collection<Feature> {
    get(fid: number): Feature | null
    first(): Feature | null
    next(): Feature | null
  }

  class FieldCollection extends Collection<any> {
    get(name: string): any | null
    get(index: number): any | null
  }

  class Layer {
    readonly name: string
    readonly geomType: string
    readonly srs: SpatialReference | null
    readonly extent: { minX: number; minY: number; maxX: number; maxY: number } | null
    readonly fields: FieldCollection
    readonly features: LayerFeatures
    setSpatialFilter(geometry: Geometry | null): void
    setAttributeFilter(filter: string | null): void
  }

  class Dataset {
    readonly bands: Collection<RasterBand> & { get(index: number): RasterBand | null }
    readonly layers: Collection<Layer> & { get(name: string): Layer | null; get(index: number): Layer | null }
    readonly description: string
    readonly driver: Driver
    readonly rasterSize: { xSize: number; ySize: number }
    /** Assignment, where the native binding has `setProjection`. */
    srs: SpatialReference | string | null
    /** Assignment, where the native binding has `setGeoTransform`. */
    geoTransform: number[] | null
    getFileList(): string[]
    flush(): void
    flushAsync(callback?: (error: Error | null) => void): Promise<void> | undefined
    close(): void
  }

  function open(path: string, mode?: string, drivers?: string[]): Dataset
  function openAsync(
    path: string,
    mode?: string,
    drivers?: string[],
    callback?: (error: Error | null, dataset?: Dataset) => void,
  ): Promise<Dataset> | undefined

  const drivers: DriverCollection
  const version: string
  const lastError: { class: number; number: number; message: string } | null
  function verbose(): void
  function quiet(): void
}

export = gdal
