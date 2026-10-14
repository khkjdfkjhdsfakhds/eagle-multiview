'use strict';
// R2-04: like Eagle, changing view clears the search and filters unless
// 锁定筛选 is on; back restores what that view had; 清除筛选 also unlocks.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-filter-lock-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'folder-count-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !window.state?.connected; i += 1) await wait(20);
    const snap = () => ({ search: state.query.search, rating: state.query.rating ?? null, box: $('#searchInput').value });
    const lockButton = () => $('#lockFiltersButton');
    const out = {};
    navigate({ kind: 'folder', id: 'A' });
    await wait(40);
    out.lockHiddenWhenIdle = lockButton()?.classList.contains('hidden') ?? null;
    state.query.search = 'cat';
    state.query.rating = 4;
    renderQueryControls();
    out.lockShownWhenFiltered = !lockButton().classList.contains('hidden');
    document.querySelector('#folderTree .folder-row[data-folder-id="B"]').click();
    await wait(60);
    out.sidebar = { view: state.currentView.id, ...snap() };
    navigateHistory(-1);
    await wait(60);
    out.back = { view: state.currentView.id, ...snap() };
    lockButton().click();
    out.locked = { pressed: lockButton().getAttribute('aria-pressed'), badge: $('#filterButton').classList.contains('locked') };
    document.querySelector('#folderTree .folder-row[data-folder-id="B"]').click();
    await wait(60);
    out.lockedSidebar = { view: state.currentView.id, ...snap() };
    clearFilters();
    out.clearUnlocks = state.filterLock;
    return out;
  })()`);
  console.log(`EAGLEMV_FILTER_LOCK ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
