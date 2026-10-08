'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const INDEX_VERSION = 4;
const DEFAULT_CONCURRENCY = 4;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

function lower(value) {
  return String(value ?? '').toLocaleLowerCase('zh-CN');
}

function compactItem(item, sequence = 0) {
  if (!item?.id) return null;
  const fields = [
    'id', 'name', 'ext', 'folders', 'tags', 'annotation', 'url', 'star',
    'width', 'height', 'size', 'btime', 'mtime', 'modificationTime',
    'isDeleted', 'palettes', 'noThumbnail', 'noPreview'
  ];
  const result = {};
  for (const field of fields) {
    if (item[field] !== undefined) result[field] = item[field];
  }
  result.sequence = sequence;
  return result;
}

function metadataText(metadata) {
  if (!metadata) return '';
  const values = [metadata.positive];
  for (const character of metadata.characters || []) values.push(character?.positive);
  return values.filter(value => value !== null && value !== undefined && String(value).trim()).join('\n');
}

function itemText(item) {
  return [item.name, item.ext, item.annotation, item.url, ...(item.tags || [])]
    .filter(value => value !== null && value !== undefined && String(value).trim()).join('\n');
}

function searchTerms(value) {
  return lower(value).trim().split(/\s+/).map(term => term.replace(/^[()[\]{}<>,]+|[()[\]{}<>,]+$/g, '')).filter(Boolean);
}

function hasAdvancedSyntax(value) {
  return /\b(?:OR|NOT)\b|(^|\s)-\S/i.test(String(value || ''));
}

function libraryKey(libraryPath) {
  return crypto.createHash('sha256').update(path.resolve(String(libraryPath || ''))).digest('hex').slice(0, 20);
}

