import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gdal, tmp } from './helpers.mjs'

test('fs reads and writes files, in memory and on disk', () => {
  const mem = '/vsimem/gdal-rs-napi-fs-test.bin'

  assert.equal(gdal.fs.exists(mem), false)
  assert.equal(gdal.fs.stat(mem), null)
  assert.throws(() => gdal.fs.readFile(mem), /VSIFOpenL|does not exist/)

  gdal.fs.writeFile(mem, Buffer.from([1, 2, 3, 4]))
  assert.equal(gdal.fs.exists(mem), true)

  const stat = gdal.fs.stat(mem)
  assert.equal(stat.size, 4)
  assert.equal(stat.isFile, true)
  assert.equal(stat.isDirectory, false)
  assert.ok(stat.modifiedMs > 0)

  assert.deepEqual(gdal.fs.readFile(mem), Buffer.from([1, 2, 3, 4]))

  gdal.fs.unlink(mem)
  assert.equal(gdal.fs.exists(mem), false)

  // The same calls reach a real directory and a real file.
  const dir = tmp('fs-dir')
  gdal.fs.mkdir(dir)
  assert.equal(gdal.fs.stat(dir).isDirectory, true)

  const file = tmp('fs-dir/note.txt')
  gdal.fs.writeFile(file, Buffer.from('hello'))
  assert.equal(gdal.fs.readFile(file).toString(), 'hello')
  assert.deepEqual(gdal.fs.readDir(dir), ['note.txt'])

  gdal.fs.unlink(file)
  gdal.fs.rmdir(dir)
  assert.equal(gdal.fs.exists(dir), false)

  // The calls that were asked to change something throw when they cannot; the
  // ones that only ask a question answer `false` / `null`.
  assert.throws(() => gdal.fs.unlink(mem), /VSIUnlink/)

  // `/vsimem/` has no directories underneath, whatever a path looks like: a name
  // that was never created is not an obstacle.
  const nested = '/vsimem/gdal-rs-napi-never-created/nested.bin'
  gdal.fs.writeFile(nested, Buffer.from([7]))
  assert.equal(gdal.fs.readFile(nested)[0], 7)
  assert.deepEqual(gdal.fs.readDir('/vsimem/gdal-rs-napi-never-created'), ['nested.bin'])
  gdal.fs.unlink(nested)
})

test('open() takes bytes as well as a path', async () => {
  const source = '/vsimem/gdal-rs-napi-buffer-source.tif'
  const dataset = gdal.createSync(source, {
    driver: 'GTiff',
    width: 2,
    height: 2,
    bandCount: 1,
  })
  dataset.band(0).fill(5)
  dataset.close()

  const bytes = gdal.fs.readFile(source)
  gdal.fs.unlink(source)

  const opened = gdal.openSync(bytes)
  assert.equal(opened.driver.name, 'GTiff')
  assert.equal(opened.bandCount, 1)
  assert.equal(opened.band(0).readPixelsSync()[0], 5)
  // The bytes live in a `/vsimem/` file, and that file is the dataset's path.
  assert.match(opened.path, /^\/vsimem\/gdal-rs-napi-/)
  assert.deepEqual(gdal.fs.readFile(opened.path), bytes)

  // Closing it is what unlinks that file.
  const path = opened.path
  opened.close()
  assert.equal(gdal.fs.exists(path), false)

  // The async form takes bytes too, and writing back through the mem file is how
  // changes made in place get out — after a flush, since GDAL holds dirty blocks
  // in memory until then, exactly as it does for a file on disk.
  const editable = gdal.openSync(bytes, { update: true })
  editable.band(0).fill(9)
  editable.flushSync()
  const written = gdal.fs.readFile(editable.path)
  assert.ok(written.length > 0)
  editable.close()

  const again = await gdal.open(written)
  assert.equal(again.band(0).readPixelsSync()[0], 9)
  again.close()

  // Bytes that are not a dataset are refused rather than opened as something
  // arbitrary. GDAL's own explanation does not survive the trip — the error reads
  // `GDALOpenEx: ` with an empty message, and does so for a garbage *path* as much
  // as for a buffer — so all this can assert is that it is refused.
  assert.throws(() => gdal.openSync(Buffer.from('definitely not a raster')), /GDALOpenEx/)
})
