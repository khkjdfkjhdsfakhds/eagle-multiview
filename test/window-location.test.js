'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveEagleWindowState } = require('../lib/window-location');

test('Eagle current folder becomes a folder-only initial window state', async () => {
  const client = {
    selectedFolder: async () => ({ id: 'child', name: 'Child' }),
    folderTree: async () => [{ id: 'parent', children: [{ id: 'child', children: [] }] }]
  };

  assert.deepEqual(await resolveEagleWindowState(client), {
    view: { kind: 'folder', id: 'child' }
  });
});

test('unavailable Eagle locations fall back to the library root', async () => {
  const cases = [
    {
      selectedFolder: async () => null,
      folderTree: async () => { throw new Error('should not read the tree without a selection'); }
    },
    {
      selectedFolder: async () => ({ id: 'deleted' }),
      folderTree: async () => [{ id: 'other', children: [] }]
    },
    {
      selectedFolder: async () => { throw new Error('Eagle unavailable'); },
      folderTree: async () => []
    }
  ];

  for (const client of cases) {
    assert.deepEqual(await resolveEagleWindowState(client), { view: { kind: 'root' } });
  }
});
