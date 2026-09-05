'use strict';

const path = require('node:path');

function timeoutError() {
  const error = new Error('回收站读取超时，请点击刷新重试');
  error.code = 'TRASH_SCAN_TIMEOUT';
  return error;
}

function invalidatedError() {
  const error = new Error('回收站数据已变化，正在重新读取');
  error.code = 'TRASH_SCAN_INVALIDATED';
  return error;
}

function createTrashScanService({ fs, timeoutMs = 8000, concurrency = 12, cacheTtlMs = 5000, now = () => Date.now() }) {
  const cache = new Map();
  const scans = new Map();
  let generation = 0;

  function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || timeoutError();
  }

  async function scan(libraryPath, signal) {
    const imagesRoot = path.join(libraryPath, 'images');
    const entries = await fs.readdir(imagesRoot, { withFileTypes: true });
    throwIfAborted(signal);
    const metadataPaths = entries
      .filter(entry => entry.isDirectory() && entry.name.endsWith('.info'))
      .map(entry => path.join(imagesRoot, entry.name, 'metadata.json'));
    const items = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < metadataPaths.length) {
        throwIfAborted(signal);
        const metadataPath = metadataPaths[cursor++];
        try {
          const item = JSON.parse(await fs.readFile(metadataPath, { encoding: 'utf8', signal }));
          if (item?.isDeleted === true && item.id) items.push(item);
        } catch (error) {
          if (signal?.aborted) throw signal.reason || error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, metadataPaths.length) }, worker));
    throwIfAborted(signal);
    items.sort((left, right) => (right.modificationTime || right.mtime || 0) - (left.modificationTime || left.mtime || 0));
    return items;
  }

  function startScan(libraryPath) {
    const controller = new AbortController();
    const entry = { controller, generation, promise: null };
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason || timeoutError());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
    // readdir has no AbortSignal support: settle callers independently of
    // the underlying I/O. A late scan only observes abort and never caches.
    entry.promise = Promise.race([scan(libraryPath, controller.signal), aborted])
      .finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        if (scans.get(libraryPath) === entry) scans.delete(libraryPath);
      });
    scans.set(libraryPath, entry);
    return entry;
  }

  async function read(libraryPath) {
    const cached = cache.get(libraryPath);
    if (cached && cached.expiresAt > now()) return cached.items;
    const scanGeneration = generation;
    const existing = scans.get(libraryPath);
    // Soft invalidation may let its original readers finish, but a new
    // reader must not promote that pre-invalidation result into fresh cache.
    const entry = existing?.generation === generation ? existing : startScan(libraryPath);
    const items = await entry.promise;
    if (generation === scanGeneration) cache.set(libraryPath, { expiresAt: now() + cacheTtlMs, items });
    return items;
  }

  function invalidateAll({ abort = false } = {}) {
    generation += 1;
    cache.clear();
    if (!abort) return;
    for (const entry of scans.values()) entry.controller.abort(invalidatedError());
    scans.clear();
  }

  return { read, invalidateAll };
}

module.exports = { createTrashScanService };
