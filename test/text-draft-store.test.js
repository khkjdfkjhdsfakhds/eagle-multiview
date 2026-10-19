'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TextDraftStore } = require('../lib/text-draft-store');

test('drafts survive reloading the store, arbitrate late writes and never erase another editor', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-draft-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TextDraftStore(root);
  const key = { libraryPath: '/synthetic/A.library', id: 'ITEM1', draftId: 'window-a-pane-1' };
  await store.put({ ...key, revision: 2, content: 'newest', base: { hash: 'base', size: 4 } });
  await store.put({ ...key, revision: 1, content: 'late old' });
  assert.equal((await new TextDraftStore(root).get(key)).content, 'newest');
  assert.equal(await store.remove({ ...key, revision: 1 }), false);
  await store.put({ ...key, draftId: 'window-b', revision: 1, content: 'other editor' });
  assert.equal(await store.remove({ ...key, revision: 2 }), true);
  await store.put({ ...key, revision: 2, content: 'late resurrect' });
  assert.equal(await store.get(key), null);
  assert.equal((await store.get({ ...key, draftId: 'window-b' })).content, 'other editor');
  await store.put({ ...key, libraryPath: '/synthetic/B.library', draftId: 'window-c', revision: 1, content: 'other library' });
  const candidates = await new TextDraftStore(root).list({ libraryPath: key.libraryPath, id: key.id });
  assert.deepEqual(candidates.map(value => value.content), ['other editor']);
});

// S-03: opening a clean TXT removes a fresh draftId at revision 0 each time.
test('removing a draft that was never written leaves nothing on disk', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-draft-clean-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TextDraftStore(root);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(await store.remove({ libraryPath: '/synthetic/A.library', id: 'ITEM1', draftId: `fresh-${index}`, revision: 0 }), true);
  }
  const names = await fs.readdir(root).catch(() => []);
  assert.deepEqual(names, []);
});

test('old tombstones are pruned while live drafts stay', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-draft-prune-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = { libraryPath: '/synthetic/A.library', id: 'ITEM1' };
  const first = new TextDraftStore(root);
  await first.put({ ...key, draftId: 'saved', revision: 1, content: 'saved text' });
  assert.equal(await first.remove({ ...key, draftId: 'saved', revision: 1 }), true);
  await first.put({ ...key, draftId: 'live', revision: 1, content: 'unsaved text' });
  assert.equal((await fs.readdir(root)).length, 2, 'a fresh tombstone protects against a late put');
  const later = new TextDraftStore(root, { tombstoneTtlMs: -1 });
  const drafts = await later.list(key);
  assert.deepEqual(drafts.map(draft => draft.content), ['unsaved text']);
  assert.equal((await fs.readdir(root)).length, 1, 'the expired tombstone is gone');
});

// S-16: any client can pick new draftIds; the directory must stay bounded.
test('new drafts are refused once the store is full, existing ones still update', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-draft-quota-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = { libraryPath: '/synthetic/A.library', id: 'ITEM1' };
  const store = new TextDraftStore(root, { maxFiles: 2 });
  await store.put({ ...key, draftId: 'a', revision: 1, content: 'a' });
  await store.put({ ...key, draftId: 'b', revision: 1, content: 'b' });
  await assert.rejects(store.put({ ...key, draftId: 'c', revision: 1, content: 'c' }), /草稿备份空间已满/);
  assert.equal((await store.put({ ...key, draftId: 'a', revision: 2, content: 'a2' })).content, 'a2');
  const bytes = new TextDraftStore(await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-draft-bytes-')), { maxBytes: 600 });
  t.after(() => fs.rm(bytes.root, { recursive: true, force: true }));
  await bytes.put({ ...key, draftId: 'small', revision: 1, content: 'x'.repeat(100) });
  await assert.rejects(bytes.put({ ...key, draftId: 'big', revision: 1, content: 'y'.repeat(400) }), /草稿备份空间已满/);
});
