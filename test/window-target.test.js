'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { windowStateForView } = require('../src/window-target');

test('path-based new windows carry only the current view location', () => {
  assert.deepEqual(windowStateForView({
    kind: 'folder',
    id: 'folder-1',
    parentId: 'parent',
    query: { search: 'do not copy' },
    previewId: 'item-1'
  }), {
    view: { kind: 'folder', id: 'folder-1' }
  });

  assert.deepEqual(windowStateForView({ kind: 'smart', id: 'smart-1', name: 'References' }), {
    view: { kind: 'smart', id: 'smart-1', name: 'References' }
  });
  assert.deepEqual(windowStateForView({ kind: 'trash', id: 'ignored' }), {
    view: { kind: 'trash' }
  });
});
