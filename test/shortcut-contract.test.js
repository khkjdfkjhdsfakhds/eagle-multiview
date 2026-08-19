'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

test('new-window and default-app shortcuts match their visible labels', () => {
  assert.match(renderer, /label: '在新窗口打开', shortcut: '⌘ O'/);
  assert.match(renderer, /openSelectionInNewWindow\(\[state\.previewId \|\| \[\.\.\.state\.selected\]\[0\]\]\)/);
  assert.match(renderer, /label: '在默认应用打开', shortcut: '⇧ Enter'/);
  assert.match(html, /id="openDefaultButton"[^>]+title="快捷键：⇧Enter"/);
});

test('macOS File menu exposes exactly one default new-window command', () => {
  const fileMenuStart = main.indexOf("      label: '文件',\n      submenu: [");
  const editMenuStart = main.indexOf("      label: '编辑',", fileMenuStart);
  assert.ok(fileMenuStart >= 0, 'File menu template exists');
  assert.ok(editMenuStart > fileMenuStart, 'File menu is followed by the Edit menu');

  const fileMenu = main.slice(fileMenuStart, editMenuStart);
  assert.equal((fileMenu.match(/label: '新窗口'/g) ?? []).length, 1);
  assert.doesNotMatch(fileMenu, /新建资料库窗口/);
  assert.match(fileMenu, /label: '新窗口',\s*accelerator: 'CmdOrCtrl\+Alt\+N',\s*click: \(\) => windowRouter\.openDefault\(\)\.catch/);
  assert.equal((main.match(/accelerator: 'CmdOrCtrl\+Alt\+N'/g) ?? []).length, 1);
});

