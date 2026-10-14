'use strict';
// Real-renderer check for R2-01: typing in the TXT editor persists the draft
// on a short throttle (localStorage ~300 ms, host store ~1 s) instead of
// serializing the whole text on every key, and still writes at once on blur
// and discard, with no late timer resurrecting a discarded draft.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-text-draft-throttle-'));
app.setPath('userData', profile);
app.on('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const assert = (value, message) => { if (!value) throw Error(message); };
    const pane = activePane();
    const session = { id: 'throttle-fixture', libraryPath: state.library.path, draftId: 'throttle-fixture',
      revision: 0, content: 'base', original: 'base', fingerprint: { size: 4, hash: 'base' }, dirty: false };
    pane.textSession = session;
    pane.previewId = session.id;
    paneRoot(pane.id).querySelector('#previewModal').classList.remove('hidden');
    renderTextPreview(session);
    // Keep autosave out of the way: only draft persistence is measured.
    window.queueTextAutoSave = () => {};
    const key = TEXT_DRAFT_PREFIX + session.draftId;
    let localWrites = 0;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) { if (name === key) localWrites += 1; return setItem.call(this, name, value); };
    const puts = [];
    window.eagleMV.putTextDraft = async payload => { puts.push(payload.content); return true; };
    window.eagleMV.removeTextDraft = async () => true;
    const stored = () => JSON.parse(localStorage.getItem(key) || 'null')?.content;
    const editor = paneQuery(pane.id, '#textEditor');
    const input = value => { editor.value = value; editor.dispatchEvent(new Event('input', { bubbles: true })); };
    editor.focus();

    // 1. Thirty keys within ~300 ms.
    for (let i = 1; i <= 30; i++) { input('typed ' + i); await wait(10); }
    assert(localWrites <= 3, 'localStorage written ' + localWrites + ' times for 30 keys');
    assert(puts.length <= 1, 'host draft written ' + puts.length + ' times for 30 keys');
    await wait(1100);
    assert(stored() === 'typed 30', 'local draft not caught up: ' + stored());
    assert(puts.at(-1) === 'typed 30', 'host draft not caught up: ' + puts.at(-1));

    // 2. Blur writes the pending draft at once.
    input('before blur');
    // A hidden window never holds focus, so deliver the blur directly.
    editor.dispatchEvent(new FocusEvent('blur'));
    assert(stored() === 'before blur', 'blur did not write the local draft: ' + stored());
    assert(puts.at(-1) === 'before blur', 'blur did not write the host draft: ' + puts.at(-1));

    // 3. Discarding wins over a pending write.
    input('to discard');
    discardTextSession(session);
    await wait(1100);
    assert(stored() === undefined, 'discarded draft came back: ' + stored());
    assert(puts.at(-1) !== 'to discard', 'discarded text reached the host store');
  })()`);
  console.log('TEXT_DRAFT_THROTTLE_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
