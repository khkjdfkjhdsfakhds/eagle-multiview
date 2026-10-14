'use strict';
require('./batch-selection-preload.cjs');
// B3-01: the copy bridge records which items ⌘C hands to the clipboard.
window.eagleMV.capabilities.clipboardFiles = true;
window.__copied = [];
window.eagleMV.copyFiles = async ids => { window.__copied.push([...ids]); return { count: ids.length, missing: 0 }; };