test('new-item shortcuts follow Eagle folder creation without reviving the old command-N conflict', () => {
  assert.match(main, /label: '新建文件夹', accelerator: 'Alt\+N'/);
  assert.match(main, /label: '新建 TXT', accelerator: 'Alt\+Shift\+N'/);
  assert.match(main, /label: '新窗口',[\s\S]{0,80}accelerator: 'CmdOrCtrl\+Alt\+N'/);
  assert.doesNotMatch(main, /label: '新建文件夹', accelerator: 'CmdOrCtrl\+N'/);
  assert.doesNotMatch(main, /label: '新建 TXT', accelerator: 'CmdOrCtrl\+Shift\+N'/);
  assert.doesNotMatch(main, /新窗口', accelerator: 'CmdOrCtrl\+N'/);
  assert.match(html, /id="newButton"[^>]+title="新建文件夹或文件（⌥N 新建文件夹）"/);
  assert.match(html, /id="newWindowButton"[^>]+title="在当前 MultiView 路径新建窗口（默认，⌘⌥N）"/);
  const keydownStart = renderer.indexOf("document.addEventListener('keydown'");
  const handler = renderer.slice(keydownStart, renderer.indexOf('\n  });\n}', keydownStart));
  assert.ok(handler.includes("primaryKey && !event.shiftKey && event.altKey && event.key.toLowerCase() === 'n'"));
  assert.ok(handler.includes("!primaryKey && event.shiftKey && event.altKey && (event.code === 'KeyN' || event.key.toLowerCase() === 'n')"));
  assert.ok(handler.includes("createNewDocument('txt'"));
  assert.ok(handler.includes("!primaryKey && !event.shiftKey && event.altKey && (event.code === 'KeyN' || event.key.toLowerCase() === 'n')"));
  assert.ok(handler.includes('createFolder(parentId, Boolean(parentId), state.activePaneId)'));
  assert.ok(!handler.includes("primaryKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n'"));
});

test('new-file entry points share one API-backed workflow and confirmed format range', () => {
  for (const type of ['txt', 'md', 'json', 'html', 'svg']) {
    assert.ok(renderer.includes(`${type}: { label:`), `${type} is exposed in the renderer`);
  }
  assert.ok(renderer.includes("if (data.kind === 'new-menu') return newCreationMenuMarkup(data)"));
  assert.ok(renderer.includes("if (data.kind === 'workspace')"));
  assert.ok(renderer.includes("action: 'create-document'"));
  assert.ok(preload.includes("createDocument: data => ipcRenderer.invoke('document:create', data)"));
  assert.ok(preload.includes("onCreateFolderRequest: callback => on('command:create-folder', callback)"));
  assert.ok(preload.includes("onCreateDocumentRequest: callback => on('command:create-document', callback)"));
  assert.ok(main.includes("handleRPC('document:create'"));
  assert.ok(main.includes("path.join(app.getPath('userData'), 'temp', 'new-files')"));
  assert.ok(main.includes('const ready = await waitForImportedFile(id, libraryPath)'));
  assert.ok(main.includes('if (!ready.fileURL) throw new Error'));
  assert.ok(main.includes('await temporary.cleanup().catch'));
  assert.ok(main.includes('await importPaths({'));
});

test('a new folder is named before it exists; documents still use a default name', () => {
  // Eagle enters an uncommitted naming state and cancelling leaves no folder
  // behind (observed on 4.0 and recorded in PROJECT_CONTEXT). Creating first
  // and renaming later diverges from that — and Eagle's API has no
  // delete-folder endpoint, so every mis-click was permanent.
  const folderStart = renderer.indexOf('async function createFolder');
  const folderEnd = renderer.indexOf('\nasync function revealCreatedDocument', folderStart);
  const folderHandler = renderer.slice(folderStart, folderEnd);
  assert.ok(folderHandler.includes('const name = await requestNameDialog({'));
  assert.ok(folderHandler.includes('if (name === null) return false;'), 'cancel creates nothing');
  assert.ok(folderHandler.indexOf('requestNameDialog') < folderHandler.indexOf('window.eagleMV.createFolder'),
    'the prompt comes before the API call');
  assert.ok(folderHandler.includes("createFolder({ name: name.trim() || '未命名文件夹'"), 'an empty name still gets the default');
  assert.ok(folderHandler.indexOf('requestNameDialog') < folderHandler.indexOf('beginForegroundOperation'),
    'the app is not held busy while waiting for input');
  assert.ok(folderHandler.includes('revealCreatedFolder({ paneId, viewKey, libraryPath, parentId'));

  const documentStart = renderer.indexOf('async function createNewDocument');
  const documentEnd = renderer.indexOf('\nasync function renameItem', documentStart);
  const documentHandler = renderer.slice(documentStart, documentEnd);
  assert.ok(documentHandler.includes('name: config.defaultName'));
  assert.equal(documentHandler.includes('requestCreationName'), false);
  assert.equal(documentHandler.includes('requestNameDialog'), false);

  const mainFolderStart = main.indexOf("handleRPC('folder:create'");
  const mainFolderEnd = main.indexOf("handleRPC('document:create'", mainFolderStart);
  const mainFolderHandler = main.slice(mainFolderStart, mainFolderEnd);
  assert.ok(mainFolderHandler.includes("name = '未命名文件夹'"));
  assert.ok(mainFolderHandler.includes('nextAvailableName(requestedName, siblingFolders(folders, parent))'));
  assert.ok(mainFolderHandler.includes('renamed: availableName !== requestedName'));
  assert.equal(mainFolderHandler.includes('同一位置已存在同名文件夹'), false);
});

test('created documents stay attached to the source pane and TXT opens only when context still matches', () => {
  const start = renderer.indexOf('async function createNewDocument');
  const end = renderer.indexOf('\nasync function renameItem', start);
  const handler = renderer.slice(start, end);
  assert.ok(handler.includes('const sourcePane = paneById(paneId)'));
  assert.ok(handler.includes('const viewKey = descriptorKey(sourcePane.currentView)'));
  assert.ok(handler.includes('revealCreatedDocument({ paneId, viewKey, libraryPath'));
  assert.ok(renderer.includes("if (state.activePaneId !== paneId || descriptorKey(pane.currentView) !== viewKey) return false"));
  assert.ok(renderer.includes("if (type === 'txt')"));
  assert.ok(renderer.includes("requestAnimationFrame(() => $('#textEditor')?.focus())"));
  assert.ok(handler.includes('if (state.folderDialogResolve)'));
  assert.ok(handler.includes('if (state.importing)'));
  assert.ok(handler.includes('if (state.operationTracker.size)'));
});

test('macOS context-menu labels match Eagle wording for common file actions', () => {
  assert.match(renderer, /finderLabel = window\.eagleMV\.platform === 'darwin' \? '在访达中打开'/);
  assert.match(renderer, /label: window\.eagleMV\.platform === 'web' \? '下载到此设备' : '导出', action: 'export'/);
  assert.match(renderer, /label: '分享', action: 'share'/);
  assert.match(renderer, /label: data\.allDeleted \? '恢复素材' : '丢到回收站'/);
});

test('folder assignment menus search beyond their initial result window', () => {
  assert.ok(renderer.includes('function contextFolderPicker(action)'));
  assert.ok(renderer.includes('placeholder="搜索全部文件夹…"'));
  assert.ok(renderer.includes("$('#contextMenu').addEventListener('input'"));
  assert.ok(renderer.includes('contextFolderEntries(folderPicker.dataset.folderPickerAction, input.value)'));
  const menuKeydown = renderer.slice(renderer.indexOf("$('#contextMenu').addEventListener('keydown'"), renderer.indexOf("$('#contextMenu').addEventListener('mouseenter'"));
  assert.ok(menuKeydown.includes('event.stopPropagation()'));
});

test('item context menu exposes searchable existing and new tags', () => {
  assert.ok(renderer.includes("label: '添加标签', submenu: contextTagPicker('add-tag', '搜索或输入标签…')"));
  assert.ok(renderer.includes("label: `添加“${keyword}”`"));
  assert.ok(renderer.includes("data-tag-picker-action=\"${escapeHTML(action)}\""));
  assert.ok(renderer.includes("executeContextAction('add-tag', { tag })"));
  assert.equal(renderer.includes('.slice(0, 30)'), false);
});

test('creating duplicates stays attached to its source pane and blocks close until complete', () => {
  const start = renderer.indexOf('async function duplicateSelection');
  const end = renderer.indexOf('\nfunction showFolderAssignmentPicker', start);
  const handler = renderer.slice(start, end);
  assert.ok(handler.includes('paneId = state.activePaneId'));
  assert.ok(handler.includes("runForegroundOperation('正在创建副本…'"));
  assert.ok(handler.includes('libraryPath }'));
  assert.ok(handler.includes('paneId }'));
  assert.ok(handler.includes('window.eagleMV.getItem(id)'));
  assert.ok(handler.includes('sourcePane.items = [...additions, ...sourcePane.items]'));
  assert.ok(handler.includes('reconcileLocalFolderCount(folderId, sourcePane.total)'));
  assert.ok(handler.includes('renderResultCount()'));
  assert.ok(handler.includes('for (const delay of [1600, 4200])'));
  assert.ok(main.includes("new SupplementalItemStore(path.join(app.getPath('userData'), 'state', 'supplemental-items.json'))"));
  assert.ok(main.includes('hub.addSupplementalItems(libraryPath, supplementalItems)'));
});

test('advertised Eagle item shortcuts have exact non-conflicting keyboard handlers', () => {
  assert.ok(renderer.includes("primaryKey && !event.shiftKey && !event.altKey && event.key === 'Enter'"));
  assert.ok(renderer.includes('showItemInFileManager(activeItemId)'));
  assert.ok(renderer.includes("primaryKey && !event.shiftKey && event.altKey && event.key.toLowerCase() === 'c'"));
  assert.ok(renderer.includes('copyItemPath(activeItemId)'));
  assert.ok(renderer.includes("primaryKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c'"));
  assert.ok(renderer.includes('copyTagsFromItems(selectedIds)'));
  assert.ok(renderer.includes("primaryKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'v'"));
  assert.ok(renderer.includes('pasteTagsToItems(selectedIds)'));
  assert.ok(renderer.includes("primaryKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'j'"));
  assert.ok(renderer.includes('showFolderAssignmentPicker(selectedIds)'));
  assert.ok(renderer.includes("!primaryKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd'"));
  assert.ok(renderer.includes("primaryKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd'"));
});

test('remove, trash, preview and paste shortcuts cannot fall through to the wrong action', () => {
  const keydownStart = renderer.indexOf("document.addEventListener('keydown'");
  const keydownEnd = renderer.indexOf('\n  });\n}', keydownStart);
  const handler = renderer.slice(keydownStart, keydownEnd);
  const remove = handler.indexOf('primaryKey && event.shiftKey && !event.altKey && deleteKey');
  const trash = handler.indexOf('primaryKey && !event.shiftKey && !event.altKey && deleteKey');
  const plainDelete = handler.lastIndexOf('deleteKey && !editable && !previewOpen && !primaryKey');
  const plainEnter = handler.indexOf("!primaryKey && !event.shiftKey && !event.altKey && event.key === 'Enter'");
  assert.ok(remove >= 0 && trash > remove && plainDelete > trash);
  assert.ok(handler.slice(remove, trash).includes('removeSelectionFromFolder'));
  assert.ok(handler.slice(trash, plainDelete).includes('setTrash(selectedIds, true)'));
  assert.ok(plainEnter >= 0);
  assert.ok(renderer.includes('state.suppressPasteUntil = Date.now() + 750'));
  assert.ok(renderer.includes('if (Date.now() < state.suppressPasteUntil)'));
});

test('inspector editing remains a hard stop for the Backspace trash shortcut', () => {
  const keydownStart = renderer.indexOf("document.addEventListener('keydown'");
  const keydownEnd = renderer.indexOf('\n  });\n}', keydownStart);
  const handler = renderer.slice(keydownStart, keydownEnd);
  const editableGuard = handler.indexOf('isEditableElement(event.target) || isEditableElement() || state.inspectorEditing');
  const plainDelete = handler.lastIndexOf('deleteKey && !editable && !previewOpen && !primaryKey');
  assert.ok(editableGuard >= 0);
  assert.ok(plainDelete > editableGuard);
  assert.ok(renderer.includes("document.addEventListener('focusin'"));
  assert.ok(renderer.includes("document.addEventListener('pointerdown'"));
});

test('last-used folder state is promoted and broadcast to every window', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.ok(renderer.includes('function rememberRecentFolderUsage(folderId)'));
  assert.ok(renderer.includes('markFolderUsed(folderId, libraryPath)'));
  assert.ok(renderer.includes('window.eagleMV.onFolderUsed(payload =>'));
  assert.ok(preload.includes("markFolderUsed: data => ipcRenderer.send('folder:used', data)"));
  assert.ok(preload.includes("onFolderUsed: callback => on('folder:used', callback)"));
  assert.ok(main.includes("onRPC('folder:used'"));
  assert.ok(main.includes("broadcast('folder:used'"));
});

test('bulk file actions resolve missing items independently with bounded concurrency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const helperStart = source.indexOf('async function resolveItemFiles(ids)');
  const helperEnd = source.indexOf('\n}', helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0);
  assert.ok(helper.includes('settleWithConcurrency(uniqueIds, itemFilePath, 8)'));
  for (const handler of ['copyItemFiles', "handleRPC('items:export'", "handleRPC('items:open-other'", "handleRPC('items:share'", "handleRPC('items:duplicate'"]) {
    const start = source.indexOf(handler);
    assert.ok(start >= 0, `${handler} exists`);
    assert.ok(source.slice(start, start + 1400).includes('resolveItemFiles(ids)'), `${handler} tolerates per-item resolution failures`);
  }
});
