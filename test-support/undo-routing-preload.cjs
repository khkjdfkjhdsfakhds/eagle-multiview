'use strict';
require('./renderer-ui-preload.cjs');
// The desktop menu item reaches the renderer through onUndoDelete.
window.eagleMV.onUndoDelete = callback => { window.__undoMenu = callback; return () => {}; };
