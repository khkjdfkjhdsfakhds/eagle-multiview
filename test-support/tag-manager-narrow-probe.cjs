'use strict';
// Real-renderer check for P7-01 / GUI-10: the tag manager holds together in
// split panes of a 980px window: nothing is clipped past the pane, the
// "新建分组" button and group titles stay on one line, every row button is
// fully visible, and an empty group's placeholder looks like a row.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-tag-manager-narrow-')));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 980, height: 700, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const tags = ['人物', '风景参考', 'a-rather-long-tag-name-for-testing', '光影', '构图'];
    state.availableTags = tags.map((name, index) => ({ name, imageCount: index * 37 }));
    state.tagGroups = [{ id: 'g1', name: '参考资料分组', tags: tags.slice(0, 3) }, { id: 'g2', name: '空分组', tags: [] }];
    const lineCount = element => Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight || '16'));
    for (const layout of ['single', 'vertical2']) {
      assert(renderPaneLayout(layout, { refresh: false }) === true, layout + ' refused');
      await wait(30);
      for (const pane of state.panes) {
        pane.currentView = { kind: 'tags' };
        withActivePane(pane.id, () => renderGrid({ preserveScroll: false }));
      }
      await wait(40);
      for (const pane of state.panes) {
        const root = paneRoot(pane.id);
        const scroller = paneQuery(pane.id, '#gridScroller');
        const label = layout + ' ' + Math.round(root.getBoundingClientRect().width) + 'px';
        assert(scroller.scrollWidth <= scroller.clientWidth + 1, label + ': tag manager scrolls sideways (' + scroller.scrollWidth + ' > ' + scroller.clientWidth + ')');
        const bounds = scroller.getBoundingClientRect();
        for (const element of root.querySelectorAll('.tag-manager button, .tag-manager select, .tag-manager h2, .tag-manager-name')) {
          const box = element.getBoundingClientRect();
          assert(box.right <= bounds.right + 0.5 && box.left >= bounds.left - 0.5, label + ': clipped ' + element.textContent.trim().slice(0, 20));
        }
        const create = root.querySelector('[data-tag-action="create-group"]');
        assert(create.getBoundingClientRect().height < 40, label + ': 新建分组 wraps (' + create.getBoundingClientRect().height + 'px)');
        for (const title of root.querySelectorAll('.tag-manager-group-heading h2')) {
          assert(title.getBoundingClientRect().height < 24, label + ': group title wraps: ' + title.textContent);
        }
        for (const button of root.querySelectorAll('.tag-manager-action')) {
          assert(button.scrollWidth <= button.clientWidth + 1 && button.getBoundingClientRect().height < 30, label + ': button squeezed: ' + button.textContent);
        }
        const empty = root.querySelector('.tag-manager-group:nth-of-type(2) .tag-manager-list > *');
        assert(empty && empty.classList.contains('tag-manager-row'), label + ': empty group placeholder is not a row');
      }
    }
  })()`);
  console.log('TAG_MANAGER_NARROW_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
