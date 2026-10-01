// The generated `binding.d.ts` is a build artifact, but it is also the API
// contract — so this test reads it and holds it against the *runtime* module,
// rather than against a hand-copied list of expectations. A declaration nothing
// exports, or an export nothing declares, is what it is here to catch: the
// generated file would otherwise be free to drift, and a TypeScript user would
// only find out at runtime.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

import asyncMethods from '../async-methods.js'

const gdal = createRequire(import.meta.url)('..')

/** Names the JavaScript shell adds that `binding.d.ts` does not declare. */
const SHELL_ADDITIONS = new Set(['const', 'RasterMuxStream', 'RasterTransform', 'calcAsync'])

/** `Function`'s own properties, which are not members anyone declares. */
const FUNCTION_BUILTINS = new Set(['length', 'name', 'arguments', 'caller', 'prototype'])

/**
 * Class members the JavaScript shell adds, which `binding.d.ts` therefore does not
 * declare — they are declared in the hand-written `index.d.ts` instead, and checked
 * by the shell test below.
 */
const SHELL_MEMBERS = new Map([
  ['RasterBand', new Set(['createReadStream', 'createWriteStream'])],
])

const sorted = (names) => [...names].sort()

/**
 * The generated file, read into the three things it declares: module-level
 * values, classes with their members, and namespaces with their functions.
 *
 * Only lines at the class body's own indentation (two spaces) are members — a
 * wrapped signature's parameters sit deeper and would otherwise read as members
 * of their own.
 */
function parseDeclarations() {
  const lines = readFileSync(new URL('../binding.d.ts', import.meta.url), 'utf8').split('\n')

  const values = new Set()
  const functions = new Set()
  const asyncFunctions = new Set()
  const classes = new Map()
  const namespaces = new Map()

  let body = null // the class/namespace/const-enum currently open

  for (const line of lines) {
    const trimmed = line.trim()
    const comment = trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')

    if (body) {
      if (!comment) {
        body.depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)
        if (body.kind === 'class') {
          const member = /^ {2}(static\s+)?(?:readonly\s+)?(?:get\s+|set\s+)?([A-Za-z_]\w*)\s*[(:<]/.exec(line)
          if (member && member[2] !== 'constructor') {
            const name = member[2]
            const target = member[1] ? body.static : body.instance
            target.add(name)
            if (line.includes(': Promise<')) {
              const asyncTarget = member[1] ? body.staticAsync : body.instanceAsync
              asyncTarget.add(name)
            }
          }
        } else if (body.kind === 'namespace') {
          const member = /^ {2}export function ([A-Za-z_]\w*)/.exec(line)
          if (member) body.members.add(member[1])
        }
      }
      if (body.depth <= 0) body = null
      continue
    }

    let match
    if ((match = /^export declare class ([A-Za-z_]\w*)/.exec(line))) {
      body = {
        kind: 'class',
        name: match[1],
        depth: 0,
        instance: new Set(),
        static: new Set(),
        instanceAsync: new Set(),
        staticAsync: new Set(),
      }
      values.add(match[1])
      classes.set(match[1], body)
    } else if ((match = /^export declare namespace ([A-Za-z_]\w*)/.exec(line))) {
      body = { kind: 'namespace', name: match[1], depth: 0, members: new Set() }
      values.add(match[1])
      namespaces.set(match[1], body.members)
    } else if (/^export declare const enum ([A-Za-z_]\w*)/.exec(line)) {
      // A `const enum` is type-level, but napi still exports a value for it.
      body = { kind: 'enum', name: /^export declare const enum ([A-Za-z_]\w*)/.exec(line)[1], depth: 0 }
      values.add(body.name)
    } else if ((match = /^export declare function ([A-Za-z_]\w*)/.exec(line))) {
      functions.add(match[1])
      values.add(match[1])
      if (line.includes(': Promise<')) asyncFunctions.add(match[1])
    } else if ((match = /^export declare const ([A-Za-z_]\w*)/.exec(line))) {
      values.add(match[1])
    } else if ((match = /^export type ([A-Za-z_]\w*) =/.exec(line))) {
      // napi emits a `Js…` alias for each class, and exports it at runtime too.
      values.add(match[1])
    }

    // A class/namespace/const-enum opens a body on the same line.
    if (body && !comment) {
      body.depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)
      if (body.depth <= 0) body = null
    }
  }

  return { values, functions, asyncFunctions, classes, namespaces }
}

