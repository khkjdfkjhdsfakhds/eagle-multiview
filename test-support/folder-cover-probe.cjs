'use strict';
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadMain } = require('./main-data-harness.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-cover-ui-'));
app.setPath('userData', path.join(profile, 'profile'));
app.on('window-all-closed', () => {});
app.on('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));
protocol.registerSchemesAsPrivileged([{ scheme: 'eaglemv', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const source = process.env.EAGLEMV_UI_SOURCE_ROOT || path.resolve(__dirname, '..');
const main = loadMain(path.join(profile, 'state'));
const libraryPath = '/tmp/EagleMV-UI-Test.library';
const thumbnail = path.join(profile, 'thumbnail.svg');
fs.writeFileSync(thumbnail, '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#76b8a0"/><circle cx="200" cy="150" r="80" fill="#f8e8b6"/></svg>');
main.hub.library = { path: libraryPath, name: '测试资料库', folders: [{ id: 'mv-folder', name: 'MultiView 文件夹', children: [] }, { id: 'eagle-folder', name: 'Eagle 文件夹', children: [] }] };
main.hub.ensureLibraryPath = async p => assert.equal(p, libraryPath);
main.client.folderTree = async () => main.hub.library.folders;
main.client.getItem = async id => ({ id, name: '封面示例', ext: 'svg', folders: ['mv-folder'] });
main.client.getItems = async ids => Promise.all(ids.map(id => main.client.getItem(id)));
main.client.appInfo = async () => ({version:'ui-test'});
main.client.libraryInfo = async () => main.hub.library;
const nativeScope = {libraryPath, folderMappings:Object.fromEntries(main.hub.library.folders.map(f=>[f.id,f])), itemMappings:{sample:{id:'sample'}},
  saveFolder(){}, resetFolderCover(f){f.covers=[];}, calculateImageBinding(){}};
main.client.request = async (url, {body}) => {
  assert.equal(url, '/api/script/inject');
  assert.equal(vm.runInNewContext(body.script, {$bodyScope:nativeScope}), true);
};
main.client.thumbnailPath = async () => thumbnail;
const windows = [];
const page = (win, code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
const until = async (check, label) => {
  for (let n = 0; n < 150; n++) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); }
  const snapshots = await Promise.all(windows.filter(win => !win.isDestroyed()).map(win => page(win, `return {covers:state.localFolderCovers,toast:document.querySelector('#toast')?.textContent,card:document.querySelector('[data-open-folder="mv-folder"]')?.outerHTML};`)));
  throw Error('Timed out: ' + label + ' ' + JSON.stringify(snapshots));
};
async function newWindow(width = 1100) {
  const win = new BrowserWindow({ show: false, width, height: 820, webPreferences: { sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'folder-cover-preload.cjs') } });
  windows.push(win); main.addFakeWindow(win);
  await win.loadFile(path.join(source, 'src/index.html'));
  await until(() => page(win, 'return state.connected && state.folderCoversReady;'), 'ready');
  return win;
}
(async () => {
  await app.whenReady(); app.dock?.hide();
  ipcMain.handle('cover-fixture:connect', () => ({app:{version:'ui-test'},library:main.hub.library}));
  for (const operation of ['get', 'set']) ipcMain.handle(`cover-fixture:${operation}`, (event, payload) => main.rpcRegistry.get(`folder-covers:${operation}`)(event, payload));
  protocol.handle('eaglemv', async request => {
    const url = new URL(request.url);
    const file = await main.resolveMediaURL(url.hostname, url.pathname.slice(1));
    return file ? net.fetch(file) : new Response('', { status: 404 });
  });
  const first = await newWindow(), second = await newWindow();
  await page(first, `
    navigate({kind:'folder',id:'mv-folder'}, {refreshView:false});
    state.items=[{id:'sample',name:'封面示例',ext:'svg',width:400,height:300,folders:['mv-folder']}]; renderGrid();
    showContextMenuAt(100,100,{kind:'items',ids:['sample'],paneId:state.activePaneId});
    const row=document.querySelector('[data-context-action="set-folder-cover"]');
    if(!row || row.disabled) throw Error('missing enabled cover menu'); row.click();
  `);
  await until(() => page(second, `return findFolder(state.library.folders,'mv-folder')?.coverId === 'sample' && document.querySelector('[data-open-folder="mv-folder"] .folder-cover img')?.naturalWidth > 0;`), 'other window renders new native cover');
  await page(second, `
    window.__coverCard=document.querySelector('[data-open-folder="mv-folder"]'); __coverCard.focus();
    acceptFolderCovers({libraryPath:state.library.path,revision:0,covers:{}});
    acceptFolderCovers({libraryPath:'/foreign.library',revision:100,covers:{}});
    if(!state.localFolderCovers.covers['mv-folder']?.revision || state.localFolderCovers.covers['mv-folder'].itemId !== null) throw Error('stale event overwrote cover receipt');
    if(document.activeElement!==__coverCard) throw Error('cover sync stole focus');
  `);
  const third = await newWindow(390);
  await page(third, `navigate({kind:'root'},{refreshView:false}); await refresh({reset:true});`);
  await until(() => page(third, `return document.querySelector('[data-open-folder="mv-folder"] .folder-cover img')?.naturalWidth > 0;`), 'new window restores cover');
  await page(third, `
    showContextMenuAt(10,100,{kind:'folder',folderId:'mv-folder',ids:[]});
    const row=document.querySelector('[data-context-action="reset-folder-cover"]');
    if(!row) throw Error('reset unavailable');
    if(row.scrollWidth>row.clientWidth+1) throw Error('narrow menu overflows');
  `);
  if (process.env.EAGLEMV_COVER_SCREENSHOT) fs.writeFileSync(process.env.EAGLEMV_COVER_SCREENSHOT, (await third.webContents.capturePage()).toPNG());
  await page(third, `document.querySelector('[data-context-action="reset-folder-cover"]').click();`);
  await until(() => page(second, `return state.localFolderCovers.covers['mv-folder']?.itemId === null && !document.querySelector('[data-open-folder="mv-folder"] .folder-cover img');`), 'reset broadcasts');
  await page(first, `
    state.items=[{id:'text',ext:'txt'}];
    if(contextMenuMarkup({kind:'items',ids:['text']}).includes('set-folder-cover')) throw Error('nonimage allowed');
    state.items=[{id:'sample',ext:'svg'}]; state.currentView={kind:'all'};
    if(!contextMenuMarkup({kind:'items',ids:['sample']}).includes('data-folder-picker-action="set-folder-cover"')) throw Error('all-items folder picker missing');
  `);
  console.log('FOLDER_COVER_RESULT ' + JSON.stringify({ windows: 3, sync: true, restored: true, reset: true, narrow: true }));
  for (const win of windows) win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
