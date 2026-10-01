'use strict'

// Every method the binding returns a promise from.
//
// It is a list because napi fixes the error type of a `Task` to `Status`, so an
// async failure cannot carry this binding's `err.code` — the stable token goes
// into the message as a `[GDAL_…]` prefix instead. `index.js` uses this list to
// turn that prefix back into a field, and `__test__/async-surface.test.mjs`
// checks the list against the generated `binding.d.ts`, so a new async method
// cannot quietly go uncovered.
//
// Kept as data in its own file rather than inside index.js so the test can read
// the same list the runtime uses.

/** Module-level functions that return a promise. */
const functions = [
  'buildVrt',
  'create',
  'createVector',
  'demProcess',
  'identifyEpsg',
  'open',
  'openThreadSafe',
  'translate',
  'vectorTranslate',
  'warp',
]

/** Methods that return a promise, by class. */
const methods = {
  CoordinateTransform: ['transformPoints'],
  Dataset: [
    'buildOverviews',
    'createCopy',
    'demProcess',
    'flush',
    'geoTransformAsync',
    'rasterSizeAsync',
    'rasterize',
    'removeOverviews',
    'reprojectImage',
    'spatialRefAsync',
    'suggestedWarpOutput',
    'translate',
    'vectorTranslate',
    'warp',
  ],
  Driver: ['create', 'createCopy', 'open'],
  FeatureCursor: ['read'],
  Layer: ['features', 'flush'],
  RasterBand: [
    'blockSizeAsync',
    'categoryNamesAsync',
    'checksum',
    'colorInterpretationAsync',
    'colorTableAsync',
    'contourGenerate',
    'dataTypeAsync',
    'descriptionAsync',
    'fillNoData',
    'flush',
    'hasArbitraryOverviewsAsync',
    'histogram',
    'idAsync',
    'maximumAsync',
    'minimumAsync',
    'noDataValueAsync',
    'offsetAsync',
    'polygonize',
    'readAs',
    'readChunks',
    'readOnlyAsync',
    'readPixels',
    'scaleAsync',
    'sieveFilter',
    'sizeAsync',
    'statistics',
    'unitTypeAsync',
    'writePixels',
  ],
  BandOverview: ['read'],
}

module.exports = { functions, methods }
