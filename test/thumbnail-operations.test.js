'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ThumbnailOperations } = require('../lib/thumbnail-operations');

const LIBRARY = '/synthetic/thumbnail-fixtures.library';

function fixture(overrides = {}) {
  const writes = [];
  const published = [];
  const invalidated = [];
  const client = {
    async getItem(id) { return { id, name: `item ${id}` }; },
    async setCustomThumbnail(id, filePath) { writes.push({ id, filePath }); return true; },
    async refreshThumbnail(id) { writes.push({ id, operation: 'refresh' }); return true; },
    ...overrides.client
  };
  const service = new ThumbnailOperations({
    client,
    ensureLibraryPath: overrides.ensureLibraryPath || (async () => {}),
    publishItemMutation: async (item, context) => published.push({ item, context }),
    invalidateThumbnail: async (id, context) => invalidated.push({ id, context }),
    ...overrides.options
  });
  return { service, writes, published, invalidated };
}

test('setting a selected file thumbnail publishes the completed item without changing its original', async () => {
  const f = fixture();
  const result = await f.service.run({ ids: ['A'], libraryPath: LIBRARY, operation: 'file', filePath: '/synthetic/cover.png', origin: 7 });
  assert.equal(result.outcomes[0].status, 'completed');
  assert.equal(result.counts.completed, 1);
  assert.deepEqual(f.writes, [{ id: 'A', filePath: '/synthetic/cover.png' }]);
  assert.equal(f.published[0].item.id, 'A');
  assert.equal(f.published[0].context.libraryPath, LIBRARY);
  assert.equal(f.published[0].context.origin, 7);
  assert.equal(f.invalidated[0].id, 'A');
});

test('a generation timeout is unconfirmed, while later selected items still complete without replay', async () => {
  const attempts = [];
  const f = fixture({ client: { async setCustomThumbnail(id) { attempts.push(id); return id !== 'A'; } } });
  const result = await f.service.run({ ids: ['A', 'B'], libraryPath: LIBRARY, operation: 'clipboard', filePath: '/synthetic/paste.png' });
  assert.deepEqual(result.outcomes.map(x => [x.id, x.status]), [['A', 'unknown'], ['B', 'completed']]);
  assert.equal(result.counts.unknown, 1);
  assert.equal(result.counts.completed, 1);
  assert.deepEqual(attempts, ['A', 'B']);
  assert.deepEqual(f.published.map(x => x.item.id), ['B']);
});

test('refresh acceptance is distinct from completion and missing items fail independently', async () => {
  const attempts = [];
  const f = fixture({ client: { async refreshThumbnail(id) { attempts.push(id); return id !== 'B'; } } });
  const result = await f.service.run({ ids: ['A', 'B'], libraryPath: LIBRARY, operation: 'refresh' });
  assert.deepEqual(result.outcomes.map(x => x.status), ['accepted', 'failed']);
  assert.equal(result.counts.completed, 0);
  assert.deepEqual(attempts, ['A', 'B']);
  assert.deepEqual(f.published, []);
  assert.deepEqual(f.invalidated, []);
});

test('transport failures and failed readback report uncertain outcomes without repeating a write', async () => {
  const attempts = [];
  const f = fixture({ client: {
    async setCustomThumbnail(id) { attempts.push(id); if (id === 'A') throw new Error('connection lost'); return true; },
    async getItem(id) { if (id === 'B') throw new Error('readback unavailable'); return { id }; }
  } });
  const result = await f.service.run({ ids: ['A', 'B', 'C'], libraryPath: LIBRARY, operation: 'file', filePath: '/synthetic/cover.png' });
  assert.deepEqual(result.outcomes.map(x => [x.status, x.phase]), [['unknown', 'write'], ['unknown', 'readback'], ['completed', 'complete']]);
  assert.equal(result.outcomes[1].writeCompleted, true);
  assert.deepEqual(attempts, ['A', 'B', 'C']);
  assert.deepEqual(f.published.map(x => x.item.id), ['C']);
});

