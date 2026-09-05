'use strict';
// Complete Web renderer + production HTTP/WebSocket transport and draft store.
// Only the Eagle data/modify boundary is a synthetic library. Child windows are
// Chromium window.open popups, never independently constructed BrowserWindows.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { createWebServer } = require(path.join(root, 'lib/web-server'));
const { TextDraftStore } = require(path.join(root, 'lib/text-draft-store'));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-opener-'));
app.setPath('userData', data);
app.on('window-all-closed', () => {});
const store = new TextDraftStore(path.join(data, 'drafts'));
const library = { path: '/mock/opener.library', name: 'Synthetic opener library', folders: [], smartFolders: [] };
const item = { id: 'text-1', name: 'Opener text', ext: 'txt', size: 8, tags: [], folders: [], annotation: '', star: 0 };
const server = createWebServer({ srcDir: path.join(root, 'src'), accessKey: 'fixture-not-a-user-key', requireKey: false,
  resolveMediaPath: async () => null,
  invoke: async (method, [payload] = []) => {
    if (method.startsWith('text-draft:')) return store[method.split(':')[1]](payload);
    if (method === 'hub:connect') return { app: { version: 'synthetic' }, library };
    if (method === 'hub:query') return { data: [item], total: 1, hasMore: false, nextOffset: 1 };
    if (method === 'hub:get-item') return item;
    if (method === 'text:read') return { content: 'original', fingerprint: { size: 8, mtimeMs: 1 } };
    if (method === 'text:save') throw new Error('fixture plugin disconnected');
    if (['hub:tags', 'hub:tag-groups', 'hub:recent-folders', 'item:comments'].includes(method)) return [];
    if (method === 'window:eagle-state') return { view: { kind: 'all' } };
    return {};
  }
});
const helpers = `
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
const until = async fn => {for(let n=0;n<300;n++){if(fn())return;await wait(20);}throw new Error('opener condition timeout');};
await until(()=>window.state?.connected&&window.state.items.length&&!window.state.loading);
`;
const openText = `
const card=document.querySelector('[data-id="text-1"]'); card.dispatchEvent(new MouseEvent('click',{bubbles:true}));card.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
await until(()=>document.querySelector('#textEditor'));
`;
async function inspect(win, script) { return win.webContents.executeJavaScript(`(async()=>{${helpers}${script}})()`, true); }
async function popup(parent, mode) {
  const created = new Promise(resolve=>parent.webContents.once('did-create-window', win=>resolve(win)));
  await parent.webContents.executeJavaScript(mode === 'prepared'
    ? `window.__prepared=window.eagleMV.prepareNewWindow(); Boolean(window.__prepared)`
    : mode === 'direct' ? `Boolean(window.open(location.href,'_blank'))` : `window.eagleMV.newWindow({view:{kind:'all'}})`, true);
  const child = await created;
  if (mode === 'prepared') await parent.webContents.executeJavaScript(`window.eagleMV.newWindow({view:{kind:'all'}},window.__prepared)`, true);
  await new Promise(resolve => { if (!child.webContents.isLoading()) resolve(); else child.webContents.once('did-finish-load',resolve); });
  return child;
}
async function run() {
  await app.whenReady();
  const address = await server.start(0, '127.0.0.1');
  const parent = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  parent.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, width: 1440, height: 900, webPreferences: { backgroundThrottling: false } } }));
  await parent.loadURL(`http://0.0.0.0:${address.port}/#state=${encodeURIComponent(JSON.stringify({view:{kind:'all'}}))}`);
  const before = await inspect(parent, `${openText}
    const editor=document.querySelector('#textEditor');editor.value='parent-only draft';editor.dispatchEvent(new Event('input',{bubbles:true}));await wait(650);
    return {key:sessionStorage.getItem('eaglemv.textWindowKey'),draftId:window.state.textSession.draftId,secure:isSecureContext};`);
  const children = [];
  for (const mode of ['prepared', 'fallback', 'direct']) {
    const child = await popup(parent, mode);
    const initial = await inspect(child, `${openText}
      return {key:sessionStorage.getItem('eaglemv.textWindowKey'),draftId:window.state.textSession.draftId,text:document.querySelector('#textEditor').value,recoveries:window.state.textSession.recoveryDrafts.length,hasOpener:Boolean(opener),secure:isSecureContext};`);
    await inspect(child, `const editor=document.querySelector('#textEditor');editor.value=${JSON.stringify(mode + '-child draft')};editor.dispatchEvent(new Event('input',{bubbles:true}));await wait(650);`);
    child.webContents.once('will-prevent-unload', event => event.preventDefault());
    await new Promise(resolve=>{child.webContents.once('did-finish-load',resolve);child.webContents.reload();});
    const afterReload = await inspect(child, `${openText}return {key:sessionStorage.getItem('eaglemv.textWindowKey'),draftId:window.state.textSession.draftId,text:document.querySelector('#textEditor').value};`);
    children.push({ mode, initial, afterReload });
    child.destroy();
  }
  const records = await store.list({libraryPath:library.path,id:item.id});
  parent.destroy(); await server.stop();
  process.stdout.write('TEXT_OPENER ' + JSON.stringify({before,children,records}) + '\n');
  fs.rmSync(data, {recursive:true,force:true}); app.quit();
}
run().catch(async error=>{console.error(error);for(const win of BrowserWindow.getAllWindows())win.destroy();await server.stop();app.exit(1);});
