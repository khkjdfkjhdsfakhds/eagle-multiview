'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

class SupplementalItemStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 1, libraries: {} };
    this.loaded = false;
    this.loading = null;
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    if (!this.loading) this.loading = (async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
        if (parsed?.version === 1 && parsed.libraries && typeof parsed.libraries === 'object') this.data = parsed;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.loaded = true;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  key(libraryPath) {
    return path.resolve(libraryPath);
  }

  async get(libraryPath) {
    await this.load();
    await this.queue;
    return [...new Set(this.data.libraries[this.key(libraryPath)] || [])];
  }

  set(libraryPath, ids) {
    return this.transact(libraryPath, () => ids || []);
  }

  add(libraryPath, ids) {
    return this.transact(libraryPath, current => [...current, ...(ids || [])]);
  }

  async remove(libraryPath, ids) {
    const removed = new Set(ids || []);
    return this.transact(libraryPath, current => current.filter(id => !removed.has(id)));
  }

  transact(libraryPath, update) {
    const operation = this.queue.then(async () => {
      await this.load();
      const key = this.key(libraryPath);
      const next = [...new Set(update(this.data.libraries[key] || []).filter(Boolean))];
      const state = structuredClone(this.data);
      if (next.length) state.libraries[key] = next;
      else delete state.libraries[key];
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await fs.rename(temporary, this.filePath);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      this.data = state;
      return [...next];
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

module.exports = { SupplementalItemStore };
