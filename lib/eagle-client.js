'use strict';

const { pathToFileURL } = require('node:url');

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

  async queryItems(query = {}) {
    const body = {
      offset: Math.max(0, Number(query.offset) || 0),
      limit: Math.min(500, Math.max(1, Number(query.limit) || 160))
    };
    if (query.folderId) body.folders = [query.folderId];
    if (query.smartFolderId) body.smartFolders = [query.smartFolderId];
    if (query.unfiled) body.isUnfiled = true;
    if (query.search?.trim()) body.keywords = query.search.trim().split(/\s+/).filter(Boolean);
    if (query.tags?.length) body.tags = query.tags;
    if (query.ext) body.ext = query.ext;
    if (Number.isInteger(query.rating)) body.rating = query.rating;
    const page = await this.request('/api/v2/item/get', { method: 'POST', body });
    return { ...page, nextOffset: body.offset + (page.data || []).length, hasMore: body.offset + (page.data || []).length < page.total };
  }

  async getItem(id) {
    const page = await this.request(`/api/v2/item/get?id=${encodeURIComponent(id)}&limit=1`);
    const item = Array.isArray(page?.data) ? page.data[0] : page;
    if (!item) throw new Error('素材不存在或已不在当前资料库');
    return item;
  }

  async getItems(ids) {
    if (!ids?.length) return [];
    const page = await this.request('/api/v2/item/get', {
      method: 'POST',
      body: { ids: [...new Set(ids)], offset: 0, limit: Math.min(1000, ids.length) }
    });
    return page?.data || [];
  }

  async listTags() {
    const page = await this.request('/api/v2/tag/get?limit=1000');
    return (page?.data || []).map(tag => typeof tag === 'string' ? { name: tag } : tag).filter(tag => tag?.name);
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
