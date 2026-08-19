'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { exportFiles, isInside, uniqueDestination } = require('../lib/export-service');

test('rejects export destinations inside the Eagle library', async () => {
  assert.equal(isInside('/library/Eagle.library', '/library/Eagle.library/out'), true);
  await assert.rejects(() => exportFiles({
    filePaths: ['/tmp/a.png'],
    destinationRoot: '/library/Eagle.library/out',
    libraryPath: '/library/Eagle.library',
    fs: { mkdir: async () => {}, access: async () => {}, copyFile: async () => {}, existsSync: () => false }
  }), /资料库内部/);
});

test('exports files with collision-safe names and reports missing files', async () => {
  const copied = [];
  const existing = new Set([path.join('/tmp/out', 'a.png')]);
  const fs = {
    mkdir: async () => {},
    access: async file => { if (file === '/tmp/missing.png') throw new Error('missing'); },
    existsSync: file => existing.has(file),
    copyFile: async (source, destination) => { existing.add(destination); copied.push([source, destination]); }
  };
  const result = await exportFiles({
    filePaths: ['/tmp/a.png', '/tmp/a.png', '/tmp/missing.png'],
    destinationRoot: '/tmp/out',
    fs
  });
  assert.equal(result.count, 1);
  assert.equal(result.missing, 1);
  assert.deepEqual(copied, [['/tmp/a.png', '/tmp/out/a (2).png']]);
  assert.equal(uniqueDestination('/tmp/out', 'a.png', file => file.endsWith('a.png') || file.endsWith('a (2).png')), '/tmp/out/a (3).png');
});
