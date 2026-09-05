'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-text-status-'));
app.setPath('userData', profile);
app.on('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_UI_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const assert = (value, message) => { if (!value) throw Error(message); };
    const pane = activePane();
    const session = { id: 'status-fixture', libraryPath: state.library.path, draftId: 'status-fixture',
      revision: 0, content: 'base', original: 'base', fingerprint: { size: 4, hash: 'base' }, dirty: false };
    pane.textSession = session;
    pane.previewId = session.id;
    paneRoot(pane.id).querySelector('#previewModal').classList.remove('hidden');
    renderTextPreview(session);
    const editor = paneQuery(pane.id, '#textEditor'), status = paneQuery(pane.id, '#textStatus');
    let saves = 0;
    window.eagleMV.saveText = async payload => {
      saves++;
      await wait(20);
      return { status: 'saved', fingerprint: { size: payload.content.length, hash: String(saves) } };
    };
    const changes = [];
    const observer = new MutationObserver(() => changes.push(status.textContent));
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    const input = value => { editor.value = value; editor.dispatchEvent(new Event('input', { bubbles: true })); };
    editor.focus();
    for (let i = 0; i < 8; i++) { input('typing-' + i); await wait(600); }
    const typing = [...changes];
    await wait(1400);
    const settled = status.textContent;
    const finalContent = editor.value;
    const caret = editor.selectionStart;
    changes.length = 0;
    input('');
    await wait(750);
    const blank = [...changes];
    console.log('TEXT_STATUS_TRACE ' + JSON.stringify({ typing, settled, blank, saves }));
    assert(saves >= 2, 'test must exercise repeated real autosave cycles');
    assert(typing.length <= 1, 'typing status repeatedly replaces text during autosave: ' + typing.length);
    assert(/已.*保存/.test(settled), 'settled successful save must remain visible');
    assert(finalContent === 'typing-7' && caret === finalContent.length, 'saving disturbed content or caret');
    assert(blank.length === 1 && /空白草稿/.test(blank[0]), 'empty draft should show one stable warning, not pending/saving/error flashes');
    assert(session.dirty && !session.saving, 'empty draft protection changed');
    const savedBeforeBlankRetry = saves;
    assert(await saveTextPreview(false, { session }) === false, 'manual empty save was accepted');
    input('');
    await wait(30);
    assert(saves === savedBeforeBlankRetry && changes.length === 1, 'blank input/retry flashed or submitted an empty body');

    window.eagleMV.saveText = async () => { throw Error('fixture offline'); };
    input('retry');
    await saveTextPreview(false, { session, automatic: true });
    assert(status.textContent.includes('尚未保存') && status.textContent.includes('fixture offline'), 'save failure was hidden or delayed');
    await wait(1300);
    assert(status.textContent.includes('fixture offline'), 'a stale success timer overwrote the error');

    window.eagleMV.saveText = async () => ({ conflict: true });
    input('conflict');
    await saveTextPreview(false, { session, automatic: true });
    const warning = status.textContent;
    input('conflict edited');
    assert(session.blocked === 'conflict' && status.textContent === warning, 'typing hid a conflict warning');

    session.blocked = false;
    window.eagleMV.saveText = async payload => ({ status: 'saved', fingerprint: { size: payload.content.length } });
    input('recovered');
    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    assert(await saveTextPreview(false, { session, automatic: true }) === false && session.dirty, 'IME composition was submitted');
    editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await saveTextPreview(false, { session });
    assert(status.textContent === '已保存' && !session.dirty, 'manual retry did not recover with immediate confirmation');

    // A later blank input while a snapshot is in flight retains the warning.
    let release;
    window.eagleMV.saveText = () => new Promise(resolve => { release = resolve; });
    input('snapshot');
    const saving = saveTextPreview(false, { session, automatic: true });
    await wait(0);
    input('');
    const blankDuringSave = status.textContent;
    release({ status: 'saved', fingerprint: { size: 8 } });
    await saving;
    assert(session.dirty && status.textContent === blankDuringSave && /空白草稿/.test(blankDuringSave), 'snapshot ACK flashed over a later empty draft');
    observer.disconnect();
    return { saves, typingUpdates: typing.length, blankUpdates: blank.length };
  })()`);
  console.log('TEXT_STATUS_RESULT ' + JSON.stringify(result));
  if (process.env.EAGLEMV_TEXT_STATUS_SCREENSHOT) {
    fs.writeFileSync(process.env.EAGLEMV_TEXT_STATUS_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  }
  win.destroy();
  app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