test('selection and source are frozen before asynchronous work and duplicate IDs write only once', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = fixture({ ensureLibraryPath: async () => barrier });
  const request = { ids: ['A', 'A', 'B'], libraryPath: LIBRARY, operation: 'file', filePath: '/synthetic/first.png' };
  const pending = f.service.run(request);
  request.ids.push('C');
  request.ids[0] = 'X';
  request.filePath = '/synthetic/later.png';
  release();
  const result = await pending;
  assert.deepEqual(result.outcomes.map(x => x.id), ['A', 'B']);
  assert.deepEqual(f.writes, [{ id: 'A', filePath: '/synthetic/first.png' }, { id: 'B', filePath: '/synthetic/first.png' }]);
});

test('unsupported clear and invalid frozen targets are rejected before any Eagle write', async () => {
  const f = fixture();
  const valid = { ids: ['A'], libraryPath: LIBRARY, operation: 'file', filePath: '/synthetic/cover.png' };
  for (const patch of [
    { operation: 'clear' }, { libraryPath: '' }, { libraryPath: 'relative.library' },
    { ids: [] }, { ids: ['A', ''] }, { ids: ['A', null] },
    { ids: Array.from({ length: 501 }, (_, i) => String(i)) }, { filePath: '' }, { filePath: 'relative.png' }
  ]) await assert.rejects(f.service.run({ ...valid, ...patch }), { code: 'INVALID_THUMBNAIL_REQUEST' });
  assert.deepEqual(f.writes, []);
});

test('cancellation stops unstarted items but keeps the outcome of an accepted write', async () => {
  const controller = new AbortController();
  const attempts = [];
  const f = fixture({ client: { async setCustomThumbnail(id) { attempts.push(id); controller.abort(); return true; } } });
  const result = await f.service.run({ ids: ['A', 'B', 'C'], libraryPath: LIBRARY, operation: 'file', filePath: '/synthetic/cover.png', signal: controller.signal });
  assert.deepEqual(result.outcomes.map(x => x.status), ['completed', 'canceled', 'canceled']);
  assert.deepEqual(attempts, ['A']);
  assert.equal(result.counts.canceled, 2);
  assert.equal(f.published.length, 1);
});

test('a library switch during refresh prevents further writes and stale publication', async () => {
  let active = LIBRARY;
  const attempts = [];
  const f = fixture({
    ensureLibraryPath: async expected => {
      if (expected !== active) throw Object.assign(new Error('library changed'), { code: 'LIBRARY_CHANGED' });
    },
    client: { async refreshThumbnail(id) { attempts.push(id); active = '/synthetic/other.library'; return true; } }
  });
  const result = await f.service.run({ ids: ['A', 'B'], libraryPath: LIBRARY, operation: 'refresh' });
  assert.deepEqual(result.outcomes.map(x => [x.status, x.code]), [['unknown', 'LIBRARY_CHANGED'], ['canceled', 'LIBRARY_CHANGED']]);
  assert.deepEqual(attempts, ['A']);
  assert.deepEqual(f.published, []);
});

test('overlapping windows serialize writes to the same item through completion readback', async () => {
  const events = [];
  let finishFirst;
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  const barrier = new Promise(resolve => { finishFirst = resolve; });
  const f = fixture({ client: {
    async setCustomThumbnail(_id, filePath) {
      events.push(filePath);
      if (filePath === '/synthetic/one.png') { firstStarted(); await barrier; }
      return true;
    },
    async getItem(id) { events.push('readback'); return { id }; }
  } });
  const request = { ids: ['A'], libraryPath: LIBRARY, operation: 'file' };
  const first = f.service.run({ ...request, filePath: '/synthetic/one.png' });
  await started;
  const second = f.service.run({ ...request, filePath: '/synthetic/two.png' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['/synthetic/one.png']);
  finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['/synthetic/one.png', 'readback', '/synthetic/two.png', 'readback']);
});

test('unexpected readback IDs cannot publish another item as the selected thumbnail', async () => {
  const f = fixture({ client: { async getItem() { return { id: 'OTHER' }; } } });
  const result = await f.service.run({ ids: ['A'], libraryPath: LIBRARY, operation: 'file', filePath: '/synthetic/cover.png' });
  assert.equal(result.outcomes[0].status, 'unknown');
  assert.equal(result.outcomes[0].writeCompleted, true);
  assert.equal(result.outcomes[0].code, 'READBACK_MISMATCH');
  assert.deepEqual(f.published, []);
  assert.deepEqual(f.invalidated, []);
});
