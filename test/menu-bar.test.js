'use strict';

// The application menu runs main.js's real setupMenu() in a VM with a fake
// Electron, so the structure, the shortcuts and the Eagle-style "ignore a
// shortcut typed into a field" wrapper are checked as built, not as text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');

function buildMenu({ focus = { editable: false, nativeCopy: false, nativeSelectAll: false } } = {}) {
  const start = main.indexOf('const MENU_FOCUS_PROBE');
  const end = main.indexOf('let updater = null;', start);
  assert.ok(start > 0 && end > start, 'menu block not found');
  const sent = [];
  const edits = [];
  const opened = [];
  let built = null;
  const contents = {
    send: (channel, payload) => sent.push({ channel, payload }),
    copy: () => edits.push('copy'),
    selectAll: () => edits.push('selectAll'),
    executeJavaScript: async () => (typeof focus === 'function' ? focus() : focus)
  };
  const window = { webContents: contents, isDestroyed: () => false, isFocused: () => true };
  const items = new Map();
  const context = {
    Menu: {
      buildFromTemplate: template => {
        built = template;
        const visit = list => list.forEach(item => {
          if (item.id) items.set(item.id, item);
          if (Array.isArray(item.submenu)) visit(item.submenu);
        });
        visit(template);
        return { template };
      },
      setApplicationMenu: () => {},
      getApplicationMenu: () => ({ getMenuItemById: id => items.get(id) || null })
    },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => window },
    onRPC: () => {},
    app: { on: () => {} },
    identity: { name: 'Eagle MultiView', profile: null },
    checkForUpdates: () => {},
    windowRouter: { openDefault: async () => opened.push('window') },
    logFault: () => {},
    shell: { openExternal: url => opened.push(url), openPath: () => {} },
    fsp: { mkdir: async () => {} },
    errorLogDir: () => '/tmp',
    isTrustedSender: () => true
  };
  vm.createContext(context);
  vm.runInContext(`${main.slice(start, end)}\nsetupMenu();`, context);
  return { template: built, window, sent, edits, opened, items };
}

function flatten(list, trail = []) {
  return list.flatMap(item => {
    const pathLabel = [...trail, item.label || item.role || item.type];
    return [{ ...item, path: pathLabel.join(' › ') }, ...(Array.isArray(item.submenu) ? flatten(item.submenu, pathLabel) : [])];
  });
}

const find = (template, pathLabel) => flatten(template).find(item => item.path === pathLabel);
// Values built inside the VM carry its own Array/Object prototypes.
const plain = value => JSON.parse(JSON.stringify(value));

test('menu bar follows Eagle\'s top-level menus (插件 left out) and every role item is labelled in Chinese', () => {
  const { template } = buildMenu();
  assert.deepEqual(plain(template.map(menu => menu.label)), ['Eagle MultiView', '资源库', '文件', '编辑', '查找', '整理', '显示', '窗口', '帮助']);
  const windowMenu = template.find(menu => menu.label === '窗口');
  assert.equal(windowMenu.role, 'window');
  assert.deepEqual(plain(windowMenu.submenu.map(item => item.label)), ['切换全屏', '最小化', '关闭窗口']);
  assert.equal(template.at(-1).role, 'help');
  for (const item of flatten(template)) {
    if (item.role && item.type !== 'separator') assert.match(item.label || '', /[一-龥]/, `${item.path} has no Chinese label`);
  }
});

test('MultiView keeps its own shortcuts where Eagle differs; free Eagle keys are added; none is used twice', () => {
  const { template } = buildMenu();
  const accelerators = flatten(template).filter(item => item.accelerator).map(item => [item.accelerator, item.path]);
  const seen = new Map();
  for (const [key, where] of accelerators) {
    assert.ok(!seen.has(key), `${key} is used by both ${seen.get(key)} and ${where}`);
    seen.set(key, where);
  }
  const key = pathLabel => find(template, pathLabel)?.accelerator;
  // Kept (user decision, handoff §25): pane layouts, reload, import, ⌥N.
  assert.equal(key('显示 › 分栏布局 › 单栏'), 'CmdOrCtrl+1');
  assert.equal(key('显示 › 分栏布局 › 四栏'), 'CmdOrCtrl+4');
  assert.equal(key('资源库 › 重新载入窗口'), 'CmdOrCtrl+Shift+R');
  assert.equal(key('文件 › 导入文件…'), 'CmdOrCtrl+Shift+O');
  assert.equal(key('文件 › 新建文件夹'), 'Alt+N');
  assert.equal(key('显示 › 左栏'), 'CmdOrCtrl+Shift+L');
  assert.equal(key('显示 › 全部'), undefined, '⌘1 stays with the pane layout');
  // Eagle's keys that MultiView did not use.
  assert.equal(key('文件 › 新建…'), 'CmdOrCtrl+N');
  assert.equal(key('整理 › 添加标签'), 'CmdOrCtrl+T');
  assert.equal(key('资源库 › 切换资源库'), 'CmdOrCtrl+L');
  assert.equal(key('查找 › 筛选器 › 打开筛选器'), 'CmdOrCtrl+Shift+F');
  assert.equal(key('显示 › 显示子文件夹内容'), 'CmdOrCtrl+Alt+7');
  // Keys typed without ⌘ would also reach the menu from a text field, so the
  // menu shows none that MultiView does not already own there.
  for (const [accelerator, where] of accelerators) {
    if (!/CmdOrCtrl/.test(accelerator)) assert.ok(['Alt+N', 'Alt+Shift+N'].includes(accelerator), `${where} adds a bare shortcut ${accelerator}`);
  }
  assert.doesNotMatch(main, /role: 'copy'|role: 'selectAll'/);
});

