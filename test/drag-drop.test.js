'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ITEM_TYPE,
  readItemIds,
  isInternalItemDrag,
  classifyDrop,
  shouldShowImportOverlay,
  libraryItemIdFromPath,
  resolveDrop
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

test('while hovering, a native file drag is treated as internal only when a session supplies ids', () => {
  const dataTransfer = transfer(['Files']);
  assert.deepEqual(readItemIds(dataTransfer, ['A']), ['A']);
  assert.equal(isInternalItemDrag(dataTransfer, ['A']), true);
  assert.equal(shouldShowImportOverlay(dataTransfer, ['A']), false);
  // Text and URL drags never borrow session ids.
  assert.notEqual(classifyDrop(transfer(['text/uri-list']), ['A']), 'internal-items');
});

test('a web image or link from a browser imports like Finder files (D-08)', () => {
  const { droppedURL } = require('../src/drag-drop');
  for (const types of [['text/uri-list'], ['text/html'], ['text/plain']]) {
    assert.equal(classifyDrop(transfer(types)), 'external-files', types[0]);
    assert.equal(shouldShowImportOverlay(transfer(types)), true, types[0]);
    assert.equal(resolveDrop(transfer(types)).kind, 'external-files', types[0]);
    // Drags that start in this page carry MultiView's own media addresses.
    assert.equal(classifyDrop(transfer(types), [], { allowURL: false }), 'unsupported', types[0]);
    assert.equal(resolveDrop(transfer(types), { allowURL: false }).kind, 'unsupported', types[0]);
  }
  // Folder and reorder drags of this app are never web addresses.
  assert.equal(classifyDrop(transfer(['application/x-eagle-multiview-folder', 'text/html'])), 'unsupported');
  // The dragged picture's <img src> wins over the page link, like Eagle.
  assert.deepEqual(droppedURL(transfer(['text/html', 'text/uri-list'], {
    'text/html': '<a href="https://site.test/page"><img alt="x" src="https://cdn.test/a.jpg?w=1&amp;h=2"></a>',
    'text/uri-list': 'https://site.test/page'
  })), { url: 'https://cdn.test/a.jpg?w=1&h=2', image: true });
  assert.deepEqual(droppedURL(transfer(['text/uri-list'], { 'text/uri-list': '# comment\r\nhttps://site.test/page\r\n' })),
    { url: 'https://site.test/page', image: false });
  assert.deepEqual(droppedURL(transfer(['text/plain'], { 'text/plain': '  https://site.test/x  ' })),
    { url: 'https://site.test/x', image: false });
  // Inline and temporary browser images are reported as such, not dropped.
  assert.equal(droppedURL(transfer(['text/html'], { 'text/html': '<img src="blob:https://site.test/1">' })).url, 'blob:https://site.test/1');
  assert.match(droppedURL(transfer(['text/html'], { 'text/html': '<img src="data:image/png;base64,AAAA">' })).url, /^data:image\/png/);
  // Plain words and non-web links are not addresses.
  assert.equal(droppedURL(transfer(['text/plain'], { 'text/plain': 'just words' })), null);
  assert.equal(droppedURL(transfer(['text/uri-list'], { 'text/uri-list': 'file:///Users/u/a.png' })), null);
});

const LIBRARY = '/Users/u/Pictures/Main.library';

test('on drop, Finder files are imports even when a stale drag session still holds ids', () => {
  const drop = resolveDrop(transfer(['Files']), {
    sessionIds: ['A'],
    sessionFiles: [`${LIBRARY}/images/A.info/a.png`],
    libraryPaths: [LIBRARY],
    paths: ['/Users/u/Desktop/photo.png']
  });
  assert.deepEqual(drop, { kind: 'external-files', ids: [], fromSession: false });
  // A mix of session and outside files is not a re-file either.
  assert.equal(resolveDrop(transfer(['Files']), {
    sessionIds: ['A'],
    sessionFiles: [`${LIBRARY}/images/A.info/a.png`],
    libraryPaths: [LIBRARY],
    paths: [`${LIBRARY}/images/A.info/a.png`, '/Users/u/Desktop/photo.png']
  }).kind, 'external-files');
  // Without readable paths there is nothing to prove the files are items.
  assert.equal(resolveDrop(transfer(['Files']), { sessionIds: ['A'], libraryPaths: [LIBRARY] }).kind, 'external-files');
});

