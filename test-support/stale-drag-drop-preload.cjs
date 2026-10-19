'use strict';
// Native item drags whose session never ends cleanly (dropped in Finder,
// Esc-cancelled, failed to start), followed by drops of Finder files.
require('./item-cross-pane-drag-preload.cjs');
const LIBRARY = '/tmp/EagleMV-UI-Test.library';
const sessionFile = id => `${LIBRARY}/images/${id}.info/${id}.png`;
window.__staleDrag = { imports: [], paths: new Map(), sessionFile };
window.eagleMV.pathForFile = file => window.__staleDrag.paths.get(file.name) || '';
window.eagleMV.focusWindow = async () => true;
window.eagleMV.importItems = async payload => {
  window.__staleDrag.imports.push(JSON.parse(JSON.stringify(payload)));
  return { count: (payload.paths || []).length, ready: (payload.paths || []).length };
};
let token = 0;
// Main broadcasts the exact file paths it handed to startDrag.
window.eagleMV.startDrag = data => {
  token += 1;
  window.__itemDrag.started = token;
  window.__itemDrag.emit?.({ ...data, active: true, token, files: data.ids.map(sessionFile) });
};
