'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-sync-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));
async function run() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'sync-panes-preload.cjs') } });
  await window.loadFile(path.join(__dirname, '../src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const until = async p => { for (let i=0;i<160;i+=1){ if (p()) return; await wait(20);} throw new Error('not ready'); };
    await until(() => document.body.classList.contains('offline') === false && document.querySelector('.content-pane'));
    document.querySelector('#syncPanesCheckbox').checked = true;
    document.querySelector('#syncPanesCheckbox').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#paneLayoutButton').click();
    await wait(30);
    document.querySelector('#paneLayoutPopover [data-layout="vertical2"]').click();
    await until(() => document.querySelectorAll('.content-pane').length === 2);
    await until(() => document.querySelectorAll('.content-pane .item-card').length === 12);
    const attrs = p => ({ selected: [...p.selected], preview: p.previewId });
    const read = () => ({ pane0: attrs(window.state.panes[0]), pane1: attrs(window.state.panes[1]) });
    const before = read();
    const activePane = document.querySelector('.content-pane.active');
    const card = activePane.querySelector('.item-card[data-id="item-2"]');
    const touchClick = target => {
      const ev = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(ev, 'pointerType', { value: 'touch' });
      target.dispatchEvent(ev);
    };
    touchClick(card);
    await wait(120);
    const afterTap = read();
    activePane.querySelector('#nextPreview').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(120);
    const afterNext = read();
    activePane.querySelector('#closePreview').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(120);
    const afterInitialClose = read();
    const starOf = p => p.previewId ? (p.items.find(i => i.id === p.previewId)?.star || 0) : 0;
    // Desktop-style selection is pane-local even while preview operations are
    // synchronized.
    const card4 = activePane.querySelector('.item-card[data-id="item-4"]');
    card4.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(120);
    const afterDesktopSelect = read();
    const siblingPane = document.querySelectorAll('.content-pane')[1];
    const siblingCard5 = siblingPane.querySelector('.item-card[data-id="item-5"]');
    siblingCard5.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(120);
    const afterIndependentSelect = read();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', bubbles: true }));
    await wait(500);
    const gridRating = {
      item4: window.state.panes[0].items.find(i => i.id === 'item-4')?.star || 0,
      item5: window.state.panes[1].items.find(i => i.id === 'item-5')?.star || 0
    };
    siblingPane.querySelector('#itemGrid .item-card[data-id="item-2"]')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await wait(120);
    const afterPreviewOpen = read();
    siblingPane.querySelector('#nextPreview').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(120);
    const afterPreviewNext = read();
    const star = siblingPane.querySelector('#modalRating [data-preview-rating="4"]');
    star.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(500);
    const previewRating = { pane0: starOf(window.state.panes[0]), pane1: starOf(window.state.panes[1]) };
    siblingPane.querySelector('#closePreview').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(120);
    const afterPreviewClose = read();
    return {
      before, afterTap, afterNext, afterInitialClose, afterDesktopSelect,
      afterIndependentSelect, gridRating, afterPreviewOpen, afterPreviewNext,
      previewRating, afterPreviewClose
    };
  })()`);
  process.stdout.write(`EAGLEMV_SYNC ${JSON.stringify(result)}\n`);
  window.destroy(); app.quit();
}
run().catch(e => { console.error(e); app.exit(1); });
