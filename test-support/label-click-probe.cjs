'use strict';
// Real-renderer check for F-01: clicking a shared tag's name or the section
// caption must not reach the first chip's remove button through a <label>.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-label-click-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'review-bugfixes-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async predicate => { for (let i = 0; i < 150; i += 1) { if (predicate()) return; await wait(20); } throw new Error('fixture not ready'); };
    await until(() => document.querySelectorAll('.content-pane .item-card').length === 6);
    const pane = document.querySelector('.content-pane');
    const click = (id, options = {}) => pane.querySelector('.item-card[data-id="' + id + '"]').dispatchEvent(new MouseEvent('click', { bubbles: true, ...options }));
    click('item-1');
    click('item-2', { metaKey: true });
    await addTagToSelection({ ids: ['item-1', 'item-2'], tag: 'alpha' });
    await addTagToSelection({ ids: ['item-1', 'item-2'], tag: 'beta' });
    await until(() => document.querySelectorAll('#sharedTagChips .tag-chip').length === 2);
    const calls = window.__reviewCalls.length;
    const press = target => target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    press([...document.querySelectorAll('#sharedTagChips .tag-chip')][1].firstElementChild);
    press(document.querySelector('#sharedTagsLabel'));
    press(document.querySelector('#sharedTagChips'));
    await wait(300);
    const removals = window.__reviewCalls.slice(calls).filter(call => call.remove?.length);
    const shared = [...document.querySelectorAll('#sharedTagChips .tag-chip')].map(chip => chip.firstElementChild.textContent);
    return { removals, shared };
  })()`);
  console.log(`EAGLEMV_LABEL_CLICK ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
