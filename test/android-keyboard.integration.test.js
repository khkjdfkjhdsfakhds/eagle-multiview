'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('Android uses Ctrl for ⌘-only shortcuts and wide touch tablets keep multi-pane; macOS keeps ⌘', { timeout: 45000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/android-keyboard-probe.cjs')], { env, timeout: 40000 });
  const line = stdout.split('\n').find(row => row.startsWith('EAGLEMV_ANDROID_KEYBOARD '));
  assert.ok(line, stdout);
  const { android, phone, apple } = JSON.parse(line.slice('EAGLEMV_ANDROID_KEYBOARD '.length));

  // Xiaomi Pad landscape: touch, desktop layout, the layout switch is shown.
  assert.deepEqual([android.apple, android.coarse, android.compact, android.layoutButton], [false, true, false, true]);
  assert.deepEqual(android.layouts, ['vertical2', 'vertical3', 'vertical4', 'single']);
  assert.equal(android.metaIgnored, 'single', 'Meta+digit is not the primary key on Android');
  assert.deepEqual(android.panels, { sidebar: [true, false], inspector: [true, false] });
  assert.equal(android.history, 'target-folder', 'Ctrl+[ goes back and Ctrl+] forward');
  assert.ok(android.menuShortcuts.includes('Ctrl+A') && android.menuShortcuts.every(text => !/[⌘⌥⇧⌃]/.test(text)), android.menuShortcuts.join());
  assert.deepEqual(android.hints, { sidebar: '显示/隐藏文件夹栏（Ctrl+Shift+L）', search: 'Ctrl+F', back: '返回（Alt+← / Ctrl+←）', layout2: '左右两栏（Ctrl+2）' });

  // Back closes native dialogs and sort popovers without touching history.
  assert.deepEqual(android.back.dialog, ['handled', 'dialog', false]);
  assert.deepEqual(android.back.busy, ['blocked', 'dialog-busy']);
  assert.deepEqual(android.back.sort, [true, 'handled', 'sort-popover', false]);
  assert.equal(android.back.historyUnchanged, true);
  assert.deepEqual(android.esc, { selected: [true, 0], idlePrevented: false });
  assert.deepEqual(android.tabletBack, ['handled', 'selection', 0], 'wide tablets clear a selection before back can exit');
  assert.deepEqual(android.folderBack, ['handled', 'selection', null], 'a selected folder card counts as a selection');
  assert.deepEqual(android.fieldEsc, { prevented: true, left: true, nextPrevented: false }, 'Esc in a field leaves it instead of becoming Back');

  // Phone width: back leaves the selection strip first, a preview closes
  // before its selection, and only then does history move.
  assert.deepEqual([phone.compact, phone.strip], [true, true]);
  assert.deepEqual(phone.first, ['handled', 'selection']);
  assert.deepEqual(phone.afterFirst, { selected: 0, strip: false, history: true });
  assert.deepEqual(phone.preview, ['preview', true]);
  assert.deepEqual(phone.second, ['handled', 'selection']);
  assert.equal(phone.third, 'history');

  // macOS is unchanged: Ctrl does not stand in for ⌘ and hints keep glyphs.
  assert.equal(apple.apple, true);
  assert.deepEqual(apple.ctrlIgnored, { layout: 'single', sidebar: true, view: 'folder' });
  assert.deepEqual(apple.metaWorks, { layout: 'vertical2', view: 'root' });
  assert.deepEqual(apple.menuShortcuts.slice(0, 2), ['⌘ A', '⌥ N']);
  assert.equal(apple.sidebarHint, '显示/隐藏文件夹栏（⌘⇧L）');
  assert.deepEqual(apple.fieldEsc, { prevented: false, stays: true }, 'macOS field Escape is unchanged');
});
