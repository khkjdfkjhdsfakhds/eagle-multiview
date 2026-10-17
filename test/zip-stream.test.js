'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { dedupeNames, writeStoreZip } = require('../lib/zip-stream');

test('DA-18: final archive names remain unique after generated suffix collisions', () => {
  const names = dedupeNames(['a.png', 'a.png', 'a-2.png', 'A.PNG', 'a.png', 'café.txt', 'cafe\u0301.txt']);
  assert.deepEqual(names, ['a.png', 'a-2.png', 'a-2-2.png', 'A-3.PNG', 'a-4.png', 'café.txt', 'cafe\u0301-2.txt']);
  assert.equal(new Set(names.map(name => name.normalize('NFC').toLowerCase())).size, names.length);
});

test('UW-03: a disconnected download rejects instead of waiting forever for drain', async () => {
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _done) {} });
  const pending = writeStoreZip(output, [{ name: 'fixture.txt', filePath: __filename }]);
  setImmediate(() => output.destroy());
  let timer;
  try {
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture timeout: no disconnect result')), 500);
    })]), /下载连接已关闭/);
  } finally { clearTimeout(timer); output.destroy(); }
});

test('S-12: names are written composed and a far-future mtime does not break the archive', async () => {
  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
  await writeStoreZip(output, [{ name: 'cafe\u0301.txt', filePath: require.resolve('../package.json'), mtime: new Date(2200, 0, 1) }]);
  const archive = Buffer.concat(chunks);
  assert.ok(archive.includes(Buffer.from('caf\u00e9.txt', 'utf8')));
  assert.ok(!archive.includes(Buffer.from('cafe\u0301.txt', 'utf8')));
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50, 'archive ends with its directory record');
});
