#!/usr/bin/env node
// Re-write a raster as a Cloud-Optimized GeoTIFF.
//
//   node examples/to-cog.mjs input.tif output.tif [KEY=VALUE ...]
//
// The COG driver implements `CreateCopy` but not `Create` — asking it to create
// a dataset from scratch fails with "no create method implemented for this
// format" — so this goes through `createCopy`, which is also how you reach any
// other copy-only driver.
import { createRequire } from 'node:module'

const gdal = createRequire(import.meta.url)('..')

const [input, output, ...rawOptions] = process.argv.slice(2)
if (!input || !output) {
  console.error('usage: node examples/to-cog.mjs <input> <output> [KEY=VALUE ...]')
  process.exit(2)
}

const options = { COMPRESS: 'DEFLATE', BLOCKSIZE: 512 }
for (const raw of rawOptions) {
  const separator = raw.indexOf('=')
  if (separator <= 0) {
    console.error(`options are KEY=VALUE, got ${JSON.stringify(raw)}`)
    process.exit(2)
  }
  options[raw.slice(0, separator).toUpperCase()] = raw.slice(separator + 1)
}

const source = gdal.openSync(input)
console.log(
  `reading ${input}: ${source.driver}, ${source.width}x${source.height}, ` +
    `${source.bandCount} band(s)`,
)

try {
  const cog = await source.createCopy(output, 'COG', options)
  console.log(`wrote ${output}: driver=${cog.driver}, options=${JSON.stringify(options)}`)
  cog.close()
} catch (error) {
  console.error(`copy failed: ${error.code} ${error.message}`)
  process.exit(1)
} finally {
  source.close()
}

const reopened = gdal.openSync(output)
console.log(
  `verified ${output}: ${reopened.width}x${reopened.height}, ` +
    `block ${reopened.band(0).blockSize.join('x')}, ` +
    `IMAGE_STRUCTURE=${JSON.stringify(reopened.metadata('IMAGE_STRUCTURE'))}`,
)
reopened.close()