test('on drop, the session files re-file every session item, including ones without a file', () => {
  const drop = resolveDrop(transfer(['Files']), {
    sessionIds: ['A', 'B', 'A'],
    sessionFiles: [`${LIBRARY}/images/A.info/a.png`],
    libraryPaths: [LIBRARY],
    paths: [`${LIBRARY}/images/A.info/a.png`]
  });
  assert.deepEqual(drop, { kind: 'internal-items', ids: ['A', 'B'], fromSession: true });
});

test('on drop, library originals outside the session are re-filed without the session context', () => {
  const drop = resolveDrop(transfer(['Files']), {
    sessionIds: ['A'],
    sessionFiles: [`${LIBRARY}/images/A.info/a.png`],
    libraryPaths: [LIBRARY],
    paths: [`${LIBRARY}/images/C.info/c.png`]
  });
  assert.deepEqual(drop, { kind: 'internal-items', ids: ['C'], fromSession: false });
  // The same originals with no session at all still never import duplicates.
  assert.deepEqual(resolveDrop(transfer(['Files']), {
    libraryPaths: [LIBRARY],
    paths: [`${LIBRARY}/images/C.info/c.png`]
  }), { kind: 'internal-items', ids: ['C'], fromSession: false });
});

test('on drop, HTML5 item data and synthetic in-page drags keep their session', () => {
  assert.deepEqual(resolveDrop(transfer([ITEM_TYPE], { [ITEM_TYPE]: '["A"]' }), { sessionIds: ['Z'] }),
    { kind: 'internal-items', ids: ['A'], fromSession: true });
  assert.deepEqual(resolveDrop(transfer([]), { sessionIds: ['A'] }),
    { kind: 'internal-items', ids: ['A'], fromSession: true });
  assert.equal(resolveDrop(transfer([])).kind, 'unsupported');
  // Text never borrows session ids: from a browser it may be a URL import.
  assert.equal(resolveDrop(transfer(['text/plain']), { sessionIds: ['A'] }).kind, 'external-files');
  assert.equal(resolveDrop(transfer(['text/plain']), { sessionIds: ['A'], allowURL: false }).kind, 'unsupported');
});

test('library item ids come only from <library>/images/<id>.info/<file>', () => {
  assert.equal(libraryItemIdFromPath(`${LIBRARY}/images/KX12.info/name.jpg`, LIBRARY), 'KX12');
  assert.equal(libraryItemIdFromPath(`${LIBRARY}/images/KX12.info/name.jpg`, `${LIBRARY}/`), 'KX12');
  assert.equal(libraryItemIdFromPath(`${LIBRARY}/images/KX12.info/sub/name.jpg`, LIBRARY), null);
  assert.equal(libraryItemIdFromPath(`${LIBRARY}/images/KX12/name.jpg`, LIBRARY), null);
  assert.equal(libraryItemIdFromPath(`${LIBRARY}-copy/images/KX12.info/name.jpg`, LIBRARY), null);
  assert.equal(libraryItemIdFromPath('/Users/u/Desktop/name.jpg', LIBRARY), null);
  assert.equal(libraryItemIdFromPath(`${LIBRARY}/images/KX12.info/name.jpg`, ''), null);
});

test('native drag sessions publish their files and stay off the web event stream', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf("onRPC('item:start-drag'");
  const handler = main.slice(start, main.indexOf("onRPC('item:cancel-drag'", start));
  assert.ok(/active: true,\s+token,\s+ids: uniqueIds,[\s\S]*?\n\s+files,/.test(handler), 'drag-state carries the dragged file paths');
  const broadcast = main.slice(main.indexOf('function broadcast(channel, payload)'));
  const skip = broadcast.indexOf("if (channel === 'item:drag-state') return;");
  const forward = broadcast.indexOf('webServer?.broadcast(channel, payload);');
  assert.ok(skip >= 0 && forward >= 0 && skip < forward);
});

