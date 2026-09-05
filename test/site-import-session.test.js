'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SiteImportSessions } = require('../lib/site-import-session');

const target = { owner: 'window-1', requestId: 'request-1', url: 'https://www.artstation.com/fixture', libraryPath: '/Fixture.library', folderId: 'FOLDER' };
const A = { id: 'asset-a', name: 'A', url: 'https://cdna.artstation.com/a.jpg', website: 'https://www.artstation.com/artwork/a' };
const B = { ...A, id: 'asset-b', name: 'B' };

test('canceling unsubmitted discovery frees capacity immediately', async () => {
  const sessions = new SiteImportSessions({ discover: async()=>({assets:[A]}), ensureLibraryPath:async()=>{}, addAsset:async()=>assert.fail('no write') });
  for(let index=0;index<25;index++) {
    const request={...target,requestId:`cancel-${index}`};
    await sessions.start(request);sessions.cancel(request);
  }
});

test('retrying partial discovery reloads the failed page without repeating already imported assets', async () => {
  let count=0;const pages=[];
  const sessions = new SiteImportSessions({ discover:async({startPage})=>{pages.push(startPage);return ++count===1?{assets:[A],failures:[{projectId:'b'}],nextPage:2}:{assets:[A,B],failures:[],nextPage:2};},
    ensureLibraryPath:async()=>{},addAsset:async()=>({id:'eagle-a'}) });
  await sessions.start(target);await sessions.importSelected({...target,ids:[A.id]});
  const result=await sessions.retry(target);
  assert.deepEqual(pages,[1,1]);assert.deepEqual(result.assets.map(x=>x.id),[B.id]);
  await assert.rejects(sessions.importSelected({...target,ids:[A.id]}),{code:'SITE_ASSET_ALREADY_SUBMITTED'});
});

test('freezes a discovery destination and imports only explicitly selected discovered assets through the public session', async () => {
  const writes = [];
  const checks = [];
  const sessions = new SiteImportSessions({
    discover: async () => ({ assets: [A, B], nextPage: null, complete: true }),
    ensureLibraryPath: async path => checks.push(path),
    addAsset: async params => { writes.push(params); return { id: 'EAGLE-A' }; }
  });
  await sessions.start(target);
  assert.deepEqual(writes, []);
  const result = await sessions.importSelected({ owner: target.owner, requestId: target.requestId, ids: ['asset-a'] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].asset.id, 'asset-a');
  assert.equal(writes[0].libraryPath, '/Fixture.library');
  assert.equal(writes[0].folderId, 'FOLDER');
  assert.deepEqual(result.ids, ['EAGLE-A']);
  assert.equal(result.count, 1);
  assert.equal(result.partial, false);
  assert.ok(checks.length >= 2);
});

test('rejects other owners, forged selection IDs, duplicate tasks and replay of committed assets before any write', async () => {
  let writes = 0;
  const sessions = new SiteImportSessions({ discover: async () => ({ assets: [A], nextPage: null }), ensureLibraryPath: async () => {}, addAsset: async () => { writes++; return 'EAGLE-A'; } });
  await sessions.start(target);
  await assert.rejects(sessions.start(target), { code: 'SITE_SESSION_EXISTS' });
  await assert.rejects(sessions.importSelected({ ...target, owner: 'other', ids: ['asset-a'] }), { code: 'SITE_SESSION_NOT_FOUND' });
  await assert.rejects(sessions.importSelected({ ...target, ids: ['asset-a', 'forged-id'] }), { code: 'SITE_SELECTION_INVALID' });
  assert.equal(writes, 0);
  await sessions.importSelected({ ...target, ids: ['asset-a', 'asset-a'] });
  assert.equal(writes, 1);
  await assert.rejects(sessions.importSelected({ ...target, ids: ['asset-a'] }), { code: 'SITE_ASSET_ALREADY_SUBMITTED' });
  assert.equal(writes, 1);
});

test('keeps successful IDs and blocks unknown writes from replay while leaving unsubmitted assets untouched', async () => {
  const C = { ...A, id: 'asset-c' };
  const writes = [];
  const sessions = new SiteImportSessions({ discover: async () => ({ assets: [A, B, C] }), ensureLibraryPath: async () => {}, addAsset: async ({ asset }) => {
    writes.push(asset.id);
    if (asset.id === B.id) throw new Error('timeout after submission');
    return 'EAGLE-A';
  } });
  await sessions.start(target);
  const result = await sessions.importSelected({ ...target, ids: [A.id, B.id, C.id] });
  assert.deepEqual(result.ids, ['EAGLE-A']);
  assert.deepEqual(result.unknown, [B.id]);
  assert.deepEqual(result.notSubmitted, [C.id]);
  assert.equal(result.partial, true);
  await assert.rejects(sessions.importSelected({ ...target, ids: [B.id] }), { code: 'SITE_ASSET_ALREADY_SUBMITTED' });
  assert.deepEqual(writes, [A.id, B.id]);
});

test('preflight library or folder failure reports unsubmitted items and performs no write', async () => {
  let changed = false;
  let writes = 0;
  const sessions = new SiteImportSessions({ discover: async () => ({ assets: [A] }), ensureLibraryPath: async () => {
    if (changed) throw Object.assign(new Error('library changed'), { code: 'LIBRARY_CHANGED' });
  }, addAsset: async () => { writes++; return 'ID'; } });
  await sessions.start(target);
  changed = true;
  const result = await sessions.importSelected({ ...target, ids: [A.id] });
  assert.equal(result.count, 0);
  assert.deepEqual(result.notSubmitted, [A.id]);
  assert.deepEqual(result.unknown, []);
  assert.equal(result.error.code, 'LIBRARY_CHANGED');
  assert.equal(writes, 0);
});

