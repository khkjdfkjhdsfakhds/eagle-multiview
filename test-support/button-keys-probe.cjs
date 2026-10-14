'use strict';
// B3-05: with items selected, Enter or Space on a keyboard-focused button is
// the button's, not "open the preview"; on a card, or on a button that only
// kept focus after a mouse click, they still open the preview.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-button-keys-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'batch-selection-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const exec = code => window.webContents.executeJavaScript(code);
  // A hidden window never has focus, so :focus-visible would never match;
  // DevTools' focused-page emulation gives the page real focus semantics.
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  await exec(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !(window.state?.connected && state.items.length === 3); i += 1) await wait(20);
    if (state.items.length !== 3) throw new Error('fixture items not loaded');
    window.__press = (target, key) => {
      const event = new KeyboardEvent('keydown', { key, code: key === ' ' ? 'Space' : key, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    window.__previewOpen = () => !$('#previewModal').classList.contains('hidden');
  })()`);
  const result = {};
  // Keyboard focus on a button (what Tab gives a keyboard user).
  result.keyboard = await exec(`(async () => {
    selectItem('a');
    const button = $('#paneLayoutButton');
    button.focus({ focusVisible: true });
    const out = { focusVisible: button.matches(':focus-visible') };
    out.enterPrevented = __press(button, 'Enter');
    out.enterPreview = __previewOpen();
    out.spacePrevented = __press(button, ' ');
    out.spacePreview = __previewOpen();
    return out;
  })()`);
  // A mouse click leaves focus on the button without :focus-visible.
  const box = await exec(`(() => { document.activeElement?.blur(); const r = $('#paneLayoutButton').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 100));
  result.mouse = await exec(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const button = $('#paneLayoutButton');
    const out = { focused: document.activeElement === button, focusVisible: button.matches(':focus-visible') };
    closeTopTransientSurface({ selection: false });
    selectItem('a');
    if (document.activeElement !== button) button.focus({ focusVisible: false });
    out.spacePrevented = __press(button, ' ');
    await wait(30);
    out.spacePreview = __previewOpen();
    closePreview({ commitSelection: false });
    return out;
  })()`);
  result.card = await exec(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    selectItem('b');
    const card = document.querySelector('.item-card[data-id="b"]');
    card.focus();
    const prevented = __press(card, 'Enter');
    await wait(30);
    return { prevented, preview: __previewOpen() };
  })()`);
  console.log(`EAGLEMV_BUTTON_KEYS ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
