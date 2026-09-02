'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ITEM_TYPE,
  readItemIds,
  isInternalItemDrag,
  classifyDrop,
  shouldShowImportOverlay
} = require('../src/drag-drop');
const fs = require('node:fs');
const path = require('node:path');

function transfer(types, values = {}) {
  return {
    types,
    getData(type) { return values[type] || ''; }
  };
}

test('reads unique internal item ids from the custom drag type', () => {
  const dataTransfer = transfer([ITEM_TYPE], { [ITEM_TYPE]: JSON.stringify(['A', 'A', 'B']) });
  assert.deepEqual(readItemIds(dataTransfer), ['A', 'B']);
  assert.equal(isInternalItemDrag(dataTransfer), true);
});

test('keeps a native file drag internal when the active MultiView session supplies ids', () => {
  const dataTransfer = transfer(['Files']);
  assert.deepEqual(readItemIds(dataTransfer, ['A']), ['A']);
  assert.equal(isInternalItemDrag(dataTransfer, ['A']), true);
  assert.equal(shouldShowImportOverlay(dataTransfer, ['A']), false);
});

test('shows the import overlay for files that genuinely come from outside MultiView', () => {
  const dataTransfer = transfer(['Files']);
  assert.equal(isInternalItemDrag(dataTransfer), false);
  assert.equal(shouldShowImportOverlay(dataTransfer), true);
});

test('classifies internal items, external files, and unsupported drags at one boundary', () => {
  assert.equal(classifyDrop(transfer([ITEM_TYPE], { [ITEM_TYPE]: '["A"]' })), 'internal-items');
  assert.equal(classifyDrop(transfer(['Files'])), 'external-files');
  assert.equal(classifyDrop(transfer(['text/plain'])), 'unsupported');
});

test('falls back to the active session when custom drag data is malformed', () => {
  const dataTransfer = transfer([ITEM_TYPE], { [ITEM_TYPE]: '{bad json' });
  assert.deepEqual(readItemIds(dataTransfer, ['fallback']), ['fallback']);
});

test('item drag: Electron cancels the default session, the web keeps HTML5 alive', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf("itemGrid.addEventListener('dragstart'");
  const end = source.indexOf("itemGrid.addEventListener('dragend'", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const handler = source.slice(start, end);
  const capabilityBranch = handler.indexOf("if (hasCapability('nativeDrag'))");
  const nativeGuard = handler.indexOf("Electron's native file drag must replace");
  const cancelDefault = handler.indexOf('event.preventDefault();', nativeGuard);
  const html5Data = handler.indexOf('event.dataTransfer.setData(window.EagleMVDragDrop.ITEM_TYPE', capabilityBranch);
  const startNativeDrag = handler.indexOf('window.eagleMV.startDrag(');
  assert.ok(capabilityBranch >= 0, 'dragstart branches on the nativeDrag capability');
  assert.ok(nativeGuard > capabilityBranch);
  assert.ok(cancelDefault > nativeGuard && cancelDefault < startNativeDrag, 'Electron path cancels the HTML5 session before startDrag');
  assert.ok(html5Data > cancelDefault && html5Data < startNativeDrag, 'web path carries ids on the live HTML5 session');
});

test('folder drops keep every queued mutation inside the library where the drag began', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  for (const functionName of ['addItemsToFolder', 'handlePaneItemDrop']) {
    const start = source.indexOf(`async function ${functionName}`);
    const next = source.indexOf('\nasync function ', start + 10);
    const nextPlain = source.indexOf('\nfunction ', start + 10);
    const end = Math.min(...[next, nextPlain].filter(index => index > start));
    const handler = source.slice(start, end);
    const mutation = handler.indexOf('window.eagleMV.mutateSet');
    assert.ok(handler.includes('libraryPath'), `${functionName} receives a captured library path`);
    assert.ok(handler.includes('libraryPath\n'));
    assert.equal(handler.includes('libraryPath: state.library?.path'), false);
    assert.ok(mutation >= 0, `${functionName} performs the queued mutation`);
  }
});

test('every drop handler releases native drag state before starting async work', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  assert.ok(source.includes('function scheduleDropTask(task)'));
  assert.ok(source.includes('clearDragUI();\n  setTimeout(() => {'));
  assert.equal(/addEventListener\('drop',\s*async/.test(source), false);
  assert.equal(source.includes('await addItemsToFolder'), false);
  assert.equal(source.includes('await handlePaneItemDrop'), false);
});

test('cross-window drag context carries the source library, pane, folder and window', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const rendererPayloads = {
    sourceFolderId: 'sourceFolderId,',
    sourcePaneId: 'sourcePaneId: paneId,',
    sourceWindowId: 'sourceWindowId: state.windowId,',
    libraryPath: 'libraryPath\n'
  };
  for (const field of Object.keys(rendererPayloads)) {
    assert.ok(renderer.includes(rendererPayloads[field]), `renderer sends ${field}`);
    assert.ok(main.includes(`${field}: payload.${field}`), `main broadcasts ${field}`);
  }
  assert.ok(renderer.includes('internalDrag.sourceWindowId === state.windowId'));
});

test('folder drops enforce move semantics from folder view and remove items from current view', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  assert.ok(source.includes('const move = Boolean(sourceFolderId || event.altKey);'));
  assert.ok(source.includes('pane.items = pane.items.filter(item => !movedIds.has(item.id));'));
  assert.ok(source.includes('movedIds.forEach(id => { pane.itemMap?.delete(id); });'));
  assert.ok(source.includes('pane.total = Math.max(0, (Number(pane.total) || 0) - movedIds.size);'));
  assert.ok(source.includes('movedIds.forEach(id => pane.selected.delete(id));'));
});

test('folderMoveDelta calculates move vs add semantics correctly', () => {
  const { folderMoveDelta } = require('../src/folder-navigation');
  // Moving from folder view to target folder removes from source and adds to target
  assert.deepEqual(folderMoveDelta('source-folder-1', 'target-folder-2'), {
    add: ['target-folder-2'],
    remove: ['source-folder-1']
  });
  // Dragging from non-folder view (null source) only adds to target
  assert.deepEqual(folderMoveDelta(null, 'target-folder-2'), {
    add: ['target-folder-2'],
    remove: []
  });
  // Moving to same folder is a no-op removal
  assert.deepEqual(folderMoveDelta('same-folder', 'same-folder'), {
    add: ['same-folder'],
    remove: []
  });
});
