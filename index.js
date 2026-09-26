'use strict'

// The napi CLI generates `binding.js` / `binding.d.ts` and the platform packages
// only ever contain the `.node` binary — extra runtime data has to live in the
// root package. So this shell exists purely to point PROJ/GDAL at the data files
// shipped under `assets/` before handing over to the generated binding.
const path = require('node:path')
const binding = require('./binding.js')

binding.configureDataPaths({
  proj: process.env.PROJ_DATA || path.join(__dirname, 'assets', 'proj'),
  gdal: process.env.GDAL_DATA || path.join(__dirname, 'assets', 'gdal'),
})

module.exports = binding
