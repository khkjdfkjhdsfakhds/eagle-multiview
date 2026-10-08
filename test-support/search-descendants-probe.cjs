'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-search-')));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: {
    contextIsolation: false, sandbox: false, preload: path.join(__dirname, 'feature-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 200 && !state.library; i++) await wait(20);
    const assert = (value, message) => { if (!value) throw Error(message); };
    state.library.folders = [{id:'parent', name:'Parent', children:[{id:'child',name:'Child',children:[{id:'deep',name:'Deep',children:[]}]}]}, {id:'outside',name:'Outside',children:[]}];
    const items = ['parent', 'child', 'deep', 'outside'].map(id => ({id, name:'needle', ext:'png', folders:[id], tags:[]}));
    items.push({id:'loose', name:'needle', ext:'png', folders:[], tags:[]});
    window.eagleMV.query = async query => {
      const data = items.filter(item => EagleMVQuerySpec.matchesConstraints(item, query));
      return {data, total:data.length, nextOffset:data.length, hasMore:false};
    };
    const pane = paneById(state.activePaneId);
    pane.currentView = {kind:'folder',id:'parent'};
    pane.query.search = 'needle';
    await refresh({preserveScroll:false});
    assert(pane.items.some(item => item.id === 'child'), 'Search omits matching child-folder item');
    assert(pane.items.some(item => item.id === 'deep'), 'Search omits matching grandchild-folder item');
    assert(!pane.items.some(item => item.id === 'outside'), 'Search escapes the current folder subtree');
    pane.query.search = '';
    await refresh({preserveScroll:false});
    assert(pane.items.length === 1 && pane.items[0].id === 'parent', 'Clearing search must restore direct-folder browsing');
    pane.currentView = {kind:'root'};
    pane.query.search = 'needle';
    await refresh({preserveScroll:false});
    assert(pane.items.length === items.length, 'Library-root search omits filed items');
    pane.currentView = {kind:'unfiled'};
    await refresh({preserveScroll:false});
    assert(pane.items.length === 1 && pane.items[0].id === 'loose', 'Unfiled search must remain unfiled');
  })()`);
  console.log('SEARCH_DESCENDANTS_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error); app.exit(1); });
