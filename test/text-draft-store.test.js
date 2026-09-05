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
