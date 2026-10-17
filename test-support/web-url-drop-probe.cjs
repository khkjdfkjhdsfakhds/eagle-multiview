'use strict';
// Real-renderer check for D-08: a picture or link dragged in from a browser
// imports its address like Eagle (the <img src> first, then the URL), into
// the pane's or crumb's folder. Items with no readable file (Photos) and
// browser-only image addresses explain themselves instead of doing nothing,
// and a drag that starts inside this page never imports its own media.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-web-url-drop-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'pane-drag-pass-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (fn, label) => { for (let i = 0; i < 200; i++) { if (fn()) return; await wait(20); } throw Error('timeout: ' + label); };
    const assert = (value, message) => { if (!value) throw Error(message); };
    await until(() => state.connected && state.manualOrdersReady, 'connect');
    assert(renderPaneLayout('vertical2', { refresh: false }) === true, 'two-pane layout refused');
    await until(() => document.querySelectorAll('#paneLayout > .content-pane').length === 2, 'two panes rendered');
    const [paneA, paneB] = state.panes;
    paneA.currentView = { kind: 'folder', id: 'mv-folder' };
    paneB.currentView = { kind: 'folder', id: 'eagle-folder' };
    await refresh({ reset: true, paneId: paneA.id });
    await refresh({ reset: true, paneId: paneB.id });
    const inPane = (paneId, selector) => document.querySelector('.content-pane[data-pane-id="' + paneId + '"] ' + selector);
    await until(() => inPane(paneB.id, '.item-card') && !paneA.loading && !paneB.loading, 'pane items');
    activatePane(paneA.id);
    const urls = [];
    window.eagleMV.importURL = async payload => { urls.push(JSON.parse(JSON.stringify(payload))); return { count: 1, ready: 0, ids: ['new'], source: 'url' }; };
    const toasts = [];
    const showToast = window.toast;
    window.toast = (message, duration) => { toasts.push(String(message)); return showToast(message, duration); };
    const idle = () => until(() => !state.operationTracker.active().length && !state.importing, 'operations idle');
    const browserDrag = values => {
      const data = new DataTransfer();
      for (const [type, value] of Object.entries(values)) data.setData(type, value);
      return data;
    };
    const dropOn = (target, data) => {
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data });
      target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }));
      target.dispatchEvent(over);
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      return over.defaultPrevented;
    };
    const scrollerB = inPane(paneB.id, '#gridScroller');

    // 1. A picture from a web page lands on pane B: its <img src> is imported
    //    into B's folder as an image.
    const accepted = dropOn(scrollerB, browserDrag({
      'text/html': '<a href="https://site.test/post"><img src="https://cdn.test/pic.jpg"></a>',
      'text/uri-list': 'https://site.test/post'
    }));
    assert(accepted, 'content area refused a web picture');
    await until(() => urls.length === 1, 'web picture imported');
    await idle();
    assert(urls[0].url === 'https://cdn.test/pic.jpg' && urls[0].image === true && urls[0].folderId === 'eagle-folder',
      'picture import ' + JSON.stringify(urls[0]));

    // 2. A link dropped on a folder crumb imports into that folder.
    const crumb = inPane(paneA.id, '#breadcrumb [data-crumb-folder-id="mv-folder"]');
    assert(crumb, 'folder crumb not rendered');
    dropOn(crumb, browserDrag({ 'text/uri-list': 'https://site.test/article' }));
    await until(() => urls.length === 2, 'link imported');
    await idle();
    assert(urls[1].url === 'https://site.test/article' && urls[1].image === false && urls[1].folderId === 'mv-folder',
      'link import ' + JSON.stringify(urls[1]));

    // 3. Photos-style items: files without a readable path explain why.
    toasts.length = 0;
    const promised = new DataTransfer();
    promised.items.add(new File(['x'], 'IMG_0001.HEIC', { type: 'image/heic' }));
    dropOn(scrollerB, promised);
    await wait(80);
    assert(toasts.some(text => text.includes('照片')), 'unreadable files dropped silently: ' + toasts.join(' / '));
    assert(window.__staleDrag.imports.length === 0 && urls.length === 2, 'unreadable files imported something');

    // 4. A browser-only (blob:) picture says it cannot be added.
    toasts.length = 0;
    dropOn(scrollerB, browserDrag({ 'text/html': '<img src="blob:https://site.test/1">' }));
    await wait(80);
    assert(toasts.some(text => text.includes('临时地址')), 'blob picture dropped silently: ' + toasts.join(' / '));
    assert(urls.length === 2, 'blob picture was imported');

    // 5. A drag that starts in this page carries our own media address.
    toasts.length = 0;
    const own = document.createElement('img');
    own.src = 'https://host.test/media/thumb/a-0';
    document.body.append(own);
    const data = browserDrag({ 'text/uri-list': own.src, 'text/html': own.outerHTML });
    own.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
    const ownAccepted = dropOn(scrollerB, data);
    own.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    own.remove();
    await wait(80);
    assert(!ownAccepted, 'content area offered to take an in-page drag');
    assert(urls.length === 2 && !toasts.length, 'in-page drag imported or toasted: ' + toasts.join(' / '));
  })()`);
  console.log('WEB_URL_DROP_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
