'use strict';
// Isolated Electron DOM test of the web renderer under an Android platform
// (Ctrl as primary modifier, touch tablet width) and under macOS (⌘ kept).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-android-keyboard-'));
app.setPath('userData', userData);
app.setPath('cache', path.join(userData, 'cache'));
app.on('window-all-closed', () => {});

const helpers = `
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => { for (let n = 0; n < 250; n++) { if (predicate()) return; await wait(20); } throw new Error('condition timed out: ' + predicate); };
const key = (k, code, options = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true, ...options }));
const layout = () => document.querySelector('#paneLayout').dataset.layout;
const visible = node => Boolean(node) && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0;
await until(() => state.library && state.panes.length && state.panes.every(p => !p.loading && p.items.length));
`;

async function open(preload, width, height) {
  const win = new BrowserWindow({ show: false, useContentSize: true, width, height,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, preload) } });
  if (process.env.EAGLEMV_PROBE_DEBUG) win.webContents.on('console-message', event => process.stderr.write(`[page] ${event.message}\n`));
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await win.loadFile(path.join(root, 'src/index.html'));
  return win;
}
const run = (win, body) => win.webContents.executeJavaScript(`(async () => {${helpers}${body}})()`);

async function main() {
  await app.whenReady();
  // Xiaomi Pad 8 Pro landscape is about 1280×800 CSS px: desktop three columns.
  const tablet = await open('android-keyboard-preload.cjs', 1280, 800);
  const android = await run(tablet, `
const result = { apple: keyboardPlatform.apple, coarse: matchMedia('(pointer: coarse)').matches, compact: isCompactLayout(),
  layoutButton: visible(document.querySelector('#paneLayoutButton')) };
const layouts = [];
for (const [n, expected] of [[2, 'vertical2'], [3, 'vertical3'], [4, 'vertical4'], [1, 'single']]) {
  key(String(n), 'Digit' + n, { ctrlKey: true });
  await until(() => layout() === expected && state.panes.length === Number(n));
  layouts.push(layout());
}
result.layouts = layouts;
key('2', 'Digit2', { metaKey: true });
key('2', 'Digit2', { ctrlKey: true, metaKey: true });
await wait(60);
result.metaIgnored = layout();
const sidebar = state.sidebarVisible, inspector = state.inspectorVisible;
key('L', 'KeyL', { ctrlKey: true, shiftKey: true });
key('I', 'KeyI', { ctrlKey: true, shiftKey: true });
result.panels = { sidebar: [sidebar, state.sidebarVisible], inspector: [inspector, state.inspectorVisible] };
key('L', 'KeyL', { ctrlKey: true, shiftKey: true });
key('I', 'KeyI', { ctrlKey: true, shiftKey: true });
navigate({ kind: 'folder', id: 'target-folder' });
await until(() => state.currentView.kind === 'folder' && !state.loading);
key('[', 'BracketLeft', { ctrlKey: true });
await until(() => state.currentView.kind === 'root');
key(']', 'BracketRight', { ctrlKey: true });
await until(() => state.currentView.kind === 'folder');
result.history = state.currentView.id;
key('[', 'BracketLeft', { ctrlKey: true });
await until(() => state.currentView.kind === 'root');
showContextMenuAt(100, 140, { kind: 'workspace', ids: [], paneId: state.activePaneId });
result.menuShortcuts = [...document.querySelectorAll('#contextMenu .context-menu-shortcut')].map(node => node.textContent);
hideContextMenu();
result.hints = { sidebar: document.querySelector('#toggleSidebarButton').title, search: document.querySelector('.search-box kbd')?.textContent,
  back: document.querySelector('#backButton').title, layout2: document.querySelector('#paneLayoutPopover [data-layout="vertical2"]').title };

// Back closes native modal dialogs through their cancel path, and a dialog
// that refuses to close blocks back instead of navigating behind it.
const historyBefore = state.historyIndex;
const dialog = document.createElement('dialog');
dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); dialog.remove(); });
document.body.append(dialog); dialog.showModal();
const closed = window.EagleMVBack.request();
const busy = document.createElement('dialog');
busy.addEventListener('cancel', event => event.preventDefault());
document.body.append(busy); busy.showModal();
const blocked = window.EagleMVBack.request();
busy.close(); busy.remove();
document.querySelector('#sortSelectButton').click();
await wait(30);
const sortOpen = Boolean(document.querySelector('.sort-popover:not(.hidden)'));
const sort = window.EagleMVBack.request();
result.back = { dialog: [closed.status, closed.reason, dialog.isConnected], busy: [blocked.status, blocked.reason],
  sort: [sortOpen, sort.status, sort.reason, Boolean(document.querySelector('.sort-popover:not(.hidden)'))],
  historyUnchanged: state.historyIndex === historyBefore };
// Esc the page acts on must be consumed, or the Android shell would also run
// system Back; an idle Esc stays unconsumed so the shell can route it to Back.
selectItem('item-1', false, false);
const escSelectedPrevented = !key('Escape', 'Escape');
result.esc = { selected: [escSelectedPrevented, state.selected.size], idlePrevented: !key('Escape', 'Escape') };
// Esc in a text field leaves the field instead of falling through to the
// shell as Back (which could close the app); the next Esc is Back again.
// (First: on a wide tablet, back with a selection clears it instead of
// leaving the app.)
selectItem('item-1', false, false);
const tabletBack = window.EagleMVBack.request();
result.tabletBack = [tabletBack.status, tabletBack.reason, state.selected.size];
selectFolderCard('target-folder');
const folderBack = window.EagleMVBack.request();
result.folderBack = [folderBack.status, folderBack.reason, state.selectedFolderCard];
const search = document.querySelector('#searchInput');
search.focus();
const fieldPrevented = !search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
result.fieldEsc = { prevented: fieldPrevented, left: document.activeElement !== search, nextPrevented: !key('Escape', 'Escape') };
return result;`);
  // Narrow phone: the selection strip is a mode that back leaves first.
  tablet.setContentSize(390, 844);
  await new Promise(resolve => setTimeout(resolve, 150));
  const phone = await run(tablet, `
navigate({ kind: 'folder', id: 'target-folder' });
await until(() => state.currentView.kind === 'folder' && !state.loading);
navigate({ kind: 'root' });
await until(() => state.currentView.kind === 'root' && !state.loading && state.items.length);
const historyBefore = state.historyIndex;
selectItem('item-1', false, false);
const strip = !document.querySelector('#selectionBar').classList.contains('hidden');
const first = window.EagleMVBack.request();
const afterFirst = { selected: state.selected.size, strip: !document.querySelector('#selectionBar').classList.contains('hidden'), history: state.historyIndex === historyBefore };
openPreview('item-2'); selectItem('item-2', false, false);
await until(() => !document.querySelector('#previewModal').classList.contains('hidden'));
const preview = window.EagleMVBack.request();
const previewClosed = document.querySelector('#previewModal').classList.contains('hidden');
const second = window.EagleMVBack.request();
const third = window.EagleMVBack.request();
await until(() => state.currentView.kind === 'folder');
return { compact: isCompactLayout(), strip, first: [first.status, first.reason], afterFirst,
  preview: [preview.action, previewClosed], second: [second.status, second.reason], third: third.action };`);
  tablet.destroy();

  const mac = await open('web-platform-preload.cjs', 1280, 800);
  const apple = await run(mac, `
const result = { apple: keyboardPlatform.apple };
key('2', 'Digit2', { ctrlKey: true });
const sidebar = state.sidebarVisible;
key('L', 'KeyL', { ctrlKey: true, shiftKey: true });
navigate({ kind: 'root' });
await until(() => state.currentView.kind === 'root' && !state.loading);
navigate({ kind: 'folder', id: 'target-folder' });
await until(() => state.currentView.kind === 'folder' && !state.loading);
key('[', 'BracketLeft', { ctrlKey: true });
await wait(80);
result.ctrlIgnored = { layout: layout(), sidebar: state.sidebarVisible === sidebar, view: state.currentView.kind };
key('[', 'BracketLeft', { metaKey: true });
await until(() => state.currentView.kind === 'root');
key('2', 'Digit2', { metaKey: true });
await until(() => layout() === 'vertical2');
result.metaWorks = { layout: layout(), view: state.currentView.kind };
showContextMenuAt(100, 140, { kind: 'workspace', ids: [], paneId: state.activePaneId });
result.menuShortcuts = [...document.querySelectorAll('#contextMenu .context-menu-shortcut')].map(node => node.textContent);
hideContextMenu();
result.sidebarHint = document.querySelector('#toggleSidebarButton').title;
const search = document.querySelector('#searchInput');
search.focus();
const fieldPrevented = !search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
result.fieldEsc = { prevented: fieldPrevented, stays: document.activeElement === search };
return result;`);
  mac.destroy();
  process.stdout.write('EAGLEMV_ANDROID_KEYBOARD ' + JSON.stringify({ android, phone, apple }) + '\n');
  fs.rmSync(userData, { recursive: true, force: true });
  app.quit();
}
main().catch(error => { console.error(error); app.exit(1); });
