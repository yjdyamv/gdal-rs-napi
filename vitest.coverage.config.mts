import { defineConfig } from 'vitest/config'

// The coverage gate, and only the coverage gate. It runs the `compat` suite — the
// one whose subject is `compat/index.js` — because merging v8 coverage across the
// whole 45-file run is not reliable, and because the number is meant to describe the
// compatibility layer rather than the binding.
//
// A ratchet, not a claim: raise it when the suite grows, never lower it to make a
// run pass. The statement and line numbers describe `compat/index.js`, which is now
// read nearly end to end (98.7% of statements, 99.3% of lines, 99.5% of functions);
// the branch number is
// lower because the adapter is full of defensive `??` and `typeof x === 'function'`
// checks whose other side is a caller mistake the tests do not make. See
// `ts-test/compat-surface.spec.ts` for the by-name coverage, and
// `ts-test/compat-reachability.spec.ts` for the per-class guard the by-name union
// cannot give.
export default defineConfig({
  test: {
    include: ['ts-test/compat-*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['compat/**/*.js'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: {
        statements: 98,
        lines: 98,
        functions: 99,
        branches: 84,
      },
    },
  },
})
