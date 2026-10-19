'use strict';
// The inspector fixture as a phone web client.
require('./inspector-refresh-preload.cjs');
window.eagleMV.platform = 'web';
// A plain browser: the web shim reports no Android shell.
window.eagleMV.shellApp = null;
