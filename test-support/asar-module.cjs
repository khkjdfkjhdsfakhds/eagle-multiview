'use strict';
// @electron/asar arrives through electron-builder rather than as a direct
// dependency; resolve it from there instead of a versioned .pnpm path, which
// broke on every dependency bump (T-15).
const path = require('node:path');

module.exports = require(require.resolve('@electron/asar', {
  paths: [path.dirname(require.resolve('electron-builder/package.json')), __dirname]
}));
