'use strict';
// B2-04: a recovered inspector draft copy moves to this pane (the source is
// removed), copies that already match Eagle are not offered, and a copy can
// be discarded.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-draft-recovery-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: { sandbox: false, contextIsolation: false, backgroundThrottling: false, preload: path.join(__dirname, 'renderer-ui-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !state.connected; i += 1) await wait(20);
    if (!state.connected) throw new Error('fixture library not connected');
    const make = id => ({ id, name: id, ext: 'png', width: 10, height: 10, folders: ['mv-folder'], tags: [], annotation: 'eagle note', url: '' });
    const items = ['recover-me', 'already-saved', 'discard-me'].map(make);
    window.eagleMV.query = async () => ({ data: items.map(item => structuredClone(item)), total: items.length, nextOffset: items.length, hasMore: false });
    window.eagleMV.getItem = async id => structuredClone(items.find(item => item.id === id));
    window.confirm = () => true;
    navigate({ kind: 'folder', id: 'mv-folder' });
    await refresh({ reset: true, preserveScroll: false });
    const library = state.library.path;
    const seed = (id, annotation) => {
      const key = JSON.stringify(['closed-window', library, 'pane-9', id]);
      const storageKey = 'eaglemv.inspectorDraft.v1.' + key;
      const item = items.find(entry => entry.id === id);
      localStorage.setItem(storageKey, JSON.stringify({ key, id, paneId: 'pane-9', libraryPath: library, base: item,
        values: { name: item.name, tags: [], star: 0, annotation, url: '' }, revision: 3 }));
      return storageKey;
    };
    const banner = () => document.querySelector('#staleBanner');
    const bannerShown = () => !banner().classList.contains('hidden') && Boolean(banner().querySelector('[data-draft-action="recover"]'));
    const out = {};
    const recoverKey = seed('recover-me', 'draft from closed window');
    selectItem('recover-me');
    out.offered = bannerShown();
    out.hasDiscard = Boolean(banner().querySelector('[data-draft-action="discard"]'));
    banner().querySelector('[data-draft-action="recover"]').click();
    out.recovered = document.querySelector('#itemAnnotation').value;
    out.sourceKept = localStorage.getItem(recoverKey) !== null;
    const savedKey = seed('already-saved', 'eagle note');
    selectItem('already-saved');
    out.obsoleteOffered = bannerShown();
    out.obsoleteKept = localStorage.getItem(savedKey) !== null;
    const discardKey = seed('discard-me', 'unwanted draft');
    selectItem('discard-me');
    out.discardOffered = bannerShown();
    banner().querySelector('[data-draft-action="discard"]').click();
    out.discardKept = localStorage.getItem(discardKey) !== null;
    out.discardBannerHidden = banner().classList.contains('hidden');
    out.discardAnnotation = document.querySelector('#itemAnnotation').value;
    return out;
  })()`);
  console.log(`EAGLEMV_DRAFT_RECOVERY ${JSON.stringify(result)}`);
  window.destroy();
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => {
  // An unsaved inspector edit would hold windows open through the close protocol.
  for (const open of BrowserWindow.getAllWindows()) open.destroy();
  app.quit();
});
