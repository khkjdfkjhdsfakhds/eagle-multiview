'use strict';

const { EventEmitter } = require('node:events');
const { detectConflicts, applySetDelta } = require('./conflict');

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
    this.pollTimer = null;
    this.polling = false;
    this.tick = 0;
  }

  async connect() {
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
    if (libraryChanged) this.emit('library-changed', { library, libraryChanged: true });
    return { app, library };
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
    try {
      const library = await this.client.libraryInfo();
      const libraryChanged = this.library?.path !== library.path;
      const metadataChanged = this.lastModificationTime !== library.modificationTime;
      const previousFolders = this.library?.folders || [];
      const wasConnected = this.connected;
      this.connected = true;
      library.folders = libraryChanged || metadataChanged
        ? await this.client.folderTree()
        : previousFolders;
      if (libraryChanged) {
        this.itemCache.clear();
        this.watchers.clear();
      }
      this.library = library;
      if (!wasConnected) this.emit('status', { connected: true, library });
      if (libraryChanged || metadataChanged) {
        this.lastModificationTime = library.modificationTime;
        this.emit('library-changed', { library, libraryChanged });
      }
      if (this.tick % 3 === 0 && this.watchers.size) {
        await this.refreshWatchedItems();
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
    for (let index = 0; index < ids.length; index += 100) {
      const chunk = ids.slice(index, index + 100);
      const page = await this.client.request('/api/v2/item/get', {
        method: 'POST',
        body: { ids: chunk, limit: 100 }
      });
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

  async query(query) {
    const page = await this.client.queryItems(query);
    for (const item of page.data || []) this.itemCache.set(item.id, item);
    return page;
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
      this.emit('items-changed', { items: [updated], source: 'multiview', origin });
      this.emit('query-invalidated', { reason: `${field}-delta`, id });
      return { ok: true, item: updated };
    });
  }
}

module.exports = { DataHub };
