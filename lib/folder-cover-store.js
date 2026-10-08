'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Only IDs are stored in MultiView userData. Eagle files are never written.
class FolderCoverStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.data) return;
    this.loading ||= (async () => {
      try {
        const data = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
        if (data?.version !== 1 || !data.libraries || typeof data.libraries !== 'object') throw new Error('封面设置文件格式无效');
        this.data = data;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.data = { version: 1, libraries: {} };
      }
    })().finally(() => { this.loading = null; });
    await this.loading;
  }

  async get(libraryPath) {
    await this.queue;
    await this.load();
    return structuredClone(this.data.libraries[path.resolve(libraryPath)] || { revision: 0, covers: {} });
  }

  async getCover(libraryPath, folderId) {
    await this.queue;
    await this.load();
    return this.data.libraries[path.resolve(libraryPath)]?.covers[folderId]?.itemId || null;
  }

  async cloneFolders(libraryPath, folderMap, itemMap) {
    const operation = this.queue.then(async () => {
      await this.load();
      const next = structuredClone(this.data);
      const key = path.resolve(libraryPath);
      const source = next.libraries[key] || { revision: 0, covers: {} };
      const target = next.libraries[key] ||= { revision: 0, covers: {} };
      for (const [sourceFolderId, targetFolderId] of Object.entries(folderMap || {})) {
        const cover = source.covers?.[sourceFolderId];
        const targetItemId = cover?.itemId && itemMap?.[cover.itemId];
        if (!cover || !targetItemId) continue;
        target.revision += 1;
        target.covers[targetFolderId] = { itemId: targetItemId, revision: target.revision };
      }
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(next)}\n`, 'utf8');
        await fs.rename(temporary, this.filePath);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      this.data = next;
      return structuredClone(target);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  set({ libraryPath, folderId, itemId, revision, syncToEagle = false }, validate = async () => {}) {
    const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
    if (!safeId(folderId) || (itemId !== null && !safeId(itemId)) || !Number.isSafeInteger(revision) || revision < 0) return Promise.reject(new Error('封面设置参数无效，请刷新后重试'));
    const operation = this.queue.then(async () => {
      await this.load();
      const next = structuredClone(this.data);
      const library = next.libraries[path.resolve(libraryPath)] ||= { revision: 0, covers: {} };
      if ((library.covers[folderId]?.revision || 0) !== revision) return { conflict: true, ...structuredClone(library) };
      await validate();
      library.revision += 1;
      // Keep reset revisions so an older window cannot overwrite a reset.
      library.covers[folderId] = { itemId: syncToEagle ? null : itemId, revision: library.revision };
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(next)}\n`, 'utf8');
        await fs.rename(temporary, this.filePath);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      this.data = next;
      return { ok: true, ...structuredClone(library) };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

module.exports = { FolderCoverStore };
