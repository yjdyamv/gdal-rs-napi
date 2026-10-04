// @ts-nocheck
// `gdal.eventLoopWarning`: a blocking call holds the JS thread for as long as it takes,
// and for a server that is the event loop stopped. The blocking methods of the classes
// that reach a dataset say so when they take too long.

import assert from 'node:assert/strict'
import { test } from 'vitest'

import { gdal, tmp } from '../helpers.js'

/**
 * Swallow whatever warnings are still queued before a window opens.
 *
 * `process.emitWarning` delivers on the next tick, so a warning emitted by the
 * previous test's teardown — a slow `close()`, say — can still be pending when the
 * next test attaches its listener, and would then be recorded as if the work under
 * test had emitted it. Two turns with a discard listener guarantee the queue is
 * empty before the real listener goes on.
 */
async function drainPendingWarnings() {
  const discard = () => {}
  process.on('warning', discard)
  try {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.removeListener('warning', discard)
  }
}

/**
 * The `GdalEventLoopWarning`s emitted while `run` does its thing.
 *
 * `process.emitWarning` delivers on the next tick, so the listener has to outlive
 * the work by a turn — otherwise the warning about the *last* call is missed.
 */
async function warningsDuring(run) {
  await drainPendingWarnings()
  const seen = []
  const listener = (warning) => {
    if (warning.name === 'GdalEventLoopWarning') seen.push(warning.message)
  }
  process.on('warning', listener)
  try {
    await run()
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.removeListener('warning', listener)
  }
  return seen
}

/** A band big enough that reading it takes real time. */
function slow() {
  const dataset = gdal.createSync(tmp('event-loop.tif'), {
    driver: 'GTiff',
    width: 1500,
    height: 1500,
    bandCount: 1,
    dataType: 'Float64',
  })
  const band = dataset.band(0)
  band.fill(1)
  return { dataset, band }
}

/** Close with the warning off: a slow disk is not what either test is about. */
function closeQuietly(dataset) {
  try {
    gdal.eventLoopWarning = false
    dataset.close()
  } finally {
    gdal.eventLoopWarning = true
  }
}

test('a blocking call that holds the event loop too long says so', async () => {
  const { dataset, band } = slow()
  assert.equal(gdal.eventLoopWarning, true, 'on by default')

  // A millisecond is far below what this read costs, which is what makes the warning
  // certain rather than a race.
  const warned = await warningsDuring(async () => {
    gdal.eventLoopWarning = 1
    band.readPixelsSync()
  })
  assert.ok(warned.length >= 1, 'the blocking read warned')
  assert.match(warned[0], /RasterBand\.readPixelsSync\(\) held the event loop for \d/)

  // Nothing is said while it is off.
  const silent = await warningsDuring(async () => {
    gdal.eventLoopWarning = false
    band.readPixelsSync()
  })
  assert.deepEqual(silent, [])

  // And back on.
  gdal.eventLoopWarning = true
  assert.equal(gdal.eventLoopWarning, true)
  const again = await warningsDuring(async () => {
    gdal.eventLoopWarning = 1
    band.readPixelsSync()
  })
  assert.ok(again.length >= 1)

  closeQuietly(dataset)
  assert.equal(gdal.eventLoopWarning, true)
})

test('a fast call says nothing, however low the threshold is', async () => {
  const { dataset, band } = slow()

  const warned = await warningsDuring(async () => {
    gdal.eventLoopWarning = 1000
    band.readPixelsSync({ x: 0, y: 0, width: 2, height: 2 })
  })
  assert.deepEqual(warned, [], 'a two-pixel read is not worth a warning')

  closeQuietly(dataset)
  assert.equal(gdal.eventLoopWarning, true)
})
