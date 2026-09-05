'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createSaveHandler } = require('../eagle-plugin/text-save-service/save-handler');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-plugin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraryPath = path.join(root, 'Fixture.library');
  const filePath = path.join(libraryPath, 'images', 'I.info', 'source.txt');
  const stagingRoot = path.join(root, 'userdata', 'staging');
  const stagedPath = path.join(stagingRoot, 'candidate.txt');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.writeFile(filePath, 'old');
  await fs.writeFile(stagedPath, 'new');
  let calls = 0;
  const item = { id: 'I', ext: 'txt', filePath, replaceFile: async stage => { calls++; await fs.copyFile(stage, filePath); } };
  const eagle = { library: { path: libraryPath }, item: { getById: async () => item } };
  const request = { requestId: 'request-a', id: 'I', libraryPath, stagedPath, base: { hash: hash('old'), size: 3 }, outputHash: hash('new') };
  return { root, libraryPath, filePath, stagingRoot, stagedPath, item, eagle, request, get calls() { return calls; } };
}

test('official-plugin adapter checks identity and version and treats undefined SDK completion as saved', async t => {
  const f = await fixture(t);
  const save = createSaveHandler({ eagle: f.eagle, stagingRoot: f.stagingRoot });
  assert.equal((await save(f.request)).status, 'saved');
  assert.equal(await fs.readFile(f.filePath, 'utf8'), 'new');
  assert.equal((await save({ ...f.request, requestId: 'identical' })).status, 'saved');
  assert.equal(f.calls, 1, 'identical bytes are a no-op, not another SDK operation');
  await fs.writeFile(f.stagedPath, 'different');
  const stale = await save({ ...f.request, requestId: 'request-b', outputHash: hash('different') });
  assert.equal(stale.conflict, true);
  assert.equal(stale.current.content, 'new');
  assert.equal(f.calls, 1);
  f.eagle.library.path = path.join(f.root, 'Other.library');
  await assert.rejects(save(f.request), /资料库/);
  assert.equal(f.calls, 1);
});

test('missing thumbnail completion releases a verified file transaction but never repeats identical content', async t => {
  const f = await fixture(t);
  let finish;
  const complete = new Promise(resolve => { finish = resolve; });
  f.item.replaceFile = async stage => { await fs.copyFile(stage, f.filePath); await complete; };
  const save = createSaveHandler({ eagle: f.eagle, stagingRoot: f.stagingRoot, timeoutMs: 25 });
  assert.equal((await save(f.request)).status, 'written_pending_refresh');
  assert.equal((await save({ ...f.request, requestId: 'second' })).status, 'saved');
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await save({ ...f.request, requestId: 'third' })).conflict, false);
});

test('an unrelated candidate path or changed candidate is rejected without any Eagle replacement', async t => {
  const f = await fixture(t);
  const save = createSaveHandler({ eagle: f.eagle, stagingRoot: f.stagingRoot });
  await assert.rejects(save({ ...f.request, stagedPath: f.filePath }), /暂存范围/);
  await fs.writeFile(f.stagedPath, 'tampered');
  await assert.rejects(save(f.request), /候选内容版本不符/);
  assert.equal(f.calls, 0);
  assert.equal(await fs.readFile(f.filePath, 'utf8'), 'old');
});

test('a hung item lookup is bounded and its late completion cannot start a replacement', async t => {
  const f = await fixture(t); let release;
  f.eagle.item.getById = () => new Promise(resolve => { release = resolve; });
  const save = createSaveHandler({ eagle: f.eagle, stagingRoot: f.stagingRoot, lookupTimeoutMs: 20 });
  await assert.rejects(save(f.request), /只读检查超时/);
  release(f.item); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls, 0);
  f.eagle.item.getById = async () => f.item;
  assert.equal((await save(f.request)).status, 'saved');
});
