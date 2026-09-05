'use strict';
// Root schedules this isolated Electron DOM test; no production main or Eagle writes.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-web-platform-'));
app.setPath('userData', userData);
app.setPath('cache', path.join(userData, 'cache'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP eaglemv-fixture.test 127.0.0.1');
app.on('window-all-closed', () => {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 1440, height: 844,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'web-platform-preload.cjs') } });
  await win.loadFile(path.join(root, 'src/index.html'));
  await wait(300);
  const layouts = ['single', 'vertical2', 'horizontal2', 'grid4', 'leftStack', 'rightStack', 'topStack', 'bottomStack', 'horizontal3', 'vertical3', 'vertical4', 'horizontal4'];
  const geometry = [];
  for (const width of [390, 768, 980, 1440]) {
    win.setContentSize(width, 844); await wait(80);
    for (const layout of layouts) {
      geometry.push(await win.webContents.executeJavaScript(`(async () => {
        showContextMenuAt(100, 140, { kind: 'workspace', ids: [], paneId: state.activePaneId });
        [...document.querySelectorAll('[data-context-action="set-pane-layout"]')]
          .find(node => JSON.parse(node.dataset.contextPayload).layout === ${JSON.stringify(layout)}).click();
        await new Promise(resolve => setTimeout(resolve, 60));
        const panel = document.querySelector('#paneLayout');
        const bounds = panel.getBoundingClientRect();
        const panes = [];
        for (const pane of panel.querySelectorAll('.content-pane')) {
          pane.scrollIntoView({ block: 'center', inline: 'nearest' });
          const r = pane.getBoundingClientRect();
          const heading = pane.querySelector('.content-heading');
          panes.push({ width: r.width, height: r.height, x: r.x,
            reachable: r.bottom > bounds.top && r.top < bounds.bottom,
            headingOverflow: heading.scrollWidth - heading.clientWidth });
        }
        panel.scrollTop = 0;
        return { width: innerWidth, layout: panel.dataset.layout, panelWidth: bounds.width, panelClientWidth: panel.clientWidth,
          panelHeight: bounds.height, overflowY: getComputedStyle(panel).overflowY,
          inlineColumns: panel.style.gridTemplateColumns, computedColumns: getComputedStyle(panel).gridTemplateColumns,
          splittersVisible: [...panel.querySelectorAll('.pane-splitter')].some(node => getComputedStyle(node).display !== 'none'), panes };
      })()`));
    }
  }
  // Existing ratio state must survive a phone detour; no new resize preference is saved.
  const before = await win.webContents.executeJavaScript(`(async () => {
    renderPaneLayout('vertical2', { splitRatios: { cols: ['0.7fr', '0.3fr'], rows: ['1fr'] } });
    return document.querySelector('#paneLayout').style.gridTemplateColumns;
  })()`);
  win.setContentSize(390, 844); await wait(150);
  const phone = await win.webContents.executeJavaScript(`document.querySelector('#paneLayout').style.gridTemplateColumns`);
  win.setContentSize(1440, 844); await wait(150);
  const after = await win.webContents.executeJavaScript(`document.querySelector('#paneLayout').style.gridTemplateColumns`);
  win.destroy();

  const server = http.createServer((req, res) => {
    if (req.url === '/web-shim.js' || req.url === '/styles.css') {
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'application/javascript' : 'text/css');
      res.end(fs.readFileSync(path.join(root, 'src', req.url.slice(1))));
    } else if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/styles.css"></head><body><button id="origin">Copy</button><script src="/web-shim.js"></script></body></html>');
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const copyWin = new BrowserWindow({ show: false, useContentSize: true, width: 390, height: 844,
    webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await copyWin.loadURL(`http://eaglemv-fixture.test:${server.address().port}/`);
  const copy = await copyWin.webContents.executeJavaScript(`(async () => {
    document.querySelector('#origin').focus();
    const promise = window.eagleMV.copyText('first line\\nsecond line');
    await new Promise(resolve => setTimeout(resolve, 40));
    const dialog = document.querySelector('.web-copy-dialog');
    const field = dialog?.querySelector('textarea');
    if (!dialog) { await promise.catch(() => {}); return { secure: isSecureContext, dialog: false }; }
    const r = dialog.getBoundingClientRect();
    const result = { secure: isSecureContext, dialog: dialog.open, text: field.value,
      selected: field.selectionEnd - field.selectionStart, fits: r.left >= 0 && r.right <= innerWidth };
    dialog.querySelector('button').click();
    result.copied = await promise;
    result.focusRestored = document.activeElement.id === 'origin';
    return result;
  })()`);
  copyWin.destroy(); await new Promise(resolve => server.close(resolve));
  process.stdout.write('EAGLEMV_WEB_PLATFORM ' + JSON.stringify({ geometry, ratios: { before, phone, after }, copy }) + '\n');
  fs.rmSync(userData, { recursive: true, force: true });
  app.quit();
}
run().catch(error => { console.error(error); app.exit(1); });
