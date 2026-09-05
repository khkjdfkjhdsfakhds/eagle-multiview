'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULT_MAX_BYTES } = require('./text-file-service');

class TextDraftStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.queues = new Map();
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

  get(data) {
    const key = this.key(data);
    return this.enqueue(key, async () => {
      const value = await this.read(key);
      return value?.removed ? null : value;
    });
  }

  async list(data) {
    const prefix = this.key({ ...data, draftId: '_' }).slice(0, 33);
    let names;
    try { names = await fs.readdir(this.root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = await Promise.all(names.filter(name => name.startsWith(prefix) && /^[a-f0-9]{32}-[a-f0-9]{64}\.json$/.test(name)).map(name => {
      const key = name.slice(0, -5);
      return this.enqueue(key, () => this.read(key));
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
    return this.enqueue(key, async () => {
      const current = await this.read(key);
      if (current && current.revision >= record.revision) return current.removed ? null : current;
      await this.write(key, record);
      return record;
    });
  }

  remove(data) {
    const key = this.key(data);
    if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('TXT 草稿删除版本无效');
    return this.enqueue(key, async () => {
      const current = await this.read(key);
      if (current && current.revision > data.revision) return false;
      // Keep a tiny tombstone so a delayed IPC put cannot resurrect saved text.
      await this.write(key, { version: 1, removed: true, revision: data.revision, updatedAt: Date.now() });
      return true;
    });
  }
}

module.exports = { TextDraftStore };
