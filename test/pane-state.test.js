'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createQuery, cloneQuery, filtersActive, filterCount, selectRange } = require('../src/pane-state');

test('clones query state without sharing tags between panes', () => {
  const first = createQuery({ search: 'one', tags: ['a', 'a'], shape: 'portrait' });
  const second = cloneQuery(first);
  second.tags.push('b');
  second.search = 'two';
  assert.deepEqual(first, {
    folderId: null,
    smartFolderId: null,
    search: 'one',
    searchScope: '',
    tags: ['a'],
    ext: '',
    rating: null,
    annotation: '',
    url: '',
    shape: 'portrait',
    color: '',
    size: null,
    added: null,
    pixels: null
  });
  assert.equal(second.search, 'two');
  assert.deepEqual(second.tags, ['a', 'b']);
});

test('counts all user-visible filter dimensions', () => {
  const query = createQuery({ search: 'cat', annotation: 'note', url: 'example', shape: 'square', rating: 4, tags: ['ref'] });
  assert.equal(filtersActive(query), true);
  assert.equal(filterCount(query), 6);
  assert.equal(filtersActive(createQuery()), false);
});

test('range selection falls back safely when the previous anchor disappeared', () => {
  const items = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  assert.deepEqual([...selectRange(items, new Set(['removed']), 'C')], ['C']);
  assert.deepEqual([...selectRange(items, new Set(['A']), 'C')], ['A', 'B', 'C']);
});

test('clicking inside the active pane does not rebuild the global sidebar', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('function activatePane(id)');
  const end = source.indexOf('\n}', start);
  const handler = source.slice(start, end);
  const samePaneGuard = handler.indexOf('if (state.activePaneId === id) return true;');
  const renderTree = handler.indexOf('renderFolderTree();');
  assert.ok(start >= 0);
  assert.ok(samePaneGuard > 0);
  assert.ok(renderTree > samePaneGuard);
});

test('switching panes resolves inspector drafts before changing the active pane', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('function activatePane(id)');
  const end = source.indexOf('\n}', start);
  const handler = source.slice(start, end);
  const discardCheck = handler.indexOf('confirmDiscardChanges({ includeText: false })');
  const switchPane = handler.indexOf('state.activePaneId = id;');
  assert.ok(discardCheck > 0);
  assert.ok(switchPane > discardCheck);
  assert.ok(handler.includes('return false;'));
});

test('layout changes preserve inspector drafts and stay blocked while a save is active', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('function renderPaneLayout(');
  const end = source.indexOf('\nasync function refreshAllPanes', start);
  const handler = source.slice(start, end);
  const sameLayout = handler.indexOf("layoutRoot.dataset.layout === layout && layoutRoot.querySelector('.content-pane')");
  const savingGuard = handler.indexOf('state.inspectorSaving');
  const foregroundGuard = handler.indexOf('state.operationTracker.size');
  const discardCheck = handler.indexOf('confirmDiscardChanges({ includeText: false })');
  const replacePanes = handler.indexOf('state.panes = Array.from');
  assert.ok(sameLayout >= 0);
  assert.ok(savingGuard > sameLayout);
  assert.ok(foregroundGuard > savingGuard);
  assert.ok(discardCheck > foregroundGuard);
  assert.ok(replacePanes > discardCheck);
  assert.ok(handler.includes('return true;'));
});

test('inspector saves use an immutable source pane snapshot and a single conflict loop', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('async function saveInspector(');
  const end = source.indexOf('\nasync function setPinned', start);
  const handler = source.slice(start, end);
  assert.ok(handler.includes('const paneId = state.activePaneId;'));
  assert.ok(handler.includes('const pane = paneById(paneId);'));
  assert.ok(handler.includes('const base = structuredClone(pane.selectedBase || {});'));
  assert.ok(handler.includes('const libraryPath = state.library?.path;'));
  assert.ok(handler.includes('while (true)'));
  assert.ok(handler.includes('pane.items.findIndex'));
  assert.ok(handler.includes('if (state.activePaneId === paneId)'));
  assert.equal(handler.includes('return saveInspector(true)'), false);
  assert.ok(handler.includes('setInspectorSaving(true)'));
  assert.ok(handler.includes('setInspectorSaving(false)'));
});

