'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-sidebar-hidden-'));
const appRoot = process.env.EAGLEMV_APP_ROOT || path.join(__dirname, '..');
app.setPath('userData', userData);
app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 820,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      preload: path.join(__dirname, 'renderer-ui-preload.cjs')
    }
  });

  await window.loadFile(path.join(appRoot, 'src/index.html'));
  await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let index = 0; index < 100; index += 1) {
      if (!document.body.classList.contains('offline') && document.querySelector('.content-pane')) return;
      await wait(20);
    }
    throw new Error('renderer did not become ready');
  })()`);

  const results = [];
  for (const width of [820, 1120, 1121, 1280, 1440]) {
    window.setSize(width, 820);
    await new Promise(resolve => setTimeout(resolve, 80));
    const result = await window.webContents.executeJavaScript(`(() => {
      if (!document.body.classList.contains('sidebar-hidden')) {
        document.querySelector('#toggleSidebarButton').click();
      }
      const search = document.querySelector('.search-box').getBoundingClientRect();
      const toolbar = document.querySelector('.toolbar').getBoundingClientRect();
      return {
        width: innerWidth,
        sidebarHidden: document.body.classList.contains('sidebar-hidden'),
        searchLeft: Math.round(search.left),
        toolbarLeft: Math.round(toolbar.left)
      };
    })()`);
    results.push(result);
  }

  process.stdout.write(`EAGLEMV_SIDEBAR_HIDDEN ${JSON.stringify(results)}\n`);
  window.destroy();
  app.quit();
}

run().catch(error => {
  console.error(error);
  app.exit(1);
});
