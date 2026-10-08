'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-sync-shortcut-'));
app.setPath('userData', profile);
app.on('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: {
    contextIsolation: false, sandbox: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_UI_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async predicate => { for (let n=0;n<150;n++) { if(predicate())return;await wait(20); } throw Error('sync shortcut readiness timeout'); };
    const assert = (value, message) => { if (!value) throw Error(message); };
    await until(() => state.connected && !state.loading);
    setSyncPanesEnabled(false);
    const key = (options = {}) => {
      const event = new KeyboardEvent('keydown', {key:'S',code:'KeyS',shiftKey:true,bubbles:true,cancelable:true,...options});
      (document.activeElement || document.body).dispatchEvent(event);
      return event;
    };
    key();
    assert(syncPanesEnabled && document.querySelector('#syncPanesCheckbox').checked, 'grid shortcut did not toggle shared state');
    const notice = document.querySelector('#previewSyncNotice');
    assert(notice.textContent === '预览同步已开启', 'enabled feedback missing');
    renderPaneLayout('vertical2', {refresh:false});
    const items = Array.from({length:60}, (_, i) => ({id:'image-'+String(i).padStart(3,'0'),name:'image-'+String(i).padStart(3,'0'),ext:'png',width:800,height:600,tags:[],folders:[]}));
    window.eagleMV.mediaURL = () => 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#456a78"/></svg>');
    for (const pane of state.panes) {
      pane.items = items; pane.itemMap = new Map(items.map(item=>[item.id,item]));
      pane.hasMore = false;
      pane.selected = new Set([items[0].id]);
      withActivePane(pane.id, () => renderGrid());
      await withActivePane(pane.id, () => openPreview(items[58].id));
    }
    activatePane(state.panes[0].id);
    const modal = paneQuery(state.activePaneId, '#previewModal');
    modal.tabIndex=-1;modal.focus();
    const focus = document.activeElement;
    key({key:'ArrowRight',code:'ArrowRight',shiftKey:false});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (const pane of state.panes) {
      assert(pane.previewId === items[59].id, 'synchronized preview did not advance');
      assert(pane.selected.size === 1 && pane.selected.has(pane.previewId), 'background selection did not follow synchronized preview');
      const card = paneQuery(pane.id, '.item-card[data-id="'+pane.previewId+'"]');
      const box = card.getBoundingClientRect();
      const viewport = paneQuery(pane.id, '#gridScroller').getBoundingClientRect();
      assert(box.top >= viewport.top-1 && box.bottom <= viewport.bottom+1, 'preview selection was not scrolled into view');
    }
    assert(document.activeElement === focus, 'following selection stole preview focus');
    const extra = {...items[59], id:'image-060', name:'image-060'};
    window.eagleMV.query = async () => ({data:[extra], total:61, nextOffset:61, hasMore:false});
    for (const pane of state.panes) { pane.hasMore = true; pane.nextOffset = 60; }
    key({key:'ArrowRight',code:'ArrowRight',shiftKey:false});
    await until(() => state.panes.every(pane => pane.previewId === extra.id));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (const pane of state.panes) {
      assert(pane.selected.has(extra.id), 'newly loaded page did not update selection');
      const box = paneQuery(pane.id, '.item-card[data-id="'+extra.id+'"]').getBoundingClientRect();
      const viewport = paneQuery(pane.id, '#gridScroller').getBoundingClientRect();
      assert(box.top >= viewport.top-1 && box.bottom <= viewport.bottom+1, 'newly loaded page did not reveal selection');
    }
    key({key:'ArrowLeft',code:'ArrowLeft',shiftKey:false});
    await wait(100);
    assert(state.panes.every(pane => pane.previewId === items[59].id && pane.selected.has(items[59].id)), 'reverse navigation lost selection');
    closePreview();
    await wait(100);
    assert(state.panes.every(pane => !pane.previewId && pane.selected.has(items[59].id)), 'closing synchronized previews lost final selection');
    for (const pane of state.panes) await withActivePane(pane.id, () => openPreview(items[59].id));
    modal.focus();
    key();
    assert(!syncPanesEnabled && notice.textContent === '预览同步已关闭', 'shortcut failed with image already open');
    assert(!modal.classList.contains('hidden') && document.activeElement === focus, 'notice closed preview or stole focus');
    key({key:'s',shiftKey:false});
    assert(Boolean(state.slideshow.timer) && !syncPanesEnabled, 'plain S no longer controls slideshow independently');
    key({key:'s',shiftKey:false});
    assert(!state.slideshow.timer, 'plain S did not stop slideshow');
    assert(getComputedStyle(notice).pointerEvents === 'none', 'notice intercepts image gestures');
    assert(Number(getComputedStyle(notice).zIndex) > Number(getComputedStyle(modal).zIndex), 'notice is covered by preview');
    key({repeat:true});key({isComposing:true});key({altKey:true});key({metaKey:true});key({ctrlKey:true});
    assert(!syncPanesEnabled, 'repeat, IME, or extra modifier toggled sync');
    const search = document.querySelector('#searchInput');search.focus();
    assert(!key().defaultPrevented && !syncPanesEnabled, 'typing was captured');
    const editor = document.createElement('textarea');modal.append(editor);editor.focus();key();
    assert(!syncPanesEnabled, 'TXT editing toggled sync');editor.remove();
    modal.focus();
    document.querySelector('#folderDialog').classList.remove('hidden');key();
    assert(!syncPanesEnabled, 'blocking dialog allowed the shortcut');
    document.querySelector('#folderDialog').classList.add('hidden');
    applyWindowChromeState({fullScreen:true});
    key();
    assert(syncPanesEnabled && localStorage.getItem('eaglemv.syncPanes') === 'true', 'preview toggle did not persist');
    await wait(1800);
    const fading = Number(getComputedStyle(notice).opacity);
    assert(fading > 0 && fading < 1 && !notice.classList.contains('hidden'), 'notice abruptly vanished instead of fading');
    key(); // Replace an in-progress fade. Its old completion must not hide this one.
    await wait(100);
    assert(Number(getComputedStyle(notice).opacity) > .99 && notice.textContent === '预览同步已关闭', 'repeated toggle did not restart readable feedback');
    await wait(700);
    assert(!notice.classList.contains('hidden'), 'old animation completion hid a newer notice');
    await until(() => notice.classList.contains('hidden'));
    const checkbox = document.querySelector('#syncPanesCheckbox');checkbox.checked=true;
    checkbox.dispatchEvent(new Event('change',{bubbles:true}));
    assert(syncPanesEnabled && notice.textContent === '预览同步已开启', 'checkbox and shortcut diverged');
    assert(checkbox.getAttribute('aria-keyshortcuts') === 'Shift+S' && checkbox.parentElement.textContent.includes('⇧S'), 'visible shortcut hint missing');
    const rect=notice.getBoundingClientRect();
    assert(rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight,'notice escaped viewport');
    await wait(100); // Let the compositor paint the new notice before optional capture.
    return {fading,previewOpen:!modal.classList.contains('hidden'),enabled:syncPanesEnabled};
  })()`);
  console.log('PREVIEW_SYNC_RESULT '+JSON.stringify(result));
  if(process.env.EAGLEMV_SYNC_SCREENSHOT) fs.writeFileSync(process.env.EAGLEMV_SYNC_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
  win.destroy();app.quit();
})().catch(error=>{console.error(error.stack||error);app.exit(1);});
