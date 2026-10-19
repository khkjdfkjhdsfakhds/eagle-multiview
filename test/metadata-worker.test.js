'use strict';
// E-02: metadata parsing in worker threads — same result as in process, a
// read that hangs is given up and its worker replaced, and a worker that
// cannot start falls back to reading in process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createMetadataWorkerReader } = require('../lib/metadata-worker');
const { readMetadata } = require('../lib/metadata-reader');

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

test('a real worker reads what the main process would', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-metadata-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.png');
  const parameters = 'a cat, masterpiece\nNegative prompt: blurry\nSteps: 28, Sampler: Euler a, CFG scale: 7, Seed: 42, Size: 512x768, Model: test';
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('tEXt', Buffer.concat([Buffer.from('parameters\0', 'latin1'), Buffer.from(parameters)])),
    pngChunk('IEND', Buffer.alloc(0))
  ]));
  const read = createMetadataWorkerReader({ size: 1 });
  t.after(() => read.close());
  const [fromWorker, fromProcess] = await Promise.all([read(file, 'png'), readMetadata(file, 'png')]);
  assert.equal(fromWorker?.positive, 'a cat, masterpiece');
  assert.deepEqual(fromWorker, fromProcess);
  await assert.rejects(read(path.join(dir, 'missing.png'), 'png'), /ENOENT|no such file/);
  assert.equal(await read('', 'png'), null);
});

// A stand-in worker the test drives by hand.
function fakeWorkers() {
  const made = [];
  class FakeWorker extends EventEmitter {
    constructor() { super(); this.posted = []; this.terminated = false; made.push(this); }
    postMessage(message) { this.posted.push(message); }
    terminate() { this.terminated = true; return Promise.resolve(0); }
    unref() {}
  }
  return { FakeWorker, made };
}

test('a hung read times out and the next read gets a fresh worker', async () => {
  const { FakeWorker, made } = fakeWorkers();
  const read = createMetadataWorkerReader({ size: 1, timeoutMs: 30, WorkerClass: FakeWorker, readInProcess: async () => 'in-process' });
  const hung = read('/a.png', 'png');
  made[0].emit('message', { ready: true });
  await assert.rejects(hung, /读取元数据超时/);
  assert.equal(made[0].terminated, true);
  const next = read('/b.png', 'png');
  assert.equal(made.length, 2);
  made[1].emit('message', { ready: true });
  made[1].emit('message', { id: made[1].posted[0].id, metadata: { prompt: 'b' } });
  assert.deepEqual(await next, { prompt: 'b' });
});

test('reads queue behind busy workers and a crash fails only its own read', async () => {
  const { FakeWorker, made } = fakeWorkers();
  const read = createMetadataWorkerReader({ size: 2, WorkerClass: FakeWorker, readInProcess: async () => 'in-process' });
  const reads = ['/1', '/2', '/3'].map(file => read(file, 'png'));
  assert.equal(made.length, 2, 'never more workers than the pool');
  for (const worker of made) worker.emit('message', { ready: true });
  made[0].emit('error', new Error('out of memory'));
  await assert.rejects(reads[0], /out of memory/);
  made[1].emit('message', { id: made[1].posted[0].id, metadata: 2 });
  assert.equal(await reads[1], 2);
  const third = made.find(worker => worker.posted.some(message => message.filePath === '/3'));
  third.emit('message', { ready: true });
  third.emit('message', { id: third.posted.at(-1).id, metadata: 3 });
  assert.equal(await reads[2], 3);
});

test('a worker that cannot start falls back to reading in process', async () => {
  const { FakeWorker, made } = fakeWorkers();
  const reported = [];
  const read = createMetadataWorkerReader({ size: 1, WorkerClass: FakeWorker, readInProcess: async file => `in-process ${file}`, onUnavailable: error => reported.push(error.message) });
  const first = read('/a.png', 'png');
  made[0].emit('error', new Error('Cannot find module'));
  assert.deepEqual(reported, ['Cannot find module'], 'reported once');
  assert.equal(await first, 'in-process /a.png');
  assert.equal(await read('/b.png', 'png'), 'in-process /b.png');
  assert.equal(made.length, 1, 'no further workers are tried');
});
