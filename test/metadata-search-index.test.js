'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { MetadataSearchIndex } = require('../lib/metadata-search-index');

async function makeIndex(t, items, metadataById, stealthById = new Map()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-metadata-index-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new Map();
  for (const item of items) {
    const file = path.join(root, `${item.id}.${item.ext || 'png'}`);
    await fs.writeFile(file, 'fixture');
    files.set(item.id, file);
  }
  const client = {
    async listAllItems() { return items; },
    async fileURLForItem(item) { return pathToFileURL(files.get(item.id)).toString(); }
  };
  const index = new MetadataSearchIndex({
    directory: path.join(root, 'state'),
    client,
    readMetadata: async filePath => metadataById.get(path.basename(filePath).split('.')[0]) || null,
    readStealthMetadata: async filePath => stealthById.get(path.basename(filePath).split('.')[0]) || null
  });
  await index.start(path.join(root, 'library.library'));
  return { index, root };
}

test('metadata index searches Eagle fields and embedded prompt text together', async t => {
  const items = [
    { id: 'one', name: 'old-one', ext: 'png', tags: ['reference'], folders: ['folder-a'], modificationTime: 1 },
    { id: 'two', name: 'old-two', ext: 'png', tags: [], folders: ['folder-b'], modificationTime: 2 },
    { id: 'three', name: 'old-three', ext: 'png', tags: [], folders: [], modificationTime: 3 }
  ];
  const { index } = await makeIndex(t, items, new Map([
    ['one', { format: 'NovelAI', positive: 'artist:reoen, masterpiece', negative: 'lowres', params: { Seed: 'secret-seed' }, loras: [{ name: 'secret-lora' }], characters: [{ positive: 'artist:character' }] }],
    ['two', { format: 'NovelAI', positive: 'artist:fuzichoco, masterpiece', negative: '', params: {} }],
    ['three', null]
  ]));
  const all = await index.search('masterpiece', { limit: 10 });
  assert.deepEqual(all.data.map(item => item.id), ['one', 'two']);
  const artist = await index.search('artist:reoen', { limit: 10 });
  assert.deepEqual(artist.data.map(item => item.id), ['one']);
  const eagleField = await index.search('reference', { limit: 10 });
  assert.deepEqual(eagleField.data.map(item => item.id), ['one']);
  const characterPositive = await index.search('artist:character', { limit: 10 });
  assert.deepEqual(characterPositive.data.map(item => item.id), ['one']);
  for (const excluded of ['lowres', 'secret-seed', 'secret-lora', 'novelai']) {
    assert.equal((await index.search(excluded, { limit: 10 })).total, 0, `${excluded} should not be indexed`);
  }
});

test('metadata index paginates and persists across reloads', async t => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    id: `item-${index}`, name: `image-${index}`, ext: 'png', tags: [], folders: [], modificationTime: index + 1
  }));
  const { index, root } = await makeIndex(t, items, new Map(items.map(item => [item.id, { positive: 'shared artist:demo' }])));
  const page = await index.search('artist:demo', { offset: 1, limit: 2 });
  assert.deepEqual(page.data.map(item => item.id), ['item-1', 'item-2']);
  assert.equal(page.total, 5);
  assert.equal(page.hasMore, true);

  const reloaded = new MetadataSearchIndex({
    directory: path.join(root, 'state'),
    client: { async listAllItems() { throw new Error('reload should use cache'); } },
    readMetadata: async () => null
  });
  assert.equal(await reloaded.load(path.join(root, 'library.library')), true);
  const cached = await reloaded.search('artist:demo', { limit: 10 });
  assert.equal(cached.total, 5);
});

test('deleted items do not appear in metadata results', async t => {
  const items = [{ id: 'deleted', name: 'gone', ext: 'png', isDeleted: true, tags: [], folders: [] }];
  const { index } = await makeIndex(t, items, new Map([['deleted', { positive: 'artist:gone' }]]));
  const result = await index.search('artist:gone', { limit: 10 });
  assert.equal(result.total, 0);
});

test('metadata index falls back to alpha-embedded prompt metadata', async t => {
  const items = [{ id: 'stealth', name: '001', ext: 'webp', tags: [], folders: [], modificationTime: 1 }];
  const { index } = await makeIndex(t, items, new Map(), new Map([
    ['stealth', { format: 'NovelAI', positive: '0.6::artist:nyong nyong ::, 0.8::artist:hiro (dismaless) ::' }]
  ]));
  const result = await index.search('artist:nyong nyong', { limit: 10 });
  assert.deepEqual(result.data.map(item => item.id), ['stealth']);
});
