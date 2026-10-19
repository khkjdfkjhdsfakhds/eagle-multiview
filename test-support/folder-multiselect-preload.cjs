'use strict';
// Eagle's sidebar multi-select: ⌘/⇧-click, one view over several folders,
// and the menu for all of them.
require('./renderer-ui-preload.cjs');
const probe = window.__multiFolder = { removals: [], colors: [], toasts: [] };
window.confirm = () => true;
window.eagleMV.removeFolder = async payload => { probe.removals.push(JSON.parse(JSON.stringify(payload))); return { ok: true, removedIds: [payload.id] }; };
window.eagleMV.updateFolderProperties = async payload => { probe.colors.push(JSON.parse(JSON.stringify(payload))); return { ok: true }; };
window.eagleMV.moveFolder = async payload => { (probe.moves ||= []).push(JSON.parse(JSON.stringify(payload))); return { ok: true }; };
