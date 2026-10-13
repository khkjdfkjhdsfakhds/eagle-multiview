'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { menuPosition, submenuPosition } = require('../src/context-menu-position');

const viewport = { width: 980, height: 640 };

test('P7-09: the menu is pushed back inside the window', () => {
  assert.deepEqual(menuPosition({ x: 960, y: 600 }, { width: 294, height: 624 }, viewport), { left: 678, top: 8 });
  assert.deepEqual(menuPosition({ x: 100, y: 100 }, { width: 294, height: 300 }, viewport), { left: 100, top: 100 });
});

test('P7-10: submenus open leftward when the right side is short and stay above the bottom edge', () => {
  const nearRight = submenuPosition({ left: 678, right: 972, top: 520 }, { width: 270, height: 240 }, viewport);
  assert.equal(nearRight.openLeft, true);
  assert.equal(nearRight.left, 678 + 2 - 270);
  assert.equal(nearRight.top, 640 - 240 - 8);
  const roomy = submenuPosition({ left: 100, right: 394, top: 120 }, { width: 270, height: 200 }, viewport);
  assert.deepEqual(roomy, { left: 392, top: 114, openLeft: false });
  const tall = submenuPosition({ left: 100, right: 394, top: 300 }, { width: 270, height: 900 }, viewport);
  assert.equal(tall.top, 8, 'a submenu taller than the window starts at the top margin');
});

test('P7-09/P7-10: at 980×640 every menu row and submenu stays inside the window', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/context-menu-fit-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_MENU_FIT '));
  assert.ok(line, `missing menu fit result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_MENU_FIT '.length));
  assert.ok(result.submenus.length > 0, 'the item menu has submenus');
  assert.deepEqual(result.problems, []);
});
