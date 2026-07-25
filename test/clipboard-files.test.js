'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clipboardFilePaths, finalizeMacImageClipboard, writeClipboardFilePaths } = require('../lib/clipboard-files');

function fakeClipboard({ formats = [], values = {}, text = '', buffer = Buffer.alloc(0) } = {}) {
  return {
    availableFormats: () => formats,
    read: format => values[format] || '',
    readText: () => text,
    readBuffer: () => buffer
  };
}

test('recognizes and deduplicates Finder file URLs and absolute text paths', () => {
  const clipboard = fakeClipboard({
    values: {
      'public.file-url': 'file:///tmp/%E7%A4%BA%E4%BE%8B%201.png',
      'text/uri-list': '# Finder\nfile:///tmp/%E7%A4%BA%E4%BE%8B%201.png\nfile:///tmp/second.jpg'
    },
    text: '/tmp/third.txt\nnot-a-path'
  });
  const result = clipboardFilePaths(clipboard, { existsSync: candidate => candidate !== '/tmp/second.jpg' });
  assert.deepEqual(result, ['/tmp/示例 1.png', '/tmp/third.txt']);
});

test('recognizes the macOS NSFilenamesPboardType Finder format', () => {
  const clipboard = fakeClipboard({ formats: ['NSFilenamesPboardType'], buffer: Buffer.from('plist') });
  const result = clipboardFilePaths(clipboard, {
    platform: 'darwin',
    existsSync: () => true,
    parsePropertyList: buffer => buffer.toString() === 'plist' ? ['/tmp/a.png', '/tmp/b.txt'] : []
  });
  assert.deepEqual(result, ['/tmp/a.png', '/tmp/b.txt']);
});

test('writes one macOS file with Finder and image pasteboard formats', () => {
  const writes = [];
  const clipboard = {
    clear: () => writes.push(['clear']),
    writeBuffer: (format, value) => writes.push([format, value.toString()])
  };
  const result = writeClipboardFilePaths(clipboard, ['/tmp/a & b.png'], {
    platform: 'darwin',
    existsSync: () => true,
    readFileSync: () => Buffer.from('png-bytes')
  });

  assert.deepEqual(result, ['/tmp/a & b.png']);
  assert.deepEqual(writes.map(entry => entry[0]), ['clear', 'public.file-url', 'NSFilenamesPboardType', 'public.png']);
  assert.match(writes[1][1], /^file:\/\/\/tmp\/a%20&%20b\.png$/);
  assert.match(writes[2][1], /<string>\/tmp\/a &amp; b\.png<\/string>/);
  assert.equal(writes[3][1], 'png-bytes');
});

test('writes multiple macOS files as one Finder file list', () => {
  const writes = [];
  const clipboard = {
    clear: () => writes.push(['clear']),
    writeBuffer: (format, value) => writes.push([format, value.toString()])
  };
  writeClipboardFilePaths(clipboard, ['/tmp/a.png', '/tmp/b.txt'], {
    platform: 'darwin',
    existsSync: () => true
  });

  assert.deepEqual(writes.map(entry => entry[0]), ['clear', 'NSFilenamesPboardType']);
  assert.match(writes[1][1], /<string>\/tmp\/a\.png<\/string>/);
  assert.match(writes[1][1], /<string>\/tmp\/b\.txt<\/string>/);
});

test('finalizes a copied macOS image through the native pasteboard script', () => {
  let invocation;
  const result = finalizeMacImageClipboard('/tmp/a & b.png', '/app/copy-image.applescript', {
    platform: 'darwin',
    existsSync: () => true,
    runScript: (...args) => {
      invocation = args;
      return { status: 0, stderr: '' };
    }
  });

  assert.deepEqual(result, { handled: true, ok: true });
  assert.equal(invocation[0], '/usr/bin/osascript');
  assert.deepEqual(invocation[1].slice(0, 3), ['/app/copy-image.applescript', '/tmp/a & b.png', 'public.png']);
  assert.match(invocation[1][3], /<string>\/tmp\/a &amp; b\.png<\/string>/);
});

test('reports native macOS image clipboard failures', () => {
  const result = finalizeMacImageClipboard('/tmp/a.jpg', '/app/copy-image.applescript', {
    platform: 'darwin',
    existsSync: () => true,
    runScript: () => ({ status: 1, stderr: 'pasteboard unavailable' })
  });
  assert.deepEqual(result, { handled: true, ok: false, message: 'pasteboard unavailable' });
});
