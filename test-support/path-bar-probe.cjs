'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-pb-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));
async function run() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'renderer-ui-preload.cjs') } });
  await window.loadFile(path.join(__dirname, '../src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const until = async p => { for (let i=0;i<120;i+=1){ if (p()) return; await wait(20);} throw new Error('not ready'); };
    await until(() => document.body.classList.contains('offline') === false && document.querySelector('.content-pane'));
    const breadcrumb = () => document.querySelector('.content-pane.active #breadcrumb');
    const title = () => document.querySelector('.content-pane.active #viewTitle');
    const read = () => ({
      crumbFont: parseFloat(getComputedStyle(breadcrumb()).fontSize),
      crumbHeight: parseFloat(getComputedStyle(breadcrumb()).height),
      titleFont: parseFloat(getComputedStyle(title()).fontSize)
    });
    const desktop = read();
    document.body.classList.add('web-client');
    const web = read();
    document.body.classList.remove('web-client');
    return { desktop, web };
  })()`);
  process.stdout.write(`EAGLEMV_PATHBAR ${JSON.stringify(result)}\n`);
  window.destroy(); app.quit();
}
run().catch(e => { console.error(e); app.exit(1); });
