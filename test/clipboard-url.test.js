'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeClipboardURL, clipboardURLKind } = require('../lib/clipboard-url');
const { EagleClient } = require('../lib/eagle-client');

test('normalizes only one http(s) clipboard URL', () => {
  assert.equal(normalizeClipboardURL('  https://example.com/a  '), 'https://example.com/a');
  assert.equal(normalizeClipboardURL('file:///tmp/a.png'), null);
  assert.equal(normalizeClipboardURL('https://example.com/a\nextra'), null);
  assert.equal(normalizeClipboardURL('not a URL'), null);
});

test('classifies image responses as downloadable assets and everything else as bookmarks', () => {
  assert.equal(clipboardURLKind('image/jpeg; charset=binary'), 'image');
  assert.equal(clipboardURLKind('text/html; charset=utf-8'), 'bookmark');
  assert.equal(clipboardURLKind(''), 'bookmark');
});

test('adds clipboard bookmarks through Eagle bookmark API', async () => {
  const client = new EagleClient();
  client.request = async (route, options) => {
    assert.equal(route, '/api/item/addBookmark');
    assert.deepEqual(options.body, { url: 'https://example.com/page', tags: [], folderId: 'folder' });
    return { id: 'bookmark-id' };
  };
  assert.deepEqual(await client.addBookmark({ url: 'https://example.com/page' }, 'folder'), { id: 'bookmark-id' });
});
