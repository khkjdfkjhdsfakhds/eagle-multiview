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
    const items = ['image-a','image-b'].map(id => ({id,name:id,ext:'png',width:800,height:600,tags:[],folders:[]}));
    window.eagleMV.mediaURL = () => 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#456a78"/></svg>');
    for (const pane of state.panes) {
      pane.items = items; pane.itemMap = new Map(items.map(item=>[item.id,item]));
      await withActivePane(pane.id, () => openPreview('image-a'));
    }
    activatePane(state.panes[0].id);
    const modal = paneQuery(state.activePaneId, '#previewModal');
    modal.tabIndex=-1;modal.focus();
    const focus = document.activeElement;
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
