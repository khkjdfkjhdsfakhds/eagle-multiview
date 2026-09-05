'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-thumbnail-ui-'));
app.setPath('userData', profile);
app.on('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadURL('data:text/html;charset=utf-8,<html><body><button id="previous">previous focus</button></body></html>');
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '../src/thumbnail-ui.js'), 'utf8') + '\n;void 0;');
  await win.webContents.executeJavaScript(`(async () => {
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const calls = [], notices = [];
    const selected = ['A', 'B'];
    const ui = window.createThumbnailUI({ api: { thumbnailOperation: async payload => { calls.push(payload); return {}; } },
      context: () => ({ ids: selected, libraryPath: '/synthetic/library', paneId: 'pane-A' }),
      refresh: async () => {}, notify: text => notices.push(text), canStart: () => true });
    let settled = false;
    const pending = ui.run('refresh').then(result => { settled = true; return result; });
    await Promise.resolve();
    assert(!settled, 'run promise resolves before a user decision');
    const dialog = document.querySelector('.feature-dialog[open]');
    assert(dialog, 'missing modal confirmation');
    dialog.querySelector('[data-thumbnail-cancel]').click();
    const result = await pending;
    assert(result.canceled === true, 'cancellation not returned');
    assert(calls.length === 0, 'cancel issued a mutation');
    assert(selected.join(',') === 'A,B', 'selection was modified');
    assert(!document.querySelector('.feature-dialog[open]'), 'modal left open');
  })()`);
  console.log('THUMBNAIL_UI_CANCEL_OK');
  await win.webContents.executeJavaScript(`(async () => {
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const calls = [], notices = [], refreshes = [];
    const ctx = { ids: ['A', 'A', 'B'], libraryPath: '/synthetic/first', paneId: 'pane-A' };
    let complete;
    const outcome = { outcomes: [{id:'A',status:'completed'},{id:'B',status:'unknown'}], counts: {completed:1,accepted:0,unknown:1,failed:0,canceled:0} };
    const ui = window.createThumbnailUI({ api: { thumbnailOperation: payload => { calls.push(payload); return new Promise(resolve => { complete = resolve; }); } },
      context: () => ctx, refresh: async value => refreshes.push(value), notify: text => notices.push(text), canStart: () => true });
    let settled = false;
    const pending = ui.run('clipboard').then(result => { settled = true; return result; });
    ctx.ids = ['CHANGED'];
    const dialog = document.querySelector('.feature-dialog[open]');
    const submit = dialog.querySelector('[data-thumbnail-submit]');
    assert(submit, 'missing submit'); submit.click(); submit.click();
    assert(calls.length === 1, 'duplicate submission');
    assert(calls[0].ids.join(',') === 'A,B' && calls[0].libraryPath === '/synthetic/first', 'selection or library not frozen');
    assert(dialog.querySelector('[role=status]').textContent.includes('正在'), 'missing progress');
    await Promise.resolve(); assert(!settled, 'promise resolved before API result');
    complete(outcome); const result = await pending;
    assert(result === outcome, 'real API result not returned');
    assert(notices.some(x => x.includes('已完成 1') && x.includes('结果未确认 1')), 'partial result mislabeled');
    assert(refreshes.length === 1, 'completed mutation not refreshed');
    assert(ctx.ids.join(',') === 'CHANGED', 'operation replaced current selection');
    document.querySelector('[data-thumbnail-cancel]')?.click();
  })()`);
  console.log('THUMBNAIL_UI_OUTCOMES_OK');
  await win.webContents.executeJavaScript(`(async () => {
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const calls = [], notices = [], refreshes = [];
    const ctx = { ids:['A'],libraryPath:'/synthetic/first' };
    let complete;
    const ui = window.createThumbnailUI({ api:{thumbnailOperation: payload => { calls.push(payload); return new Promise(resolve => {complete = resolve;}); }},
      context:()=>ctx,refresh:async()=>refreshes.push(true),notify:text=>notices.push(text),canStart:()=>true });
    const before = ui.run('refresh'); ctx.libraryPath='/synthetic/second';
    document.querySelector('[data-thumbnail-submit]').click();
    assert(calls.length===0,'library changed before submit but request was sent');
    document.querySelector('[data-thumbnail-cancel]').click(); await before;
    const during = ui.run('file'); document.querySelector('[data-thumbnail-submit]').click();
    ctx.libraryPath='/synthetic/third'; complete({outcomes:[{id:'A',status:'completed'}],counts:{completed:1}});
    await during;
    assert(refreshes.length===0,'old operation refreshed new library');
    assert(notices.some(x=>x.includes('先前资料库')),'changed-library result not labeled');
  })()`);
  console.log('THUMBNAIL_UI_LIBRARY_OK');
  await win.webContents.executeJavaScript(`(async () => {
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const notices = [], calls = [];
    const ui = window.createThumbnailUI({api:{thumbnailOperation: async payload=>{calls.push(payload);return {counts:{accepted:1},outcomes:[{id:'A',status:'accepted'}]};}},
      context:()=>({ids:['A'],libraryPath:'/synthetic/library'}),refresh:async()=>{throw Error('accepted refresh is not completed');},
      notify:text=>notices.push(text),canStart:()=>true});
    const clear = ui.run('clear');
    assert(!document.querySelector('.feature-dialog[open]'),'clear incorrectly opens mutable dialog');
    assert((await clear).unsupported===true,'missing capability result');
    assert(notices.some(x=>x.includes('取消自定义')&&x.includes('刷新')),'clear limitation not explained');
    const pending=ui.run('refresh'); document.querySelector('[data-thumbnail-submit]').click(); await pending;
    assert(calls.length===1&&calls[0].operation==='refresh','clear was disguised as refresh');
    assert(notices.some(x=>x.includes('已提交生成 1')&&x.includes('尚未确认完成')),'refresh falsely marked completed');
  })()`);
  console.log('THUMBNAIL_UI_CAPABILITY_OK');
  await win.webContents.executeJavaScript(`(async () => {
    const assert = (value, message) => { if (!value) throw new Error(message); };
    let shortcuts=0, attempts=0; const notices=[];
    const shortcut=()=>{shortcuts++;}; document.addEventListener('keydown',shortcut);
    const outcome={outcomes:[{id:'A',status:'completed'}],counts:{completed:1}};
    const ui=window.createThumbnailUI({api:{thumbnailOperation:async()=>{attempts++;return outcome;}},context:()=>({ids:['A'],libraryPath:'/synthetic/library'}),
      refresh:async()=>{throw Error('view unavailable');},notify:text=>notices.push(text),canStart:()=>true});
    const pending=ui.run('file'); const dialog=document.querySelector('.feature-dialog[open]');
    dialog.querySelector('[data-thumbnail-submit]').dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}));
    assert(shortcuts===0,'dialog shortcut leaked to grid');
    dialog.querySelector('[data-thumbnail-submit]').click();
    assert(await pending===outcome,'refresh failure discarded completed-write outcome');
    assert(notices.some(x=>x.includes('已完成 1')&&x.includes('视图刷新失败')),'refresh failure misreported as write failure');
    document.querySelector('[data-thumbnail-submit]')?.click();assert(attempts===1,'failed refresh replayed write');
    document.querySelector('[data-thumbnail-cancel]')?.click();
    document.removeEventListener('keydown',shortcut);
    const failing=window.createThumbnailUI({api:{thumbnailOperation:async()=>{attempts++;throw Error('network disconnected');}},
      context:()=>({ids:['A'],libraryPath:'/synthetic/library'}),refresh:async()=>{},notify:text=>notices.push(text),canStart:()=>true});
    const failed=failing.run('file');document.querySelector('[data-thumbnail-submit]').click();
    assert((await failed).unknown===true,'transport error lost uncertainty');
    document.querySelector('[data-thumbnail-submit]').click();assert(attempts===2,'network failure auto replayed');
    document.querySelector('[data-thumbnail-cancel]').click();
    const malformed=window.createThumbnailUI({api:{thumbnailOperation:async()=>({})},context:()=>({ids:['A'],libraryPath:'/synthetic/library'}),
      refresh:async()=>{},notify:()=>{},canStart:()=>true});
    const invalid=malformed.run('file');document.querySelector('[data-thumbnail-submit]').click();
    assert((await invalid).unknown===true,'malformed response displayed as a clean zero-success result');
    document.querySelector('[data-thumbnail-cancel]').click();
  })()`);
  console.log('THUMBNAIL_UI_FAILURE_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error); app.exit(1); });