test('inspector metadata auto-saves after a quiet edit and on field exit', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  assert.equal(source.includes('id="saveButton"'), false);
  const markStart = source.indexOf('function markDirty()');
  const markEnd = source.indexOf('\nfunction collectPatch', markStart);
  const markHandler = source.slice(markStart, markEnd);
  assert.ok(markHandler.includes('queueInspectorAutoSave()'));
  const queueStart = source.indexOf('function queueInspectorAutoSave');
  const queueEnd = source.indexOf('\nfunction collectPatch', queueStart);
  const queueHandler = source.slice(queueStart, queueEnd);
  assert.ok(queueHandler.includes('setTimeout'));
  assert.ok(queueHandler.includes('saveInspector()'));
  const bindStart = source.indexOf('function bindEvents()');
  const bindEnd = source.indexOf('\nfunction bindHubEvents()', bindStart);
  const bindings = source.slice(bindStart, bindEnd);
  assert.ok(bindings.includes("queueInspectorAutoSave({ immediate: true })"));
  assert.equal(bindings.includes("$('#saveButton')"), false);
});

test('inspector auto-save stays behind the live editor and queues in-flight typing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const savingStart = source.indexOf('function setInspectorSaving(');
  const savingEnd = source.indexOf('\nasync function saveInspector', savingStart);
  const savingHandler = source.slice(savingStart, savingEnd);
  assert.equal(savingHandler.includes('control.disabled'), false);
  assert.equal(savingHandler.includes('#itemAnnotation'), false);

  const saveStart = source.indexOf('async function saveInspector(');
  const saveEnd = source.indexOf('\nasync function setPinned', saveStart);
  const saveHandler = source.slice(saveStart, saveEnd);
  const successStart = saveHandler.indexOf('const contextStillActive');
  const successEnd = saveHandler.indexOf("toast('修改已同步到所有窗口')", successStart);
  const successHandler = saveHandler.slice(successStart, successEnd);
  assert.ok(successStart >= 0);
  assert.ok(successHandler.includes('pane.selectedBase = structuredClone(result.item)'));
  assert.ok(successHandler.includes('state.inspectorDirty = Object.keys(collectPatch()).length > 0'));
  assert.equal(successHandler.includes('renderInspector()'), false);
  assert.ok(saveHandler.includes('if (queueFollowUp) queueInspectorAutoSave()'));

  const scheduleStart = source.indexOf('const scheduleChangedInspectorRender');
  const scheduleEnd = source.indexOf('\nfunction queueChangedInspectorRender', scheduleStart);
  const scheduleHandler = source.slice(scheduleStart, scheduleEnd);
  assert.ok(scheduleHandler.includes('state.inspectorSaving'));
  assert.ok(scheduleHandler.includes('state.inspectorEditing'));
  assert.ok(scheduleHandler.indexOf('return;') < scheduleHandler.indexOf('renderInspector();'));
});

test('window close waits for an inspector save instead of abandoning an in-flight write', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('window.eagleMV.onRequestClose');
  const end = source.indexOf('window.eagleMV.onTrashSelection', start);
  const handler = source.slice(start, end);
  const pendingWrites = handler.indexOf('blockingForegroundOperations()');
  const savingGuard = handler.indexOf('state.inspectorSaving');
  const unsavedCheck = handler.indexOf('const hasUnsavedText');
  assert.ok(pendingWrites >= 0);
  assert.ok(savingGuard > pendingWrites);
  assert.ok(savingGuard < unsavedCheck);
  assert.ok(handler.includes('window.eagleMV.cancelClose();'));
  assert.ok(handler.includes('if (state.inspectorDirty)'));
  assert.ok(handler.includes('if (!await saveInspector()) return;'));
});

test('high-risk writes register and release a close-blocking foreground operation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  for (const functionName of ['saveInspector', 'setPinned', 'applyTrash', 'mutateSelectionSet', 'moveSelectionToFolder', 'setSelectionRating', 'saveTextPreview', 'importFiles', 'addItemsToFolder', 'handlePaneItemDrop']) {
    const start = source.indexOf(`async function ${functionName}`);
    const nextFunction = source.indexOf('\nfunction ', start + 10);
    const nextAsyncFunction = source.indexOf('\nasync function ', start + 10);
    const end = Math.min(...[nextFunction, nextAsyncFunction].filter(index => index > start));
    const handler = source.slice(start, end);
    assert.ok(start >= 0, `${functionName} exists`);
    assert.ok(handler.includes('beginForegroundOperation('), `${functionName} registers an operation`);
    assert.ok(handler.includes('endForegroundOperation(operationToken)'), `${functionName} releases its operation`);
  }
});

