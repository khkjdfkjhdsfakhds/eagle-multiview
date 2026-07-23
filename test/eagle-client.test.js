'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EagleClient } = require('../lib/eagle-client');

class RecordingClient extends EagleClient {
  constructor() {
    super('http://unused');
    this.calls = [];
  }

  async request(path, options = {}) {
    this.calls.push({ path, options });
    return { data: [], total: 0 };
  }
}

test('folder queries request only the directly assigned folder', async () => {
  const client = new RecordingClient();
  await client.queryItems({ folderId: 'parent', offset: 0, limit: 160 });
  assert.equal(client.calls[0].path, '/api/v2/item/get');
  assert.deepEqual(client.calls[0].options.body.folders, ['parent']);
  assert.equal('folderIds' in client.calls[0].options.body, false);
});

test('library root requests only unfiled root items', async () => {
  const client = new RecordingClient();
  await client.queryItems({ unfiled: true, offset: 0, limit: 160 });
  assert.equal(client.calls[0].options.body.isUnfiled, true);
  assert.equal('folders' in client.calls[0].options.body, false);
});

test('all-items view has no folder restriction', async () => {
  const client = new RecordingClient();
  await client.queryItems({ offset: 0, limit: 160 });
  assert.equal('folders' in client.calls[0].options.body, false);
  assert.equal('isUnfiled' in client.calls[0].options.body, false);
});

test('random view uses Eagle random ordering endpoint', async () => {
  const client = new RecordingClient();
  await client.queryItems({ random: true, offset: 0, limit: 12, search: 'cat', ext: 'png', tags: ['ref', 'blue'] });
  assert.match(client.calls[0].path, /^\/api\/item\/list\?/);
  assert.match(client.calls[0].path, /orderBy=RANDOM/);
  assert.match(client.calls[0].path, /keyword=cat/);
  assert.match(client.calls[0].path, /ext=png/);
  assert.match(client.calls[0].path, /tags=ref%2Cblue/);
});

test('random view applies rating consistently to returned items', async () => {
  const client = new RecordingClient();
  client.request = async () => [
    { id: 'one', star: 1 },
    { id: 'two', star: 4 },
    { id: 'three', star: 4 }
  ];
  const page = await client.queryItems({ random: true, rating: 4 });
  assert.deepEqual(page.data.map(item => item.id), ['two', 'three']);
  assert.equal(page.total, 2);
});

test('recent folders use Eagle recent-folder endpoint', async () => {
  const client = new RecordingClient();
  await client.listRecentFolders();
  assert.equal(client.calls[0].path, '/api/folder/listRecent');
});

test('does not send unsupported trash filters that Eagle would silently ignore', async () => {
  const client = new RecordingClient();
  await client.queryItems({ deleted: true, offset: 0, limit: 160 });
  assert.equal('isDeleted' in client.calls[0].options.body, false);
});

test('batch import uses Eagle local-path API with the target folder', async () => {
  const client = new RecordingClient();
  await client.addItems(['/tmp/a.png', '/tmp/b.txt'], 'folder-1');
  assert.equal(client.calls[0].path, '/api/item/addFromPaths');
  assert.equal(client.calls[0].options.method, 'POST');
  assert.deepEqual(client.calls[0].options.body, {
    paths: ['/tmp/a.png', '/tmp/b.txt'],
    folderId: 'folder-1'
  });
});

test('single unfiled import omits a folder assignment', async () => {
  const client = new RecordingClient();
  await client.addItems(['/tmp/a.png'], null);
  assert.deepEqual(client.calls[0].options.body, { paths: ['/tmp/a.png'] });
});

test('surfaces Eagle response details instead of a generic HTTP status', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ status: 'error', message: 'local path handler failed' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' }
  });
  try {
    await assert.rejects(() => new EagleClient('http://unused').appInfo(), /Eagle API 500：local path handler failed/);
  } finally {
    global.fetch = originalFetch;
  }
});
