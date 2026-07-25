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

test('uses Eagle full-text search for an unscoped search', async () => {
  const client = new RecordingClient();
  await client.queryItems({ search: 'cat OR dog -watermark', offset: 10, limit: 20 });
  assert.equal(client.calls[0].path, '/api/v2/item/query');
  assert.deepEqual(client.calls[0].options.body, { query: 'cat OR dog -watermark', offset: 10, limit: 20 });
});

test('applies folder and metadata constraints to full-text results', async () => {
  const client = new RecordingClient();
  client.request = async (path, options = {}) => {
    client.calls.push({ path, options });
    if (path === '/api/v2/item/query') {
      const offset = options.body.offset;
      return offset ? { data: [], total: 2 } : {
        data: [
          { id: 'keep', folders: ['folder-1'], ext: 'png', star: 4, tags: ['ref'], width: 100, height: 100 },
          { id: 'drop', folders: ['folder-2'], ext: 'png', star: 4, tags: ['ref'], width: 100, height: 100 }
        ],
        total: 2
      };
    }
    throw new Error(`unexpected ${path}`);
  };
  const page = await client.queryItems({ search: 'cat', folderId: 'folder-1', ext: 'png', rating: 4, tags: ['ref'], shape: 'square', offset: 0, limit: 10 });
  assert.deepEqual(page.data.map(item => item.id), ['keep']);
  assert.equal(page.total, 1);
  assert.equal(client.calls.length, 1);
});

test('constrained full-text search returns the first usable page without scanning the entire library', async () => {
  const client = new RecordingClient();
  client.request = async (path, options = {}) => {
    client.calls.push({ path, options });
    const start = options.body.offset;
    return {
      data: Array.from({ length: 1000 }, (_, index) => ({
        id: `item-${start + index}`,
        folders: ['folder-1'],
        tags: ['ref']
      })),
      total: 10000
    };
  };
  const page = await client.queryItems({ search: 'cat', folderId: 'folder-1', tags: ['ref'], offset: 0, limit: 160 });
  assert.equal(client.calls.length, 1);
  assert.equal(page.data.length, 160);
  assert.equal(page.total, 1000);
  assert.equal(page.estimated, true);
  assert.equal(page.hasMore, true);
});

test('later constrained search pages stop once enough matching rows are collected', async () => {
  const client = new RecordingClient();
  client.request = async (path, options = {}) => {
    client.calls.push({ path, options });
    return {
      data: Array.from({ length: 1000 }, (_, index) => ({ id: `item-${index}`, folders: ['folder-1'] })),
      total: 5000
    };
  };
  const page = await client.queryItems({ search: 'cat', folderId: 'folder-1', offset: 160, limit: 20 });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(page.data.map(item => item.id), Array.from({ length: 20 }, (_, index) => `item-${160 + index}`));
  assert.equal(page.nextOffset, 180);
  assert.equal(page.estimated, true);
});

test('derives Eagle panoramic shapes when full-text filtering locally', () => {
  assert.equal(EagleClient.matchesSearchConstraints({ id: 'wide', width: 2400, height: 900 }, { shape: 'panoramic-landscape' }), true);
  assert.equal(EagleClient.matchesSearchConstraints({ id: 'tall', width: 900, height: 2400 }, { shape: 'panoramic-portrait' }), true);
  assert.equal(EagleClient.matchesSearchConstraints({ id: 'normal', width: 1600, height: 900 }, { shape: 'panoramic-landscape' }), false);
});

test('format filters forward a typed extension to Eagle', async () => {
  const client = new RecordingClient();
  await client.queryItems({ ext: 'heic', offset: 0, limit: 160 });
  assert.equal(client.calls[0].options.body.ext, 'heic');
});

