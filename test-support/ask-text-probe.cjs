'use strict';
// BUG-02: comment and tag-colour entries must ask through the in-app dialog,
// because Electron's window.prompt() never shows anything.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-ask-text-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'ask-text-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (predicate, label) => { for (let i = 0; i < 150; i += 1) { if (predicate()) return; await wait(20); } throw new Error('timeout: ' + label); };
    await until(() => document.querySelectorAll('.content-pane .item-card').length === 6, 'items');
    document.querySelector('.content-pane .item-card[data-id="item-1"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const dialog = document.querySelector('#folderDialog');
    const input = document.querySelector('#folderNameInput');
    const answer = async value => {
      await until(() => !dialog.classList.contains('hidden'), 'dialog shown');
      const asked = { title: document.querySelector('#folderDialogTitle').textContent, initial: input.value };
      input.value = value;
      document.querySelector('#folderDialogForm').requestSubmit();
      await wait(30);
      return asked;
    };
    window.state.contextMenu = { ids: ['item-1'] };
    const colour = executeContextAction('tag-color', { tag: 'alpha' });
    const colourAsked = await answer('#ff0000');
    await colour;
    const comment = addCommentToSelected();
    const commentAsked = await answer('好图');
    const rectAsked = await answer('');
    await comment;
    return { colourAsked, commentAsked, rectAsked, calls: window.__askText, hidden: dialog.classList.contains('hidden') };
  })()`);
  console.log(`EAGLEMV_ASK_TEXT ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