test('shows the import overlay for files that genuinely come from outside MultiView', () => {
  const dataTransfer = transfer(['Files']);
  assert.equal(isInternalItemDrag(dataTransfer), false);
  assert.equal(shouldShowImportOverlay(dataTransfer), true);
});

test('classifies internal items, external files, and unsupported drags at one boundary', () => {
  assert.equal(classifyDrop(transfer([ITEM_TYPE], { [ITEM_TYPE]: '["A"]' })), 'internal-items');
  assert.equal(classifyDrop(transfer(['Files'])), 'external-files');
  assert.equal(classifyDrop(transfer(['text/plain']), [], { allowURL: false }), 'unsupported');
  assert.equal(classifyDrop(transfer(['application/x-other'])), 'unsupported');
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

test('native drag uses a bundled PNG when the item preview cannot be decoded', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('function dragIcon(');
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.ok(
    handler.includes("path.join(__dirname, 'src', 'brand-icon.png')"),
    'startDrag must always receive a NativeImage that Electron can decode'
  );
  assert.equal(handler.includes("path.join(process.resourcesPath, 'icon.icns')"), false);
});

test('native drag converts an unsupported macOS thumbnail before using the app icon', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const converterStart = source.indexOf('function convertedMacDragIcon(');
  const dragStart = source.indexOf('function dragIcon(');
  const dragEnd = source.indexOf('\n}\n', dragStart);
  assert.ok(converterStart >= 0, 'unsupported image formats need a synchronous macOS thumbnail converter');
  assert.ok(source.includes("spawnSync('/usr/bin/sips'"));
  assert.ok(source.includes("'-Z', '96'"));
  const handler = source.slice(dragStart, dragEnd);
  assert.ok(handler.indexOf('convertedMacDragIcon(') < handler.indexOf("brand-icon.png"));
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
  assert.ok(source.includes('const move = Boolean(sourceFolderId && !event.altKey);'));
  assert.ok(source.includes('move: Boolean(sourceFolderId && !event.altKey)'));
  assert.ok(source.includes("dropEffect = dropKind === 'internal-items' && sourceFolderId && !event.altKey ? 'move' : 'copy'"));
  assert.ok(source.includes("event.dataTransfer.dropEffect = sourceFolderId && !event.altKey ? 'move' : 'copy'"));
  assert.ok(source.includes('pane.items = pane.items.filter(item => !movedIds.has(item.id));'));
  assert.ok(source.includes('movedIds.forEach(id => { pane.itemMap?.delete(id); });'));
  assert.ok(source.includes('pane.total = Math.max(0, (Number(pane.total) || 0) - movedIds.size);'));
  assert.ok(source.includes('movedIds.forEach(id => pane.selected.delete(id));'));
});

test('folder drags advertise copy for Option and move otherwise on every drop target', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'feature-ui.js'), 'utf8');
  assert.ok(source.includes("event.dataTransfer.dropEffect = valid ? (event.altKey ? 'copy' : 'move') : 'none';"),
    'dragover advertises copy with Option and move otherwise');
  assert.ok(source.includes("const copy = event.altKey;"), 'drop reads the Option modifier');
  assert.ok(source.includes("? copyFolder(payload.id, target.parentId, ctx, target.placement)"),
    'Option drop copies the folder subtree (after confirmation) at the drop position');
  assert.ok(source.includes(": moveFolder(payload.id, target.parentId, { ...ctx, sourceId: payload.id,"),
    'plain drop moves the folder');
  assert.ok(source.includes("const parentId = context().paneDestination?.(pane.dataset.paneId);"),
    'content-area drops resolve the destination from the pane they land on');
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