test('serializes session operations and cancellation during an in-flight write stops only subsequent submissions', async () => {
  let release;
  const started = new Promise(resolve => { release = resolve; });
  let finish;
  const pendingWrite = new Promise(resolve => { finish = resolve; });
  const writes = [];
  const sessions = new SiteImportSessions({ discover: async () => ({ assets: [A, B], nextPage: 2 }), ensureLibraryPath: async () => {}, addAsset: async ({ asset }) => {
    writes.push(asset.id); release(); return pendingWrite;
  } });
  await sessions.start(target);
  const run = sessions.importSelected({ ...target, ids: [A.id, B.id] });
  await started;
  await assert.rejects(sessions.importSelected({ ...target, ids: [B.id] }), { code: 'SITE_SESSION_BUSY' });
  await assert.rejects(sessions.next(target), { code: 'SITE_SESSION_BUSY' });
  assert.equal(sessions.cancel(target).canceled, true);
  finish('EAGLE-A');
  const result = await run;
  assert.deepEqual(result.ids, ['EAGLE-A']);
  assert.deepEqual(result.notSubmitted, [B.id]);
  assert.equal(result.canceled, true);
  assert.deepEqual(writes, [A.id]);
});

test('continuation retains the original target, deduplicates prior assets, and discovery cancellation never submits', async () => {
  const calls = [];
  const sessions = new SiteImportSessions({ discover: async options => {
    calls.push(options);
    return options.startPage === 1 ? { assets: [A], nextPage: 2 } : { assets: [A, B], nextPage: null, complete: true };
  }, ensureLibraryPath: async () => {}, addAsset: async () => 'ID' });
  await sessions.start(target);
  const next = await sessions.next({ ...target, libraryPath: '/Other.library', folderId: 'OTHER', url: 'https://other.test/' });
  assert.equal(calls[1].url, target.url);
  assert.equal(calls[1].startPage, 2);
  assert.equal(next.totalAssets, 2);
  assert.deepEqual(next.assets.map(asset => asset.id), [B.id]);
  const waiting = new SiteImportSessions({ discover: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'ABORT_ERR' })), { once: true })), ensureLibraryPath: async () => {}, addAsset: async () => assert.fail('must not import') });
  const pending = waiting.start(target);
  await new Promise(resolve => setImmediate(resolve));
  waiting.cancel(target);
  await assert.rejects(pending, { code: 'ABORT_ERR' });
});

test('expires idle tasks, bounds session/asset counts, and rejects empty task identities', async () => {
  let now = 100;
  const sessions = new SiteImportSessions({ now: () => now, ttlMs: 10, maxSessions: 1, maxAssets: 1,
    discover: async () => ({ assets: [A, B], nextPage: 2 }), ensureLibraryPath: async () => {}, addAsset: async () => 'ID' });
  await assert.rejects(sessions.start({ ...target, requestId: '' }), { code: 'SITE_SESSION_INVALID' });
  const result = await sessions.start(target);
  assert.equal(result.assets.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.nextPage, null);
  await assert.rejects(sessions.start({ ...target, requestId: 'another' }), { code: 'SITE_SESSION_LIMIT' });
  now = 111;
  await assert.rejects(sessions.importSelected({ ...target, ids: [A.id] }), { code: 'SITE_SESSION_EXPIRED' });
  await sessions.start({ ...target, requestId: 'another' });
});

test('a refresh failure or missing returned ID never erases committed evidence or makes unknown assets replayable', async () => {
  const sessions = new SiteImportSessions({ discover: async () => ({ assets: [A, B] }), ensureLibraryPath: async () => {},
    addAsset: async ({ asset }) => asset.id === A.id ? { id: 'EAGLE-A' } : {},
    refresh: async () => { throw new Error('refresh disconnected'); } });
  await sessions.start(target);
  const first = await sessions.importSelected({ ...target, ids: [A.id] });
  assert.deepEqual(first.ids, ['EAGLE-A']);
  assert.equal(first.partial, true);
  assert.equal(first.error.code, 'SITE_REFRESH_FAILED');
  const unknown = await sessions.importSelected({ ...target, ids: [B.id] });
  assert.deepEqual(unknown.unknown, [B.id]);
  await assert.rejects(sessions.importSelected({ ...target, ids: [B.id] }), { code: 'SITE_ASSET_ALREADY_SUBMITTED' });
});

test('checks library identity again after asynchronous folder validation before the first write', async () => {
  let switched = false;
  let writes = 0;
  const sessions = new SiteImportSessions({ discover: async () => ({ assets: [A] }),
    ensureLibraryPath: async () => { if (switched) throw Object.assign(new Error('changed'), { code: 'LIBRARY_CHANGED' }); },
    ensureDestination: async () => { switched = true; },
    addAsset: async () => { writes++; return 'ID'; } });
  await sessions.start(target);
  const result = await sessions.importSelected({ ...target, ids: [A.id] });
  assert.equal(writes, 0);
  assert.deepEqual(result.notSubmitted, [A.id]);
  assert.equal(result.error.code, 'LIBRARY_CHANGED');
});