const declarations = parseDeclarations()

test('every value the binding declares is one the runtime exports, and the reverse', () => {
  const runtime = sorted(Object.keys(gdal).filter((name) => !SHELL_ADDITIONS.has(name)))
  const declared = sorted(declarations.values)

  assert.deepEqual(runtime, declared, 'module-level exports')
})

test('every class member the binding declares exists at runtime, and the reverse', () => {
  for (const [name, members] of declarations.classes) {
    const klass = gdal[name]
    assert.equal(typeof klass, 'function', `${name} is exported and callable`)

    const shell = SHELL_MEMBERS.get(name) ?? new Set()
    const actualInstance = sorted(
      Object.getOwnPropertyNames(klass.prototype).filter(
        (member) => member !== 'constructor' && !shell.has(member),
      ),
    )
    const actualStatic = sorted(
      Object.getOwnPropertyNames(klass).filter((member) => !FUNCTION_BUILTINS.has(member)),
    )

    assert.deepEqual(sorted(members.instance), actualInstance, `${name} instance members`)
    assert.deepEqual(sorted(members.static), actualStatic, `${name} static members`)
  }
})

test('every namespace function the binding declares exists at runtime', () => {
  for (const [name, members] of declarations.namespaces) {
    const namespace = gdal[name]
    assert.equal(typeof namespace, 'object', `${name} is exported as an object`)
    assert.deepEqual(sorted(members), sorted(Object.keys(namespace)), `${name} members`)
  }
})

test('the async members are exactly the ones the shell wraps, per class', () => {
  assert.deepEqual(
    sorted(declarations.asyncFunctions),
    sorted(asyncMethods.functions),
    'module-level async functions',
  )

  // By class, not flattened: a promise method filed under the wrong class is a
  // mistake this catches and a flattened comparison would not.
  const declaredAsync = new Map()
  for (const [name, members] of declarations.classes) {
    const all = [...members.instanceAsync, ...members.staticAsync]
    if (all.length > 0) declaredAsync.set(name, sorted(all))
  }

  const expectedAsync = new Map(
    Object.entries(asyncMethods.methods).map(([name, wrapped]) => [name, sorted(wrapped)]),
  )

  assert.deepEqual(
    Object.fromEntries([...declaredAsync].sort()),
    Object.fromEntries([...expectedAsync].sort()),
    'async methods by class',
  )
})

test('no async member is declared as `Promise<unknown>`', () => {
  // `Promise<unknown>` compiles fine and tells a TypeScript user nothing — the
  // annotations that prevent it are one attribute each and easy to drop.
  const types = readFileSync(new URL('../binding.d.ts', import.meta.url), 'utf8')
  assert.equal(
    types.includes('Promise<unknown>'),
    false,
    'every async member should name what it resolves to',
  )
})

test('the hand-written shell is reflected at runtime and declared too', () => {
  // `gdal.const` is added in `index.js`, not generated — so it is checked here
  // rather than by the set-equality above.
  assert.equal(typeof gdal.const, 'object')
  for (const name of Object.keys(gdal.const)) {
    assert.ok(Object.isFrozen(gdal.const[name]), `gdal.const.${name} is frozen`)
  }

  // The `for await` support is a shell augmentation on the class prototype.
  assert.equal(
    typeof gdal.FeatureCursor.prototype[Symbol.asyncIterator],
    'function',
    'FeatureCursor is async-iterable',
  )

  // And `index.d.ts` — the hand-written half of the types — declares both.
  const index = readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8')
  assert.match(index, /as const/)
  assert.match(index, /Symbol\.asyncIterator/)

  // The shell's own prototype members, checked both ways: present at runtime, and
  // declared here rather than in the generated file.
  for (const [className, members] of SHELL_MEMBERS) {
    for (const member of members) {
      assert.equal(
        typeof gdal[className].prototype[member],
        'function',
        `${className}.${member} is a function`,
      )
      assert.ok(index.includes(member), `${className}.${member} is declared in index.d.ts`)
    }
  }
})
