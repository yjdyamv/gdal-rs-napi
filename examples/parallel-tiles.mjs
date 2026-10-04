#!/usr/bin/env node
// Read one raster as tiles, one at a time and then all at once, through a
// thread-safe handle — the `openThreadSafe` path that lets several threads read
// the *same* dataset.
//
//   node examples/parallel-tiles.mjs [size] [tile]
//
// It builds its own fixture, so it runs with nothing but the repository: the
// ground truth for the concurrency section of the README, without a sample file.
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const gdal = createRequire(import.meta.url)('..')

const size = Number(process.argv[2] ?? 4096)
const tile = Number(process.argv[3] ?? 512)

if (!gdal.features().threadSafe) {
  console.error('this build has no openThreadSafe (GDAL < 3.10); nothing to show')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'gdal-rs-napi-tiles-'))
const file = join(dir, 'tiles.tif')

// One Float32 band, tiled at the tile size so each read touches one block.
const created = gdal.createSync(file, {
  driver: 'GTiff',
  width: size,
  height: size,
  bandCount: 1,
  dataType: 'Float32',
  options: { TILED: true, BLOCKXSIZE: tile, BLOCKYSIZE: tile, COMPRESS: 'DEFLATE' },
})
created.band(0).fill(1)
created.close()

const windows = []
for (let y = 0; y < size; y += tile) {
  for (let x = 0; x < size; x += tile) {
    windows.push({
      x,
      y,
      width: Math.min(tile, size - x),
      height: Math.min(tile, size - y),
    })
  }
}

const dataset = gdal.openThreadSafeSync(file)
const band = dataset.band(0)

// One read after another, awaited in turn.
const serialStart = process.hrtime.bigint()
for (const window of windows) await band.readPixels(window)
const serialMs = Number(process.hrtime.bigint() - serialStart) / 1e6

// The same reads issued together. `openThreadSafe` is what makes several threads
// on one handle safe; a plain `open` would serialise them per handle.
const parallelStart = process.hrtime.bigint()
await Promise.all(windows.map((window) => band.readPixels(window)))
const parallelMs = Number(process.hrtime.bigint() - parallelStart) / 1e6

const pool = process.env.UV_THREADPOOL_SIZE ?? '4'
console.log(
  `${size}x${size}, ${windows.length} tiles of ${tile}px, UV_THREADPOOL_SIZE=${pool}`,
)
console.log(`  serial:   ${serialMs.toFixed(1)} ms`)
console.log(`  parallel: ${parallelMs.toFixed(1)} ms`)
console.log(`  speedup:  ${(serialMs / parallelMs).toFixed(2)}x`)

dataset.close()
rmSync(dir, { recursive: true, force: true })
