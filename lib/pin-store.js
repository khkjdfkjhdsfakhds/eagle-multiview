'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

class PinStore {
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

  async get(libraryPath) {
    await this.load();
    await this.queue;
    return structuredClone(this.data.libraries[path.resolve(libraryPath)] || {});
  }

  async set(libraryPath, folderId, ids, pinned) {
    if (!folderId) throw new Error('置顶仅适用于普通文件夹');
    const operation = this.queue.then(async () => {
      await this.load();
      const state = structuredClone(this.data);
      const key = path.resolve(libraryPath);
      const library = state.libraries[key] ||= {};
      library[folderId] ||= {};
      const now = Date.now();
      for (const [index, id] of [...new Set(ids || [])].entries()) {
        if (pinned) library[folderId][id] = now - index;
        else if (library[folderId][id] > 0) delete library[folderId][id];
        else library[folderId][id] = -1;
      }
      if (!Object.keys(library[folderId]).length) delete library[folderId];
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await fs.rename(temporary, this.filePath);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      this.data = state;
      return structuredClone(library);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

module.exports = { PinStore };
