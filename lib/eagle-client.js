'use strict';

const { pathToFileURL } = require('node:url');
const { fileInDirectory } = require('./item-paths');
const querySpec = require('../src/query-spec');
const paneState = require('../src/pane-state');

class EagleClient {
  constructor(baseURL = 'http://127.0.0.1:41595') {
    this.baseURL = baseURL;
  }

  async request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || 8000);
    try {
      const response = await fetch(`${this.baseURL}${path}`, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
      const raw = await response.text();
      let payload;
      try { payload = JSON.parse(raw); } catch { payload = null; }
      if (!response.ok) {
        const detail = String(payload?.message || payload?.data || raw || '').trim().slice(0, 500);
        throw new Error(`Eagle API ${response.status}${detail ? `：${detail}` : ''}`);
      }
      if (!payload) throw new Error('Eagle API 返回了无法识别的内容');
      if (payload.status !== 'success') throw new Error(payload.message || 'Eagle API 请求失败');
      return payload.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  appInfo() {
    return this.request('/api/v2/app/info');
  }

  libraryInfo() {
    return this.request('/api/v2/library/info');
  }

  // Eagle's history endpoint returns some paths with a trailing slash, but
  // its switch endpoint rejects that form and library info reports without
  // it — normalize everywhere so the three agree.
  static normalizeLibraryPath(value) {
    const raw = String(value || '');
    const trimmed = raw.replace(/\/+$/, '');
    return trimmed || raw;
  }

  async listLibraryHistory() {
    const paths = await this.request('/api/library/history');
    if (!Array.isArray(paths)) return [];
    // Eagle lists the same library twice when its history holds both the
    // plain and trailing-slash form; normalization makes them collide.
    return [...new Set(paths.filter(entry => typeof entry === 'string' && entry).map(EagleClient.normalizeLibraryPath))];
  }

  switchLibrary(libraryPath) {
    return this.request('/api/library/switch', {
      method: 'POST',
      body: { libraryPath: EagleClient.normalizeLibraryPath(libraryPath) }
    });
  }

  // Eagle loads the new library asynchronously after a switch request; poll
  // until library info reflects the target before rebuilding state on it.
  async waitForLibrary(libraryPath, { timeoutMs = 20000, intervalMs = 400 } = {}) {
    const target = EagleClient.normalizeLibraryPath(libraryPath);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (EagleClient.normalizeLibraryPath((await this.libraryInfo())?.path) === target) return true;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  async folderTree() {
    const page = await this.request('/api/v2/folder/get?limit=1000');
    return page.data || [];
  }

  async listRecentFolders() {
    const page = await this.request('/api/folder/listRecent');
    return page || [];
  }

  async selectedFolder() {
    const page = await this.request('/api/v2/folder/get', {
      method: 'POST',
      body: { isSelected: true, limit: 1 }
    });
    return Array.isArray(page?.data) ? page.data[0] || null : null;
  }

  async randomItems(query = {}) {
    const params = new URLSearchParams({
      orderBy: 'RANDOM',
      limit: String(Math.min(500, Math.max(1, Number(query.limit) || 160))),
      offset: String(Math.max(0, Number(query.offset) || 0))
    });
    if (query.search?.trim()) params.set('keyword', query.search.trim());
    // Only what the v1 list narrows exactly; the local match does the rest.
    const body = querySpec.itemQueryBody(query);
    if (body.ext) params.set('ext', body.ext);
    if (body.tags?.length) params.set('tags', body.tags.join(','));
    const data = await this.request(`/api/item/list?${params}`);
    const items = Array.isArray(data) ? data : [];
    const filtered = items.filter(item => EagleClient.matchesSearchConstraints(item, query));
    return {
      data: filtered,
      total: filtered.length,
      nextOffset: (Number(query.offset) || 0) + filtered.length,
      hasMore: false,
      estimated: true
    };
  }

  async smartFolderItemIds(id) {
    const ids = new Set();
    let offset = 0;
    while (true) {
      const page = await this.request(`/api/v2/smartFolder/getItems?smartFolderId=${encodeURIComponent(id)}&offset=${offset}&limit=1000`);
      const data = Array.isArray(page?.data) ? page.data : [];
      for (const item of data) if (item?.id) ids.add(item.id);
      offset += data.length;
      if (!data.length || offset >= Number(page?.total || offset)) break;
    }
    return ids;
  }

  // Color parsing/matching and the constraint predicate all derive from the
  // declarative field table in src/query-spec.js; these statics stay as the
  // stable entry points (data-hub resolves the matcher via the constructor).
  static parseHexColor(value) {
    return querySpec.parseHexColor(value);
  }

  static matchesColor(item, colorValue, threshold = 96) {
    return querySpec.matchesColor(item, colorValue, threshold);
  }

  static matchesSearchConstraints(item, query, smartFolderIds = null) {
    return querySpec.matchesConstraints(item, query, { smartFolderIds });
  }

  async queryTextItems(query) {
    const offset = Math.max(0, Number(query.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 160));
    if (!querySpec.clientConstrained(query)) {
      const page = await this.request('/api/v2/item/query', {
        method: 'POST',
        body: { query: query.search.trim(), offset, limit }
      });
      return { ...page, nextOffset: offset + (page.data || []).length, hasMore: offset + (page.data || []).length < page.total };
    }

    return this.scanFilteredItems(query, scanOffset => this.request('/api/v2/item/query', {
      method: 'POST',
      body: { query: query.search.trim(), offset: scanOffset, limit: 1000 }
    }));
  }

  // Shared client-side scan for filters the Eagle API cannot evaluate:
  // fetch server pages, filter locally, and report "at least N" totals until
  // the scan is exhausted (continued scrolling extends it).
  async scanFilteredItems(query, fetchPage) {
    const offset = Math.max(0, Number(query.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 160));
    const smartFolderIds = query.smartFolderId ? await this.smartFolderItemIds(query.smartFolderId) : null;
    const matches = [];
    let scanOffset = 0;
    let exhausted = false;
    const needed = offset + limit;
    while (matches.length < needed) {
      const page = await fetchPage(scanOffset);
      const data = Array.isArray(page?.data) ? page.data : [];
      matches.push(...data.filter(item => EagleClient.matchesSearchConstraints(item, query, smartFolderIds)));
      scanOffset += data.length;
      if (!data.length || scanOffset >= Number(page?.total || scanOffset)) {
        exhausted = true;
        break;
      }
    }
    const data = matches.slice(offset, offset + limit);
    return {
      data,
      total: matches.length,
      estimated: !exhausted,
      offset,
      limit,
      nextOffset: offset + data.length,
      hasMore: !exhausted || offset + data.length < matches.length
    };
  }

  static itemQueryBody(query) {
    return querySpec.itemQueryBody(query);
  }

  async queryItems(query = {}) {
    if (query.random) return this.randomItems(query);
    if (query.search?.trim()) return this.queryTextItems(query);
    if (querySpec.needsClientScan(query)) return this.queryColorItems(query);
    const body = {
      ...EagleClient.itemQueryBody(query),
      offset: Math.max(0, Number(query.offset) || 0),
      limit: Math.min(500, Math.max(1, Number(query.limit) || 160))
    };
    const page = await this.request('/api/v2/item/get', { method: 'POST', body });
    return { ...page, nextOffset: body.offset + (page.data || []).length, hasMore: body.offset + (page.data || []).length < page.total };
  }

  // File count and total size of a view for the inspector (P2-05), reading
  // only id and size, 1000 rows per request (the whole of an 85k-item library
  // in about a second). Null for searches, random and client-filtered views,
  // which the API cannot page as one plain list.
  async viewStats(query = {}) {
    // A folder shown with its subfolders' content is the one client-side
    // constraint this can still serve: read folders too and match locally.
    const subtree = Array.isArray(query.folderIds) && query.folderIds.length > 1 ? new Set(query.folderIds) : null;
    if (query.random || query.search?.trim() || querySpec.needsClientScan({ ...query, folderIds: null })) return null;
    const body = EagleClient.itemQueryBody(query);
    const fields = subtree ? ['id', 'size', 'folders'] : ['id', 'size'];
    let offset = 0;
    let count = 0;
    let size = 0;
    while (true) {
      const page = await this.request('/api/v2/item/get', {
        method: 'POST',
        body: { ...body, offset, limit: 1000, fields }
      });
      const data = Array.isArray(page?.data) ? page.data : [];
      for (const item of data) {
        if (subtree && !(item?.folders || []).some(id => subtree.has(id))) continue;
        count += 1;
        size += Number(item?.size) || 0;
      }
      offset += data.length;
      if (!data.length || offset >= Number(page?.total || 0)) return { count, size };
    }
  }

  // What the filter panel lists with counts, like Eagle's filter menus: each
  // format, each folder (direct membership, plus 未分类), each month of the
  // added and modified dates, each rating and each shape, over the view
  // without its filters. Same
  // paging as viewStats, reading only the fields counted.
  async viewFacets(query = {}) {
    const subtree = Array.isArray(query.folderIds) && query.folderIds.length > 1 ? new Set(query.folderIds) : null;
    if (query.random || query.search?.trim() || querySpec.needsClientScan({ ...query, folderIds: null })) return null;
    const body = EagleClient.itemQueryBody(query);
    const facets = { total: 0, exts: {}, folders: {}, addedMonths: {}, modifiedMonths: {}, ratings: {}, shapes: {} };
    const bump = (map, key) => { map[key] = (map[key] || 0) + 1; };
    let offset = 0;
    while (true) {
      const page = await this.request('/api/v2/item/get', {
        method: 'POST',
        body: { ...body, offset, limit: 1000, fields: ['id', 'ext', 'folders', 'modificationTime', 'mtime', 'star', 'width', 'height'] }
      });
      const data = Array.isArray(page?.data) ? page.data : [];
      for (const item of data) {
        const folders = Array.isArray(item?.folders) ? item.folders : [];
        if (subtree && !folders.some(id => subtree.has(id))) continue;
        facets.total += 1;
        const ext = String(item?.ext || '').toLowerCase();
        if (ext) bump(facets.exts, ext);
        if (folders.length) folders.forEach(id => bump(facets.folders, id));
        else bump(facets.folders, querySpec.NO_FOLDER);
        const added = Number(item?.modificationTime) || 0;
        if (added) bump(facets.addedMonths, querySpec.monthKey(added));
        const modified = Number(item?.mtime) || added;
        if (modified) bump(facets.modifiedMonths, querySpec.monthKey(modified));
        // Eagle's filterCounts: an unrated item counts as 0.
        bump(facets.ratings, String(Number(item?.star) || 0));
        for (const shape of querySpec.shapeFacetKeys(item)) bump(facets.shapes, shape);
      }
      offset += data.length;
      if (!data.length || offset >= Number(page?.total || 0)) return facets;
    }
  }

  // Every id of a view, for ⌘A past what the grid has loaded (P6-02). A
  // plain view reads only ids, 1000 per request; searches and client-side
  // filters scan once with the same matcher queryItems uses, instead of
  // re-scanning from the start for every page. Null for random views.
  async viewItemIds(query = {}) {
    if (query.random) return null;
    const ids = [];
    const subtree = Array.isArray(query.folderIds) && query.folderIds.length > 1 ? new Set(query.folderIds) : null;
    const search = String(query.search || '').trim();
    const plain = !search && !querySpec.needsClientScan({ ...query, folderIds: null });
    if (plain) {
      const body = EagleClient.itemQueryBody(query);
      const fields = subtree ? ['id', 'folders'] : ['id'];
      for (let offset = 0; ;) {
        const page = await this.request('/api/v2/item/get', { method: 'POST', body: { ...body, offset, limit: 1000, fields } });
        const data = Array.isArray(page?.data) ? page.data : [];
        for (const item of data) {
          if (!item?.id || (subtree && !(item.folders || []).some(id => subtree.has(id)))) continue;
          ids.push(item.id);
        }
        offset += data.length;
        if (!data.length || offset >= Number(page?.total || 0)) return ids;
      }
    }
    const constrained = search ? querySpec.clientConstrained(query) : true;
    const smartFolderIds = constrained && query.smartFolderId ? await this.smartFolderItemIds(query.smartFolderId) : null;
    for (let offset = 0; ;) {
      const page = search
        ? await this.request('/api/v2/item/query', { method: 'POST', body: { query: search, offset, limit: 1000 } })
        : await this.request('/api/v2/item/get', { method: 'POST', body: { ...EagleClient.itemQueryBody(query), offset, limit: 1000 } });
      const data = Array.isArray(page?.data) ? page.data : [];
      for (const item of data) {
        if (!item?.id || (constrained && !EagleClient.matchesSearchConstraints(item, query, smartFolderIds))) continue;
        ids.push(item.id);
      }
      offset += data.length;
      if (!data.length || offset >= Number(page?.total || offset)) return ids;
    }
  }

  // Summary of a selection the grid has not loaded all of (P6-02): what the
  // multi-select inspector shows, computed here so the renderer never holds
  // tens of thousands of items. Reads the fields it needs, 1000 per request.
  async selectionSummary(ids = []) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    const items = [];
    for (let start = 0; start < unique.length; start += 1000) {
      const chunk = unique.slice(start, start + 1000);
      const page = await this.request('/api/v2/item/get', {
        method: 'POST',
        body: { ids: chunk, offset: 0, limit: chunk.length, fields: ['id', 'size', 'star', 'tags', 'folders', 'annotation', 'url'] }
      });
      if (Array.isArray(page?.data)) items.push(...page.data);
    }
    return paneState.selectionSummary(items);
  }

  // Position of an item in the same order queryItems pages through, reading
  // only ids (1000 per request, about 10–20 ms each). Returns -1 when the
  // query does not contain it, or null for searches, random and color views,
  // whose order is not the plain API order.
  async locateItemIndex(query = {}, id) {
    if (query.random || query.search?.trim() || querySpec.needsClientScan(query)) return null;
    const body = EagleClient.itemQueryBody(query);
    let offset = 0;
    while (true) {
      const page = await this.request('/api/v2/item/get', {
        method: 'POST',
        body: { ...body, offset, limit: 1000, fields: ['id'] }
      });
      const data = Array.isArray(page?.data) ? page.data : [];
      const index = data.findIndex(item => item?.id === id);
      if (index !== -1) return offset + index;
      offset += data.length;
      if (!data.length || offset >= Number(page?.total || 0)) return -1;
    }
  }

  // The Eagle API cannot filter by color, so color queries reuse the shared
  // client-side scan over /api/v2/item/get pages.
  queryColorItems(query) {
    return this.scanFilteredItems(query, scanOffset => this.request('/api/v2/item/get', {
      method: 'POST',
      body: { ...EagleClient.itemQueryBody(query), offset: scanOffset, limit: 1000 }
    }));
  }

  async getItem(id) {
    const page = await this.request(`/api/v2/item/get?id=${encodeURIComponent(id)}&limit=1`);
    const item = Array.isArray(page?.data) ? page.data[0] : page;
    if (item) return item;
    // v2 item/get leaves trashed items out even by id; v1 item/info still
    // returns them, and restoring one (undo delete) reads it first.
    const info = await this.request(`/api/item/info?id=${encodeURIComponent(id)}`).catch(() => null);
    if (info?.id === id) return info;
    throw new Error('素材不存在或已不在当前资源库');
  }

  async getItems(ids, options = {}) {
    if (!ids?.length) return [];
    const page = await this.request('/api/v2/item/get', {
      method: 'POST',
      body: { ids: [...new Set(ids)], offset: 0, limit: Math.min(1000, ids.length) },
      ...(options.timeout ? { timeout: options.timeout } : {})
    });
    return page?.data || [];
  }

  async listAllItems({ includeDeleted = true } = {}) {
    const items = [];
    let offset = 0;
    while (true) {
      const page = await this.request('/api/v2/item/get', {
        method: 'POST',
        body: { offset, limit: 1000 }
      });
      const data = Array.isArray(page?.data) ? page.data : [];
      items.push(...(includeDeleted ? data : data.filter(item => !item?.isDeleted)));
      offset += data.length;
      if (!data.length || offset >= Number(page?.total || offset)) break;
    }
    return items;
  }

  // The v2 list endpoints answer one page ({ data, total, offset, limit });
  // a library past the first page lost its later tags everywhere (B2-02).
  async listPaged(endpoint, limit = 1000) {
    const records = [];
    let offset = 0;
    while (true) {
      const page = await this.request(`${endpoint}?limit=${limit}&offset=${offset}`);
      const data = Array.isArray(page?.data) ? page.data : [];
      records.push(...data);
      offset += data.length;
      if (!data.length || offset >= Number(page?.total ?? offset)) break;
    }
    return records;
  }

  async listTags() {
    const tags = await this.listPaged('/api/v2/tag/get');
    return tags.map(tag => typeof tag === 'string' ? { name: tag } : tag).filter(tag => tag?.name);
  }

  // Exact number of (non-trashed) items holding the tag; item/get's tag
  // filter is an intersection rule on exact names.
  async countItemsWithTag(name) {
    const page = await this.request('/api/v2/item/get', {
      method: 'POST',
      body: { tags: [name], offset: 0, limit: 1, fields: ['id'] }
    });
    return Number(page?.total) || 0;
  }

  async listTagGroups() {
    return this.listPaged('/api/v2/tagGroup/get');
  }

  // Eagle's 常用标签. The API can read them but offers no way to set them.
  async listStarredTags() {
    const tags = await this.listPaged('/api/v2/tag/getStarredTags');
    return tags.map(tag => (typeof tag === 'string' ? tag : tag?.name)).filter(Boolean);
  }

  async listSmartFolders() {
    return this.listPaged('/api/v2/smartFolder/get');
  }

  async getComments(id) {
    const data = await this.request(`/api/v2/item/getComments?id=${encodeURIComponent(id)}`);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.comments)) return data.comments;
    return [];
  }

  addComment(id, comment = {}) {
    return this.request('/api/v2/item/addComment', {
      method: 'POST',
      body: { id, ...comment }
    });
  }

  updateComment(id, commentId, patch = {}) {
    return this.request('/api/v2/item/updateComment', {
      method: 'POST',
      body: { id, commentId, ...patch }
    });
  }

  removeComment(id, commentId) {
    return this.request('/api/v2/item/removeComment', {
      method: 'POST',
      body: { id, commentId }
    });
  }

  setCustomThumbnail(itemId, filePath, width, height) {
    return this.request('/api/v2/item/setCustomThumbnail', {
      method: 'POST',
      timeout: 15000,
      body: { itemId, filePath, ...(Number.isFinite(width) ? { width } : {}), ...(Number.isFinite(height) ? { height } : {}) }
    });
  }

  createSmartFolder(payload) {
    return this.request('/api/v2/smartFolder/create', { method: 'POST', body: payload });
  }

  updateSmartFolder(id, patch) {
    return this.request('/api/v2/smartFolder/update', { method: 'POST', body: { id, ...patch } });
  }

  removeSmartFolder(id) {
    return this.request('/api/v2/smartFolder/remove', { method: 'POST', body: { id } });
  }

  renameTag(originalName, name) {
    return this.request('/api/v2/tag/update', {
      method: 'POST',
      body: { originalName, name }
    });
  }

  mergeTag(source, target) {
    return this.request('/api/v2/tag/merge', {
      method: 'POST',
      body: { source, target }
    });
  }

  createTagGroup(name) {
    return this.request('/api/v2/tagGroup/create', {
      method: 'POST',
      body: { name }
    });
  }

  updateTagGroup(id, patch) {
    return this.request('/api/v2/tagGroup/update', {
      method: 'POST',
      body: { id, ...patch }
    });
  }

  removeTagGroup(id) {
    return this.request('/api/v2/tagGroup/remove', {
      method: 'POST',
      body: { id }
    });
  }

  addTagsToGroup(groupId, tags) {
    return this.request('/api/v2/tagGroup/addTags', {
      method: 'POST',
      body: { groupId, tags }
    });
  }

  removeTagsFromGroup(groupId, tags) {
    return this.request('/api/v2/tagGroup/removeTags', {
      method: 'POST',
      body: { groupId, tags }
    });
  }

  updateItem(id, patch) {
    return this.request('/api/v2/item/update', {
      method: 'POST',
      body: { id, ...patch }
    });
  }

  createFolder(name, parent, options = {}) {
    return this.request('/api/v2/folder/create', {
      method: 'POST',
      body: { name, ...(parent ? { parent } : {}), ...(options.description !== undefined ? { description: options.description } : {}) }
    });
  }

  updateFolderProperties(id, patch = {}) {
    return this.request('/api/v2/folder/update', {
      method: 'POST', body: { id, ...patch }
    });
  }

  updateFolder(id, patch = {}) {
    return this.request('/api/folder/rename', {
      method: 'POST',
      body: { folderId: id, newName: patch.name || patch.newName || '' }
    });
  }

  moveFolder(id, { parent, iconColor }) {
    return this.request('/api/v2/folder/update', {
      method: 'POST', body: { id, parent, iconColor }
    });
  }

  // With tags (a folder's auto tags) the same endpoint takes per-file items;
  // Eagle adds them exactly as the plain path list otherwise.
  addItems(paths, folderId, tags = []) {
    return this.request('/api/item/addFromPaths', {
      method: 'POST',
      body: { ...(tags.length ? { items: paths.map(path => ({ path, tags: [...tags] })) } : { paths }), ...(folderId ? { folderId } : {}) }
    });
  }

  addSiteAsset({ url, name, website }, folderId) {
    return this.request('/api/v2/item/add', {
      method: 'POST', timeout: 60000,
      body: { url, name, website, folders: folderId ? [folderId] : [] }
    });
  }

  addBookmark({ url, name, tags = [] }, folderId) {
    return this.request('/api/item/addBookmark', {
      method: 'POST', timeout: 60000,
      body: { url, ...(name ? { name } : {}), tags, ...(folderId ? { folderId } : {}) }
    });
  }

  refreshThumbnail(id) {
    return this.request('/api/v2/item/refreshThumbnail', {
      method: 'POST',
      body: { itemId: id }
    });
  }

  async thumbnailPath(id) {
    const value = await this.request(`/api/item/thumbnail?id=${encodeURIComponent(id)}`);
    if (!value) return null;
    try { return decodeURIComponent(value); } catch { return value; }
  }

  async fileURLForItem(item, libraryPath) {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const folder = path.join(libraryPath, 'images', `${item.id}.info`);
    const expected = fileInDirectory(folder, `${item.name}.${item.ext}`);
    try {
      if (expected) {
        await fs.access(expected);
        return pathToFileURL(expected).toString();
      }
    } catch {}
    try {
      const names = await fs.readdir(folder);
      const ext = `.${String(item.ext || '').toLowerCase()}`;
      const match = names.find(name => name.toLowerCase().endsWith(ext) && !name.includes('_thumbnail'));
      if (match) return pathToFileURL(path.join(folder, match)).toString();
    } catch {}
    return null;
  }
}

module.exports = { EagleClient };
