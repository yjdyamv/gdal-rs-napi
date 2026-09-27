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

  // BUILD_INFO lists what was compiled in; GEOS was not, so its key is absent
  // rather than "NO".
  assert.equal(info.build.OGR_ENABLED, 'YES')
  assert.match(info.build.PROJ_BUILD_VERSION, /^\d+\.\d+/)
  assert.notEqual(info.build.GEOS_ENABLED, 'YES')

  assert.equal(info.driverCount, gdal.drivers().length)
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
  assert.throws(() => gdal.openSync(tmp('does-not-exist.tif')), /GDALOpenEx/)
  assert.equal(gdal.lastError(), null)
})
