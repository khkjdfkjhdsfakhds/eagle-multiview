'use strict';
// Isolated Electron DOM test: inside the Android shell's Back request
// (window.EagleMVBack.request() through evaluateJavascript) the page never
// blocks on confirm(); the question comes right after the request returns.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-android-shell-back-');
app.setPath('userData', userData);
app.setPath('cache', path.join(userData, 'cache'));
app.on('window-all-closed', () => {});

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'android-shell-back-preload.cjs') } });
  await win.loadFile(path.join(root, 'src/index.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => { for (let n = 0; n < 250; n++) { if (predicate()) return; await wait(20); } throw new Error('condition timed out: ' + predicate); };
await until(() => state.library && state.panes.length && state.panes.every(p => !p.loading && p.items.length));
const asked = [];
let answer = false;
window.confirm = message => { asked.push(message); return answer; };
const toFolder = async () => {
  navigate({ kind: 'folder', id: 'target-folder' });
  await until(() => state.currentView.kind === 'folder' && !state.loading);
};
// An inspector edit that cannot be saved while Eagle is disconnected asks
// before leaving.
const dirty = () => { state.inspectorDirty = true; state.connected = false; };

await toFolder();
dirty();
const declined = window.EagleMVBack.request();
const askedDuringRequest = asked.length;
await until(() => asked.length === 1);
await wait(60);
const afterDecline = { view: state.currentView.kind, dirty: state.inspectorDirty };

answer = true;
const accepted = window.EagleMVBack.request();
const askedDuringSecond = asked.length - 1;
await until(() => state.currentView.kind === 'root');
const afterAccept = { asked: asked.length, dirty: state.inspectorDirty };

// Without a pending question the request answers synchronously as before.
state.connected = true;
await toFolder();
const plain = window.EagleMVBack.request();
await until(() => state.currentView.kind === 'root');
return {
  declined: [declined.status, declined.action, declined.reason, askedDuringRequest],
  afterDecline,
  accepted: [accepted.status, askedDuringSecond],
  afterAccept,
  plain: [plain.status, plain.action, asked.length]
};
})()`);
  process.stdout.write('EAGLEMV_ANDROID_SHELL_BACK ' + JSON.stringify(result) + '\n');
  win.destroy();
  fs.rmSync(userData, { recursive: true, force: true });
  app.quit();
}
main().catch(error => { console.error(error); app.exit(1); });
