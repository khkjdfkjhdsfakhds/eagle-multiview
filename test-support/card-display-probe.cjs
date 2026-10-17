'use strict';
// Real-renderer check for P1-06/P1-07: Eagle's 显示 switches live in the
// view popover, are global, and reshape the cards; 显示子文件夹内容 widens a
// folder to its subtree (matched locally) and the folder menu toggles it too.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-card-display-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'inspector-refresh-preload.cjs')
  } });
  const source = path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html');
  await win.loadFile(source);
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const parent = state.library.folders.find(folder => folder.id === 'mv-folder');
    parent.children = [{ id: 'mv-child', name: '子', imageCount: 1, children: [] }];
    const own = window.__inspectorRefresh.items;
    const childItem = { id: 'c-0', name: 'Child', ext: 'webp', width: 20, height: 30, size: 4096, modificationTime: 5, folders: ['mv-child'], tags: ['t'], comments: [{}, {}] };
    const queries = [];
    window.eagleMV.query = async query => {
      queries.push(query);
      const data = query.folderIds?.length > 1 ? [...own, childItem] : own;
      return { data: JSON.parse(JSON.stringify(data)), total: data.length, nextOffset: data.length, hasMore: false };
    };
    navigate({ kind: 'folder', id: 'mv-folder' });
    await wait(80);
    const pane = paneById(state.activePaneId);
    assert(!(queries.at(-1).folderIds?.length > 1), 'subfolder content on by default: ' + JSON.stringify(queries.at(-1)));
    const card = id => paneRoot(pane.id).querySelector('.item-card[data-id="' + id + '"]');
    assert(card('i-0') && !card('c-0'), 'child item shown before the switch');
    // Eagle's default card: name with its extension, 尺寸 as the meta line,
    // no format label on JPG, no star overlay.
    assert(card('i-0').querySelector('.card-name').textContent === 'Image 0.jpg', 'name ' + card('i-0').querySelector('.card-name').textContent);
    assert(card('i-0').querySelector('.card-meta').textContent === '10 x 10', 'meta ' + card('i-0').querySelector('.card-meta').textContent);
    assert(!card('i-0').querySelector('.format-badge') && !card('i-0').querySelector('.card-stars'), 'jpg card has a label or stars');

    paneQuery(pane.id, '#sortSelectButton').click();
    await wait(40);
    const popover = paneQuery(pane.id, '#sortPopover');
    const toggle = key => popover.querySelector('[data-card-display="' + key + '"]');
    for (const key of ['name', 'meta', 'ext', 'extLabel', 'annotation']) assert(toggle(key).checked, key + ' not on by default');
    assert(!toggle('subfolderContent').checked, 'subfolder content checked');
    assert(popover.querySelector('[data-card-meta-type]').value === 'RESOLUTION', 'meta type');
    for (const element of popover.querySelectorAll('.sort-popover-toggles .sort-popover-item')) {
      assert(element.scrollWidth <= element.clientWidth + 1, 'toggle row overflows: ' + element.textContent.trim());
    }

    toggle('subfolderContent').click();
    await wait(80);
    assert(JSON.stringify(queries.at(-1).folderIds) === JSON.stringify(['mv-folder', 'mv-child']), 'widened query ' + JSON.stringify(queries.at(-1)));
    assert(card('c-0'), 'child item missing with subfolder content on');
    assert(JSON.parse(localStorage.getItem('eaglemv.cardDisplay.v1')).subfolderContent === true, 'setting not stored');
    assert(!supportsManual({ kind: 'folder', id: 'mv-folder' }), 'custom order still offered on a widened folder');
    assert(card('c-0').querySelector('.annotation-badge').textContent === '2', 'annotation count');
    assert(card('c-0').querySelector('.format-badge').textContent === 'WEBP', 'webp label');

    toggle('name').click();
    toggle('extLabel').click();
    toggle('annotation').click();
    await wait(20);
    assert(getComputedStyle(card('i-0').querySelector('.card-name')).display === 'none', 'name still shown');
    assert(getComputedStyle(card('c-0').querySelector('.format-badge')).display === 'none', 'label still shown');
    assert(getComputedStyle(card('c-0').querySelector('.annotation-badge')).display === 'none', 'annotation still shown');
    toggle('name').click();
    toggle('ext').click();
    await wait(20);
    assert(getComputedStyle(card('i-0').querySelector('.card-ext')).display === 'none' && card('i-0').querySelector('.card-name').innerText === 'Image 0', 'extension still shown');

    const select = popover.querySelector('[data-card-meta-type]');
    select.value = 'FILESIZE';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(30);
    assert(card('i-0').querySelector('.card-meta').textContent === formatBytes(100), 'meta after FILESIZE ' + card('i-0').querySelector('.card-meta').textContent);
    toggle('meta').click();
    await wait(20);
    assert(select.disabled && getComputedStyle(card('i-0').querySelector('.card-meta')).display === 'none', 'meta off');

    // The folder menu toggles the same switch.
    paneQuery(pane.id, '#sortSelectButton').click();
    showContextMenuAt(300, 300, { kind: 'folder', ids: [], folderId: 'mv-child', paneId: pane.id });
    await wait(30);
    const row = [...document.querySelectorAll('#contextMenu [data-context-action="toggle-subfolder-content"]')];
    assert(row.length === 1 && row[0].getAttribute('aria-checked') === 'true', 'menu row ' + row.map(r => r.outerHTML));
    row[0].click();
    await wait(80);
    assert(!cardDisplay.subfolderContent && !(queries.at(-1).folderIds?.length > 1) && !card('c-0'), 'menu did not turn it off');
    localStorage.removeItem('eaglemv.cardDisplay.v1');
  })()`);
  console.log('CARD_DISPLAY_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
