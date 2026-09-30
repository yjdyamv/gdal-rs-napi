import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * The generated `binding.d.ts` is a build artifact, so it only exists after
 * `npm run build`. Saying that beats an ENOENT.
 */
function generatedTypes() {
  try {
    return readFileSync(new URL('../binding.d.ts', import.meta.url), 'utf8')
  } catch {
    throw new Error(
      'binding.d.ts is missing — run `npm run build` before `npm test` (CI does both, in that order)',
    )
  }
}

test('the generated types name what the async methods resolve to', () => {
  // `Promise<unknown>` compiles perfectly well and tells a TypeScript user nothing.
  // The annotations that fix that are one attribute each, and easy to drop in a
  // refactor, so this reads the generated file rather than trusting them.
  const types = generatedTypes()

  assert.equal(
    types.includes('Promise<unknown>'),
    false,
    'every async method should name what it resolves to',
  )

  for (const pattern of [
    /statistics\([^)]*\): Promise<BandStatistics \| null>/,
    /histogram\([^)]*\): Promise<BandHistogram>/,
    /readPixels\([^)]*\): Promise<Buffer>/,
    /readAs\([^)]*\): Promise<Buffer>/,
    /writePixels\([^)]*\): Promise<void>/,
    /read\(\): Promise<Array<FeatureRecord>>/,
    /identifyEpsg\([^)]*\): Promise<string \| null>/,
    /transformPoints\([^)]*\): Promise<Float64Array>/,
    /buildOverviews\([^)]*\): Promise<void>/,
    /createCopy\([^)]*\): Promise<Dataset>/,
  ]) {
    assert.match(types, pattern)
  }
})
