'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clipboardFilePaths } = require('../lib/clipboard-files');

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
