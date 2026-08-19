'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-layout-probe-'));
app.setPath('userData', userData);
app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: Number(process.env.EAGLEMV_PROBE_WIDTH || 1280),
    height: Number(process.env.EAGLEMV_PROBE_HEIGHT || 749),
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      preload: path.join(__dirname, 'path-bar-ui-preload.cjs')
    }
  });
  ipcMain.handle('path-bar-ui-resize', (_event, { width, height }) => {
    window.setSize(Number(width), Number(height));
    return true;
  });
  await window.loadFile(path.join(__dirname, '../src/index.html'));
  const zoom = Number(process.env.EAGLEMV_PROBE_ZOOM || 1);
  if (zoom !== 1) window.webContents.setZoomFactor(zoom);
  const sidebarWidth = process.env.EAGLEMV_PROBE_SIDEBAR || '';
  const inspectorWidth = process.env.EAGLEMV_PROBE_INSPECTOR || '';
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async predicate => {
      for (let index = 0; index < 150; index += 1) {
        if (predicate()) return;
        await wait(20);
      }
      throw new Error('renderer did not become ready');
    };
    await until(() => document.body.classList.contains('offline') === false && Boolean(window.state?.library) && Boolean(document.querySelector('#paneLayoutButton')));
    if ('${sidebarWidth}') document.documentElement.style.setProperty('--sidebar-width', '${sidebarWidth}');
    if ('${inspectorWidth}') document.documentElement.style.setProperty('--inspector-width', '${inspectorWidth}');
    if ('${sidebarWidth}' || '${inspectorWidth}') {
      window.dispatchEvent(new Event('resize'));
      await wait(60);
    }
    document.querySelector('#paneLayoutButton').click();
    await wait(60);
    const popover = document.querySelector('#paneLayoutPopover');
    const rows = [];
    for (const option of popover.querySelectorAll('.pane-layout-option')) {
      const rect = option.getBoundingClientRect();
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const hit = document.elementFromPoint(center.x, center.y);
      rows.push({
        layout: option.dataset.layout,
        label: option.getAttribute('aria-label'),
        rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
        hitIsOption: Boolean(hit && (hit === option || option.contains(hit))),
        hitClass: hit ? (hit.className || hit.tagName) : null,
        display: getComputedStyle(option).display,
        visibility: getComputedStyle(option).visibility,
        iconDisplay: getComputedStyle(option.querySelector('.layout-icon')).display,
        iconRect: (() => { const r = option.querySelector('.layout-icon').getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; })()
      });
    }
    const clippedBy = [];
    for (const el of [popover, popover.parentElement, popover.parentElement.parentElement, popover.parentElement.parentElement.parentElement, document.querySelector('.toolbar'), document.querySelector('.content-panel')]) {
      if (!el) continue;
      const style = getComputedStyle(el);
      if (style.overflow !== 'visible') clippedBy.push({ tag: el.className || el.tagName, overflow: style.overflow });
    }
    return {
      innerWidth,
      innerHeight,
      uiZoom: parseFloat(getComputedStyle(document.documentElement).fontSize),
      wrapped: document.querySelector('.toolbar').classList.contains('wrapped'),
      buttonRect: (() => { const r = document.querySelector('#paneLayoutButton').getBoundingClientRect(); return { left: Math.round(r.left), width: Math.round(r.width), center: Math.round(r.left + r.width / 2) }; })(),
      popoverRect: (() => { const r = popover.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })(),
      popoverDisplay: getComputedStyle(popover).display,
      clippedBy,
      rows
    };
  })()`);
  process.stdout.write(`EAGLEMV_LAYOUT_PROBE ${JSON.stringify(result)}\n`);
  window.destroy();
  app.quit();
}

run().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
}).finally(() => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});
