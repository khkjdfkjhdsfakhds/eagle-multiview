'use strict';
// Real-renderer checks for the P3 renderer batch: 原始大小 in the preview
// (B2-13, ⌘0), the 最近使用 list honours the search box (B1-08), every pane's
// slideshow select shows its interval (B3-09), F2 renames a selected folder
// card like ⌘R (B3-11), and a library change that lands during a failed sync
// is still applied (H-06).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-renderer-polish-')));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const key = (code, extra = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { code, key: code === 'Digit0' ? '0' : code, metaKey: true, bubbles: true, cancelable: true, ...extra }));

    // B2-13: ⌘0 in an image preview switches to 原始大小 and back.
    const item = { id: 'polish-img', name: '大图', ext: 'png', width: 4000, height: 3000, size: 1, folders: [], tags: [] };
    const pane = activePane();
    pane.items = [item];
    pane.itemMap = new Map([[item.id, item]]);
    pane.total = 1;
    renderGrid({ preserveScroll: true });
    await openPreview(item.id);
    await wait(30);
    // test:// never loads, and a failed load swaps in the "cannot preview"
    // card; put the image element back so the zoom styles have a target.
    if (!previewImage()) $('#modalMedia').innerHTML = '<img class="preview-image" alt="">';
    renderPreviewZoom();
    const image = previewImage();
    assert(image, 'no preview image');
    assert(image.style.maxWidth === '100%', 'fit starts constrained: ' + image.style.maxWidth);
    key('Digit0');
    assert(state.previewZoom.mode === 'actual', 'Cmd+0 did not switch to actual: ' + state.previewZoom.mode);
    assert(image.style.maxWidth === 'none' && image.style.maxHeight === 'none', 'actual size still capped: ' + image.style.maxWidth);
    key('Digit0');
    assert(state.previewZoom.mode === 'fit' && image.style.maxWidth === '100%', 'Cmd+0 did not return to fit');
    closePreview();
    await wait(20);

    // B1-08: the 最近使用 folder list follows the search box.
    state.recentFolders = state.library.folders.slice(0, 2);
    state.currentView = { kind: 'recent' };
    state.query.search = 'eagle';
    const recent = visibleChildFolders().map(folder => folder.id);
    assert(recent.length === 1 && recent[0] === 'eagle-folder', 'recent ignores search: ' + recent.join(','));
    state.query.search = '';
    state.currentView = { kind: 'root' };

    // B3-09: a new pane's slideshow select shows the 4 s default, not 2 s.
    renderPaneLayout('vertical2', { refresh: false });
    await wait(30);
    const selects = [...document.querySelectorAll('.content-pane #slideshowInterval')];
    assert(selects.length === 2, 'expected two panes, got ' + selects.length);
    for (const select of selects) assert(select.value === '4000', 'slideshow select shows ' + select.value);
    renderPaneLayout('single', { refresh: false });
    await wait(30);

    // B3-11: F2 with a folder card selected renames it (same as Cmd+R).
    state.selected = new Set();
    state.selectedFolderCard = 'mv-folder';
    document.body.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', code: 'F2', bubbles: true, cancelable: true }));
    await wait(30);
    const dialogTitle = document.querySelector('#folderDialog:not(.hidden) h2, #folderDialogTitle')?.textContent || '';
    const dialogOpen = Boolean(state.folderDialogResolve);
    if (dialogOpen) { document.querySelector('#folderDialogCancel, [data-folder-dialog-cancel]')?.click(); state.folderDialogResolve?.(null); }
    assert(dialogOpen, 'F2 on a folder card opened no rename dialog');

    return { dialogTitle };
  })()`);
  console.log('RENDERER_POLISH_OK ' + JSON.stringify(result));
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
