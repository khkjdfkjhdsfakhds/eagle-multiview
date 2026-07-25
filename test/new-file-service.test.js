'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  NEW_FILE_TYPES,
  normalizeNewFileType,
  validateNewItemName,
  nextAvailableName,
  newFileContent,
  createTemporaryNewFile
} = require('../lib/new-file-service');

test('new-file types are limited to the confirmed text formats', () => {
  assert.deepEqual(Object.keys(NEW_FILE_TYPES), ['txt', 'md', 'json', 'html', 'svg']);
  assert.equal(normalizeNewFileType('.TXT'), 'txt');
  assert.throws(() => normalizeNewFileType('pdf'), /不支持/);
});

test('new item names reject unsafe paths and strip an already typed extension', () => {
  assert.equal(validateNewItemName('说明.txt', { extension: 'txt' }), '说明');
  assert.equal(validateNewItemName('说明.TXT', { extension: 'txt' }), '说明');
  for (const name of ['', '../secret', 'a/b', 'a\\b', 'name.']) {
    assert.throws(() => validateNewItemName(name, { extension: 'txt' }));
  }
  assert.equal(validateNewItemName(' 说明 '), '说明');
});

test('same-type duplicate names receive a stable numeric suffix', () => {
  const items = [
    { name: '说明', ext: 'txt' },
    { name: '说明 (1)', ext: 'txt' },
    { name: '说明', ext: 'md' }
  ];
  assert.equal(nextAvailableName('说明', items, 'txt'), '说明 (2)');
  assert.equal(nextAvailableName('说明', items, 'html'), '说明');
});

test('duplicate folder names receive the same stable suffix without an extension', () => {
  const folders = [
    { name: '未命名文件夹' },
    { name: '未命名文件夹 (1)' },
    { name: '其他文件夹' }
  ];
  assert.equal(nextAvailableName('未命名文件夹', folders), '未命名文件夹 (2)');
});

test('temporary new files stay under the supplied app directory and clean up idempotently', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-new-file-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const created = await createTemporaryNewFile({ root, name: '空白数据.json', type: 'json' });
  assert.equal(path.dirname(created.directory), path.resolve(root));
  assert.equal(path.basename(created.filePath), '空白数据.json');
  assert.equal(await fs.readFile(created.filePath, 'utf8'), '{}\n');
  await created.cleanup();
  await created.cleanup();
  await assert.rejects(fs.access(created.directory));
});

test('Markdown uses a visually blank unique payload required by reliable Eagle import', () => {
  const payload = newFileContent('md', () => Buffer.from([0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55]));
  assert.equal(payload.at(0), '\uFEFF');
  assert.match(payload.slice(1, -1), /^[ \t]{64}$/);
  assert.equal(payload.at(-1), '\n');
  assert.equal(payload.trim(), '');
  assert.equal(Buffer.byteLength(payload), 68);
  assert.notEqual(payload, newFileContent('md', () => Buffer.alloc(8, 0)));
});
