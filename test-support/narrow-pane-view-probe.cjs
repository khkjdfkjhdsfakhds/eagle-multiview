'use strict';
// Real-renderer check for P7-12: split panes too narrow for the layout and
// sort controls still reach both. The sort popover carries the layout choice
// when the layout buttons are hidden, the sort button shrinks to an icon in
// the narrowest splits instead of vanishing, and the blank-area menu offers
// 排序方式 and 布局 submenus with the current choice checked.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-narrow-pane-view-')));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 980, height: 640, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'inspector-refresh-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const visible = element => Boolean(element && element.offsetParent && element.getBoundingClientRect().width > 0);
    const inside = (element, pane) => {
      const box = element.getBoundingClientRect(), outer = paneRoot(pane.id).getBoundingClientRect();
      return box.left >= outer.left - 0.5 && box.right <= outer.right + 0.5;
    };
    const load = async () => {
      for (const pane of state.panes) {
        pane.currentView = { kind: 'folder', id: 'mv-folder' };
        await refresh({ reset: true, paneId: pane.id });
      }
      await wait(40);
    };

    // 1. Two panes at 980px: layout buttons hidden, the popover offers them.
    assert(renderPaneLayout('vertical2', { refresh: false }) === true, 'two-pane layout refused');
    await load();
    let pane = state.panes[1];
    assert(!visible(paneQuery(pane.id, '#viewModeGroup')), 'fixture: layout buttons still shown at ' + paneRoot(pane.id).offsetWidth + 'px');
    paneQuery(pane.id, '#sortSelectButton').click();
    await wait(30);
    let layoutRow = paneQuery(pane.id, '.sort-popover-layout');
    assert(visible(layoutRow), 'popover has no layout row while the buttons are hidden');
    paneQuery(pane.id, '.sort-popover-layout [data-view-mode="list"]').click();
    await wait(30);
    assert(pane.viewMode === 'list', 'popover layout choice not applied: ' + pane.viewMode);
    assert(paneQuery(pane.id, '#sortPopover').classList.contains('hidden'), 'popover stayed open after a layout choice');
    paneQuery(pane.id, '#sortSelectButton').click();
    await wait(30);
    assert(paneQuery(pane.id, '.sort-popover-layout [data-view-mode="list"]').classList.contains('active'), 'current layout not marked');
    paneQuery(pane.id, '#sortSelectButton').click();

    // 2. A wide single pane keeps its own buttons and no duplicate row.
    assert(renderPaneLayout('single', { refresh: false }) === true, 'single layout refused');
    await load();
    pane = state.panes[0];
    assert(visible(paneQuery(pane.id, '#viewModeGroup')), 'single pane lost its layout buttons');
    paneQuery(pane.id, '#sortSelectButton').click();
    await wait(30);
    assert(!visible(paneQuery(pane.id, '.sort-popover-layout')), 'wide pane popover repeats the layout buttons');
    paneQuery(pane.id, '#sortSelectButton').click();

    // 3. Four side-by-side panes: the sort button stays, as an icon.
    assert(renderPaneLayout('vertical4', { refresh: false }) === true, 'four-pane layout refused');
    await load();
    for (const each of state.panes) {
      const button = paneQuery(each.id, '#sortSelectButton');
      assert(visible(button), 'sort button gone in a ' + paneRoot(each.id).offsetWidth + 'px pane');
      assert(inside(button, each), 'sort button overflows its pane');
      assert(!visible(paneQuery(each.id, '#sortSelectLabel')), 'label still shown in a narrow pane');
    }
    pane = state.panes[2];
    paneQuery(pane.id, '#sortSelectButton').click();
    await wait(30);
    assert(visible(paneQuery(pane.id, '.sort-popover-layout')), 'narrowest popover has no layout row');
    paneQuery(pane.id, '#sortPopover [data-sort="name"]').click();
    await wait(30);
    assert(pane.sort === 'name', 'sort from the icon popover not applied: ' + pane.sort);

    // 4. The blank-area menu: 排序方式 and 布局, current choice checked.
    showContextMenuAt(200, 200, { kind: 'workspace', ids: [], paneId: pane.id, folderId: 'mv-folder' });
    const menu = document.querySelector('#contextMenu');
    const row = (action, key, value) => [...menu.querySelectorAll('[data-context-action="' + action + '"]')]
      .find(node => JSON.parse(node.dataset.contextPayload)[key] === value);
    const labels = [...menu.querySelectorAll(':scope .context-menu-row > .context-menu-label')].map(node => node.textContent);
    assert(labels.includes('排序方式') && labels.includes('布局'), 'menu lacks the submenus: ' + labels.join(' / '));
    assert(row('set-sort', 'sort', 'name')?.getAttribute('aria-checked') === 'true', 'current sort not checked');
    assert(row('set-sort', 'sort', 'size')?.getAttribute('aria-checked') === 'false', 'other sort checked');
    row('set-sort', 'sort', 'size').click();
    await wait(30);
    assert(pane.sort === 'size', 'menu sort not applied: ' + pane.sort);
    showContextMenuAt(200, 200, { kind: 'workspace', ids: [], paneId: pane.id, folderId: 'mv-folder' });
    assert(row('set-sort-dir', 'dir', 'asc')?.getAttribute('aria-disabled') === 'false', 'direction disabled for a sortable field');
    row('set-sort-dir', 'dir', 'asc').click();
    await wait(30);
    assert(pane.sortDir === 'asc', 'menu direction not applied: ' + pane.sortDir);
    showContextMenuAt(200, 200, { kind: 'workspace', ids: [], paneId: pane.id, folderId: 'mv-folder' });
    row('set-view-mode', 'mode', 'waterfall').click();
    await wait(30);
    assert(pane.viewMode === 'waterfall', 'menu layout not applied: ' + pane.viewMode);
    showContextMenuAt(200, 200, { kind: 'workspace', ids: [], paneId: pane.id, folderId: 'mv-folder' });
    assert(row('set-view-mode', 'mode', 'waterfall')?.getAttribute('aria-checked') === 'true', 'current layout not checked');
  })()`);
  // 5. The tightest split: four panes in a 700px window.
  win.setContentSize(700, 640);
  await new Promise(resolve => setTimeout(resolve, 200));
  await win.webContents.executeJavaScript(`(async () => {
    const assert = (value, message) => { if (!value) throw Error(message); };
    assert(innerWidth === 700, 'window width ' + innerWidth);
    for (const pane of state.panes) {
      const root = paneRoot(pane.id).getBoundingClientRect();
      const heading = paneQuery(pane.id, '.heading-main-row');
      assert(heading.scrollWidth <= heading.clientWidth + 1, 'heading overflows a ' + Math.round(root.width) + 'px pane');
      const button = paneQuery(pane.id, '#sortSelectButton').getBoundingClientRect();
      assert(button.width > 0 && button.right <= root.right + 0.5, 'sort button outside a ' + Math.round(root.width) + 'px pane');
    }
  })()`);
  console.log('NARROW_PANE_VIEW_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
