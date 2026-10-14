'use strict';
// B1-02: "包含子文件夹" is one preference shared by every pane and window; each
// pane's checkbox must show it, and only the shared value may decide whether a
// sort change is written to the whole subtree.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-sort-cascade-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: { sandbox: false, contextIsolation: false, backgroundThrottling: false, preload: path.join(__dirname, 'renderer-ui-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !state.connected; i += 1) await wait(20);
    if (!state.connected) throw new Error('fixture library not connected');
    const cascades = [];
    sortMemory.rememberCascade = (...args) => { cascades.push(args[1]); };
    renderPaneLayout('vertical2', { refresh: false });
    const [a, b] = state.panes;
    for (const pane of [a, b]) { pane.currentView = { kind: 'folder', id: 'mv-folder' }; }
    const check = pane => paneQuery(pane.id, '#sortCascadeCheck');
    activatePane(a.id);
    check(a).checked = true;
    check(a).dispatchEvent(new Event('change', { bubbles: true }));
    const afterCheck = { a: check(a).checked, b: check(b).checked };
    check(a).checked = false;
    check(a).dispatchEvent(new Event('change', { bubbles: true }));
    const afterUncheck = { a: check(a).checked, b: check(b).checked };
    // Another window turns it on.
    localStorage.setItem(SORT_CASCADE_KEY, 'true');
    window.dispatchEvent(new StorageEvent('storage', { key: SORT_CASCADE_KEY, oldValue: 'false', newValue: 'true' }));
    const afterRemote = { a: check(a).checked, b: check(b).checked };
    // Opening a pane's sort menu shows the shared value even if its box went stale.
    check(b).checked = false;
    paneQuery(b.id, '#sortSelectButton').click();
    const reopened = check(b).checked;
    paneQuery(b.id, '#sortSelectButton').click();
    // Turned off elsewhere: a sort change in B must not cascade.
    localStorage.setItem(SORT_CASCADE_KEY, 'false');
    window.dispatchEvent(new StorageEvent('storage', { key: SORT_CASCADE_KEY, oldValue: 'true', newValue: 'false' }));
    cascades.length = 0;
    activatePane(b.id);
    const select = paneQuery(b.id, '#sortSelect');
    select.value = 'name';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const cascadedWhenOff = cascades.length;
    return { afterCheck, afterUncheck, afterRemote, reopened, cascadedWhenOff };
  })()`);
  console.log(`EAGLEMV_SORT_CASCADE ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
