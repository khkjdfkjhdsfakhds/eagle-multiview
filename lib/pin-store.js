'use strict';

const fs = require('node:fs/promises');
const { readStateFile, writeStateFile } = require('./json-state-file');
const path = require('node:path');

// Folder and item ids become object keys; anything outside Eagle's id shape
// (above all __proto__) would otherwise reach Object.prototype.
const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);

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
      this.data = await readStateFile(this.filePath, {
        label: '置顶记录文件',
        isValid: parsed => parsed?.version === 1 && parsed.libraries && typeof parsed.libraries === 'object',
        empty: () => ({ version: 1, libraries: {} })
      });
      this.loaded = true;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async get(libraryPath) {
    await this.load();
    await this.queue;
    return structuredClone(this.data.libraries[path.resolve(libraryPath)] || {});
  }

  async cloneFolders(libraryPath, folderMap, itemMap) {
    const operation = this.queue.then(async () => {
      await this.load();
      const state = structuredClone(this.data);
      const key = path.resolve(libraryPath);
      const source = state.libraries[key] || {};
      const target = state.libraries[key] ||= {};
      for (const [sourceFolderId, targetFolderId] of Object.entries(folderMap || {})) {
        if (!safeId(sourceFolderId) || !safeId(targetFolderId)) continue;
        const pins = Object.prototype.hasOwnProperty.call(source, sourceFolderId) ? source[sourceFolderId] : null;
        if (!pins) continue;
        const copied = {};
        for (const [sourceItemId, value] of Object.entries(pins)) {
          const targetItemId = Object.prototype.hasOwnProperty.call(itemMap || {}, sourceItemId) ? itemMap[sourceItemId] : null;
          if (safeId(targetItemId)) copied[targetItemId] = value;
        }
        if (Object.keys(copied).length) target[targetFolderId] = copied;
      }
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      try {
        await writeStateFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
        await fs.rename(temporary, this.filePath);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      this.data = state;
      return structuredClone(target);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  // `isLive(id)`, when given, drops records of items that left the library,
  // above all the -1 "unpinned here" markers, which otherwise only grow (S-15).
  async set(libraryPath, folderId, ids, pinned, { synced = false, isLive = null } = {}) {
    if (!folderId) throw new Error('置顶仅适用于普通文件夹');
    if (!safeId(folderId) || !Array.isArray(ids || []) || (ids || []).some(id => !safeId(id))) {
      throw new Error('置顶参数无效，请刷新后重试');
    }
    const operation = this.queue.then(async () => {
      await this.load();
      const state = structuredClone(this.data);
      const key = path.resolve(libraryPath);
      const library = state.libraries[key] ||= {};
      library[folderId] ||= {};
      const now = Date.now();
      for (const [index, id] of [...new Set(ids || [])].entries()) {
        if (synced) delete library[folderId][id];
        else if (pinned) library[folderId][id] = now - index;
        else if (library[folderId][id] > 0) delete library[folderId][id];
        else library[folderId][id] = -1;
      }
      if (typeof isLive === 'function') {
        for (const id of Object.keys(library[folderId])) if (!isLive(id)) delete library[folderId][id];
      }
      if (!Object.keys(library[folderId]).length) delete library[folderId];
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      try {
        await writeStateFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
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
