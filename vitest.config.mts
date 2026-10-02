import { defineConfig } from 'vitest/config'

// The TypeScript suite for the binding and the `gdal-async` compatibility layer.
//
// Two halves: `ts-test/*.spec.ts` is the typed suite against `compat/index.d.ts`,
// and `ts-test/native/*.spec.ts` is the binding's own suite (the one that used to
// be `node --test`). Both run here, on one runner.
//
// Coverage is *not* measured here: it is a property of the compatibility layer, and
// `vitest.coverage.config.mts` runs just that suite to measure it, because merging
// v8 coverage across the many workers this full run spawns is not reliable.
export default defineConfig({
  test: {
    include: ['ts-test/**/*.spec.ts'],
    environment: 'node',
  },
})
