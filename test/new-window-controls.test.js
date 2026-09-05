'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const shim = fs.readFileSync(path.join(root, 'src/web-shim.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');

test('new-window toolbar controls are removed while the window bridge remains available', () => {
  assert.doesNotMatch(html, /id="newWindow(?:Menu)?Button"/);
  assert.doesNotMatch(renderer, /\$\('#newWindow(?:Menu)?Button'\)\.addEventListener/);
  assert.match(html, /<script src="window-target\.js"><\/script>[\s\S]*<script src="window-actions\.js"><\/script>[\s\S]*<script src="renderer\.js"><\/script>/);
});

test('new-window location menu exposes the three specified targets', () => {
  for (const label of ['新建在根目录', '新建在当前 Eagle 路径', '新建在当前 MultiView 路径（默认）']) {
    assert.ok(renderer.includes(`label: '${label}'`), label);
  }
  assert.ok(renderer.includes("if (data.kind === 'new-window-menu')"));
  assert.ok(renderer.includes("openNewWindowAt('root')"));
  assert.ok(renderer.includes("openNewWindowAt('eagle')"));
  assert.ok(renderer.includes("openNewWindowAt('multiview')"));
  assert.ok(renderer.includes("menu.setAttribute('aria-label', contextMenuAriaLabel(data.kind))"));
  assert.ok(renderer.includes("if (!$('#contextMenu').classList.contains('hidden')) { event.preventDefault(); hideContextMenu(); return; }"), 'Escape closes the location menu');
  assert.ok(renderer.includes("!event.target.closest('.new-window-control')"), 'outside clicks dismiss the location menu');
});

test('desktop and web bridges expose current Eagle location and default-window requests', () => {
  assert.ok(preload.includes("currentEagleWindowState: () => ipcRenderer.invoke('window:eagle-state')"));
  assert.ok(preload.includes("onNewWindowRequest: callback => on('command:new-window', callback)"));
  assert.ok(shim.includes("currentEagleWindowState: () => invoke('window:eagle-state')"));
  assert.ok(shim.includes("onNewWindowRequest: callback => on('command:new-window', callback)"));
  assert.ok(main.includes("handleRPC('window:eagle-state'"));
  assert.ok(preload.includes('prepareNewWindow: () => null'));
  assert.ok(shim.includes("prepareNewWindow: () => window.open('about:blank', '_blank')"));
  assert.ok(shim.includes('newWindow: async (data, preparedWindow) =>'));
});

test('refresh-all follows the current Eagle path button, which still navigates the active pane', () => {
  assert.match(html, /id="currentEaglePathButton"[\s\S]*?<\/button>\s*<button id="refreshAllPanesButton"/);
  assert.match(html, /id="currentEaglePathButton"[^>]+title="跳转到当前 Eagle 路径"[^>]+aria-label="跳转到当前 Eagle 路径"/);
  assert.ok(renderer.includes("$('#currentEaglePathButton').addEventListener('click', navigateToCurrentEaglePath);"));
  assert.ok(renderer.includes('async function navigateToCurrentEaglePath()'));
  assert.ok(renderer.includes('const paneId = state.activePaneId;'));
  assert.ok(renderer.includes('previousQuery = cloneQuery(pane.query);'));
  assert.ok(renderer.includes('const navigated = withActivePane(paneId, () => {'));
  assert.ok(renderer.includes('state.query = createQuery();'));
  assert.ok(renderer.includes('const result = navigate(initialState.view);'));
  assert.ok(styles.includes('.current-eagle-path-button'));
});

test('new toolbar button preserves the established unit wrapping and compact slider row', () => {
  assert.match(styles, /\.toolbar \.toolbar-cluster \{[\s\S]*?flex: 1 1 auto;[\s\S]*?display: flex;/);
  assert.match(styles, /\.toolbar\.wrapped \.toolbar-cluster \{ flex: 0 0 auto; \}/);
  assert.match(styles, /@media \(max-width: 1120px\) \{[\s\S]*?\.new-window-button > span:not\(\.new-button-chevron\) \{ display: none; \}/);
  assert.match(styles, /@media \(max-width: 600px\) \{[\s\S]*?\.toolbar \.new-window-control \{ display: none; \}/);
  assert.doesNotMatch(styles, /@media \(max-width: 600px\) \{[\s\S]*?\.current-eagle-path-button \{ display: none; \}/);
});
