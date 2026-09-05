'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-pane-reveal-'));
app.setPath('userData', userData);
app.setPath('cache', path.join(userData, 'cache'));

(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 820, webPreferences: {
    contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_UI_SOURCE_ROOT || path.join(__dirname, '..'), 'src/index.html'));
  const result = await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'pane-reveal-scenarios.js'), 'utf8'));
  if (process.env.EAGLEMV_UI_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.EAGLEMV_UI_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.EAGLEMV_UI_SCREENSHOT_DIR, 'pane-reveal.png'), (await win.webContents.capturePage()).toPNG());
  }
  process.stdout.write('PANE_REVEAL_RESULT ' + JSON.stringify(result) + '\n');
  win.destroy();
  app.quit();
})().catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); });
app.on('will-quit', () => { fs.rmSync(userData, { recursive: true, force: true }); });
