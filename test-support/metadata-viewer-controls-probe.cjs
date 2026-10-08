'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-metadata-controls-'));
app.setPath('userData', profile);
app.on('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));

(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1000, height: 820, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  const root = process.env.EAGLEMV_UI_SOURCE_ROOT || path.resolve(__dirname, '..');
  await win.loadFile(path.join(root, 'src/index.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    await wait(150);
    const assert = (value, message) => { if (!value) throw Error(message); };
    const key = (code, target = document) => target.dispatchEvent(new KeyboardEvent('keydown', {
      code, key: code === 'Equal' ? '=' : code === 'Minus' ? '-' : '0', metaKey: true,
      shiftKey: code === 'Equal',
      bubbles: true, cancelable: true
    }));
    const section = document.querySelector('#generationMetadataSection');
    const panel = document.querySelector('#generationMetadata');
    const zoom = () => String(metadataViewerZoom);
    assert(!document.querySelector('#metadataZoomSlider, #metadataZoomIn, #metadataZoomOut, #metadataZoomValue'), 'visible zoom controls must be absent');
    const handle = document.querySelector('#metadataResizeHandle');
    const thumb = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thumb'));
    renderGenerationMetadata({ format: 'NovelAI', positive: 'a long prompt', negative: 'blurry', params: { Steps: '28' } });
    document.querySelector('#noSelection').classList.add('hidden');
    document.querySelector('#inspectorContent').classList.remove('hidden');
    assert(!section.classList.contains('hidden'), 'metadata section should be visible');
    assert(zoom() === '100', 'metadata zoom should start at 100%');

    // The metadata area is opt-in: clicking it routes Cmd+plus to its text.
    panel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }));
    const thumbBefore = thumb();
    key('Equal'); await wait(30);
    assert(zoom() === '110', 'Cmd+plus should grow metadata text after clicking the panel');
    assert(getComputedStyle(section).getPropertyValue('--metadata-zoom').trim() === '1.1', 'metadata CSS zoom should follow shortcut');
    assert(thumb() === thumbBefore, 'metadata shortcut must not resize the grid');

    // Clicking away restores the normal software thumbnail shortcut.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, clientX: 900, clientY: 700 }));
    key('Equal'); await wait(30);
    assert(thumb() === thumbBefore + 12, 'Cmd+plus outside metadata should resize the grid');
    panel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    key('Minus');
    assert(zoom() === '100', 'minus should shrink metadata');
    for (let i = 0; i < 5; i++) key('Equal');
    assert(zoom() === '150', 'keyboard zoom should accumulate without controls');
    renderGenerationMetadata({ format: 'NovelAI', positive: 'next prompt' });
    assert(zoom() === '150', 'switching content should retain zoom');

    applyMetadataViewerHeight(240, { persist: false });
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 3, clientX: 980, clientY: 100 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 3, clientX: 980, clientY: 160 }));
    handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3, clientX: 980, clientY: 160 }));
    await wait(30);
    const afterHeight = Number.parseFloat(getComputedStyle(section).getPropertyValue('--metadata-viewer-height'));
    assert(afterHeight >= 148, 'metadata resize handle should set a usable viewer height: ' + section.getAttribute('style'));
    assert(localStorage.getItem('eaglemv.metadataViewerHeight') === String(Math.round(afterHeight)), 'metadata height should persist after drag');
    return { zoom: zoom(), thumb: thumb(), heightChanged: afterHeight };
  })()`);
  console.log('METADATA_VIEWER_CONTROLS_RESULT ' + JSON.stringify(result));
  win.destroy();
  app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
