'use strict';
// D-08: a picture dragged out of a web page as a data: address imports like
// a pasted image — decoded to a temporary file and sent through items:import.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadMain } = require('../test-support/main-data-harness.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64');

test('data: images decode by their type; other data is refused', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-data-url-'));
  try {
    const main = loadMain(root);
    const png = main.decodeImageDataURL(`data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal(png.ext, 'png');
    assert.deepEqual(Buffer.from(png.bytes), PNG);
    assert.equal(main.decodeImageDataURL('data:image/jpeg;charset=binary;base64,AAAA').ext, 'jpg');
    const svg = main.decodeImageDataURL('data:image/svg+xml;utf8,%3Csvg%3E%3C%2Fsvg%3E');
    assert.equal(svg.ext, 'svg');
    assert.equal(Buffer.from(svg.bytes).toString('utf8'), '<svg></svg>');
    assert.throws(() => main.decodeImageDataURL('data:text/html;base64,AAAA'), /只能添加网页里的图片/);
    assert.throws(() => main.decodeImageDataURL('data:image/png;base64,'), /图片内容为空/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a dropped data: image goes through items:import as a temporary file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-data-url-'));
  try {
    const main = loadMain(root);
    const calls = [];
    main.rpcRegistry.set('items:import', async (_event, payload) => {
      calls.push({ ...payload, bytes: await fs.readFile(payload.paths[0]) });
      return { count: 1, ready: 1, ids: ['NEW'], rejected: [] };
    });
    const result = await main.rpcRegistry.get('items:import-url')({ sender: { id: 1 } }, {
      url: `data:image/png;base64,${PNG.toString('base64')}`, image: true, folderId: 'F', libraryPath: '/L.library'
    });
    assert.equal(result.source, 'data-url');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].folderId, 'F');
    assert.equal(calls[0].libraryPath, '/L.library');
    assert.match(path.basename(calls[0].paths[0]), /^网页图片-.*\.png$/);
    assert.deepEqual(calls[0].bytes, PNG);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
