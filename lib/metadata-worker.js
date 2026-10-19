'use strict';

// E-02: generation metadata is parsed in worker threads, so a crafted or
// huge file — inflating text chunks, scanning prompt text — cannot stall the
// main process. A read that takes too long is given up and its worker
// replaced; a worker that cannot start at all (no worker support where the
// app runs) falls back to reading in the main process, as before.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const ROLE = 'eaglemv-metadata';

if (!isMainThread && workerData?.role === ROLE) {
  const { readMetadata } = require('./metadata-reader');
  parentPort.on('message', async ({ id, filePath, ext }) => {
    try {
      parentPort.postMessage({ id, metadata: await readMetadata(filePath, ext) });
    } catch (error) {
      parentPort.postMessage({ id, error: error?.message || String(error) });
    }
  });
  parentPort.postMessage({ ready: true });
}

function createMetadataWorkerReader({
  size = 2,
  timeoutMs = 20000,
  readInProcess = (...args) => require('./metadata-reader').readMetadata(...args),
  WorkerClass = Worker,
  workerOptions = { resourceLimits: { maxOldGenerationSizeMb: 256 } }
} = {}) {
  const slots = Array.from({ length: Math.max(1, size) }, () => ({ worker: null, ready: false, job: null }));
  const queue = [];
  let sequence = 0;
  let unavailable = false;
  let closed = false;

  const settle = (slot, error, metadata) => {
    const job = slot.job;
    if (!job) return;
    slot.job = null;
    clearTimeout(job.timer);
    if (error) job.reject(error);
    else job.resolve(metadata ?? null);
    dispatch();
  };

  const retire = (slot, worker) => {
    if (slot.worker !== worker) return;
    slot.worker = null;
    slot.ready = false;
    worker.terminate?.().catch?.(() => {});
  };

  // A worker that dies before saying it is ready never will: read in this
  // process from now on, starting with the job it was given.
  const failedToStart = (slot, worker) => {
    retire(slot, worker);
    unavailable = true;
    const job = slot.job;
    slot.job = null;
    if (job) {
      clearTimeout(job.timer);
      readInProcess(job.filePath, job.ext).then(job.resolve, job.reject);
    }
    dispatch();
  };

  const spawn = slot => {
    let worker;
    try {
      worker = new WorkerClass(__filename, { ...workerOptions, workerData: { role: ROLE } });
    } catch {
      unavailable = true;
      return false;
    }
    slot.worker = worker;
    slot.ready = false;
    worker.unref?.();
    worker.on('message', message => {
      if (slot.worker !== worker) return;
      if (message?.ready) { slot.ready = true; return; }
      if (slot.job?.id === message?.id) settle(slot, message.error ? new Error(message.error) : null, message.metadata);
    });
    const lost = reason => {
      if (slot.worker !== worker) return;
      if (!slot.ready) return failedToStart(slot, worker);
      retire(slot, worker);
      settle(slot, new Error(reason));
    };
    worker.on('error', error => lost(`读取元数据失败：${error?.message || error}`));
    worker.on('exit', () => lost('读取元数据的进程已退出'));
    return true;
  };

  function dispatch() {
    while (queue.length) {
      if (unavailable || closed) {
        const job = queue.shift();
        if (closed) job.reject(new Error('元数据读取已停止'));
        else readInProcess(job.filePath, job.ext).then(job.resolve, job.reject);
        continue;
      }
      const slot = slots.find(candidate => !candidate.job);
      if (!slot) return;
      if (!slot.worker && !spawn(slot)) continue;
      const job = queue.shift();
      slot.job = job;
      job.timer = setTimeout(() => {
        if (slot.job !== job) return;
        retire(slot, slot.worker);
        settle(slot, new Error('读取元数据超时'));
      }, timeoutMs);
      job.timer.unref?.();
      slot.worker.postMessage({ id: job.id, filePath: job.filePath, ext: job.ext });
    }
  }

  function readMetadata(filePath, ext) {
    if (!filePath) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      queue.push({ id: ++sequence, filePath, ext, resolve, reject, timer: null });
      dispatch();
    });
  }

  readMetadata.close = () => {
    closed = true;
    for (const slot of slots) {
      if (slot.worker) retire(slot, slot.worker);
      settle(slot, new Error('元数据读取已停止'));
    }
    dispatch();
  };
  return readMetadata;
}

module.exports = { createMetadataWorkerReader };
