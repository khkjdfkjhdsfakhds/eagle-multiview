'use strict';

// Eagle-parity batch 2: sidebar folders show Eagle's folder color as a dot
// on the icon and a lock badge for password folders; navigation into a
// locked folder is refused (the Eagle API cannot unlock them).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

test('folder colors accept hex directly and map Eagle named presets', () => {
  const start = renderer.indexOf('function folderColorValue(folder)');
  assert.ok(start >= 0);
  const fn = renderer.slice(start, renderer.indexOf('\n}', start));
  assert.ok(fn.includes('/^#[0-9a-f]{3,8}$/i.test(raw)'));
  assert.ok(fn.includes('eagleNamedFolderColors[raw.toLowerCase()]'));
  for (const name of ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'pink', 'gray']) {
    assert.match(renderer, new RegExp(`${name}: '#[0-9a-f]{6}'`), `named color ${name} must exist`);
  }
});

test('tree rows and quick access rows render the dot and the lock badge', () => {
  const treeRow = renderer.indexOf("${eagleIcon('ic-filter-item-folder.svg')}${folderColorDot(folder)}");
  assert.ok(treeRow >= 0, 'folder icon must contain the color dot');
  assert.equal((renderer.match(/folderColorDot\(folder\)/g) || []).length >= 2, true, 'quick access must render the dot too');
  assert.equal((renderer.match(/folderLockBadge\(folder\)/g) || []).length >= 2, true);
  assert.match(styles, /\.folder-color-dot\s*\{/);
  assert.match(styles, /\.folder-lock\s*\{/);
});

test('locked folders cannot be entered and show the API limitation', () => {
  const start = renderer.indexOf('function navigate(view');
  assert.ok(start >= 0);
  const fn = renderer.slice(start, start + 900);
  const guard = fn.indexOf('target?.password');
  const discard = fn.indexOf('confirmDiscardChanges');
  assert.ok(guard >= 0);
  assert.ok(discard === -1 || guard < discard, 'lock guard must run before discarding drafts');
  assert.ok(fn.includes('该文件夹已加密，MultiView 无法解锁（Eagle API 限制）'));
  const returnIndex = fn.indexOf('return false;', guard);
  assert.ok(returnIndex > guard && returnIndex < fn.indexOf('recordViewNavigation'), 'must bail out before touching history');
});
