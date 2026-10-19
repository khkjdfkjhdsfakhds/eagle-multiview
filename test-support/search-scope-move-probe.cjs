'use strict';
// D-07 / B2-06: a folder search lists the whole subtree, so moving or
// removing from it must leave every folder of that subtree, not just the
// open one. Without a search only the open folder is left.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-search-scope-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'search-scope-move-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !(window.state?.connected && state.library?.folders?.length === 3); i += 1) await wait(20);
    if (!state.connected) throw new Error('fixture library not connected');
    const folders = () => Object.fromEntries(window.__scopeItems.map(item => [item.id, [...item.folders].sort()]));
    const pane = paneById(state.activePaneId);
    pane.currentView = { kind: 'folder', id: 'parent' };
    pane.query.search = 'needle';
    await refresh({ preserveScroll: false, paneId: pane.id });
    const listed = pane.items.map(item => item.id).sort();
    const removable = {
      c: await canRemoveFromCurrentFolder(['c'], pane.id),
      d: await canRemoveFromCurrentFolder(['d'], pane.id)
    };
    await moveSelectionToFolder({ ids: ['c', 'd'], folderId: 'target', paneId: pane.id });
    await removeSelectionFromFolder({ ids: ['e'], paneId: pane.id });
    const scopeOf = () => typeof paneFolderScope === 'function' ? paneFolderScope(pane) : [];
    const scope = scopeOf();
    await addItemsToFolder(['f'], 'target', 'Target', state.library.path, { move: true, sourceFolderId: 'parent', sourceFolderIds: scope, sourcePaneId: pane.id });
    const dropContext = paneItemDropContext(pane.id, { altKey: false, dataTransfer: { getData: () => '' } },
      { ids: ['h'], session: { sourcePaneId: pane.id, sourceWindowId: state.windowId } });
    await handlePaneItemDrop({ ...dropContext, targetFolderId: 'target' });
    await addItemsToFolder(['k'], 'child', 'Child', state.library.path, { move: true, sourceFolderId: 'parent', sourceFolderIds: scope, sourcePaneId: pane.id });
    const keptInView = pane.items.some(item => item.id === 'k');
    pane.query.search = '';
    await refresh({ preserveScroll: false, paneId: pane.id });
    const plainScope = scopeOf();
    await removeSelectionFromFolder({ ids: ['g'], paneId: pane.id });
    return { listed, keptInView, removable, scope: [...scope].sort(), dropScope: [...(dropContext.sourceFolderIds || [])].sort(), plainScope, folders: folders() };
  })()`);
  console.log(`EAGLEMV_SEARCH_SCOPE ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