test('comment writes only reload the inspector context that initiated them', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  assert.ok(source.includes('function commentContextMatches({ paneId, id, libraryPath })'));
  for (const functionName of ['addCommentToSelected', 'editComment', 'removeComment']) {
    const start = source.indexOf(`async function ${functionName}`);
    const next = source.indexOf('\nasync function ', start + 10);
    const handler = source.slice(start, next);
    assert.ok(handler.includes('const paneId = state.activePaneId;'), `${functionName} captures its pane`);
    assert.ok(handler.includes('const libraryPath = state.library?.path;'), `${functionName} captures its library`);
    assert.ok(handler.includes('commentContextMatches({ paneId, id, libraryPath })'), `${functionName} checks its original inspector context`);
  }
});

test('TXT saves freeze their snapshot, avoid recursive conflicts, and survive preview teardown', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('async function saveTextPreview(');
  const end = source.indexOf('\nfunction closePreview', start);
  const handler = source.slice(start, end);
  assert.ok(handler.includes('if (state.textSaving) return false;'));
  assert.ok(handler.includes('const content = session.content;'));
  assert.ok(handler.includes('const base = structuredClone(session.fingerprint);'));
  assert.ok(handler.includes('const libraryPath = state.library?.path;'));
  assert.ok(handler.includes('while (true)'));
  assert.equal(handler.includes('return saveTextPreview(true)'), false);
  assert.ok(handler.includes('if (state.textSession === session)'));
  assert.ok(handler.includes('setTextSaving(false, session)'));
});

test('pin writes repaint their source pane instead of whichever pane is active later', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('async function setPinned(');
  const end = source.indexOf('\nfunction closeTrashDialog', start);
  const handler = source.slice(start, end);
  assert.ok(handler.includes('paneId = state.activePaneId'));
  assert.ok(handler.includes('const pane = paneById(paneId);'));
  assert.ok(handler.includes('const folderId = pane.currentView.id;'));
  assert.ok(handler.includes('schedulePaneGridRender(paneId)'));
  assert.ok(handler.includes('if (state.activePaneId === paneId) renderInspector();'));
});

test('inactive pane scrolling updates that pane directly without activating it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf("scroller.addEventListener('scroll'");
  const end = source.indexOf('\n  });', start);
  const handler = source.slice(start, end);
  assert.ok(handler.includes('pane.scrollTop = element.scrollTop;'));
  assert.equal(handler.includes('activatePane(paneId)'), false);
  assert.ok(handler.includes('pane.loading'));
  assert.ok(handler.includes('pane.hasMore'));
});

test('background pane refresh cannot repaint the active inspector or footer', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('async function refresh(');
  const end = source.indexOf('\nconst scheduleRefresh', start);
  const handler = source.slice(start, end);
  const pageResolved = handler.indexOf('if (refreshToken !== pane.refreshToken) return;');
  const activeSnapshot = handler.indexOf('const paneIsActive = state.activePaneId === paneId;', pageResolved);
  const temporarySwitch = handler.indexOf('withActivePane(paneId', activeSnapshot);
  assert.ok(activeSnapshot > 0);
  assert.ok(activeSnapshot > pageResolved);
  assert.ok(activeSnapshot < temporarySwitch);
  assert.ok(handler.includes('if (paneIsActive) renderInspector();'));
  assert.ok(handler.includes('if (paneIsActive) updateScrollUI();'));
  assert.equal(handler.includes('state.activePaneId === paneId) renderInspector'), false);
});

test('background grid renders respect the visibly active pane before updating the shared footer', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('function renderGrid(');
  const end = source.indexOf('\nfunction updateScrollUI', start);
  const handler = source.slice(start, end);
  assert.ok(handler.includes("const updateSharedFooter = paneRoot()?.classList.contains('active') ?? true;"));
  // Three exits: tag-manager view, the lazy-load append fast path, and the
  // full rebuild — each may only touch the shared footer from the active pane.
  assert.equal((handler.match(/if \(updateSharedFooter\) updateScrollUI\(\);/g) || []).length, 3);
});

