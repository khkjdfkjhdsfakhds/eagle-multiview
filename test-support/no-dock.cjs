'use strict';
// Preloaded into every process the test run starts (NODE_OPTIONS, set by
// test-support/run-tests.cjs). Inside an Electron main process on macOS it
// turns the probe into an accessory app, so the ~90 probe windows of a full
// run no longer pop up one Dock icon each. Everywhere else it does nothing.
//
// The electron module cannot be required while this preload runs, only once
// the probe's own script has started, hence the nextTick; that is still
// before app 'ready', which is when the Dock icon would appear.
if (process.platform === 'darwin' && process.versions.electron && process.type === 'browser') {
  process.nextTick(() => {
    try {
      const { app } = require('electron');
      app.setActivationPolicy('accessory');
      app.dock?.hide();
    } catch {}
  });
}
