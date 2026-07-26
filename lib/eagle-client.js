'use strict';

const { pathToFileURL } = require('node:url');
const querySpec = require('../src/query-spec');

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

  async folderTree() {
    const page = await this.request('/api/v2/folder/get?limit=1000');
    return page.data || [];
  }

  async listRecentFolders() {
    const page = await this.request('/api/folder/listRecent');
    return page || [];
  }

  async randomItems(query = {}) {
    const params = new URLSearchParams({
      orderBy: 'RANDOM',
      limit: String(Math.min(500, Math.max(1, Number(query.limit) || 160))),
      offset: String(Math.max(0, Number(query.offset) || 0))
    });
    if (query.search?.trim()) params.set('keyword', query.search.trim());
    if (query.ext) params.set('ext', query.ext);
    if (query.tags?.length) params.set('tags', query.tags.join(','));
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
    if (!item) throw new Error('素材不存在或已不在当前资料库');
    return item;
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

  async listTags() {
    const page = await this.request('/api/v2/tag/get?limit=1000');
    return (page?.data || []).map(tag => typeof tag === 'string' ? { name: tag } : tag).filter(tag => tag?.name);
  }

  async listTagGroups() {
    const page = await this.request('/api/v2/tagGroup/get?limit=1000');
    return page?.data || [];
  }

  async listSmartFolders() {
    const page = await this.request('/api/v2/smartFolder/get?limit=1000');
    return page?.data || [];
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

  createFolder(name, parent) {
    return this.request('/api/v2/folder/create', {
      method: 'POST',
      body: { name, ...(parent ? { parent } : {}) }
    });
  }

  updateFolder(id, patch) {
    return this.request('/api/v2/folder/update', {
      method: 'POST',
      body: { id, ...patch }
    });
  }

  addItems(paths, folderId) {
    return this.request('/api/item/addFromPaths', {
      method: 'POST',
      body: { paths, ...(folderId ? { folderId } : {}) }
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
    const expected = path.join(folder, `${item.name}.${item.ext}`);
    try {
      await fs.access(expected);
      return pathToFileURL(expected).toString();
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
