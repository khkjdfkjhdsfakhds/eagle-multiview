'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

class SupplementalItemStore {
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
      if (error.code !== 'ENOENT') console.error('Unable to read supplemental item store:', error);
    }
  }

  key(libraryPath) {
    return path.resolve(libraryPath);
  }

  async get(libraryPath) {
    await this.load();
    return [...new Set(this.data.libraries[this.key(libraryPath)] || [])];
  }

  async set(libraryPath, ids) {
    await this.load();
    const key = this.key(libraryPath);
    const next = [...new Set((ids || []).filter(Boolean))];
    if (next.length) this.data.libraries[key] = next;
    else delete this.data.libraries[key];
    await this.save();
    return next;
  }

  async add(libraryPath, ids) {
    return this.set(libraryPath, [...await this.get(libraryPath), ...(ids || [])]);
  }

  async remove(libraryPath, ids) {
    const removed = new Set(ids || []);
    return this.set(libraryPath, (await this.get(libraryPath)).filter(id => !removed.has(id)));
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

module.exports = { SupplementalItemStore };
