'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_BYTES = 5 * 1024 * 1024;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

async function readVersion(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('TXT 原文件无效或超过 5 MB');
  const bytes = await fs.readFile(file);
  if (bytes.length > MAX_BYTES || bytes.includes(0)) throw new Error('TXT 正文格式无效');
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { content, fingerprint: { hash: hash(bytes), size: bytes.length, mtimeMs: stat.mtimeMs } };
}

function createSaveHandler({ eagle, stagingRoot, timeoutMs = 8000, lookupTimeoutMs = 5000 }) {
  const pending = new Map();
  const unknown = message => ({ status: 'unknown', message: message || 'TXT 文件替换仍在进行或结果待确认，草稿已保留' });
  function assertLibrary(request) {
    if (!request.libraryPath || path.resolve(eagle.library.path || '.') !== path.resolve(request.libraryPath)) {
      throw new Error('Eagle 已切换资料库，TXT 草稿已保留');
    }
  }
  async function hasTemporary(original) {
    try { await fs.lstat(`${original}.tmp`); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function boundedRead(operation) {
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('TXT 只读检查超时，草稿已保留')), lookupTimeoutMs); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async function releaseCompletedOwner(key) {
    const owner = pending.get(key);
    if (!owner?.original || await hasTemporary(owner.original)) return false;
    const current = await readVersion(owner.original);
    if (owner.settled || current.fingerprint.hash === owner.outputHash) {
      if (pending.get(key) === owner) pending.delete(key);
      return true;
    }
    return false;
  }
  return async function save(request) {
    if (!request || !/^[\w-]{1,128}$/.test(String(request.id || '')) || !request.requestId) throw new Error('TXT 保存身份无效');
    const reconciling = request.operation === 'reconcile';
    if (request.operation && !['replace', 'reconcile'].includes(request.operation)) throw new Error('TXT 操作无效');
    const key = `${path.resolve(request.libraryPath)}\0${request.id}`;
    try { assertLibrary(request); } catch (error) { if (reconciling) return unknown(error.message); throw error; }
    if (pending.has(key)) {
      await boundedRead(releaseCompletedOwner(key)).catch(() => false);
      if (pending.has(key)) return unknown('该 TXT 的上次文件替换仍待确认，正在只读核对；草稿已保留');
    }
    // Mark ownership before any await, including the official item lookup.
    const owner = { settled: false, outputHash: request.outputHash };
    pending.set(key, owner);
    let keepPending = false;
    try {
      const item = await boundedRead(eagle.item.getById(request.id));
      assertLibrary(request);
      if (!item || item.id !== request.id || String(item.ext).toLowerCase() !== 'txt' || item.isDeleted) throw new Error('指定 TXT 不存在或已在回收站');
      const library = await boundedRead(fs.realpath(request.libraryPath));
      const original = await boundedRead(fs.realpath(item.filePath));
      const itemRoot = `${path.join(library, 'images', `${request.id}.info`)}${path.sep}`;
      if (!original.startsWith(itemRoot)) throw new Error('TXT 原文件不属于指定素材');
      if (await boundedRead(hasTemporary(original))) return unknown('Eagle 仍有未完成的 TXT 替换临时文件，草稿已保留');
      const current = await boundedRead(readVersion(original));
      assertLibrary(request);
      if (reconciling) {
        // No staged candidate is needed and no write is performed. A fresh
        // plugin session has no old JS transaction; a surviving session must
        // first prove its local owner completed via releaseCompletedOwner.
        if (current.fingerprint.hash === request.outputHash) return { conflict: false, fingerprint: current.fingerprint, status: 'written_pending_refresh' };
        // An unconsumed candidate must be retired by the client before a
        // fresh session declares an old job uncommitted. This prevents
        // unlocking while a previously leased preflight can still use it.
        const candidatePath = path.resolve(String(request.stagedPath || ''));
        if (!candidatePath.startsWith(`${path.resolve(stagingRoot)}${path.sep}`)) return unknown('TXT 旧任务暂存身份待核对');
        try {
          await boundedRead(fs.lstat(candidatePath));
          return unknown('TXT 旧任务候选仍在等待清理，草稿已保留');
        } catch (error) { if (error.code !== 'ENOENT') return unknown(error.message); }
        if (current.fingerprint.hash === request.base?.hash && current.fingerprint.size === request.base?.size) return { status: 'not_committed' };
        return { conflict: true, current };
      }
      const stageRoot = await boundedRead(fs.realpath(stagingRoot));
      const stage = await boundedRead(fs.realpath(request.stagedPath));
      if (!stage.startsWith(`${stageRoot}${path.sep}`) || path.extname(stage).toLowerCase() !== '.txt'
        || stage.startsWith(`${library}${path.sep}`)) throw new Error('TXT 候选文件超出应用暂存范围');
      const candidate = await boundedRead(readVersion(stage));
      if (!candidate.content.length) throw new Error('Eagle 暂不提交空正文，草稿已保留');
      if (candidate.fingerprint.hash !== request.outputHash) throw new Error('TXT 候选内容版本不符，草稿已保留');
      // Identical bytes are a no-op, not evidence that an unstarted replace
      // operation has completed. Never invoke the SDK for this case.
      if (candidate.fingerprint.hash === current.fingerprint.hash) return { conflict: false, fingerprint: current.fingerprint, status: 'saved' };
      if (!request.base || current.fingerprint.hash !== request.base.hash || current.fingerprint.size !== request.base.size) return { conflict: true, current };
      assertLibrary(request);
      // This is the only library mutation in this plugin. No fs write, rename,
      // open-item, select-item, window.show or focus fallback is permitted here.
      owner.original = original;
      const operation = Promise.resolve().then(() => item.replaceFile(stage));
      keepPending = true;
      operation.then(() => { owner.settled = true; }, () => { owner.settled = true; });
      let timer;
      let outcome;
      try {
        outcome = await Promise.race([
          operation.then(() => ({ completed: true }), error => ({ error })),
          new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); })
        ]);
      } finally { clearTimeout(timer); }
      assertLibrary(request);
      const after = await boundedRead(readVersion(original));
      if (await boundedRead(hasTemporary(original))) return unknown('Eagle 仍有未完成的 TXT 替换临时文件，草稿已保留');
      if (after.fingerprint.hash === candidate.fingerprint.hash) {
        keepPending = false;
        return { conflict: false, fingerprint: after.fingerprint, status: outcome.completed ? 'saved' : 'written_pending_refresh' };
      }
      if (outcome.timedOut) return unknown();
      keepPending = false;
      if (outcome.error) throw new Error(`Eagle TXT 保存失败：${outcome.error.message || '未知错误'}`);
      return { conflict: true, current: after };
    } catch (error) {
      if (keepPending || reconciling) return unknown(error.message);
      throw error;
    } finally {
      if (!keepPending && pending.get(key) === owner) pending.delete(key);
    }
  };
}

module.exports = { createSaveHandler };
