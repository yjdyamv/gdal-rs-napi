#!/usr/bin/env node
// What the reference's own tests use, held against what `compat` answers.
//
// `gdal-async` ships ~60 TypeScript test files, and they are the closest thing there
// is to a specification of how its API is *actually* used — which is the part a
// hand-written adapter guesses at. This reads them mechanically (no execution: they
// need its native module and its fixtures) and reports, for every name they reach for,
// whether `gdal-rs-napi/compat` has it.
//
// It is a dev tool, not a test: it needs a checkout of the reference beside this repo.
//
//   node scripts/compat-coverage.mjs [path-to-node-gdal-async]
//
// Without an argument it looks for `../node-gdal-async` and `../../node-gdal-async`.
// Exit code is 1 when something is missing, so it can be wired into a check once the
// list is empty — or into a `--allow` list of the gaps that are deliberate.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const compat = createRequire(import.meta.url)('../compat')

/** Every name `gdal.<name>` the tests use. */
const moduleUses = new Map()
/** Every `.<member>` a test reaches for, and a sample of where. */
const memberUses = new Map()

const visit = (directory, onFile) => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) visit(path, onFile)
    else if (/\.(test|spec)\.(ts|js|mjs)$/.test(entry)) onFile(path)
  }
}

const count = (map, name, where) => {
  const entry = map.get(name) ?? { count: 0, where: new Set() }
  entry.count += 1
  entry.where.add(where)
  map.set(name, entry)
}

/** Members that are JavaScript's or a test framework's, not the reference's API. */
const IGNORED = new Set([
  'length',
  'name',
  'map',
  'filter',
  'forEach',
  'push',
  'join',
  'slice',
  'indexOf',
  'includes',
  'toString',
  'valueOf',
  'then',
  'catch',
  'finally',
  'constructor',
  'prototype',
  'toFixed',
  'padStart',
  'keys',
  'values',
  'entries',
  'charAt',
  'replace',
  'split',
  'trim',
  'sort',
  'some',
  'every',
  'reduce',
  'concat',
  'substring',
  'toLowerCase',
  'toUpperCase',
  'test',
  'match',
  'apply',
  'call',
  'bind',
  'toJSON',
])

/**
 * Names the regex catches that are not the reference's API at all: TypeScript *types*
 * (they only appear in annotations, and a `.d.ts` name is not a runtime export), and
 * the suite's own helpers and fixtures.
 */
const NOT_API = new Set([
  // Type-level only.
  'TypedArray',
  'Float16Array',
  'ReprojectOptions',
  'WarpOptions',
  'LayerAsync',
  'RasterBandAsync',
  // The suite's own helpers, fixtures and internals.
  'algebra',
  'js',
  'org',
  'log',
  'warn',
  'error',
  'data',
  'tif',
  'jpg',
  'gdb',
  'hgt',
  'aux',
  'ramp',
  'src',
  'dst',
  'geo',
  'tmp',
  'env',
  'op',
  'versions',
  'magellium',
  'amazonaws',
  'opengis',
  'latest',
  'grib2',
  'npmjs',
  'mapserver',
])

/** Their internals mark themselves: a leading underscore, or `$`. */
const isTheirInternal = (name) => name.startsWith('_') || name.startsWith('$')

/** The test framework's own vocabulary — `assert.equal`, `it.skip`, … — and Node's. */
const FRAMEWORK = new Set([
  'equal',
  'throws',
  'instanceOf',
  'closeTo',
  'eventually',
  'isRejected',
  'isFulfilled',
  'deepEqual',
  'isTrue',
  'isFalse',
  'isNull',
  'isNotNull',
  'isNumber',
  'isString',
  'isObject',
  'isArray',
  'isBoolean',
  'isUndefined',
  'isNaN',
  'isAbove',
  'isBelow',
  'isAtLeast',
  'isAtMost',
  'strictEqual',
  'notStrictEqual',
  'notEqual',
  'deepInclude',
  'doesNotThrow',
  'include',
  'ok',
  'gte',
  'gt',
  'lt',
  'lengthOf',
  'propertyVal',
  'sameMembers',
  'satisfies',
  'hasAllKeys',
  'becomes',
  'all',
  'resolve',
  'reject',
  'skip',
  'only',
  'skipIf',
  'timeout',
  'retries',
  'random',
  'once',
  'on',
  'emit',
  'removeAllListeners',
  'destroy',
  'gc',
  'nextTick',
  'pipe',
  'existsSync',
  'readFileSync',
  'writeFileSync',
  'unlinkSync',
  'exec',
  'execSync',
  'cloneDir',
  'deleteRecursiveVSIMEM',
  'typeOf',
  'alloc',
  'subarray',
  'ceil',
  'floor',
  'round',
  'max',
  'min',
  'abs',
  'sqrt',
  'parse',
  'merge',
  'assign',
  'from',
  'set',
  'setFrom',
  'empty',
  'now',
  'constants',
  'versions',
])


