import { defineConfig } from 'vitest/config'

// The suite for a `bundled-lean` build.
//
// Most tests are driver-agnostic, and the ones that need a library-backed driver
// gate themselves on `hasDriver` (see `ts-test/helpers.ts`), so they skip rather
// than fail. The multidimensional files are netCDF all the way through, so they
// are left out here instead of being made conditional.
//
//   npm run build:lean && npm run test:lean
export default defineConfig({
  test: {
    include: ['ts-test/**/*.spec.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'ts-test/native/multidim.spec.ts',
      'ts-test/native/compat-multidim.spec.ts',
      'ts-test/compat-multidim.spec.ts',
    ],
    environment: 'node',
  },
})
