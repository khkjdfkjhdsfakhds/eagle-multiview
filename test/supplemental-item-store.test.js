'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SupplementalItemStore } = require('../lib/supplemental-item-store');

test('supplemental item ids persist per library and deduplicate', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-supplemental-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state', 'supplemental-items.json');
  const first = new SupplementalItemStore(file);
  await first.add('/tmp/one.library', ['a', 'b', 'a']);
  await first.add('/tmp/two.library', ['x']);
  await first.remove('/tmp/one.library', ['a']);

  const reloaded = new SupplementalItemStore(file);
  assert.deepEqual(await reloaded.get('/tmp/one.library'), ['b']);
  assert.deepEqual(await reloaded.get('/tmp/two.library'), ['x']);
});