const collect = (source, where) => {
  for (const match of source.matchAll(/\bgdal\.([A-Za-z_$][\w$]*)/g)) {
    if (!NOT_API.has(match[1]) && !isTheirInternal(match[1])) count(moduleUses, match[1], where)
  }
  // `gdal.X` is a module name, not a member — the dot in it must not be read as one.
  for (const match of source.matchAll(/(?<!gdal)\.([A-Za-z_$][\w$]*)\s*(?:\(|\.|\[)/g)) {
    const name = match[1]
    if (IGNORED.has(name) || NOT_API.has(name) || FRAMEWORK.has(name) || isTheirInternal(name)) {
      continue
    }
    count(memberUses, name, where)
  }
}

const candidates = [
  join('..', 'node-gdal-async'),
  join('..', '..', 'node-gdal-async'),
  join('..', 'node-gdal-async', 'test'),
]
const root = process.argv[2] ? resolve(process.argv[2]) : candidates.map(resolve).find(exists)
if (!root) {
  console.error(
    '[coverage] no gdal-async checkout found — pass one: ' +
      'node scripts/compat-coverage.mjs /path/to/node-gdal-async',
  )
  process.exitCode = 2
} else {
  const tests = join(root, 'test') === root ? root : join(root, 'test')

  try {
    visit(tests, (path) => collect(readFileSync(path, 'utf8'), path.slice(tests.length + 1)))
  } catch (error) {
    console.error(`[coverage] could not read ${tests}: ${error.message}`)
    process.exitCode = 2
  }
}

function exists(candidate) {
  try {
    statSync(candidate)
    return true
  } catch {
    return false
  }
}

if (process.exitCode !== 2) {
  // A member counts as answered when *any* class on our side has it — the reference's
  // tests reach for the same name on different objects, and we do not need to guess
  // which class a name came from to answer "do we have this at all".
  //
  // The **whole prototype chain** counts, because that is how the adapter classes are
  // built: `wrapGeometry` sets a native prototype underneath, so a native method is
  // reachable on a compat object without appearing in its own property list. Both entry
  // points are walked, since `compat` re-exports the main one.
  const native = createRequire(import.meta.url)('..')
  const members = new Set()
  const addAll = (value) => {
    if (typeof value === 'function') {
      for (let prototype = value.prototype; prototype; prototype = Object.getPrototypeOf(prototype)) {
        for (const member of Object.getOwnPropertyNames(prototype)) members.add(member)
      }
      for (const member of Object.getOwnPropertyNames(value)) members.add(member)
    } else if (value && typeof value === 'object') {
      // `fs`, `config`, the constant tables: plain objects whose keys are the API.
      for (const member of Object.getOwnPropertyNames(value)) members.add(member)
    }
  }
  for (const source of [compat, native]) {
    for (const name of Object.keys(source)) addAll(source[name])
  }
  // The collections and the pixel object are reached through accessors rather than
  // through a class, so what they carry is part of the surface by name.
  for (const name of ['bands', 'layers', 'features', 'fields', 'pixels', 'overviews']) {
    members.add(name)
  }
  for (const name of ['get', 'count', 'getNames', 'add', 'remove', 'forEach', 'map']) members.add(name)

  const report = (label, map, has) => {
    const missing = []
    const present = []
    for (const [name, entry] of [...map].sort(([, a], [, b]) => b.count - a.count)) {
      ;(has(name) ? present : missing).push(`${name} (${entry.count})`)
    }
    console.log(`\n[coverage] ${label}: ${present.length} answered, ${missing.length} missing`)
    if (missing.length > 0) console.log(`[coverage]   missing: ${missing.join(', ')}`)
    return missing
  }

  const missingModule = report('gdal.*', moduleUses, (name) => name in compat)
  const missingMembers = report('members', memberUses, (name) => members.has(name))

  // Only the module-level names gate. The member list is a lead, not a measurement: a
  // bare `.<name>` cannot say which class it was reached on, so it mixes in the suite's
  // own helpers and any local with a gdal-ish name — and it is a **union across
  // classes**, so a name answered on one class hides the same name missing on another.
  // It is still the fastest way to find a whole family of accessors that an adapter
  // forgot (`points`, `rings`, the `SpatialReference.from*` statics) — read it, do not
  // gate on it. `ts-test/compat-reachability.spec.ts` is the per-class guard.
  if (missingModule.length > 0) {
    console.log(
      `\n[coverage] ${missingModule.length} module-level name(s) the reference's tests use ` +
        `that compat does not answer`,
    )
    process.exitCode = 1
  } else {
    console.log('\n[coverage] every gdal.* name the reference\'s own tests use is answered')
  }
  if (missingMembers.length > 0) {
    console.log(`[coverage] ${missingMembers.length} member name(s) missing — see the note above`)
  }
}
