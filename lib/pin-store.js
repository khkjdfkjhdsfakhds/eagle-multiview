'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

class PinStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 1, libraries: {} };
    this.loaded = false;
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (parsed?.version === 1 && parsed.libraries && typeof parsed.libraries === 'object') this.data = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Unable to read pin store:', error);
    }
  }

  library(libraryPath) {
    const key = path.resolve(libraryPath);
    this.data.libraries[key] ||= {};
    return this.data.libraries[key];
  }

  async get(libraryPath) {
    await this.load();
    return structuredClone(this.library(libraryPath));
  }

  async set(libraryPath, folderId, ids, pinned) {
    await this.load();
    if (!folderId) throw new Error('置顶仅适用于普通文件夹');
    const library = this.library(libraryPath);
    library[folderId] ||= {};
    const now = Date.now();
    for (const [index, id] of [...new Set(ids || [])].entries()) {
      if (pinned) library[folderId][id] = now - index;
      else if (library[folderId][id] > 0) delete library[folderId][id];
      else library[folderId][id] = -1;
    }
    if (!Object.keys(library[folderId]).length) delete library[folderId];
    await this.save();
    return structuredClone(library);
  }

  async save() {
    this.queue = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      await fs.rename(temporary, this.filePath);
    });
    return this.queue;
  }
}

module.exports = { PinStore };