test('delayed import refreshes stay attached to the pane that received the import', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('async function importFiles(');
  const end = source.indexOf('\n}', start);
  const handler = source.slice(start, end);
  assert.ok(handler.includes('const sourcePaneId = state.activePaneId;'));
  assert.match(handler, /setTimeout\(\(\) => refresh\(\{ reset: true, preserveScroll: true, paneId: sourcePaneId \}\), 1600\)/);
  assert.match(handler, /setTimeout\(\(\) => refresh\(\{ reset: true, preserveScroll: true, paneId: sourcePaneId \}\), 4200\)/);
});

test('blocking dialogs consume Escape before workspace shortcuts can run', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf("document.addEventListener('keydown'");
  const end = source.indexOf('\n  });', start);
  const handler = source.slice(start, end);
  const escape = handler.indexOf("if (event.key === 'Escape')");
  const shortcut = handler.indexOf("event.key.toLowerCase() === 'n'");
  assert.ok(escape >= 0);
  assert.ok(escape < shortcut);
  assert.ok(handler.includes("closeDuplicateDialog('cancel')"));
  assert.ok(handler.includes('if (blockingSurfaceOpen()) return;'));
});

test('paste import stays disabled behind dialogs and preview', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf("document.addEventListener('paste'");
  const end = source.indexOf('\n  });', start);
  const handler = source.slice(start, end);
  assert.ok(handler.includes('blockingSurfaceOpen()'));
  assert.ok(handler.includes("!$('#previewModal').classList.contains('hidden')"));
});

test('item change events batch pane renders instead of repainting every pane immediately', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('window.eagleMV.onItemsChanged');
  const end = source.indexOf("window.eagleMV.onLibraryChanged", start);
  const handler = source.slice(start, end);
  assert.ok(start >= 0);
  assert.ok(handler.includes('schedulePaneGridRender(pane.id);'));
  assert.equal(handler.includes('withActivePane(pane.id, () => renderGrid'), false);
});

test('bulk folder, rating, and trash operations use bounded batches with partial failure tracking', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  for (const functionName of ['applyTrash', 'mutateSelectionSet', 'moveSelectionToFolder', 'setSelectionRating']) {
    const start = source.indexOf(`function ${functionName}`);
    const end = source.indexOf('\n}', start);
    const handler = source.slice(start, end);
    assert.ok(start >= 0, `${functionName} exists`);
    assert.ok(handler.includes('runItemBatch('), `${functionName} batches Eagle writes`);
  }
  assert.ok(source.includes('pane.selected = new Set(outcome.failed);'));
});

test('one pane query failure stays local and offers a retry instead of disabling the app', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const catchStart = source.indexOf("} else {\n      withActivePane(paneId", source.indexOf('async function refresh('));
  const catchEnd = source.indexOf('\n    }\n  } finally', catchStart);
  const handler = source.slice(catchStart, catchEnd);
  assert.ok(catchStart >= 0);
  assert.ok(handler.includes("state.errorMessage = error.message"));
  assert.equal(handler.includes('setConnection(false'), false);
  assert.ok(source.includes("query('#emptyRetryButton').addEventListener('click'"));
});

test('slow bulk mutations remain bound to the pane that started them', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  for (const functionName of ['applyTrash', 'mutateSelectionSet', 'moveSelectionToFolder', 'setSelectionRating']) {
    const start = source.indexOf(`function ${functionName}`);
    const nextFunction = source.indexOf('\nfunction ', start + 10);
    const nextAsyncFunction = source.indexOf('\nasync function ', start + 10);
    const candidates = [nextFunction, nextAsyncFunction].filter(index => index > start);
    const end = Math.min(...candidates);
    const handler = source.slice(start, end);
    assert.ok(handler.includes('paneId'), `${functionName} captures a pane id`);
    assert.ok(handler.includes('pane.selected = new Set(outcome.failed'), `${functionName} restores failures in its source pane`);
    assert.ok(handler.includes('paneId }'), `${functionName} refreshes its source pane`);
  }
});
