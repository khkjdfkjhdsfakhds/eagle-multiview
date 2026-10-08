'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-text-focus-'));
app.setPath('userData', profile);
app.on('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_UI_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const js = code => win.webContents.executeJavaScript(code);
  const settle = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  // Real input events, so default focus handling and preventDefault apply.
  const click = async ({ x, y }) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await settle();
  };
  const focusState = () => js(`({ active: state.activePaneId, editorFocused: document.activeElement?.id === 'textEditor', activeClass: String(document.activeElement?.className || document.activeElement?.tagName) })`);
  const fail = message => { throw Error(message); };
  win.webContents.focus();
  const setup = await js(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    document.querySelector('#paneLayoutPopover [data-layout="vertical2"]').click();
    await wait(100);
    const [textPane, otherPane] = state.panes;
    activatePane(textPane.id);
    const item = { id: 'focus-txt', ext: 'txt', name: 'TXT focus fixture' };
    textPane.items = [item]; textPane.itemMap.set(item.id, item);
    window.eagleMV.readText = async () => ({ content: 'fixture body', fingerprint: { size: 12, hash: 'base' } });
    await openPreview(item.id);
    const center = element => { const box = element.getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; };
    const scroller = paneQuery(otherPane.id, '#gridScroller');
    const box = scroller.getBoundingClientRect();
    let blank = null;
    for (let y = box.bottom - 12; y > box.top + 8 && !blank; y -= 12) {
      for (let x = box.left + 12; x < box.right - 24 && !blank; x += 24) {
        const hit = document.elementFromPoint(x, y);
        if (hit && scroller.contains(hit) && !hit.closest('.item-card, .folder-card, button, input, select, textarea, a')) blank = { x: Math.round(x), y: Math.round(y) };
      }
    }
    return { textPane: textPane.id, otherPane: otherPane.id, blank,
      editor: center(paneQuery(textPane.id, '#textEditor')),
      heading: center(paneQuery(otherPane.id, '#viewTitle')),
      card: center(paneRoot(otherPane.id).querySelector('.folder-card, .item-card')) };
  })()`);
  if (!setup.blank) fail('No blank grid area found in the other pane');
  const focusEditor = async () => {
    await click(setup.editor);
    const now = await focusState();
    if (!now.editorFocused || now.active !== setup.textPane) fail('Clicking the TXT editor did not focus and activate its pane: ' + JSON.stringify(now));
  };
  const report = {};
  for (const target of ['blank', 'heading', 'card']) {
    await focusEditor();
    await click(setup[target]);
    const now = await focusState();
    await js(`for (const p of document.querySelectorAll('.sort-popover:not(.hidden)')) p.classList.add('hidden')`);
    if (now.active !== setup.otherPane) fail(target + ' click did not activate the other pane: ' + JSON.stringify(now));
    if (now.editorFocused) fail(target + ' click in the other pane left focus in the TXT editor');
    report[target] = now.activeClass;
  }
  await focusEditor();
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'x' });
  await settle();
  const value = await js(`paneQuery('${setup.textPane}', '#textEditor').value`);
  if (!value.includes('x') || !value.includes('fixture body')) fail('TXT editor no longer accepts typing after refocus: ' + value);
  report.retypedLength = value.length;
  console.log('TEXT_FOCUS_RESULT ' + JSON.stringify(report));
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
