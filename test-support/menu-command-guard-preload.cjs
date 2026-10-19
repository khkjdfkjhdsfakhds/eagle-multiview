'use strict';
require('./batch-selection-preload.cjs');
// F-05: keep the IPC menu-command callbacks so the probe can fire them the
// way the application menu would.
window.__menuCommands = {};
for (const name of ['onCreateFolderRequest', 'onRenameRequest', 'onSetRating']) {
  window.eagleMV[name] = callback => { window.__menuCommands[name] = callback; return () => {}; };
}
