'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const { itemFolderLocations } = require('../src/folder-navigation');

test('openItemLocationMenuMarkup generates "全部" and Eagle parent folders instead of Finder', () => {
  assert.ok(
    renderer.includes('function openItemLocationMenuMarkup('),
    'renderer must declare openItemLocationMenuMarkup helper'
  );
  assert.ok(
    renderer.includes("action: 'open-item-location'"),
    'open-item-location action must be dispatched'
  );
  // Ensure the old bug is gone: 打开文件所在的位置 should NOT have finder in its submenu
  assert.doesNotMatch(
    renderer,
    /label:\s*'打开文件所在的位置',\s*submenu:\s*contextMenuRow\(\{\s*label:\s*finderLabel,\s*action:\s*'finder'\s*\}\)/,
    '打开文件所在的位置 must not open Finder in its submenu'
  );
  // Ensure finder is a standalone row
  assert.match(
    renderer,
    /contextMenuRow\(\{\s*icon:\s*'finder',\s*label:\s*finderLabel,\s*shortcut:\s*'⌘ Enter',\s*action:\s*'finder'\s*\}\)/,
    'finder must be its own context menu item without a location submenu'
  );
});

test('openItemLocationMenuMarkup is only included when a single item is selected', () => {
  assert.match(
    renderer,
    /\.\.\.\(one\s*\?\s*\[openItemLocationMenuMarkup\(data\.ids\[0\],\s*data\.paneId\)\]\s*:\s*\[\]\)/,
    'openItemLocationMenuMarkup must only be rendered when exactly one item is selected'
  );
});

test('openItemLocation handles all view targets, clears search, and selects item', () => {
  assert.match(
    renderer,
    /if\s*\(\s*action\s*===\s*'open-item-location'\s*\)\s*return\s+openItemLocation\(payload\.id\s*\|\|\s*firstId,\s*payload\.folderId\s*\?\?\s*null,\s*\{\s*paneId:\s*data\.paneId\s*\}\);/,
    'executeContextAction must forward to openItemLocation'
  );
  assert.ok(
    renderer.includes('async function openItemLocation(id, folderId = null, { paneId = state.activePaneId } = {})'),
    'openItemLocation declaration must match expected signature'
  );
  const fnStart = renderer.indexOf('async function openItemLocation(');
  const fnEnd = renderer.indexOf('\nfunction contextFolderEntries(', fnStart);
  assert.ok(fnStart >= 0 && fnEnd > fnStart);
  const fnBody = renderer.slice(fnStart, fnEnd);
  assert.ok(fnBody.includes("targetView = { kind: 'all' }"), 'handles All view target');
  assert.ok(fnBody.includes("targetView = { kind: 'folder', id: folder.id, name: folder.name }"), 'handles Folder view target');
  assert.ok(fnBody.includes('if (folder.password)'), 'protects encrypted folders');
  assert.ok(fnBody.includes('createQuery()'), 'clears filters and search keyword upon navigation');
  assert.ok(fnBody.includes('card.scrollIntoView('), 'scrolls selected card into view');
  assert.ok(fnBody.includes('card.focus('), 'focuses selected card');
});

test('itemFolderLocations helper correctly resolves folders and password states', () => {
  const libraryFolders = [
    {
      id: 'root-1',
      name: 'Illustrations',
      children: [
        { id: 'sub-1', name: 'Characters', password: '', children: [] },
        { id: 'sub-2', name: 'Locked', password: '123', children: [] }
      ]
    },
    { id: 'root-2', name: 'Backgrounds', children: [] }
  ];

  // Item with no folders
  assert.deepEqual(itemFolderLocations({ id: 'item-1', folders: [] }, libraryFolders), []);
  assert.deepEqual(itemFolderLocations({ id: 'item-1' }, libraryFolders), []);

  // Item with single folder
  assert.deepEqual(itemFolderLocations({ id: 'item-2', folders: ['root-2'] }, libraryFolders), [
    { id: 'root-2', name: 'Backgrounds', password: false }
  ]);

  // Item with multiple folders including nested and encrypted
  assert.deepEqual(itemFolderLocations({ id: 'item-3', folders: ['sub-1', 'sub-2', 'missing'] }, libraryFolders), [
    { id: 'sub-1', name: 'Characters', password: false },
    { id: 'sub-2', name: 'Locked', password: true }
  ]);
});
