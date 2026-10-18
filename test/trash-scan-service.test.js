'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrashScanService } = require('../lib/trash-scan-service');

test('shares one scan among concurrent trash readers and caches its result', async () => {
  let readdirCalls = 0;
  let readFileCalls = 0;
  const fs = {
    async readdir() {
      readdirCalls += 1;
      return [{ name: 'A.info', isDirectory: () => true }];
    },
    async readFile(_path, options) {
      readFileCalls += 1;
      assert.equal(options.encoding, 'utf8');
      assert.ok(options.signal instanceof AbortSignal);
      await new Promise(resolve => setTimeout(resolve, 5));
      return JSON.stringify({ id: 'A', isDeleted: true, modificationTime: 1 });
    }
  };
  const service = createTrashScanService({ fs, cacheTtlMs: 1000 });
  const [first, second] = await Promise.all([service.read('/Mock.library'), service.read('/Mock.library')]);
  assert.deepEqual(first, [{ id: 'A', isDeleted: true, modificationTime: 1 }]);
  assert.deepEqual(second, first);
  await service.read('/Mock.library');
  assert.equal(readdirCalls, 1);
  assert.equal(readFileCalls, 1);
});

test('aborts an overdue trash scan instead of leaving readers running', async () => {
  let aborted = false;
  const fs = {
    async readdir() {
      return [{ name: 'A.info', isDirectory: () => true }];
    },
    async readFile(_path, { signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    }
  };
  const service = createTrashScanService({ fs, timeoutMs: 10 });
  await assert.rejects(service.read('/Mock.library'), error => error.code === 'TRASH_SCAN_TIMEOUT');
  assert.equal(aborted, true);
});

test('aborts an in-flight scan after invalidation and starts a fresh scan', async () => {
  let readdirCalls = 0;
  let readFileCalls = 0;
  let firstReadAborted = false;
  const fs = {
    async readdir() {
      readdirCalls += 1;
      return [{ name: 'A.info', isDirectory: () => true }];
    },
    async readFile(_path, { signal }) {
      readFileCalls += 1;
      if (readFileCalls > 1) return JSON.stringify({ id: 'A', isDeleted: true, modificationTime: 2 });
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          firstReadAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    }
  };
  const service = createTrashScanService({ fs });
  const first = service.read('/Mock.library');
  await new Promise(resolve => setImmediate(resolve));
  service.invalidateAll({ abort: true });
  await assert.rejects(first, error => error.code === 'TRASH_SCAN_INVALIDATED');

  const second = await service.read('/Mock.library');
  assert.deepEqual(second, [{ id: 'A', isDeleted: true, modificationTime: 2 }]);
  assert.equal(firstReadAborted, true);
  assert.equal(readdirCalls, 2);
  assert.equal(readFileCalls, 2);
});

// E-20: the timeout catches a stalled scan, not a slow one that keeps moving.
test('a large scan that keeps making progress outlives the timeout', async () => {
  const names = Array.from({ length: 12 * 8 }, (_, index) => ({ name: `I${index}.info`, isDirectory: () => true }));
  const fs = {
    async readdir() { return names; },
    async readFile(file) {
      await new Promise(resolve => setTimeout(resolve, 8));
      const id = file.match(/I(\d+)\.info/)[1];
      return JSON.stringify({ id, isDeleted: id === '5', modificationTime: 1 });
    }
  };
  // 8 rounds of 8 ms reads take well over the 30 ms stall limit in total.
  const service = createTrashScanService({ fs, timeoutMs: 30 });
  const started = Date.now();
  const items = await service.read('/Mock.library');
  assert.ok(Date.now() - started > 30, 'the scan ran past the stall limit');
  assert.deepEqual(items.map(item => item.id), ['5']);
});

test('a soft invalidation lets the running scan answer its readers', async () => {
  let release;
  let reads = 0;
  const fs = {
    async readdir() { return [{ name: 'A.info', isDirectory: () => true }]; },
    async readFile() {
      reads += 1;
      if (reads === 1) await new Promise(resolve => { release = resolve; });
      return JSON.stringify({ id: 'A', isDeleted: true, modificationTime: reads });
    }
  };
  const service = createTrashScanService({ fs, timeoutMs: 1000 });
  const first = service.read('/Mock.library');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  service.invalidateAll();
  release();
  assert.deepEqual((await first).map(item => item.modificationTime), [1], 'the waiting reader gets its answer');
  assert.deepEqual((await service.read('/Mock.library')).map(item => item.modificationTime), [2], 'a later reader rescans');
});
