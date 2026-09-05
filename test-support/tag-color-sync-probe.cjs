'use strict';
// Complete production renderer/Web transport and main tag-color RPC handlers.
// All libraries, files and profiles belong to this fixture; Eagle networking is disabled.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadMain } = require('./main-data-harness.cjs');
const { createWebServer } = require('../lib/web-server');
const { TextDraftStore } = require('../lib/text-draft-store');
const source = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-tag-sync-'));
app.setPath('userData', path.join(directory, 'profile'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP eaglemv-tag-sync.test 127.0.0.1');
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const main = loadMain(path.join(directory, 'main-state'));
const drafts = new TextDraftStore(path.join(directory, 'drafts'));
const libraryA = { path: '/synthetic/tag-sync-A.library', name: 'Synthetic A', folders: [], smartFolders: [] };
const libraryB = { ...libraryA, path: '/synthetic/tag-sync-B.library', name: 'Synthetic B' };
let library = libraryA;
const items = ['image-1', 'text-1'].map(id => ({ id, name: id, ext: id === 'text-1' ? 'txt' : 'png', tags: ['Shared tag'], folders: [], annotation: '', star: 0, size: 8 }));
const calls = [], popups = [], errors = [], pendingReads = [];
let delayLibraryAReads = false;
let srcDir = path.join(source, 'src');
const mutation = process.env.EAGLEMV_TAG_COLOR_MUTATION || '';
if (mutation) {
  if (mutation !== 'drop-notification') throw new Error('Unknown tag-color mutation');
  srcDir = path.join(directory, 'mutated-src');
  fs.cpSync(path.join(source, 'src'), srcDir, { recursive: true });
  const file = path.join(srcDir, 'renderer.js');
  const original = fs.readFileSync(file, 'utf8');
  const needle = 'window.eagleMV.onTagDataChanged(async payload => {';
  if (original.split(needle).length !== 2) throw new Error('Tag-color mutation anchor must match exactly once');
  // Deliberately omit notification handling, without changing startup/transport.
  fs.writeFileSync(file, original.replace(needle, needle + '\n    return; // isolated negative-control mutation'));
}
const server = createWebServer({ srcDir, accessKey: 'synthetic-key', requireKey: false,
  resolveMediaPath: async () => null,
  invoke: async (method, args = []) => {
    calls.push({ method, args });
    if (method === 'tag-colors:get') {
      const colors = structuredClone(await main.getTagColors(args[0].libraryPath));
      if (delayLibraryAReads && args[0].libraryPath === libraryA.path) await new Promise(resolve => pendingReads.push(resolve));
      return colors;
    }
    if (method === 'tag-colors:set') return main.rpcRegistry.get(method)({ sender: { id: 'synthetic-web-window' } }, ...args);
    if (method === 'hub:connect') return { app: { version: 'synthetic' }, library };
    if (method === 'hub:query') return { data: items, total: items.length, hasMore: false, nextOffset: items.length };
    if (method === 'hub:get-item') return items.find(item => item.id === args[0]);
    if (method === 'hub:tags') return [{ name: 'Shared tag', imageCount: 2 }];
    if (['hub:tag-groups', 'hub:recent-folders', 'item:comments'].includes(method)) return [];
    if (method === 'text:read') return { content: 'original', fingerprint: { size: 8, mtimeMs: 1 } };
    if (method === 'text:save' || method === 'hub:mutate') throw new Error('Synthetic disconnected writer: retain the draft');
    if (method.startsWith('text-draft:')) return drafts[method.slice('text-draft:'.length)](...args);
    if (method === 'window:eagle-state') return { view: { kind: 'all' } };
    if (method === 'item:metadata') return { metadata: null };
    return {};
  }
});
main.setWebServer(server);
const windows = [];
const page = (win, script) => win.webContents.executeJavaScript(`(async()=>{${script}})()`, true);
async function until(predicate, label) {
  for (let attempt = 0; attempt < 250; attempt++) { if (await predicate()) return; await delay(20); }
  throw new Error('Tag-color condition timed out: ' + label);
}
async function ready(win) {
  await until(() => page(win, 'return state?.connected && state.items.length === 2 && !state.loading;'), 'renderer ready');
}
const snapshots = () => Promise.all(windows.map((win, index) => page(win, `
  const input = window.__draftInput;
  return {
    library: state.library.path, colors: state.tagColors,
    chips: [...document.querySelectorAll('.tag-chip')].filter(chip => chip.querySelector('span[title]')?.title === 'Shared tag').map(chip => chip.style.getPropertyValue('--tag-color')),
    inputUnreplaced: input === document.querySelector(${JSON.stringify(index ? '#textEditor' : '#itemTagInput')}),
    focused: document.activeElement === input, value: input?.value, caret: input?.selectionStart,
    annotation: document.querySelector('#itemAnnotation').value,
    annotationUnreplaced: ${index ? 'true' : 'window.__annotationInput === document.querySelector("#itemAnnotation")'},
    dirty: ${index ? 'Boolean(state.textSession?.dirty)' : 'state.inspectorDirty'},
    preview: state.previewId, text: state.textSession?.content || null,
    tags: [...state.draftTags], unhandled: window.__unhandled
  };`)));
const readCount = () => calls.filter(call => call.method === 'tag-colors:get').length;
async function run() {
  await app.whenReady(); app.dock?.hide();
  await main.setTagColor(libraryA.path, 'Shared tag', '#112233');
  await main.setTagColor(libraryB.path, 'Shared tag', '#445566');
  const address = await server.start(0, '127.0.0.1');
  for (let index = 0; index < 2; index++) {
    const win = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, partition: `tag-sync-${index}-${path.basename(directory)}` } });
    windows.push(win);
    win.webContents.setWindowOpenHandler(details => { popups.push(details.url); return { action: 'deny' }; });
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
    await win.loadURL(`http://eaglemv-tag-sync.test:${address.port}/#state=${encodeURIComponent(JSON.stringify({ view: { kind: 'all' } }))}`);
    await ready(win);
    await page(win, `window.__unhandled=[];window.addEventListener('unhandledrejection',event=>window.__unhandled.push(String(event.reason?.message || event.reason)));`);
  }
  await page(windows[0], `
    document.querySelector('[data-id="image-1"]').click();
    window.__annotationInput = document.querySelector('#itemAnnotation');
    __annotationInput.value = 'Unsaved metadata draft'; __annotationInput.dispatchEvent(new Event('input',{bubbles:true}));
    window.__draftInput = document.querySelector('#itemTagInput');
    __draftInput.value = 'Partial new tag'; __draftInput.dispatchEvent(new Event('input',{bubbles:true}));
    __draftInput.focus(); __draftInput.setSelectionRange(4,4);
  `);
  await page(windows[1], `const card=document.querySelector('[data-id="text-1"]');card.click();card.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));`);
  await until(() => page(windows[1], 'return Boolean(document.querySelector("#textEditor"));'), 'TXT preview');
  await page(windows[1], `window.__draftInput=document.querySelector('#textEditor');__draftInput.value='Unsaved TXT draft';__draftInput.dispatchEvent(new Event('input',{bubbles:true}));__draftInput.focus();__draftInput.setSelectionRange(5,5);`);
  await delay(750);
  const before = await snapshots();
  // The public bridge invokes the real main handler; the other window sees only its WS broadcast.
  await page(windows[0], `await window.eagleMV.setTagColor({libraryPath:state.library.path,tag:'Shared tag',color:'#abcdef'});`);
  await delay(350);
  const sameLibrary = { before, after: await snapshots(), saved: await main.getTagColors(libraryA.path) };
  if (mutation) return { mutation, sameLibrary, popups, errors };

  let count = readCount();
  server.broadcast('tag-data:changed', { libraryPath: libraryA.path, colors: { 'Shared tag': '#112233' }, reason: 'old-delayed-payload' });
  await until(() => readCount() >= count + 2, 'old notification rereads current committed colors'); await delay(100);
  const oldPayload = await snapshots();
  count = readCount();
  server.broadcast('tag-data:changed', { libraryPath: libraryB.path, colors: { 'Shared tag': '#ff0000' }, reason: 'foreign-library' });
  await delay(200);
  const foreign = { reads: readCount() - count, snapshots: await snapshots() };

  // Let an A read complete only after both real library-change handlers have moved to B.
  delayLibraryAReads = true;
  server.broadcast('tag-data:changed', { libraryPath: libraryA.path, reason: 'slow-old-library' });
  await until(() => pendingReads.length === 2, 'both old-library reads held');
  library = libraryB;
  server.broadcast('hub:library-changed', { library: libraryB, revision: 1000 });
  await until(async () => (await Promise.all(windows.map(win => page(win, `return state.library.path === ${JSON.stringify(libraryB.path)} && state.tagColors['Shared tag'] === '#445566' && !state.loading;`)))).every(Boolean), 'both views switched to B');
  for (const win of windows) await page(win, `document.querySelector('[data-id="image-1"]').click();`);
  delayLibraryAReads = false;
  pendingReads.splice(0).forEach(resolve => resolve());
  await delay(200);
  const afterLibrarySwitch = await Promise.all(windows.map(win => page(win, `return {library:state.library.path,colors:state.tagColors,chips:[...document.querySelectorAll('.tag-chip')].map(chip=>chip.style.getPropertyValue('--tag-color')),unhandled:window.__unhandled};`)));
  const metadataRecords = await page(windows[0], `return Object.keys(localStorage).filter(key=>key.startsWith('eaglemv.inspectorDraft.v1.')).map(key=>JSON.parse(localStorage.getItem(key)));`);
  const textRecords = await drafts.list({ libraryPath: libraryA.path, id: 'text-1' });
  return { sameLibrary, oldPayload, foreign, afterLibrarySwitch,
    retained: { metadata: metadataRecords.map(row => ({ libraryPath: row.libraryPath, id: row.id, annotation: row.values.annotation })), text: textRecords.map(row => ({ libraryPath: row.libraryPath, id: row.id, content: row.content })) }, popups, errors };
}
run().then(result => process.stdout.write('TAG_COLOR_SYNC ' + JSON.stringify(result) + '\n')).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  pendingReads.splice(0).forEach(resolve => resolve());
  for (const win of windows) win.destroy();
  await server.stop().catch(() => {});
  fs.rmSync(directory, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
