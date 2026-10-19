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

test('E-01: metadata edits reuse indexed prompt text, skip non-images and read few files at a time', async t => {
  const items = [
    { id: 'img', name: 'cat', ext: 'png', size: 10, tags: [], folders: [], modificationTime: 1 },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `p${i}`, ext: 'png', size: 10, tags: [], folders: [], modificationTime: 1 })),
    { id: 'vid', name: 'clip', ext: 'mp4', size: 10, tags: [], folders: [], modificationTime: 1 }
  ];
  const { index } = await makeIndex(t, items, new Map([['img', { positive: 'Glowing nebula' }]]));
  let reads = 0, active = 0, peak = 0;
  index.readMetadata = async () => {
    reads += 1; active += 1; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    return { positive: 'Fresh prompt' };
  };
  await index.refreshItem({ ...items[0], tags: ['space'], modificationTime: 2 });
  assert.equal(reads, 0, 'a tag edit does not read the original again');
  const tagged = await index.search('nebula space');
  assert.deepEqual(tagged.data.map(item => item.id), ['img'], 'old prompt text and the new tag are both searchable');
  await index.refreshItem({ ...items.at(-1), tags: ['x'], size: 99 });
  assert.equal(reads, 0, 'videos are never read');
  await Promise.all(items.slice(1, 9).map(item => index.refreshItem({ ...item, size: 11 })));
  assert.equal(reads, 8, 'a changed file is read again');
  assert.ok(peak <= 3, `at most three files at a time, saw ${peak}`);
});

test('a refresh queued for the previous library does not switch the index back (E-05)', async t => {
  const { index, root } = await makeIndex(t, [{ id: 'one', name: 'one', ext: 'png', tags: [], folders: [], modificationTime: 1 }], new Map());
  const first = path.join(root, 'library.library');
  const second = path.join(root, 'other.library');
  index.scheduleRefresh(first);
  await index.start(second);
  assert.equal(index.refreshTimer, null, 'switching library cancels the queued refresh');
  // A stale timer that slipped through is ignored too.
  index.scheduleRefresh(first);
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal(index.libraryPath, path.resolve(second));
});
