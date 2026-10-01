import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gdal, tmp } from './helpers.mjs'

test('config.get and config.set read and write GDAL configuration options', () => {
  // An option nobody has set is null, and a default is what stands in for it.
  assert.equal(gdal.config.get('GDAL_RS_NAPI_ABSENT'), null)
  assert.equal(gdal.config.get('GDAL_RS_NAPI_ABSENT', 'fallback'), 'fallback')

  gdal.config.set('GDAL_RS_NAPI_VALUE', 'hello')
  assert.equal(gdal.config.get('GDAL_RS_NAPI_VALUE'), 'hello')

  // Clearing is `set(key, null)`, which is what the C API's NULL does.
  gdal.config.set('GDAL_RS_NAPI_VALUE', null)
  assert.equal(gdal.config.get('GDAL_RS_NAPI_VALUE'), null)

  // A key GDAL itself cares about, to prove these are not a private store.
  gdal.config.set('GDAL_NUM_THREADS', 'ALL_CPUS')
  assert.equal(gdal.config.get('GDAL_NUM_THREADS'), 'ALL_CPUS')
  gdal.config.set('GDAL_NUM_THREADS', null)
})

test('info() reports the build that version() summarises', () => {
  const info = gdal.info()

  assert.match(info.releaseName, /^3\./)
  assert.match(info.versionNum, /^\d+$/)
  assert.equal(info.releaseDate.length, 8)
  // The one-liner and the detailed view have to agree.
  assert.ok(gdal.version().gdal.includes(info.releaseName), info.releaseName)

  // BUILD_INFO lists what was compiled in. GEOS is, now that it is vendored and
  // built like GDAL itself — so the key is present and says "YES", which is the
  // same answer `features()` and `diagnostics()` give.
  assert.equal(info.build.OGR_ENABLED, 'YES')
  assert.match(info.build.PROJ_BUILD_VERSION, /^\d+\.\d+/)
  assert.equal(info.build.GEOS_ENABLED, 'YES')
  assert.equal(gdal.features().geos, true)

  assert.equal(info.driverCount, gdal.drivers().length)
})

test('infoAsync() is info() without holding the event loop while it waits', async () => {
  const dataset = gdal.createSync(tmp('info-async.tif'), {
    driver: 'GTiff',
    width: 1500,
    height: 1500,
    bandCount: 1,
    dataType: 'Float64',
  })
  dataset.band(0).fill(1)

  // Building overviews holds the exclusive lock for a while. `info()` takes the
  // *shared* side — it touches no dataset and changes no global state — but the
  // shared side still waits for that lock, and that wait is the whole reason the
  // asynchronous form exists.
  const building = dataset.buildOverviews('average', [2, 4])

  const pending = gdal.infoAsync()
  assert.ok(pending instanceof Promise)
  let ticked = false
  await new Promise((resolve) => {
    setTimeout(() => {
      ticked = true
      resolve()
    }, 0)
  })
  assert.equal(ticked, true, 'the event loop ran while infoAsync was waiting')

  assert.deepEqual(await pending, gdal.info())
  await building
  dataset.close()
})

test('lastError reports an error that never became an exception', () => {
  // GTiff does not know this creation option: GDAL warns and carries on, so the
  // call succeeds and nothing consumes the error state.
  const dataset = gdal.createSync(tmp('last-error.tif'), {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 1,
    options: { NOT_A_REAL_OPTION: 'x' },
  })

  const last = gdal.lastError()
  assert.ok(last, 'the warning is still there to be read')
  assert.equal(last.class, 2, 'CE_Warning')
  assert.equal(last.number, 6, 'CPLE_NotSupported')
  assert.match(last.message, /NOT_A_REAL_OPTION/)
  dataset.close()

  // A failure that *is* thrown has been consumed and reset on the way out — the
  // rust `gdal` crate calls CPLErrorReset after reading it — so by the time JS
  // sees the exception there is nothing left here. This is the documented split.
  //
  // The message is not empty, though: the open asks GDAL for
  // `GDAL_OF_VERBOSE_ERROR`, so a failed open explains itself rather than being
  // the bare `GDALOpenEx: ` it once was. GDAL names the path it could not read.
  assert.throws(
    () => gdal.openSync(tmp('does-not-exist.tif')),
    (error) => /GDALOpenEx/.test(error.message) && /does-not-exist\.tif/.test(error.message),
  )
  assert.equal(gdal.lastError(), null)
})
