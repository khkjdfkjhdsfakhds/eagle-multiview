'use strict';
// Real-renderer check for B2-05: a reset refresh that leaves the selected
// item's file alone (a rating, a tag, another window's change) updates the
// inspector in place. Comments do not flash "正在读取…", the generation
// metadata stays (with an expanded workflow still expanded) and is not read
// again, and the preview thumbnail is not rebuilt. A changed file, another
// item or a new thumbnail revision still reloads.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-inspector-refresh-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'inspector-refresh-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (fn, label) => { for (let i = 0; i < 200; i++) { if (fn()) return; await wait(20); } throw Error('timeout: ' + label); };
    const assert = (value, message) => { if (!value) throw Error(message); };
    await until(() => state.connected, 'connect');
    state.currentView = { kind: 'folder', id: 'mv-folder' };
    await refresh({ reset: true });
    await until(() => document.querySelector('.item-card[data-id="i-0"]') && !state.loading, 'items');
    const counts = window.__inspectorRefresh;
    const comments = () => document.querySelector('#itemComments').textContent;
    const metadataShown = () => !document.querySelector('#generationMetadataSection').classList.contains('hidden');
    selectItem('i-0');
    await until(() => comments().includes('note') && metadataShown(), 'first inspector load');
    assert(counts.metadata === 1, 'metadata reads after select: ' + counts.metadata);
    const details = document.querySelector('.metadata-workflow-details');
    assert(details, 'workflow details not rendered');
    details.open = true;
    const previewImage = document.querySelector('#previewBox img');

    // Watch every state the inspector passes through during the refresh.
    const seen = [];
    const observer = new MutationObserver(() => {
      seen.push({ comments: comments(), metadata: metadataShown() });
    });
    observer.observe(document.querySelector('#inspector') || document.body, { subtree: true, childList: true, attributes: true, characterData: true });

    // 1. A rating changed elsewhere: same file, new star.
    counts.items[0].star = 4;
    const commentReads = counts.comments;
    await refresh({ reset: true });
    await until(() => counts.comments > commentReads, 'comments refreshed after the reset');
    await wait(120);
    observer.disconnect();
    assert(document.querySelector('#itemRating').value === '4', 'rating not updated in place: ' + document.querySelector('#itemRating').value);
    assert(!seen.some(entry => entry.comments.includes('正在读取')), 'comments flashed the loading text');
    assert(!seen.some(entry => !entry.metadata), 'generation metadata hid during the refresh');
    assert(counts.metadata === 1, 'unchanged file re-read its metadata: ' + counts.metadata);
    assert(document.querySelector('.metadata-workflow-details')?.open, 'expanded workflow collapsed');
    assert(document.querySelector('#previewBox img') === previewImage, 'preview thumbnail rebuilt');
    assert(comments().includes('note'), 'comments lost');

    // 2. The file itself changed: metadata is read again.
    counts.items[0].modificationTime += 1;
    counts.items[0].size += 1;
    await refresh({ reset: true });
    await until(() => counts.metadata === 2, 'changed file re-read');

    // 3. A new thumbnail revision rebuilds the preview image.
    const before = document.querySelector('#previewBox img');
    thumbnailRevision += 1;
    await refresh({ reset: true });
    await until(() => document.querySelector('#previewBox img') !== before, 'thumbnail revision ignored');

    // 4. Another item and back reloads everything for it.
    selectItem('i-1');
    await until(() => counts.metadata === 3, 'other item metadata');
    selectItem('i-0');
    await until(() => counts.metadata === 4, 'reselected item metadata');
  })()`);
  console.log('INSPECTOR_REFRESH_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
