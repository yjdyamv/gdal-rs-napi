#!/usr/bin/env node
// Copy every feature of one vector file into another, discovering the schema as
// it goes: `createFeature` adds a field for any property it has not seen before,
// inferring the type from the value.
//
//   node examples/convert-vector.mjs roads.geojson roads.gpkg [layer-name]
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'

const gdal = createRequire(import.meta.url)('..')

/** Output formats this example knows how to name. */
const DRIVERS = [
  [/\.gpkg$/i, 'GPKG'],
  [/\.(geojson|json)$/i, 'GeoJSON'],
  [/\.fgb$/i, 'FlatGeobuf'],
]

const [input, output, layerName = 'features'] = process.argv.slice(2)
if (!input || !output) {
  console.error('usage: node examples/convert-vector.mjs <input> <output> [layer-name]')
  process.exit(2)
}

const match = DRIVERS.find(([pattern]) => pattern.test(output))
if (!match) {
  console.error(`cannot tell the output format from ${JSON.stringify(output)}`)
  console.error(`known extensions: ${DRIVERS.map(([pattern]) => pattern.source).join(', ')}`)
  process.exit(2)
}
const [, driver] = match

// Drivers disagree about overwriting an existing file, so start from a clean slate.
rmSync(output, { force: true })

const source = gdal.openSync(input)
if (source.layerCount === 0) {
  console.error(`${input} has no vector layers (is it a raster?)`)
  process.exit(1)
}

const sourceLayer = source.layer(0)
const target = gdal.createVectorSync(output, driver)
const targetLayer = target.createLayer({
  name: layerName,
  geometryType: sourceLayer.geometryType,
  epsg: 4326,
})

let written = 0
for (const feature of sourceLayer.featuresSync()) {
  // A feature with no geometry passes `null` and is written attribute-only.
  targetLayer.createFeature(feature.geometry, feature.properties)
  written += 1
}

const fields = targetLayer.fields.map((field) => `${field.name}:${field.fieldType}`)
target.flushSync()
target.close()
source.close()

console.log(`${input} -> ${output}`)
console.log(`  ${written} feature(s) into layer ${JSON.stringify(layerName)} (${driver})`)
console.log(`  fields: ${fields.length === 0 ? '(none)' : fields.join(', ')}`)