class MetadataSearchIndex {
  constructor({ directory, readMetadata, readStealthMetadata = null, client, concurrency = DEFAULT_CONCURRENCY } = {}) {
    this.directory = directory;
    this.readMetadata = readMetadata;
    this.readStealthMetadata = readStealthMetadata;
    this.client = client;
    this.concurrency = Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY);
    this.libraryPath = null;
    this.entries = new Map();
    this.ready = false;
    this.building = false;
    this.buildPromise = null;
    this.activeBuildGeneration = null;
    this.generation = 0;
    this.listeners = new Set();
    this.saveTimer = null;
    this.refreshTimer = null;
  }

  on(event, callback) {
    if (event === 'ready' && typeof callback === 'function') this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  emitReady(payload) {
    for (const callback of this.listeners) {
      try { callback(payload); } catch {}
    }
  }

  filePath() {
    return path.join(this.directory, `${libraryKey(this.libraryPath)}.json`);
  }

  async load(libraryPath) {
    this.libraryPath = libraryPath ? path.resolve(libraryPath) : null;
    this.entries = new Map();
    this.ready = false;
    if (!this.libraryPath) return false;
    try {
      const payload = JSON.parse(await fs.readFile(this.filePath(), 'utf8'));
      if (payload.version !== INDEX_VERSION || path.resolve(payload.libraryPath || '') !== this.libraryPath) return false;
      for (const entry of payload.entries || []) {
        if (entry?.id && entry.item && typeof entry.text === 'string') this.entries.set(entry.id, entry);
      }
      this.ready = true;
      this.emitReady({ ready: true, indexed: this.entries.size, cached: true });
      return true;
    } catch {
      return false;
    }
  }

  async save() {
    if (!this.libraryPath) return;
    await fs.mkdir(this.directory, { recursive: true });
    const file = this.filePath();
    const temporary = `${file}.${process.pid}.tmp`;
    const payload = {
      version: INDEX_VERSION,
      libraryPath: this.libraryPath,
      updatedAt: Date.now(),
      entries: [...this.entries.values()]
    };
    try {
      await fs.writeFile(temporary, JSON.stringify(payload), 'utf8');
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async start(libraryPath) {
    const resolved = libraryPath ? path.resolve(libraryPath) : null;
    if (resolved !== this.libraryPath) {
      this.generation += 1;
      await this.load(resolved);
    }
    if (this.building) {
      if (this.activeBuildGeneration === this.generation) return this.buildPromise;
      return this.buildPromise?.finally(() => this.start(resolved));
    }
    if (!this.libraryPath) return null;
    const generation = this.generation;
    this.building = true;
    this.activeBuildGeneration = generation;
    this.buildPromise = this.build(generation).finally(() => {
      this.building = false;
      this.activeBuildGeneration = null;
      this.buildPromise = null;
    });
    return this.buildPromise;
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch(() => {});
    }, 500);
  }

  scheduleRefresh(libraryPath = this.libraryPath) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.start(libraryPath).catch(() => {});
    }, 2000);
  }

  async refreshItem(item, libraryPath = this.libraryPath) {
    if (!this.ready || !item?.id || path.resolve(String(libraryPath || '')) !== this.libraryPath) return false;
    let embedded = null;
    try {
      const fileURL = await this.client.fileURLForItem(item, this.libraryPath);
      if (fileURL) {
        const filePath = fileURLToPath(fileURL);
        embedded = await this.readMetadata(filePath, item.ext);
        if (!embedded && this.readStealthMetadata) embedded = await this.readStealthMetadata(filePath, item.ext);
      }
    } catch {}
    const previous = this.entries.get(item.id);
    const sequence = previous?.sequence ?? this.entries.size;
    const revision = `${item.modificationTime || item.mtime || item.size || 0}`;
    this.entries.set(item.id, {
      id: item.id,
      revision,
      sequence,
      item: compactItem(item, sequence),
      text: lower(`${itemText(item)}\n${metadataText(embedded)}`)
    });
    this.scheduleSave();
    return true;
  }

  async build(generation) {
    let items;
    try {
      items = await this.client.listAllItems();
    } catch {
      return { ready: this.ready, indexed: this.entries.size, error: 'Eagle 无法读取全部素材' };
    }
    if (generation !== this.generation) return { ready: false, indexed: 0 };

    let dirty = false;
    const liveIds = new Set(items.map(item => item?.id).filter(Boolean));
    for (const id of this.entries.keys()) {
      if (!liveIds.has(id)) {
        this.entries.delete(id);
        dirty = true;
      }
    }

    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length && generation === this.generation) {
        const sequence = cursor;
        const item = items[cursor++];
        if (!item?.id || item.isDeleted) {
          if (item?.id) {
            const next = { id: item.id, item: compactItem(item, sequence), text: '' };
            if (JSON.stringify(this.entries.get(item.id)) !== JSON.stringify(next)) dirty = true;
            this.entries.set(item.id, next);
          }
          continue;
        }
        const compact = compactItem(item, sequence);
        const revision = `${item.modificationTime || item.mtime || item.size || 0}`;
        const previous = this.entries.get(item.id);
        if (previous?.revision === revision && previous.item) {
          if (JSON.stringify(previous.item) !== JSON.stringify(compact) || previous.sequence !== sequence) dirty = true;
          previous.item = compact;
          previous.sequence = sequence;
          continue;
        }
        let embedded = null;
        if (IMAGE_EXTENSIONS.has(String(item.ext || '').toLowerCase())) {
          try {
            const fileURL = await this.client.fileURLForItem(item, this.libraryPath);
            if (fileURL) {
              const filePath = fileURLToPath(fileURL);
              embedded = await this.readMetadata(filePath, item.ext);
              if (!embedded && this.readStealthMetadata) embedded = await this.readStealthMetadata(filePath, item.ext);
            }
          } catch {}
        }
        this.entries.set(item.id, {
          id: item.id,
          revision,
          sequence,
          item: compact,
          text: lower(`${itemText(item)}\n${metadataText(embedded)}`)
        });
        dirty = true;
        if (sequence % 200 === 0) await new Promise(resolve => setImmediate(resolve));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, items.length || 1) }, worker));
    if (generation !== this.generation) return { ready: false, indexed: this.entries.size };
    const hadReadyIndex = this.ready;
    this.ready = true;
    if (dirty || !hadReadyIndex) await this.save().catch(() => {});
    const result = { ready: true, indexed: this.entries.size };
    this.emitReady(result);
    return result;
  }

  async search(query, { offset = 0, limit = 160, matcher = null } = {}) {
    const terms = searchTerms(query);
    if (!terms.length || !this.ready) return null;
    const matches = [];
    let examined = 0;
    for (const entry of this.entries.values()) {
      examined += 1;
      if (!entry?.item || entry.item.isDeleted) continue;
      if (matcher && !matcher(entry.item)) continue;
      if (terms.every(term => entry.text.includes(term))) matches.push(entry);
      if (examined % 500 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    matches.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
    const start = Math.max(0, Number(offset) || 0);
    const pageSize = Math.min(500, Math.max(1, Number(limit) || 160));
    const data = matches.slice(start, start + pageSize).map(entry => entry.item);
    return {
      data,
      total: matches.length,
      offset: start,
      limit: pageSize,
      nextOffset: start + data.length,
      hasMore: start + data.length < matches.length,
      estimated: false,
      metadataIndexed: true
    };
  }
}

module.exports = { MetadataSearchIndex, metadataText, itemText, searchTerms, hasAdvancedSyntax };
