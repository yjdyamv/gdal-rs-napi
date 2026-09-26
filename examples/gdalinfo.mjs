#!/usr/bin/env node
// A miniature `gdalinfo`, covering both halves of the binding in one file.
//
//   node examples/gdalinfo.mjs path/to/anything.tif
//
// Run it from the repository root; it loads the package through `..` so it works
// before anything is published.
import { createRequire } from 'node:module'

const gdal = createRequire(import.meta.url)('..')

const target = process.argv[2]
if (!target) {
  console.error('usage: node examples/gdalinfo.mjs <dataset>')
  process.exit(2)
}

let dataset
try {
  dataset = gdal.openSync(target)
} catch (error) {
  console.error(`cannot open ${target}: ${error.message}`)
  process.exit(1)
}

const { gdal: gdalVersion, proj } = gdal.version()

// `width` / `height` come straight from GDAL and are only meaningful when there
// are bands: a vector-only GPKG still reports a raster size, and it is noise.
const isRaster = dataset.bandCount > 0
const lines = [
  `Driver:  ${dataset.driver}`,
  isRaster
    ? `Size:    ${dataset.width} x ${dataset.height} x ${dataset.bandCount}`
    : `Layers:  ${dataset.layerCount}`,
  `GDAL:    ${gdalVersion} (PROJ ${proj})`,
]

if (isRaster) {
  if (dataset.geoTransform) {
    const [originX, pixelWidth, , originY, , pixelHeight] = dataset.geoTransform
    lines.push(`Origin:  (${originX}, ${originY})`)
    lines.push(`Pixel:   (${pixelWidth}, ${pixelHeight})`)
  }
  if (dataset.projection) lines.push(`CRS:     ${summariseWkt(dataset.projection)}`)

  const metadata = Object.entries(dataset.metadata())
  if (metadata.length > 0) {
    lines.push('Metadata:')
    for (const [key, value] of metadata.slice(0, 6)) {
      lines.push(`  ${key}=${value}`)
    }
    if (metadata.length > 6) lines.push(`  ... ${metadata.length - 6} more`)
  }

  for (const band of dataset.bands()) {
    const [width, height] = band.size
    const parts = [
      `Band ${band.index + 1}: ${band.dataType}`,
      `${width}x${height}`,
      band.colorInterpretation,
      `block ${band.blockSize.join('x')}`,
    ]
    if (band.noDataValue !== null) parts.push(`noData=${band.noDataValue}`)
    lines.push(parts.join(', '))
  }
}

for (const layer of dataset.layers()) {
  lines.push(`Layer ${layer.index}: ${layer.name}`)
  lines.push(
    `  Geometry: ${layer.geometryType}, ` +
      `${layer.featureCount === null ? 'unknown count' : `${layer.featureCount} feature(s)`}`,
  )
  const fields = layer.fields.map((field) => `${field.name}:${field.fieldType}`)
  lines.push(`  Fields:   ${fields.length === 0 ? '(none)' : fields.join(', ')}`)
  if (layer.extent) lines.push(`  Extent:   ${layer.extent.join(', ')}`)
  if (layer.spatialRefWkt) lines.push(`  CRS:      ${summariseWkt(layer.spatialRefWkt)}`)
}

console.log(lines.join('\n'))
dataset.close()

/** WKT is one enormous line; the first clause is enough for a summary. */
function summariseWkt(wkt) {
  const end = wkt.indexOf('],')
  return end === -1 ? wkt : `${wkt.slice(0, end + 1)}]`
}