test('forwards Eagle v2 untagged and metadata filters', async () => {
  const client = new RecordingClient();
  await client.queryItems({ isUntagged: true, annotation: 'note', url: 'example', shape: 'portrait', offset: 0, limit: 160 });
  assert.deepEqual(client.calls[0].options.body, {
    offset: 0,
    limit: 160,
    annotation: 'note',
    url: 'example',
    shape: 'portrait',
    isUntagged: true
  });
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

test('random view applies metadata and shape filters consistently', async () => {
  const client = new RecordingClient();
  client.request = async () => [
    { id: 'keep', annotation: 'approved', url: 'example.test', width: 2400, height: 900, tags: [] },
    { id: 'drop', annotation: 'draft', url: 'other.test', width: 1600, height: 900, tags: ['tag'] }
  ];
  const page = await client.queryItems({ random: true, annotation: 'approved', url: 'example', shape: 'panoramic-landscape', isUntagged: true });
  assert.deepEqual(page.data.map(item => item.id), ['keep']);
});

test('recent folders use Eagle recent-folder endpoint', async () => {
  const client = new RecordingClient();
  await client.listRecentFolders();
  assert.equal(client.calls[0].path, '/api/folder/listRecent');
});

test('tag management uses Eagle v2 mutation endpoints', async () => {
  const client = new RecordingClient();
  await client.renameTag('old', 'new');
  await client.mergeTag('source', 'target');
  await client.createTagGroup('People');
  await client.updateTagGroup('group-1', { name: 'Characters' });
  await client.addTagsToGroup('group-1', ['portrait']);
  await client.removeTagsFromGroup('group-1', ['portrait']);
  await client.removeTagGroup('group-1');
  assert.deepEqual(client.calls.map(call => [call.path, call.options.body]), [
    ['/api/v2/tag/update', { originalName: 'old', name: 'new' }],
    ['/api/v2/tag/merge', { source: 'source', target: 'target' }],
    ['/api/v2/tagGroup/create', { name: 'People' }],
    ['/api/v2/tagGroup/update', { id: 'group-1', name: 'Characters' }],
    ['/api/v2/tagGroup/addTags', { groupId: 'group-1', tags: ['portrait'] }],
    ['/api/v2/tagGroup/removeTags', { groupId: 'group-1', tags: ['portrait'] }],
    ['/api/v2/tagGroup/remove', { id: 'group-1' }]
  ]);
});

test('smart folder management uses Eagle v2 endpoints', async () => {
  const client = new RecordingClient();
  const conditions = [{ match: 'AND', rules: [{ property: 'type', method: 'equal', value: 'png' }] }];
  await client.listSmartFolders();
  await client.createSmartFolder({ name: 'PNG references', conditions });
  await client.updateSmartFolder('smart-1', { name: 'PNG' });
  await client.removeSmartFolder('smart-1');
  assert.deepEqual(client.calls.map(call => call.path), [
    '/api/v2/smartFolder/get?limit=1000',
    '/api/v2/smartFolder/create',
    '/api/v2/smartFolder/update',
    '/api/v2/smartFolder/remove'
  ]);
  assert.deepEqual(client.calls[1].options.body, { name: 'PNG references', conditions });
});

test('comments and custom thumbnails use Eagle v2 endpoints', async () => {
  const client = new RecordingClient();
  client.request = async (path, options = {}) => {
    client.calls.push({ path, options });
    if (path.includes('getComments')) return { data: [{ id: 'comment-1', annotation: 'Face' }] };
    return { id: 'comment-1' };
  };
  assert.deepEqual(await client.getComments('item-1'), [{ id: 'comment-1', annotation: 'Face' }]);
  await client.addComment('item-1', { annotation: 'Face', x: 10, y: 20, width: 30, height: 40 });
  await client.updateComment('item-1', 'comment-1', { annotation: 'Updated' });
  await client.removeComment('item-1', 'comment-1');
  await client.setCustomThumbnail('item-1', '/tmp/thumb.png', 100, 80);
  assert.deepEqual(client.calls.map(call => call.path), [
    '/api/v2/item/getComments?id=item-1',
    '/api/v2/item/addComment',
    '/api/v2/item/updateComment',
    '/api/v2/item/removeComment',
    '/api/v2/item/setCustomThumbnail'
  ]);
  assert.deepEqual(client.calls[1].options.body, { id: 'item-1', annotation: 'Face', x: 10, y: 20, width: 30, height: 40 });
  assert.deepEqual(client.calls[2].options.body, { id: 'item-1', commentId: 'comment-1', annotation: 'Updated' });
  assert.deepEqual(client.calls[4].options.body, { itemId: 'item-1', filePath: '/tmp/thumb.png', width: 100, height: 80 });
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

test('folder rename uses the Eagle folder update endpoint', async () => {
  const client = new RecordingClient();
  await client.updateFolder('folder-1', { name: '新名称' });
  assert.equal(client.calls[0].path, '/api/v2/folder/update');
  assert.equal(client.calls[0].options.method, 'POST');
  assert.deepEqual(client.calls[0].options.body, { id: 'folder-1', name: '新名称' });
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
