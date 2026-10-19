'use strict';
// F-03: folder copy is a MultiView-only feature that cannot be undone through
// the API. The context menu offers it with a destination picker, and an
// Option drop on a row's insertion line copies next to that sibling; both ask
// first.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const profile = require('./temp-userdata.cjs').tempUserData('eaglemv-folder-copy-confirm-');
app.setPath('userData', profile);

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: {
    contextIsolation: false, nodeIntegration: false, sandbox: false, preload: path.join(__dirname, 'feature-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const until = async fn => { for (let i = 0; i < 150; i++) { if (fn()) return; await wait(20); } throw Error('UI timeout'); };
    await until(() => document.querySelector('[data-folder-id="mv-folder"]'));
    const copies = () => window.__uiTestCalls.filter(call => call.kind === 'copy-folder');
    const out = {};
    // Context menu entry with a destination picker.
    document.querySelector('[data-folder-id="mv-folder"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 200 }));
    const entry = document.querySelector('[data-context-action="copy-folder-node"]');
    out.menuEntry = entry?.textContent.trim() || null;
    entry.click();
    await until(() => document.querySelector('.feature-dialog[open] select'));
    const dialog = document.querySelector('.feature-dialog[open]');
    const select = dialog.querySelector('select');
    const options = [...select.options].map(option => option.value);
    out.excludesSubtree = !options.includes('mv-folder') && !options.includes('child-folder');
    out.defaultTarget = select.value;
    select.value = 'eagle-folder';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => dialog.querySelector('[data-feature-submit]').disabled === false);
    out.summary = dialog.querySelector('[data-copy-summary]').textContent;
    out.copiedBeforeConfirm = copies().length;
    dialog.querySelector('[data-feature-submit]').click();
    await until(() => copies().length === 1);
    out.menuPayload = copies()[0].payload;
    await until(() => !document.querySelector('.feature-dialog[open]'));
    // The finished copy refreshes the panes before new drags are accepted.
    await until(() => document.querySelector('#toast')?.textContent.includes('已复制'));
    // Option drop on the top edge of a sidebar row copies before that sibling.
    const sourceRow = document.querySelector('#folderTree .folder-row[data-folder-node-id="mv-folder"]');
    const anchorRow = document.querySelector('#folderTree .folder-row[data-folder-node-id="eagle-folder"]');
    const data = new DataTransfer();
    sourceRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
    data.setData('application/x-eagle-multiview-folder-node', JSON.stringify({ id: 'mv-folder', baseParentId: null, libraryPath: '/tmp/EagleMV-UI-Test.library' }));
    const rect = anchorRow.getBoundingClientRect();
    const option = type => { const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientX: rect.left + 20, clientY: rect.top + 1 }); Object.defineProperty(event, 'altKey', { value: true }); return event; };
    anchorRow.dispatchEvent(option('dragover'));
    out.edgeFeedback = anchorRow.dataset.manualDrop || null;
    anchorRow.dispatchEvent(option('drop'));
    await until(() => document.querySelector('.feature-dialog[open] [data-feature-submit]')?.disabled === false);
    out.edgeText = document.querySelector('.feature-dialog[open]').textContent;
    document.querySelector('.feature-dialog[open] [data-feature-submit]').click();
    await until(() => copies().length === 2);
    out.edgePayload = copies()[1].payload;
    return out;
  })()`);
  console.log(`EAGLEMV_FOLDER_COPY_CONFIRM ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => {
  for (const open of BrowserWindow.getAllWindows()) open.destroy();
  app.quit();
});
