// @ts-nocheck
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'vitest'
import { crc32 } from 'node:zlib'

import { gdal, tmp, workdir } from '../helpers.js'

/**
 * A one-entry, stored (uncompressed) ZIP. `/vsizip/` behaves differently from a
 * plain path, and that is worth pinning — writing the four headers a container
 * needs is cheaper than carrying a binary fixture, and there is no reader to
 * depend on.
 */
function storedZip(name, contents) {
  const nameBytes = Buffer.from(name, 'utf8')
  const crc = crc32(contents)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0) // local file header
  local.writeUInt16LE(20, 4) // version needed
  local.writeUInt16LE(0, 8) // stored, not deflated
  local.writeUInt16LE(0x21, 12) // 1980-01-01, so the bytes are deterministic
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(contents.length, 18)
  local.writeUInt32LE(contents.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0) // central directory header
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x21, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(contents.length, 20)
  central.writeUInt32LE(contents.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt32LE(0, 42) // the local header is at offset 0

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory
  end.writeUInt16LE(1, 8) // one entry on this disk
  end.writeUInt16LE(1, 10) // one entry in total
  end.writeUInt32LE(central.length + nameBytes.length, 12)
  end.writeUInt32LE(local.length + nameBytes.length + contents.length, 16)

  return Buffer.concat([local, nameBytes, contents, central, nameBytes, end])
}

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
  // arbitrary, and the error carries GDAL's own reason — the bytes are written to
  // a `/vsimem/` file, so the message names that path and says why it was not read.
  assert.throws(
    () => gdal.openSync(Buffer.from('definitely not a raster')),
    (error) => error.code === 'GDAL_BAD_ARGUMENT' && /not recognized/.test(error.message),
  )
})

test('fs renames, copies, globs and clears a whole tree', () => {
  const dir = '/vsimem/gdal-rs-napi-fs-ops'
  gdal.fs.writeFile(`${dir}/a.bin`, Buffer.from([1, 2, 3]))
  gdal.fs.writeFile(`${dir}/b.bin`, Buffer.from([4, 5]))
  gdal.fs.writeFile(`${dir}/note.txt`, Buffer.from('n'))

  // A miss is an empty array, and that is the regression: GDAL answers "" past the
  // end of a string list, so the walk has to be over the array, not over the field.
  assert.deepEqual(gdal.fs.glob(`${dir}/nothing*.bin`), [])
  assert.deepEqual(gdal.fs.glob(`${dir}/*.bin`).sort(), [`${dir}/a.bin`, `${dir}/b.bin`])

  gdal.fs.rename(`${dir}/a.bin`, `${dir}/c.bin`)
  assert.equal(gdal.fs.exists(`${dir}/a.bin`), false)
  assert.deepEqual(gdal.fs.readFile(`${dir}/c.bin`), Buffer.from([1, 2, 3]))

  gdal.fs.copyFile(`${dir}/b.bin`, `${dir}/d.bin`)
  assert.deepEqual(gdal.fs.readFile(`${dir}/d.bin`), Buffer.from([4, 5]))
  // A copy leaves the source in place.
  assert.equal(gdal.fs.exists(`${dir}/b.bin`), true)

  gdal.fs.rmdirRecursive(dir)
  assert.equal(gdal.fs.exists(dir), false)
})

test('fs makes a nested directory in one call, and removes it the same way', () => {
  const root = tmp('fs-nested')
  const nested = tmp('fs-nested/one/two')

  // `mkdir` would refuse the missing parent; `mkdirRecursive` makes the chain.
  gdal.fs.mkdirRecursive(nested)
  assert.equal(gdal.fs.stat(nested).isDirectory, true)

  gdal.fs.writeFile(`${nested}/x.bin`, Buffer.from([9]))
  gdal.fs.rmdirRecursive(root)
  assert.equal(gdal.fs.exists(root), false)
  assert.equal(gdal.fs.exists(nested), false)
})

test('fs says what is local, and how much room a real directory has', () => {
  assert.equal(gdal.fs.isLocal(tmp('anything.bin')), true)
  assert.ok(gdal.fs.diskFreeSpace(workdir) > 0)
})

test('a /vsizip/ view reads like a path but only partly writes like one', () => {
  const archive = tmp('archive.zip')
  writeFileSync(archive, storedZip('hello.txt', Buffer.from('hello')))
  const view = `/vsizip/${archive}`

  assert.equal(gdal.fs.exists(`${view}/hello.txt`), true)
  assert.equal(gdal.fs.readFile(`${view}/hello.txt`).toString(), 'hello')
  assert.deepEqual(gdal.fs.readDir(view), ['hello.txt'])

  // Adding an entry is the write GDAL supports here; overwriting, deleting and
  // renaming are not, and each refuses with GDAL's own reason.
  gdal.fs.writeFile(`${view}/added.txt`, Buffer.from('added'))
  assert.deepEqual(gdal.fs.readDir(view).sort(), ['added.txt', 'hello.txt'])
  assert.throws(() => gdal.fs.writeFile(`${view}/hello.txt`, Buffer.from('x')))
  assert.throws(() => gdal.fs.unlink(`${view}/hello.txt`))
  assert.throws(() => gdal.fs.rename(`${view}/hello.txt`, `${view}/hi.txt`))
})

test("fs clears GDAL's curl cache, which is a no-op with nothing fetched", () => {
  // The call is here so the name is reachable; there is nothing to assert beyond
  // that it does not throw.
  assert.doesNotThrow(() => gdal.fs.clearCurlCache())
})
