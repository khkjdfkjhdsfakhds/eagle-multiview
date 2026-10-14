'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULT_MAX_BYTES } = require('./text-file-service');

// A tombstone only has to outlive a delayed put for the same draft.
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
// Drafts can be written over Web RPC with any draftId; bound the directory so
// a client cannot fill the disk. New drafts are refused, never evicted.
const MAX_DRAFT_FILES = 1000;
const MAX_DRAFT_BYTES = 256 * 1024 * 1024;
const RECORD_NAME = /^[a-f0-9]{32}-[a-f0-9]{64}\.json$/;

class TextDraftStore {
  constructor(root, { maxFiles = MAX_DRAFT_FILES, maxBytes = MAX_DRAFT_BYTES, tombstoneTtlMs = TOMBSTONE_TTL_MS } = {}) {
    this.root = path.resolve(root);
    this.queues = new Map();
    this.limits = { maxFiles, maxBytes, tombstoneTtlMs };
    this.pruned = null;
  }

  key(data) {
    if (!data || !path.isAbsolute(String(data.libraryPath || '')) || !data.id || !data.draftId
      || String(data.id).length > 256 || String(data.draftId).length > 512 || data.libraryPath.length > 4096) {
      throw new Error('TXT 草稿身份无效');
    }
    const group = crypto.createHash('sha256').update(JSON.stringify([path.resolve(data.libraryPath), String(data.id)])).digest('hex').slice(0, 32);
    return `${group}-` + crypto.createHash('sha256').update(JSON.stringify([
      path.resolve(data.libraryPath), String(data.id), String(data.draftId)
    ])).digest('hex');
  }

  enqueue(key, task) {
    const next = (this.queues.get(key) || Promise.resolve()).catch(() => {}).then(task);
    this.queues.set(key, next);
    return next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
  }

  async read(key) {
    try { return JSON.parse(await fs.readFile(path.join(this.root, `${key}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('TXT 草稿读取失败，已保留原记录', { cause: error }); }
  }

  async write(key, record) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = path.join(this.root, `${key}.json`);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, target);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  async names() {
    try { return (await fs.readdir(this.root)).filter(name => RECORD_NAME.test(name)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  // Drops tombstones older than their TTL. Runs once per store on first use.
  async prune(now = Date.now()) {
    for (const name of await this.names()) {
      const key = name.slice(0, -5);
      await this.enqueue(key, async () => {
        let record;
        try { record = await this.read(key); } catch { return; }
        if (record?.removed && now - (Number(record.updatedAt) || 0) > this.limits.tombstoneTtlMs) {
          await fs.unlink(path.join(this.root, name)).catch(() => {});
        }
      });
    }
  }

  pruneOnce() {
    this.pruned ||= this.prune().catch(() => {});
    return this.pruned;
  }

  // Every operation waits for the one-time prune, then queues per key; all of
  // them chain on the same promise, so their relative order is kept.
  queued(key, task) {
    return this.pruneOnce().then(() => this.enqueue(key, task));
  }

  async assertRoomForNewDraft(bytes) {
    const names = await this.names();
    let total = bytes;
    for (const name of names) {
      const stat = await fs.stat(path.join(this.root, name)).catch(() => null);
      total += stat?.size || 0;
    }
    if (names.length + 1 > this.limits.maxFiles || total > this.limits.maxBytes) {
      throw new Error('TXT 草稿备份空间已满，请先保存或放弃其他未保存的文本');
    }
  }

  get(data) {
    const key = this.key(data);
    return this.queued(key, async () => {
      const value = await this.read(key);
      return value?.removed ? null : value;
    });
  }

  async list(data) {
    const prefix = this.key({ ...data, draftId: '_' }).slice(0, 33);
    await this.pruneOnce();
    const names = await this.names();
    const records = await Promise.all(names.filter(name => name.startsWith(prefix)).map(name => {
      const key = name.slice(0, -5);
      return this.queued(key, () => this.read(key));
    }));
    return records.filter(record => record && !record.removed && record.libraryPath === path.resolve(data.libraryPath) && record.id === String(data.id))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  put(data) {
    const key = this.key(data);
    if (!Number.isSafeInteger(data.revision) || data.revision < 0 || typeof data.content !== 'string'
      || Buffer.byteLength(data.content, 'utf8') > DEFAULT_MAX_BYTES) throw new Error('TXT 草稿版本或内容无效');
    const record = {
      version: 1, libraryPath: path.resolve(data.libraryPath), id: String(data.id), draftId: String(data.draftId),
      revision: data.revision, content: data.content, base: data.base ? structuredClone(data.base) : null, updatedAt: Date.now()
    };
    return this.queued(key, async () => {
      const current = await this.read(key);
      if (current && current.revision >= record.revision) return current.removed ? null : current;
      if (!current) {
        await this.assertRoomForNewDraft(Buffer.byteLength(JSON.stringify(record), 'utf8'));
      }
      await this.write(key, record);
      return record;
    });
  }

  remove(data) {
    const key = this.key(data);
    if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('TXT 草稿删除版本无效');
    return this.queued(key, async () => {
      const current = await this.read(key);
      if (current && current.revision > data.revision) return false;
      // Nothing can be resurrected when nothing was written: opening a clean
      // TXT removes a fresh draftId at revision 0 every time (S-03).
      if (!current && data.revision === 0) return true;
      if (current?.removed && current.revision === data.revision) return true;
      // Keep a tiny tombstone so a delayed IPC put cannot resurrect saved text.
      await this.write(key, { version: 1, removed: true, revision: data.revision, updatedAt: Date.now() });
      return true;
    });
  }
}

module.exports = { TextDraftStore, TOMBSTONE_TTL_MS, MAX_DRAFT_FILES, MAX_DRAFT_BYTES };
