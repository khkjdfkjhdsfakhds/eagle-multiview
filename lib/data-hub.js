'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');
const { detectConflicts, applySetDelta } = require('./conflict');
const { folderPlacementScript } = require('./folder-placement');
const { folderRemovalScript, folderRemovalUndoScript } = require('./folder-removal');
const { hasAdvancedSyntax } = require('./metadata-search-index');
const { changedTagNames } = require('./tag-tally');

function findFolder(nodes, id) {
  for (const folder of nodes || []) {
    if (folder.id === id) return folder;
    const child = findFolder(folder.children, id);
    if (child) return child;
  }
  return null;
}

// The colours Eagle's own folder menu offers; '' is "无".
const FOLDER_ICON_COLORS = new Set(['', 'red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'pink']);
const FOLDER_PROPERTY_FIELDS = new Set(['iconColor', 'description']);

function findFolderLocation(nodes, id, parentId = null) {
  for (const folder of nodes || []) {
    if (folder.id === id) return { folder, parentId };
    const child = findFolderLocation(folder.children, id, folder.id);
    if (child) return child;
  }
  return null;
}

// A folder's auto tags (Eagle's getExtendTags): its own tags, then each
// ancestor's while the ancestor carries a tags list, de-duplicated and
// reversed so the outermost ancestor's tags come first.
function folderExtendTags(nodes, id) {
  const tags = [];
  let location = findFolderLocation(nodes, id);
  while (location) {
    tags.push(...(Array.isArray(location.folder.tags) ? location.folder.tags : []));
    const parent = location.parentId ? findFolderLocation(nodes, location.parentId) : null;
    if (!parent || !parent.folder.tags) break;
    location = parent;
  }
  return [...new Set(tags)].reverse();
}

function folderStructure(folder) {
  return { id: folder.id, children: (folder.children || []).map(folderStructure) };
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
  constructor(client, { metadataSearchIndex = null } = {}) {
    super();
    this.client = client;
    this.metadataSearchIndex = metadataSearchIndex;
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
    // Revisions restart at 0 with the process; clients that outlive a
    // restart compare this id to know their revision counters are obsolete.
    this.instanceId = require('node:crypto').randomUUID();
    this.snapshotCommitRevision = 0;
    this.connectionGeneration = 0;
    this.connectionPromise = null;
    this.libraryEpoch = 0;
    this.itemRevisions = new Map();
    this.itemWriteRevision = 0;
    this.folderTreeDirty = false;
    this.metadataSearchIndex?.on('ready', () => {
      this.emit('query-invalidated', {
        reason: 'metadata-index-ready',
        libraryPath: this.library?.path || null
      });
    });
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

  publishLibrarySnapshot(library, { source = 'multiview', origin = null, notify = true, folderTreeFresh = true } = {}) {
    this.snapshotCommitRevision += 1;
    const libraryChanged = Boolean(this.library?.path && this.library.path !== library.path);
    if (libraryChanged) {
      this.libraryEpoch += 1;
      this.itemCache.clear();
      this.itemRevisions.clear();
      this.watchers.clear();
      this.setSupplementalItems(null, []);
    }
    this.connected = true;
    this.library = library;
    this.folderTreeDirty = !folderTreeFresh;
    if (folderTreeFresh) this.lastModificationTime = library.modificationTime;
    else if (libraryChanged) this.lastModificationTime = null;
    if (this.metadataSearchIndex && (libraryChanged || !this.metadataSearchIndex.libraryPath)) {
      this.metadataSearchIndex.start(library.path).catch(() => {});
    } else if (this.metadataSearchIndex && notify && source === 'eagle') {
      this.metadataSearchIndex.scheduleRefresh(library.path);
    }
    if (notify || libraryChanged) this.emit('library-changed', {
      library, libraryChanged, source, origin, revision: this.nextSnapshotRevision(), hubInstance: this.instanceId
    });
    return libraryChanged;
  }

  connect({ notify = false, source = 'multiview', origin = null } = {}) {
    const generation = ++this.connectionGeneration;
    const commitRevision = this.snapshotCommitRevision;
    this.beginSnapshotWrite();
    const operation = (async () => {
      try {
        const [app, library, folders] = await Promise.all([this.client.appInfo(), this.client.libraryInfo(), this.client.folderTree()]);
        if (generation !== this.connectionGeneration) return this.connectionPromise;
        // A folder mutation may publish while this connect is in flight,
        // without starting another connect. Do not replace its committed tree.
        if (commitRevision !== this.snapshotCommitRevision) return { app, library: this.library };
        library.folders = folders;
        this.publishLibrarySnapshot(library, { notify, source, origin });
        this.emit('status', { connected: true, app, library });
        return { app, library, revision: this.snapshotRevision, hubInstance: this.instanceId };
      } finally { this.endSnapshotWrite(); }
    })();
    this.connectionPromise = operation;
    return operation;
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
      if (libraryChanged || metadataChanged || this.folderTreeDirty) {
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
      // A folder rename or library switch published a newer snapshot while
      // this poll was reading.  Never let this late response roll the hub
      // back to an older or partial folder tree.
      if (!this.snapshotIsCurrent(snapshotEpoch)) return;
      const notify = libraryChanged || metadataChanged || this.folderTreeDirty;
      this.publishLibrarySnapshot(library, { source: 'eagle', notify, folderTreeFresh });
      if (!wasConnected) this.emit('status', { connected: true, library });
      if (this.tick % 3 === 0 && this.watchers.size) {
        await this.refreshWatchedItems().catch(() => {});
      }
    } catch (error) {
      if (!this.snapshotIsCurrent(snapshotEpoch)) return;
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
    const read = this.captureItemRead();
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
        const tagNames = [];
        if (!this.itemReadIsCurrent(read)) return;
        for (const item of page.data || []) {
          if (this.itemRevisions.get(item.id) !== read.revisions.get(item.id)) continue;
          const old = this.itemCache.get(item.id);
          if (!old || old.modificationTime !== item.modificationTime || JSON.stringify(old) !== JSON.stringify(item)) {
            this.itemCache.set(item.id, item);
            changed.push(item);
            if (old) tagNames.push(...changedTagNames(old, item));
          }
        }
        if (changed.length) this.emit('items-changed', { items: changed, source: 'eagle', libraryPath: read.libraryPath });
        if (tagNames.length) this.emit('item-tags-touched', { names: [...new Set(tagNames)], libraryPath: read.libraryPath });
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

  async viewStats(query = {}) {
    const read = this.captureItemRead();
    const stats = await this.client.viewStats(query);
    if (!this.itemReadIsCurrent(read)) {
      throw Object.assign(new Error('Eagle 已切换资源库，请重新读取当前视图'), { code: 'LIBRARY_CHANGED' });
    }
    return stats;
  }

  async viewFacets(query = {}) {
    const read = this.captureItemRead();
    const facets = await this.client.viewFacets(query);
    if (!this.itemReadIsCurrent(read)) {
      throw Object.assign(new Error('Eagle 已切换资源库，请重新读取当前视图'), { code: 'LIBRARY_CHANGED' });
    }
    return facets;
  }

  async query(query, staleRetries = 0) {
    const effectiveQuery = { ...query };
    if (query.folderId && String(query.search || '').trim() && Array.isArray(this.library?.folders)) {
      const ids = [];
      const visit = nodes => (nodes || []).forEach(folder => {
        if (folder.id === query.folderId) {
          const collect = branch => (branch || []).forEach(child => { ids.push(child.id); collect(child.children); });
          ids.push(folder.id); collect(folder.children);
        } else visit(folder.children);
      });
      visit(this.library.folders);
      if (ids.length) effectiveQuery.folderIds = ids;
    }
    const read = this.captureItemRead();
    const libraryPath = this.library?.path ? path.resolve(this.library.path) : null;
    const supplemental = libraryPath && this.supplementalLibraryPath === libraryPath
      ? [...this.supplementalItems.values()].filter(item => this.supplementalMatches(item, query))
        .sort((left, right) => Number(right.modificationTime || right.mtime || 0) - Number(left.modificationTime || left.mtime || 0))
      : [];
    const canUseMetadataIndex = Boolean(
      this.metadataSearchIndex?.ready &&
      // The index must belong to the library being queried (E-05).
      Boolean(this.library?.path) && this.metadataSearchIndex.libraryPath === path.resolve(this.library.path) &&
      String(effectiveQuery.search || '').trim() &&
      !hasAdvancedSyntax(effectiveQuery.search) &&
      !effectiveQuery.random &&
      !effectiveQuery.smartFolderId &&
      !effectiveQuery.searchScope &&
      !supplemental.length
    );
    if (canUseMetadataIndex) {
      const page = await this.metadataSearchIndex.search(effectiveQuery.search, {
        offset: effectiveQuery.offset,
        limit: effectiveQuery.limit,
        matcher: item => this.client.constructor.matchesSearchConstraints(item, effectiveQuery)
      });
      if (page) {
        for (const item of page.data || []) this.itemCache.set(item.id, item);
        return page;
      }
    }
    const offset = Math.max(0, Number(query.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 160));
    const supplementalSlice = supplemental.slice(offset, Math.min(supplemental.length, offset + limit));
    const apiOffset = Math.max(0, offset - supplemental.length);
    const apiLimit = Math.max(1, limit - supplementalSlice.length);
    const page = await this.client.queryItems({ ...effectiveQuery, offset: apiOffset, limit: apiLimit });
    if (!this.itemReadIsCurrent(read)) {
      const error = new Error('Eagle 已切换资源库，请重新读取当前视图');
      error.code = 'LIBRARY_CHANGED';
      throw error;
    }
    if (read.writeRevision !== this.itemWriteRevision) {
      // Replacing just the stale row with a cached mutation would violate
      // filter membership, sorting and pagination. Ask the original query
      // again, including server-only smart-folder and full-text semantics.
      if (staleRetries >= 2) {
        const error = new Error('素材正在连续更新，请稍后刷新当前视图');
        error.code = 'QUERY_CHANGED';
        throw error;
      }
      return this.query(query, staleRetries + 1);
    }
    const pageData = page.data || [];
    const indexedIds = pageData.map(item => item.id).filter(id => this.supplementalItems.has(id));
    if (indexedIds.length) {
      for (const id of indexedIds) this.supplementalItems.delete(id);
      this.emit('supplemental-indexed', { libraryPath: this.library?.path, ids: indexedIds });
      return this.query(query, staleRetries);
    }
    const data = [...supplementalSlice, ...pageData].slice(0, limit);
    const total = Number(page.total || 0) + supplemental.length;
    const apiNextOffset = Number.isFinite(Number(page.nextOffset)) ? Number(page.nextOffset) : apiOffset + pageData.length;
    const nextOffset = supplementalSlice.length < limit
      ? Math.max(offset + data.length, supplemental.length + apiNextOffset)
      : offset + data.length;
    const merged = {
      ...page,
      data,
      total,
      nextOffset,
      hasMore: Boolean(page.hasMore) || offset + data.length < total
    };
    for (const item of data) this.itemCache.set(item.id, item);
    return merged;
  }

  // Every id of query()'s view (P6-02 ⌘A): not-yet-indexed imports, then
  // the indexed full-text matches or the Eagle API's. Null when it cannot
  // be listed (random views).
  async viewIds(query = {}) {
    const read = this.captureItemRead();
    const libraryPath = this.library?.path ? path.resolve(this.library.path) : null;
    const supplemental = libraryPath && this.supplementalLibraryPath === libraryPath
      ? [...this.supplementalItems.values()].filter(item => this.supplementalMatches(item, query)).map(item => item.id)
      : [];
    let ids = null;
    const search = String(query.search || '').trim();
    if (this.metadataSearchIndex?.ready && libraryPath && this.metadataSearchIndex.libraryPath === libraryPath
      && search && !hasAdvancedSyntax(search) && !query.random && !query.smartFolderId && !query.searchScope && !supplemental.length) {
      ids = await this.metadataSearchIndex.searchIds(search, {
        matcher: item => this.client.constructor.matchesSearchConstraints(item, query)
      });
    }
    if (!ids) ids = await this.client.viewItemIds(query);
    if (!this.itemReadIsCurrent(read)) {
      throw Object.assign(new Error('Eagle 已切换资源库，请重新读取当前视图'), { code: 'LIBRARY_CHANGED' });
    }
    if (!ids) return null;
    const known = new Set(supplemental);
    return [...supplemental, ...ids.filter(id => !known.has(id))];
  }

  // Where `id` sits in query()'s order: not-yet-indexed imports come first,
  // then the Eagle API order. -1 when absent, null when it cannot be told.
  async locateItem(query, id) {
    const libraryPath = this.library?.path ? path.resolve(this.library.path) : null;
    const supplemental = libraryPath && this.supplementalLibraryPath === libraryPath
      ? [...this.supplementalItems.values()].filter(item => this.supplementalMatches(item, query))
        .sort((left, right) => Number(right.modificationTime || right.mtime || 0) - Number(left.modificationTime || left.mtime || 0))
      : [];
    const early = supplemental.findIndex(item => item.id === id);
    if (early !== -1) return { index: early };
    const index = await this.client.locateItemIndex(query, id);
    return { index: index === null || index === -1 ? index : supplemental.length + index };
  }

  captureItemRead() {
    return { epoch: this.libraryEpoch, libraryPath: this.library?.path || null, writeRevision: this.itemWriteRevision, revisions: new Map(this.itemRevisions) };
  }

  itemReadIsCurrent(read) {
    return read.epoch === this.libraryEpoch && read.libraryPath === (this.library?.path || null);
  }

  markItemWrite(id) {
    this.itemWriteRevision += 1;
    this.itemRevisions.set(id, (this.itemRevisions.get(id) || 0) + 1);
  }

  publishItemMutation(item, { libraryPath = this.library?.path || null, origin = null, reason = 'item-update', previous = null } = {}) {
    if (libraryPath !== (this.library?.path || null)) return false;
    this.markItemWrite(item.id);
    previous ||= this.itemCache.get(item.id);
    this.itemCache.set(item.id, item);
    this.metadataSearchIndex?.refreshItem(item, libraryPath).catch(() => {});
    this.updateSupplementalItem(item);
    this.emit('items-changed', { items: [item], source: 'multiview', origin, libraryPath });
    // Tag edits go through mutate/mutateSet, which pass the version they
    // changed; other publishers (comments, thumbnails, pins) leave tags alone.
    const tagNames = previous ? changedTagNames(previous, item) : [];
    if (tagNames.length) this.emit('item-tags-touched', { names: tagNames, libraryPath });
    this.emit('query-invalidated', { reason, id: item.id, libraryPath });
    return true;
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
    const target = path.resolve(expectedPath);
    // Eagle answers /api/v2/library/info from the metadata.json snapshot on
    // disk, which briefly lags while it is rewriting a large import. Reading
    // the old path once used to abort finished work, so the check now only
    // fails after the mismatch survives several reads.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 150 * attempt));
      const current = await this.client.libraryInfo();
      if (current?.path && path.resolve(current.path) === target) return;
    }
    const error = new Error('Eagle 已切换资源库，本次修改已取消，请在新资源库中重新操作');
    error.code = 'LIBRARY_CHANGED';
    throw error;
  }

  async mutate({ id, patch, base, force = false, origin = null, libraryPath = null }) {
    const targetPath = libraryPath || this.library?.path || null;
    return this.enqueue(id, async () => {
      await this.ensureLibraryPath(targetPath);
      const current = await this.client.getItem(id);
      const conflicts = force ? [] : detectConflicts(current, base || {}, patch || {});
      if (conflicts.length) return { ok: false, conflict: true, current, conflicts };
      await this.ensureLibraryPath(targetPath);
      this.markItemWrite(id);
      const updated = await this.client.updateItem(id, patch);
      await this.ensureLibraryPath(targetPath);
      this.publishItemMutation(updated, { libraryPath: targetPath, origin, previous: current });
      return { ok: true, item: updated };
    });
  }

  // autoTags ('joined' | 'always') files an item the way Eagle's own
  // classify actions do: the target folders' auto tags are added with it —
  // for folders the item newly joins (menus, move dialog), or for every target
  // folder (a drag onto a folder, Eagle's classifySelected).
  async mutateSet({ id, field, add = [], remove = [], autoTags = null, origin = null, libraryPath = null }) {
    const targetPath = libraryPath || this.library?.path || null;
    return this.enqueue(id, async () => {
      await this.ensureLibraryPath(targetPath);
      const current = await this.client.getItem(id);
      const next = applySetDelta(current[field], add, remove);
      const patch = { [field]: next };
      if (field === 'folders' && autoTags) {
        const joined = autoTags === 'always' ? add : add.filter(folderId => !(current.folders || []).includes(folderId));
        const extra = joined.flatMap(folderId => folderExtendTags(this.library?.folders, folderId));
        const tags = [...new Set([...(current.tags || []), ...extra])];
        if (tags.length !== (current.tags || []).length) patch.tags = tags;
      }
      await this.ensureLibraryPath(targetPath);
      this.markItemWrite(id);
      const updated = await this.client.updateItem(id, patch);
      await this.ensureLibraryPath(targetPath);
      this.publishItemMutation(updated, { libraryPath: targetPath, origin, reason: `${field}-delta`, previous: current });
      // What the write replaced, for the 撤销 of Eagle's notice (P3-05).
      const previous = Object.fromEntries(Object.keys(patch).map(key => [key, current[key] ?? []]));
      return { ok: true, item: updated, previous };
    });
  }

  async mutateFolder({ id, name, baseName, force = false, origin = null, libraryPath = null }) {
    const targetPath = libraryPath || this.library?.path || null;
    return this.enqueue(`folder:${id}`, async () => {
      this.beginSnapshotWrite();
      try {
        await this.ensureLibraryPath(targetPath);
        const currentFolders = await this.client.folderTree();
        await this.ensureLibraryPath(targetPath);
        const current = findFolder(currentFolders, id);
        if (!current) throw new Error('文件夹不存在或已不在当前资源库');
        if (!force && current.name !== baseName) {
          const library = { ...(this.library || {}), folders: currentFolders };
          this.publishLibrarySnapshot(library, { source: 'eagle' });
          return {
            ok: false,
            conflict: true,
            current,
            conflicts: [{ field: 'name', base: baseName, current: current.name, next: name }]
          };
        }
        await this.ensureLibraryPath(targetPath);
        await this.client.updateFolder(id, { name });
        return await this.commitFolderPatch({ id, patch: { name }, currentFolders, targetPath, origin });
      } finally {
        this.endSnapshotWrite();
      }
    });
  }

  // Folder colour and description (P1-12, P2-05) go through
  // /api/v2/folder/update. Its handler treats a missing iconColor as "clear"
  // and a parent that differs from the stored one as "move" (a root folder
  // sent parent:null is moved to the end of the root list), so every write
  // carries the colour to keep and, for a subfolder only, its parent.
  async updateFolderProperties({ id, patch = {}, base = {}, force = false, origin = null, libraryPath = null }) {
    const fields = Object.keys(patch || {});
    if (!fields.length || fields.some(field => !FOLDER_PROPERTY_FIELDS.has(field))) {
      throw Object.assign(new Error('不支持修改这个文件夹属性'), { code: 'INVALID_FOLDER_PATCH' });
    }
    if ('iconColor' in patch && !FOLDER_ICON_COLORS.has(patch.iconColor)) {
      throw Object.assign(new Error('Eagle 不支持这个文件夹颜色'), { code: 'INVALID_FOLDER_PATCH' });
    }
    if ('description' in patch && (typeof patch.description !== 'string' || patch.description.length > 10000)) {
      throw Object.assign(new Error('文件夹描述不能超过 10000 个字符'), { code: 'INVALID_FOLDER_PATCH' });
    }
    const targetPath = libraryPath || this.library?.path || null;
    return this.enqueue(`folder:${id}`, async () => {
      this.beginSnapshotWrite();
      try {
        await this.ensureLibraryPath(targetPath);
        const currentFolders = await this.client.folderTree();
        await this.ensureLibraryPath(targetPath);
        const location = findFolderLocation(currentFolders, id);
        if (!location) throw new Error('文件夹不存在或已不在当前资源库');
        const current = location.folder;
        const conflicts = fields
          .filter(field => String(current[field] ?? '') !== String(base?.[field] ?? ''))
          .map(field => ({ field, base: base?.[field] ?? '', current: current[field] ?? '', next: patch[field] }));
        if (!force && conflicts.length) {
          this.publishLibrarySnapshot({ ...(this.library || {}), folders: currentFolders }, { source: 'eagle' });
          return { ok: false, conflict: true, current, conflicts };
        }
        const iconColor = 'iconColor' in patch ? patch.iconColor : (current.iconColor || '');
        const body = {
          ...(iconColor ? { iconColor } : {}),
          ...('description' in patch ? { description: patch.description } : {}),
          ...(location.parentId ? { parent: location.parentId } : {})
        };
        await this.ensureLibraryPath(targetPath);
        await this.client.updateFolderProperties(id, body);
        const overlay = { ...patch, iconColor: iconColor || undefined };
        return await this.commitFolderPatch({ id, patch: overlay, currentFolders, targetPath, origin });
      } finally {
        this.endSnapshotWrite();
      }
    });
  }

  // After a folder write: read the tree back and publish it with the
  // confirmed patch overlaid, unless the library or a newer snapshot moved on.
  async commitFolderPatch({ id, patch, currentFolders, targetPath, origin }) {
    const readGeneration = this.connectionGeneration;
    const readCommitRevision = this.snapshotCommitRevision;
    const [library, folders] = await Promise.all([
      this.client.libraryInfo(),
      this.folderTreeWithContinuity(currentFolders)
    ]);
    if (readGeneration !== this.connectionGeneration) {
      const latest = await this.connectionPromise;
      if (targetPath && path.resolve(latest.library.path) !== path.resolve(targetPath)) {
        const error = new Error('文件夹修改后 Eagle 已切换资源库，请回到原库核对结果');
        error.code = 'LIBRARY_CHANGED';
        throw error;
      }
      // A concurrent connect already published a newer same-library
      // snapshot; retain it instead of replacing it with this late read.
      return { ok: true, folder: findFolder(latest.library.folders, id) };
    }
    if (targetPath && path.resolve(library.path) !== path.resolve(targetPath)) {
      library.folders = folders;
      this.publishLibrarySnapshot(library, { origin });
      const error = new Error('文件夹修改后 Eagle 已切换资源库，请回到原库核对结果');
      error.code = 'LIBRARY_CHANGED';
      throw error;
    }
    if (readCommitRevision !== this.snapshotCommitRevision) {
      if (targetPath && (!this.library?.path || path.resolve(this.library.path) !== path.resolve(targetPath))) {
        const error = new Error('文件夹修改后 Eagle 已切换资源库，请回到原库核对结果');
        error.code = 'LIBRARY_CHANGED';
        throw error;
      }
      // A different folder's mutation has committed a newer snapshot.
      // Merge only this confirmed patch, never its stale sibling values.
      const latest = { ...this.library, folders: overlayFolder(this.library.folders, id, patch) };
      this.publishLibrarySnapshot(latest, { origin });
      this.emit('query-invalidated', { reason: 'folder-update', id });
      return { ok: true, folder: findFolder(latest.folders, id) };
    }
    const completeIds = folderIds(currentFolders);
    const foldersAreComplete = [...completeIds].every(pid => findFolder(folders, pid));
    const baseFolders = foldersAreComplete && findFolder(folders, id) ? folders : currentFolders;
    const publishedFolders = overlayFolder(baseFolders, id, patch);
    library.folders = publishedFolders;
    this.publishLibrarySnapshot(library, { origin });
    const updated = findFolder(publishedFolders, id);
    this.emit('query-invalidated', { reason: 'folder-update', id });
    return { ok: true, folder: updated };
  }

  async moveFolder({ id, parentId, baseParentId, anchorId = null, position = null, targetSiblingIds = null, baseSiblingIds = null, origin = null, libraryPath }) {
    const validId = value => typeof value === 'string' && value.trim().length > 0;
    if (!validId(id) || !validId(libraryPath) ||
        !(parentId === null || validId(parentId)) || !(baseParentId === null || validId(baseParentId))) {
      throw Object.assign(new Error('文件夹移动需要完整的资源库、来源和目标，请重新打开移动操作'), { code: 'INVALID_FOLDER_MOVE' });
    }
    const placing = anchorId !== null;
    if (placing && (!validId(anchorId) || anchorId === id || !['before', 'after'].includes(position)
      || !Array.isArray(targetSiblingIds) || !targetSiblingIds.every(validId)
      || (baseSiblingIds !== null && (!Array.isArray(baseSiblingIds) || !baseSiblingIds.every(validId)))
      || new Set(targetSiblingIds).size !== targetSiblingIds.length)) {
      throw Object.assign(new Error('插入位置无效，请重新拖动'), { code: 'INVALID_FOLDER_MOVE' });
    }
    return this.enqueue('folder-tree:move', async () => {
      this.beginSnapshotWrite();
      let writeAttempted = false;
      try {
        // A reconnect or another metadata write may finish during a tree
        // request. Re-read instead of merging stale topology like a rename.
        const readSnapshot = async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const generation = this.connectionGeneration;
            const revision = this.snapshotCommitRevision;
            const library = await this.client.libraryInfo();
            if (!library.path || path.resolve(library.path) !== path.resolve(libraryPath)) {
              throw Object.assign(new Error('Eagle 已切换资源库，请回到原库核对移动结果'), { code: 'LIBRARY_CHANGED' });
            }
            const folders = await this.client.folderTree();
            await this.ensureLibraryPath(libraryPath);
            if (generation === this.connectionGeneration && revision === this.snapshotCommitRevision) return { ...library, folders };
          }
          throw Object.assign(new Error('文件夹正在其他窗口更新，请刷新后重新操作'), { code: 'FOLDER_MOVE_SNAPSHOT_CHANGED' });
        };
        const beforeSnapshot = await readSnapshot();
        const before = beforeSnapshot.folders;
        const location = findFolderLocation(before, id);
        if (!location || (parentId !== null && !findFolder(before, parentId))) {
          throw Object.assign(new Error('来源或目标文件夹已不存在，请刷新后重新操作'), { code: 'FOLDER_NOT_FOUND' });
        }
        const current = location.folder;
        if (parentId === id || findFolder(current.children, parentId)) {
          throw Object.assign(new Error('请选择当前文件夹及其子文件夹之外的目标'), { code: 'FOLDER_MOVE_CYCLE' });
        }
        if (location.parentId !== baseParentId) {
          return { ok: false, conflict: true, current, conflicts: [{ field: 'parent', base: baseParentId, current: location.parentId, next: parentId }] };
        }
        const siblings = parentId === null ? before : findFolder(before, parentId).children || [];
        let expectedOrder = null;
        if (placing) {
          const rawSiblingIds = siblings.map(folder => folder.id);
          if ((baseSiblingIds ? JSON.stringify(rawSiblingIds) !== JSON.stringify(baseSiblingIds)
            : JSON.stringify(rawSiblingIds) !== JSON.stringify(targetSiblingIds))
            || new Set(targetSiblingIds).size !== targetSiblingIds.length
            || targetSiblingIds.length !== rawSiblingIds.length
            || targetSiblingIds.some(folderId => !rawSiblingIds.includes(folderId))
            || !siblings.some(folder => folder.id === anchorId)) return { ok: false, conflict: true };
          expectedOrder = targetSiblingIds.filter(folderId => folderId !== id);
          expectedOrder.splice(expectedOrder.indexOf(anchorId) + (position === 'after' ? 1 : 0), 0, id);
        }
        if (location.parentId === parentId && (!placing || JSON.stringify(expectedOrder) === JSON.stringify(targetSiblingIds))) return { ok: true, noop: true, folder: current, parentId };
        await this.ensureLibraryPath(libraryPath);
        writeAttempted = true;
        if (placing) {
          await this.client.request('/api/script/inject', { method: 'POST', body: {
            script: folderPlacementScript({ id, parentId, baseParentId, anchorId, position, targetSiblingIds, baseSiblingIds: baseSiblingIds || targetSiblingIds, libraryPath })
          } });
        } else await this.client.moveFolder(id, { parent: parentId, iconColor: current.iconColor });
        let library = await readSnapshot();
        if (placing) {
          const matches = snapshot => JSON.stringify((parentId === null ? snapshot.folders : findFolder(snapshot.folders, parentId)?.children || []).map(folder => folder.id)) === JSON.stringify(expectedOrder);
          for (let attempt = 0; attempt < 12 && !matches(library); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            library = await readSnapshot();
          }
          if (!matches(library)) throw Object.assign(new Error('Eagle 未确认插入位置'), { code: 'FOLDER_MOVE_UNCONFIRMED' });
        }
        const folders = library.folders;
        const confirmed = findFolderLocation(folders, id);
        if (!confirmed || confirmed.parentId !== parentId ||
            JSON.stringify(folderStructure(current)) !== JSON.stringify(folderStructure(confirmed.folder)) ||
            ![...folderIds(before)].every(folderId => findFolder(folders, folderId))) {
          throw Object.assign(new Error('Eagle 已接收移动，但回读结果尚未确认；请刷新核对，不要重复提交'), { code: 'FOLDER_MOVE_UNCONFIRMED' });
        }
        this.publishLibrarySnapshot(library, { origin });
        this.emit('query-invalidated', { reason: 'folder-move', id, libraryPath });
        return { ok: true, folder: findFolder(folders, id), parentId };
      } catch (error) {
        if (writeAttempted) {
          error.uncertain = true;
          // Electron may preserve only the message across invoke; keep the
          // no-replay guidance visible even when custom error fields are lost.
          error.message = `移动请求已发送，结果尚未确认；请刷新核对，不要重复提交。${error.message || ''}`;
          this.folderTreeDirty = true;
          this.emit('query-invalidated', { reason: 'folder-move-unconfirmed', id, libraryPath });
        }
        throw error;
      } finally {
        this.endSnapshotWrite();
      }
    });
  }

  // Delete a folder through Eagle's own removeFolder (the API has no
  // endpoint). baseName is the name the user confirmed, for the
  // cross-window check; isDeleteImages is Eagle's "把文件夹内项目丢到回收站".
  async removeFolder({ id, baseName = null, isDeleteImages = true, origin = null, libraryPath }) {
    const validId = value => typeof value === 'string' && value.trim().length > 0;
    if (!validId(id) || !validId(libraryPath)) {
      throw Object.assign(new Error('删除文件夹需要完整的资源库和文件夹，请重新操作'), { code: 'INVALID_FOLDER_REMOVE' });
    }
    return this.enqueue('folder-tree:move', async () => {
      this.beginSnapshotWrite();
      let writeAttempted = false;
      try {
        const readSnapshot = async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const generation = this.connectionGeneration;
            const revision = this.snapshotCommitRevision;
            const library = await this.client.libraryInfo();
            if (!library.path || path.resolve(library.path) !== path.resolve(libraryPath)) {
              throw Object.assign(new Error('Eagle 已切换资源库，请回到原库核对删除结果'), { code: 'LIBRARY_CHANGED' });
            }
            const folders = await this.client.folderTree();
            await this.ensureLibraryPath(libraryPath);
            if (generation === this.connectionGeneration && revision === this.snapshotCommitRevision) return { ...library, folders };
          }
          throw Object.assign(new Error('文件夹正在其他窗口更新，请刷新后重新操作'), { code: 'FOLDER_REMOVE_SNAPSHOT_CHANGED' });
        };
        const before = (await readSnapshot()).folders;
        const location = findFolderLocation(before, id);
        if (!location) return { ok: false, missing: true };
        if (baseName !== null && location.folder.name !== baseName) {
          return { ok: false, conflict: true, current: location.folder };
        }
        const removedIds = folderIds([location.folder]);
        const keptIds = [...folderIds(before)].filter(folderId => !removedIds.has(folderId));
        await this.ensureLibraryPath(libraryPath);
        writeAttempted = true;
        const undoToken = `folder-undo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        await this.client.request('/api/script/inject', { method: 'POST', body: {
          script: folderRemovalScript({ id, libraryPath, isDeleteImages, token: undoToken })
        } });
        // Eagle opens its prompt after 100 ms; answered at once, the folder
        // leaves its tree within a few hundred. Eagle refuses silently (a
        // locked folder, another Eagle version), so a folder still there
        // after the wait was not deleted.
        let library = await readSnapshot();
        const gone = snapshot => [...removedIds].every(folderId => !findFolder(snapshot.folders, folderId));
        for (let attempt = 0; attempt < 30 && !gone(library); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          library = await readSnapshot();
        }
        if (!gone(library)) {
          if (findFolder(library.folders, id)) {
            writeAttempted = false;
            throw Object.assign(new Error('Eagle 没有执行删除，文件夹未改动。加密文件夹需先在 Eagle 中解锁；也可能是当前 Eagle 版本不支持'), { code: 'FOLDER_REMOVE_REFUSED' });
          }
          throw Object.assign(new Error('Eagle 只删除了部分子文件夹'), { code: 'FOLDER_REMOVE_UNCONFIRMED' });
        }
        if (!keptIds.every(folderId => findFolder(library.folders, folderId))) {
          throw Object.assign(new Error('Eagle 删除后其他文件夹回读不完整'), { code: 'FOLDER_REMOVE_UNCONFIRMED' });
        }
        // Items of the subtree changed folders (and maybe went to the
        // trash); Eagle saves them itself, so drop what this hub cached.
        for (const [itemId, item] of this.itemCache) {
          if ((item?.folders || []).some(folderId => removedIds.has(folderId))) this.itemCache.delete(itemId);
        }
        this.itemWriteRevision += 1;
        this.publishLibrarySnapshot(library, { origin });
        this.metadataSearchIndex?.scheduleRefresh?.(libraryPath);
        this.emit('query-invalidated', { reason: 'folder-remove', id, libraryPath });
        return { ok: true, removedIds: [...removedIds], parentId: location.parentId, undoToken };
      } catch (error) {
        if (writeAttempted) {
          error.uncertain = true;
          error.message = `删除请求已发送，结果尚未确认；请刷新核对，不要重复删除。${error.message || ''}`;
          this.folderTreeDirty = true;
          this.emit('query-invalidated', { reason: 'folder-remove-unconfirmed', id, libraryPath });
        }
        throw error;
      } finally {
        this.endSnapshotWrite();
      }
    });
  }

  // 撤销 of a folder deletion (P3-05) runs Eagle's own restore: the tree,
  // and every item's folders and trash state, as they were. Eagle drops the
  // restore after 12 s or when another notice replaces it; then nothing
  // changes and the folder stays deleted.
  async restoreRemovedFolder({ id, undoToken, origin = null, libraryPath }) {
    if (typeof id !== 'string' || typeof undoToken !== 'string' || typeof libraryPath !== 'string') {
      throw Object.assign(new Error('撤销需要完整的资源库和文件夹'), { code: 'INVALID_FOLDER_RESTORE' });
    }
    return this.enqueue('folder-tree:move', async () => {
      this.beginSnapshotWrite();
      try {
        await this.ensureLibraryPath(libraryPath);
        await this.client.request('/api/script/inject', { method: 'POST', body: {
          script: folderRemovalUndoScript({ token: undoToken, libraryPath })
        } });
        let folders = null;
        for (let attempt = 0; attempt < 20; attempt++) {
          await this.ensureLibraryPath(libraryPath);
          folders = await this.client.folderTree();
          if (findFolder(folders, id)) break;
          folders = null;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!folders) throw Object.assign(new Error('Eagle 的撤销已失效（超时，或 Eagle 里又有了新的操作），文件夹仍是删除状态'), { code: 'FOLDER_RESTORE_EXPIRED' });
        const library = await this.client.libraryInfo();
        this.itemCache.clear();
        this.itemWriteRevision += 1;
        this.publishLibrarySnapshot({ ...library, folders }, { origin });
        this.metadataSearchIndex?.scheduleRefresh?.(libraryPath);
        this.emit('query-invalidated', { reason: 'folder-restore', id, libraryPath });
        return { ok: true };
      } finally {
        this.endSnapshotWrite();
      }
    });
  }
}

module.exports = { DataHub, folderExtendTags };