test('every menu command the template sends has a renderer case', () => {
  const block = main.slice(main.indexOf('function setupMenu()'), main.indexOf('let updater = null;'));
  const commands = new Set([...block.matchAll(/send\('([a-z-]+)'/g)].map(match => match[1]));
  commands.add('copy-items').add('select-all').add('view-mode').add('pane-layout');
  const runner = renderer.slice(renderer.indexOf('function runMenuCommand('), renderer.indexOf('\n// Eagle\'s ⌘T opens'));
  for (const command of commands) assert.ok(runner.includes(`case '${command}':`), `runMenuCommand misses ${command}`);
  assert.match(renderer, /onMenuCommand\?\.\(whenWorkspaceFree\(payload => runMenuCommand\(payload\)\)\)/);
});

test('the pane-layout submenu lists the renderer\'s layouts in order', () => {
  const { template } = buildMenu();
  const labels = find(template, '显示 › 分栏布局').submenu.map(item => item.label);
  const block = renderer.slice(renderer.indexOf('const paneLayoutLabels = Object.freeze({'), renderer.indexOf('});', renderer.indexOf('const paneLayoutLabels')));
  assert.deepEqual(plain(labels), [...block.matchAll(/: '([^']+)'/g)].map(match => match[1]));
});

test('a shortcut typed into a field does nothing; a click on the item still runs', async () => {
  let editable = true;
  const menu = buildMenu({ focus: () => ({ editable, nativeCopy: editable, nativeSelectAll: editable }) });
  const tag = find(menu.template, '整理 › 添加标签');
  await tag.click(tag, menu.window, { triggeredByAccelerator: true });
  assert.equal(menu.sent.length, 0);
  await tag.click(tag, menu.window, { triggeredByAccelerator: false });
  assert.deepEqual(plain(menu.sent.at(-1)), { channel: 'command:menu', payload: { command: 'add-tag' } });
  editable = false;
  await tag.click(tag, menu.window, { triggeredByAccelerator: true });
  assert.equal(menu.sent.length, 2);
  // Undo stays edit-aware: the renderer undoes typing in a field itself.
  editable = true;
  const undo = find(menu.template, '编辑 › 撤销');
  await undo.click(undo, menu.window, { triggeredByAccelerator: true });
  assert.equal(menu.sent.at(-1).channel, 'command:undo-delete');
});

test('复制 and 全选 edit text in a field and act on items elsewhere, by key or by click (P3-02)', async () => {
  let focus = { editable: true, nativeCopy: true, nativeSelectAll: true };
  const menu = buildMenu({ focus: () => focus });
  const copy = find(menu.template, '编辑 › 复制');
  const selectAll = find(menu.template, '编辑 › 全选');
  await copy.click(copy, menu.window, { triggeredByAccelerator: true });
  await selectAll.click(selectAll, menu.window, {});
  assert.deepEqual(menu.edits, ['copy', 'selectAll']);
  assert.equal(menu.sent.length, 0);
  focus = { editable: false, nativeCopy: false, nativeSelectAll: false };
  await copy.click(copy, menu.window, {});
  await selectAll.click(selectAll, menu.window, { triggeredByAccelerator: true });
  assert.deepEqual(plain(menu.sent.map(entry => entry.payload.command)), ['copy-items', 'select-all']);
  // Selected text outside a field still copies as text.
  focus = { editable: false, nativeCopy: true, nativeSelectAll: false };
  await copy.click(copy, menu.window, {});
  assert.deepEqual(menu.edits, ['copy', 'selectAll', 'copy']);
});

test('layout ticks follow the reported state of the focused window', () => {
  const start = main.indexOf('function applyMenuState');
  assert.ok(start > 0);
  const menu = buildMenu();
  assert.ok(menu.items.get('view-mode-list') && menu.items.get('pane-layout-vertical3'));
  assert.equal(find(menu.template, '显示 › 列表').type, 'radio');
  assert.match(renderer, /reportMenuState\(\);\n {2}for \(const button of \$\('#sortPopover'\)/);
  assert.match(renderer, /layoutRoot\.dataset\.layout = layout;\n {2}reportMenuState\(\);/);
});
