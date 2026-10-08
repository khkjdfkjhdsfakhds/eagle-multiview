'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-create-scroll-')));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: {
    contextIsolation: false, nodeIntegration: false, sandbox: false, preload: path.join(__dirname, 'feature-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async fn => { for (let i=0;i<200;i++) { if(fn()) return; await wait(20); } throw Error('creation timeout'); };
    const assert = (value, message) => { if (!value) throw Error(message); };
    await until(() => document.querySelector('.folder-card'));
    window.eagleMV.createFolder = async ({name, parent}) => {
      const folders = parent ? window.__featureState.folders.find(f => f.id === parent).children : window.__featureState.folders;
      const folder = {id: 'created-' + (parent || 'root'), name, children: []};
      folders.push(folder);
      window.__featureEmit(window.__featureState.libraryPath);
      await until(() => document.querySelector('.folder-card[data-open-folder="' + folder.id + '"]'));
      folders.pop(); folders.unshift(folder);
      window.__featureEmit(window.__featureState.libraryPath);
      return {id: folder.id, name};
    };
    for (const parent of [null, 'mv-folder']) {
      if (parent) {
        window.__featureState.folders.find(f => f.id === parent).children = Array.from({length: 150}, (_, i) => ({id:'child-'+i,name:'子目录 '+i,children:[]}));
        window.__featureEmit(window.__featureState.libraryPath);
        await wait(500);
        document.querySelector('.folder-card[data-open-folder="mv-folder"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
        await until(() => document.querySelector('.folder-card[data-open-folder="child-149"]'));
      }
      const scroller = paneQuery(state.activePaneId, '#gridScroller');
      scroller.scrollTop = 0;
      const creating = createFolder(parent, Boolean(parent));
      await until(() => !document.querySelector('#folderDialog').classList.contains('hidden'));
      document.querySelector('#folderDialogCreateButton').click();
      await creating;
      await wait(700);
      const card = paneQuery(state.activePaneId, '.folder-card');
      assert(card.dataset.openFolder === 'created-' + (parent || 'root'), 'new folder is not first');
      assert(scroller.scrollTop < 50, 'new folder is first but viewport jumped to bottom: ' + scroller.scrollTop);
      assert(card.classList.contains('selected'), 'new folder selection lost');
    }
  })()`);
  if (process.env.EAGLEMV_TEST_SCREENSHOT) fs.writeFileSync(process.env.EAGLEMV_TEST_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  console.log('FOLDER_CREATE_SCROLL_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error); app.exit(1); });
