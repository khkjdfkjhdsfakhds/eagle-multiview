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
