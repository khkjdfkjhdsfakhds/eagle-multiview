'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TagTally, changedTagNames } = require('../lib/tag-tally');
const { DataHub } = require('../lib/data-hub');
const { loadMain } = require('../test-support/main-data-harness.cjs');

const countingClient = counts => ({
  calls: [],
  async countItemsWithTag(name) { this.calls.push(name); return counts[name] || 0; }
});

test('V-01: a tag Eagle has not listed yet joins the list with its live count', async () => {
  const client = countingClient({ 验收A: 3, 旧标签: 7 });
  const tally = new TagTally(client);
  tally.note('/A.library', ['验收A', '旧标签']);
  const merged = await tally.merge('/A.library', [{ name: '旧标签', imageCount: 6, groups: ['G'] }, { name: '别的', imageCount: 2 }]);
  assert.deepEqual(merged, [
    { name: '旧标签', imageCount: 7, groups: ['G'] },
    { name: '别的', imageCount: 2 },
    { name: '验收A', imageCount: 3, groups: [] }
  ]);
});

test('V-01: a touched name no item holds any more is not added', async () => {
  const tally = new TagTally(countingClient({ 去掉了: 0 }));
  tally.note('/A.library', ['去掉了']);
  assert.deepEqual(await tally.merge('/A.library', []), []);
});

test('V-01: switching libraries forgets the previous library\'s names', async () => {
  const client = countingClient({ 验收A: 3 });
  const tally = new TagTally(client);
  tally.note('/A.library', ['验收A']);
  assert.deepEqual(await tally.merge('/B.library', [{ name: 'B', imageCount: 1 }]), [{ name: 'B', imageCount: 1 }]);
  assert.deepEqual(client.calls, []);
});

test('V-01: the remembered names are bounded, oldest first out', async () => {
  const client = countingClient({ a: 1, b: 1, c: 1 });
  const tally = new TagTally(client, { limit: 2 });
  tally.note('/A.library', ['a', 'b']);
  tally.note('/A.library', ['a']);
  tally.note('/A.library', ['c']);
  const merged = await tally.merge('/A.library', []);
  assert.deepEqual(merged.map(tag => tag.name).sort(), ['a', 'c']);
});

test('V-01: a failed count keeps Eagle\'s own number', async () => {
  const tally = new TagTally({ async countItemsWithTag() { throw new Error('offline'); } });
  tally.note('/A.library', ['x', '新']);
  assert.deepEqual(await tally.merge('/A.library', [{ name: 'x', imageCount: 4 }]), [{ name: 'x', imageCount: 4 }]);
});

test('changedTagNames covers added, removed and trashed items', () => {
  assert.deepEqual(changedTagNames({ tags: ['a', 'b'] }, { tags: ['b', 'c'] }).sort(), ['a', 'c']);
  assert.deepEqual(changedTagNames({ tags: ['a'] }, { tags: ['a'] }), []);
  assert.deepEqual(changedTagNames({ tags: ['a'], isDeleted: false }, { tags: ['a'], isDeleted: true }), ['a']);
});

test('V-01: a tag edit through the hub reports the names it changed', async () => {
  let item = { id: 'A', tags: ['旧'], folders: [], modificationTime: 1 };
  const client = {
    async libraryInfo() { return { path: '/library' }; },
    async getItem() { return structuredClone(item); },
    async updateItem(_id, patch) { item = { ...item, ...patch, modificationTime: item.modificationTime + 1 }; return structuredClone(item); }
  };
  const hub = new DataHub(client);
  hub.library = { path: '/library' };
  const touched = [];
  hub.on('item-tags-touched', payload => touched.push(payload));
  await hub.mutateSet({ id: 'A', field: 'tags', add: ['验收A'], remove: ['旧'], libraryPath: '/library' });
  assert.equal(touched.length, 1);
  assert.deepEqual(touched[0].names.sort(), ['旧', '验收A']);
  await hub.mutate({ id: 'A', patch: { name: '只改名' }, base: {}, libraryPath: '/library' });
  assert.equal(touched.length, 1, 'edits that keep the tags report nothing');
});

test('V-01: every window hears about a new tag and reads it from hub:tags', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-tag-tally-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = loadMain(root);
  let item = { id: 'A', tags: [], folders: [], modificationTime: 1 };
  main.hub.library = { path: '/A.library', folders: [] };
  main.client.libraryInfo = async () => ({ path: '/A.library' });
  main.client.getItem = async () => structuredClone(item);
  main.client.updateItem = async (_id, patch) => { item = { ...item, ...patch }; return structuredClone(item); };
  main.client.listTags = async () => [{ name: '已有', imageCount: 5 }];
  main.client.countItemsWithTag = async name => (item.tags.includes(name) ? 1 : 0);
  const events = [];
  main.addFakeWindow({ isDestroyed: () => false, webContents: { send: (channel, payload) => events.push({ channel, payload }) } });
  await main.rpcRegistry.get('hub:mutate-set')({ sender: { id: 1 } }, { id: 'A', field: 'tags', add: ['验收A'], libraryPath: '/A.library' });
  const deadline = Date.now() + 3000;
  while (!events.some(event => event.channel === 'tag-data:changed') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const notice = events.find(event => event.channel === 'tag-data:changed');
  assert.ok(notice, 'tag-data:changed was broadcast');
  assert.equal(notice.payload.libraryPath, '/A.library');
  assert.equal(notice.payload.reason, 'item-tags');
  const tags = await main.rpcRegistry.get('hub:tags')({ sender: { id: 1 } });
  assert.deepEqual(tags.map(tag => [tag.name, tag.imageCount]), [['已有', 5], ['验收A', 1]]);
});

test('V-01: the renderer refreshes only the tag list for item tag edits', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const handler = source.slice(source.indexOf('window.eagleMV.onTagDataChanged('), source.indexOf('window.eagleMV.onTextChanged('));
  assert.match(handler, /payload\.reason === 'item-tags'[\s\S]*?refreshAvailableTags\(\)/);
  const refresh = source.slice(source.indexOf('async function refreshAvailableTags()'), source.indexOf('async function restoreInitialWindowState()'));
  assert.match(refresh, /state\.availableTags = tags/);
  assert.match(refresh, /renderFolderTree\(\)/);
});
