'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-zoom-test-'));
app.setPath('userData', userData);
app.setPath('cache', path.join(userData, 'cache'));

function readThumb() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thumb'));
}

function press(code, { meta = true, ctrl = false }) {
  document.dispatchEvent(new KeyboardEvent('keydown', { code, metaKey: meta, ctrlKey: ctrl, altKey: false, bubbles: true, cancelable: true }));
}

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      preload: path.join(__dirname, 'renderer-ui-preload.cjs')
    }
  });
  await window.loadFile(path.join(__dirname, '../src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async predicate => {
      for (let index = 0; index < 100; index += 1) {
        if (predicate()) return;
        await wait(20);
      }
      throw new Error('renderer did not become ready');
    };
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const readThumb = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thumb'));
    const slider = () => document.querySelector('#sizeSlider');
    const sidebarWidth = () => getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width') || 'unset';
    const inspectorWidth = () => getComputedStyle(document.documentElement).getPropertyValue('--inspector-width') || 'unset';

    await until(() => document.body.classList.contains('offline') === false && document.querySelector('.content-pane'));

    const defaultThumb = readThumb();
    assert(defaultThumb === 168, 'default thumbnail size should be 168, got ' + defaultThumb);
    assert(slider() && slider().value === '168', 'slider should start at 168');

    const sideBefore = { sidebar: sidebarWidth(), inspector: inspectorWidth() };

    // Meta + Equal should grow only the middle grid thumbnail and sync the slider.
    const press = (code, { meta = true, ctrl = false } = {}) => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code, metaKey: meta, ctrlKey: ctrl, altKey: false, bubbles: true, cancelable: true }));
    };

    press('Equal');
    await wait(60);
    const grown = readThumb();
    assert(grown === defaultThumb + 12, 'Cmd+plus should grow thumb by 12, got ' + grown);
    assert(slider().value === String(grown), 'slider should follow Cmd+plus, got ' + slider().value);
    assert(sidebarWidth() === sideBefore.sidebar && inspectorWidth() === sideBefore.inspector, 'side columns must not resize');

    // Meta + Minus should shrink back to default and keep the slider in sync.
    press('Minus');
    await wait(60);
    assert(readThumb() === defaultThumb, 'Cmd+minus should return to default, got ' + readThumb());

    // Repeated minus clamps at the minimum.
    for (let i = 0; i < 20; i += 1) press('Minus');
    await wait(80);
    assert(readThumb() === 110, 'long minus run should clamp to 110, got ' + readThumb());
    assert(slider().value === '110', 'slider should clamp to 110');

    // Meta + 0 resets to the default.
    press('Digit0');
    await wait(60);
    assert(readThumb() === 168, 'Cmd+0 should reset to 168, got ' + readThumb());
    assert(slider().value === '168', 'slider should reset to 168');

    return { defaultThumb, grown, clampedLow: readThumb(), slider: slider().value };
  })()`);
  process.stdout.write(`EAGLEMV_ZOOM_RESULT ${JSON.stringify(result)}\n`);
  window.destroy();
  app.quit();
}

run().catch(error => {
  console.error(error);
  app.exit(1);
});
