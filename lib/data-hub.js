'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');
const { detectConflicts, applySetDelta } = require('./conflict');

function findFolder(nodes, id) {
  for (const folder of nodes || []) {
    if (folder.id === id) return folder;
    const child = findFolder(folder.children, id);
    if (child) return child;
  }
  return null;
}

function overlayFolder(nodes, id, patch) {
  let changed = false;
  const next = (nodes || []).map(folder => {
    if (folder.id === id) {
      changed = true;
      return { ...folder, ...patch };
    }
    const children = overlayFolder(folder.children, id, patch);
    if (children === folder.children) return folder;
    changed = true;
    return { ...folder, children };
  });
  return changed ? next : nodes;
}

function folderIds(nodes, result = new Set()) {
  for (const folder of nodes || []) {
    if (folder?.id) result.add(folder.id);
    folderIds(folder?.children, result);
  }
  return result;
}

class DataHub extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.library = null;
    this.connected = false;
    this.lastModificationTime = null;
    this.itemCache = new Map();
    this.watchers = new Map();
    this.writeQueues = new Map();
    this.supplementalLibraryPath = null;
    this.supplementalItems = new Map();
    this.pollTimer = null;
    this.polling = false;
    this.tick = 0;
    // Library snapshots may be read by a poll while a folder mutation is in
    // flight.  Epochs invalidate every read that started before the latest
    // accepted write, while depth prevents a read that started during the
    // write from committing before the write publishes its snapshot.
    this.snapshotEpoch = 0;
    this.snapshotWriteDepth = 0;
    this.snapshotRevision = 0;
  }

  beginSnapshotWrite() {
    this.snapshotEpoch += 1;
    this.snapshotWriteDepth += 1;
  }

  endSnapshotWrite() {
    this.snapshotEpoch += 1;
    this.snapshotWriteDepth = Math.max(0, this.snapshotWriteDepth - 1);
  }

  snapshotIsCurrent(epoch) {
    return epoch === this.snapshotEpoch && this.snapshotWriteDepth === 0;
  }

  async folderTreeWithContinuity(previousFolders = []) {
    const previousIds = folderIds(previousFolders);
    let folders = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      folders = await this.client.folderTree();
      const complete = [...previousIds].every(id => findFolder(folders, id));
      if (complete || attempt === 2) return folders;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    return folders;
  }

  nextSnapshotRevision() {
    this.snapshotRevision += 1;
    return this.snapshotRevision;
  }

  async connect() {
    this.beginSnapshotWrite();
    try {
      const previousPath = this.library?.path;
      const [app, library, folders] = await Promise.all([this.client.appInfo(), this.client.libraryInfo(), this.client.folderTree()]);
      library.folders = folders;
      const libraryChanged = Boolean(previousPath && previousPath !== library.path);
      if (libraryChanged) {
        this.itemCache.clear();
        this.watchers.clear();
      }
      this.connected = true;
      this.library = library;
      this.lastModificationTime = library.modificationTime;
      this.emit('status', { connected: true, app, library });
      if (libraryChanged) this.emit('library-changed', { library, libraryChanged: true, revision: this.nextSnapshotRevision(), source: 'multiview' });
      return { app, library };
    } finally {
      this.endSnapshotWrite();
    }
  }

  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll().catch(() => {}), 900);
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    this.tick += 1;
    const snapshotEpoch = this.snapshotEpoch;
    try {
      const library = await this.client.libraryInfo();
      const libraryChanged = this.library?.path !== library.path;
      const metadataChanged = this.lastModificationTime !== library.modificationTime;
      const previousFolders = this.library?.folders || [];
      const wasConnected = this.connected;
      let folderTreeFresh = true;
      this.connected = true;
      if (libraryChanged || metadataChanged) {
        try {
          library.folders = await this.folderTreeWithContinuity(libraryChanged ? [] : previousFolders);
        } catch {
          // libraryInfo succeeded, so Eagle is still connected. Keep the last
          // usable tree instead of disabling every window because one
          // secondary request failed. A library switch gets one clean retry.
          folderTreeFresh = false;
          library.folders = libraryChanged ? [] : previousFolders;
        }
      } else {
        library.folders = previousFolders;
      }
      if (libraryChanged) {
        this.itemCache.clear();
        this.watchers.clear();
      }
      // A folder rename or library switch published a newer snapshot while
      // this poll was reading.  Never let this late response roll the hub
      // back to an older or partial folder tree.
      if (!this.snapshotIsCurrent(snapshotEpoch)) return;
      this.library = library;
      if (!wasConnected) this.emit('status', { connected: true, library });
      if (libraryChanged || metadataChanged) {
        this.lastModificationTime = folderTreeFresh || !libraryChanged ? library.modificationTime : null;
        this.emit('library-changed', { library, libraryChanged, revision: this.nextSnapshotRevision(), source: 'eagle' });
      }
      if (this.tick % 3 === 0 && this.watchers.size) {
        await this.refreshWatchedItems().catch(() => {});
      }
    } catch (error) {
      if (this.connected) {
        this.connected = false;
        this.emit('status', { connected: false, message: 'Eagle 未运行或接口暂不可用' });
      }
    } finally {
      this.polling = false;
    }
  }

  setWatchedIds(owner, ids) {
    this.watchers.set(owner, new Set((ids || []).slice(0, 300)));
  }

  removeWatcher(owner) {
    this.watchers.delete(owner);
  }

  async refreshWatchedItems() {
    const ids = [...new Set([...this.watchers.values()].flatMap(set => [...set]))];
    const chunks = [];
    for (let index = 0; index < ids.length; index += 100) chunks.push(ids.slice(index, index + 100));
    let cursor = 0;
    let succeeded = 0;
    let firstError = null;
    const run = async () => {
      while (cursor < chunks.length) {
        const chunk = chunks[cursor++];
        let page;
        try {
          page = await this.client.request('/api/v2/item/get', {
            method: 'POST',
            body: { ids: chunk, limit: 100 }
          });
          succeeded += 1;
        } catch (error) {
          firstError ||= error;
          continue;
        }
        const changed = [];
        for (const item of page.data || []) {
          const old = this.itemCache.get(item.id);
          if (!old || old.modificationTime !== item.modificationTime || JSON.stringify(old) !== JSON.stringify(item)) {
            this.itemCache.set(item.id, item);
            changed.push(item);
          }
        }
        if (changed.length) this.emit('items-changed', { items: changed, source: 'eagle' });
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, run));
    if (chunks.length && !succeeded) throw firstError || new Error('无法刷新可见素材');
  }

  setSupplementalItems(libraryPath, items = []) {
    this.supplementalLibraryPath = libraryPath ? path.resolve(libraryPath) : null;
    this.supplementalItems = new Map((items || []).filter(item => item?.id).map(item => [item.id, item]));
  }

  addSupplementalItems(libraryPath, items = []) {
    const resolved = libraryPath ? path.resolve(libraryPath) : null;
    if (!resolved || resolved !== path.resolve(this.library?.path || '')) return false;
    if (this.supplementalLibraryPath !== resolved) this.setSupplementalItems(resolved, []);
    for (const item of items || []) if (item?.id) this.supplementalItems.set(item.id, item);
    return true;
  }

  updateSupplementalItem(item) {
    if (item?.id && this.supplementalItems.has(item.id)) this.supplementalItems.set(item.id, item);
  }

  supplementalMatches(item, query = {}) {
    if (!item || item.isDeleted || query.random || query.smartFolderId) return false;
    const matcher = this.client.constructor.matchesSearchConstraints;
    if (typeof matcher === 'function' && !matcher(item, query)) return false;
    const search = String(query.search || '').trim().toLocaleLowerCase('zh-CN');
    if (!search) return true;
    const haystack = [item.name, item.annotation, item.url, ...(item.tags || [])].join('\n').toLocaleLowerCase('zh-CN');
    return search.split(/\s+/).filter(Boolean).every(term => haystack.includes(term));
  }

  async query(query) {
    const libraryPath = this.library?.path ? path.resolve(this.library.path) : null;
    const supplemental = libraryPath && this.supplementalLibraryPath === libraryPath
      ? [...this.supplementalItems.values()].filter(item => this.supplementalMatches(item, query))
        .sort((left, right) => Number(right.modificationTime || right.mtime || 0) - Number(left.modificationTime || left.mtime || 0))
      : [];
    const offset = Math.max(0, Number(query.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 160));
    const supplementalSlice = supplemental.slice(offset, Math.min(supplemental.length, offset + limit));
    const apiOffset = Math.max(0, offset - supplemental.length);
    const apiLimit = Math.max(1, limit - supplementalSlice.length);
    const page = await this.client.queryItems({ ...query, offset: apiOffset, limit: apiLimit });
    const indexedIds = (page.data || []).map(item => item.id).filter(id => this.supplementalItems.has(id));
    if (indexedIds.length) {
      for (const id of indexedIds) this.supplementalItems.delete(id);
      this.emit('supplemental-indexed', { libraryPath: this.library?.path, ids: indexedIds });
      return this.query(query);
    }
    const data = [...supplementalSlice, ...(page.data || [])].slice(0, limit);
    const total = Number(page.total || 0) + supplemental.length;
    const merged = {
      ...page,
      data,
      total,
      nextOffset: offset + data.length,
      hasMore: offset + data.length < total
    };
    for (const item of data) this.itemCache.set(item.id, item);
    return merged;
  }

  enqueue(id, operation) {
    const previous = this.writeQueues.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.writeQueues.set(id, current);
    current.then(() => {
      if (this.writeQueues.get(id) === current) this.writeQueues.delete(id);
    }, () => {
      if (this.writeQueues.get(id) === current) this.writeQueues.delete(id);
    });
    return current;
  }

  async ensureLibraryPath(expectedPath) {
    if (!expectedPath) return;
    const current = await this.client.libraryInfo();
    if (current.path !== expectedPath) {
      const error = new Error('Eagle 已切换资料库，本次修改已取消，请在新资料库中重新操作');
      error.code = 'LIBRARY_CHANGED';
      throw error;
    }
  }

  async mutate({ id, patch, base, force = false, origin = null, libraryPath = null }) {
    return this.enqueue(id, async () => {
      await this.ensureLibraryPath(libraryPath);
      const current = await this.client.getItem(id);
      const conflicts = force ? [] : detectConflicts(current, base || {}, patch || {});
      if (conflicts.length) return { ok: false, conflict: true, current, conflicts };
      await this.ensureLibraryPath(libraryPath);
      const updated = await this.client.updateItem(id, patch);
      this.itemCache.set(id, updated);
      this.updateSupplementalItem(updated);
      this.emit('items-changed', { items: [updated], source: 'multiview', origin });
      this.emit('query-invalidated', { reason: 'item-update', id });
      return { ok: true, item: updated };
    });
  }

  async mutateSet({ id, field, add = [], remove = [], origin = null, libraryPath = null }) {
    return this.enqueue(id, async () => {
      await this.ensureLibraryPath(libraryPath);
      const current = await this.client.getItem(id);
      const next = applySetDelta(current[field], add, remove);
      await this.ensureLibraryPath(libraryPath);
      const updated = await this.client.updateItem(id, { [field]: next });
      this.itemCache.set(id, updated);
      this.updateSupplementalItem(updated);
      this.emit('items-changed', { items: [updated], source: 'multiview', origin });
      this.emit('query-invalidated', { reason: `${field}-delta`, id });
      return { ok: true, item: updated };
    });
  }

  async mutateFolder({ id, name, baseName, force = false, origin = null, libraryPath = null }) {
    return this.enqueue(`folder:${id}`, async () => {
      this.beginSnapshotWrite();
      try {
        await this.ensureLibraryPath(libraryPath);
        const currentFolders = await this.client.folderTree();
        const current = findFolder(currentFolders, id);
        if (!current) throw new Error('文件夹不存在或已不在当前资料库');
        if (!force && current.name !== baseName) {
          const library = { ...(this.library || {}), folders: currentFolders };
          this.library = library;
          this.emit('library-changed', { library, libraryChanged: false, source: 'eagle', revision: this.nextSnapshotRevision() });
          return {
            ok: false,
            conflict: true,
            current,
            conflicts: [{ field: 'name', base: baseName, current: current.name, next: name }]
          };
        }
        await this.ensureLibraryPath(libraryPath);
        await this.client.updateFolder(id, { name });
        const [library, folders] = await Promise.all([
          this.client.libraryInfo(),
          this.folderTreeWithContinuity(currentFolders)
        ]);
        const completeIds = folderIds(currentFolders);
        const foldersAreComplete = [...completeIds].every(pid => findFolder(folders, pid));
        const baseFolders = foldersAreComplete && findFolder(folders, id) ? folders : currentFolders;
        const publishedFolders = overlayFolder(baseFolders, id, { name });
        library.folders = publishedFolders;
        this.library = library;
        this.lastModificationTime = library.modificationTime;
        const updated = findFolder(publishedFolders, id);
        this.emit('library-changed', { library, libraryChanged: false, source: 'multiview', origin, revision: this.nextSnapshotRevision() });
        this.emit('query-invalidated', { reason: 'folder-update', id });
        return { ok: true, folder: updated };
      } finally {
        this.endSnapshotWrite();
      }
    });
  }
}

module.exports = { DataHub };
