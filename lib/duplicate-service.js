'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileInDirectory } = require('./item-paths');

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(Buffer.from(chunk));
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => {});
  }
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const value = values[cursor++];
      const result = await mapper(value);
      if (result !== null && result !== undefined) results.push(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), values.length) }, worker));
  return results;
}

function pairImportedIdsWithFolders(importedIds = [], entries = []) {
  // A truncated or deduplicated response no longer identifies which source
  // produced each ID. Never assign another file's folders by guessed index.
  if (importedIds.length !== entries.length || new Set(importedIds).size !== importedIds.length || importedIds.some(id => !id)) return [];
  return importedIds.map((id, index) => {
    const folders = [...new Set((entries[index]?.item?.folders || []).filter(Boolean))];
    return id && folders.length ? { id, folders } : null;
  }).filter(Boolean);
}

async function mediaPathForMetadata(imagesRoot, folder, metadata) {
  const directory = path.join(imagesRoot, folder.name);
  const extension = `.${String(metadata.ext || '').toLowerCase()}`;
  const expected = fileInDirectory(directory, `${metadata.name}${extension}`);
  try {
    if (expected) {
      await fs.access(expected);
      return expected;
    }
  } catch {}
  try {
    const names = await fs.readdir(directory);
    const match = names.find(name => name.toLowerCase().endsWith(extension) && !name.includes('_thumbnail'));
    return match ? path.join(directory, match) : null;
  } catch {
    return null;
  }
}

async function readLibraryRecords(libraryPath, metadataConcurrency = 128) {
  const imagesRoot = path.join(libraryPath, 'images');
  let folders;
  try { folders = await fs.readdir(imagesRoot, { withFileTypes: true }); } catch { return []; }
  const metadataFolders = folders.filter(folder => folder.isDirectory() && folder.name.endsWith('.info'));
  return mapWithConcurrency(metadataFolders, metadataConcurrency, async folder => {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(imagesRoot, folder.name, 'metadata.json'), 'utf8'));
      return { folder, metadata };
    } catch {
      return null;
    }
  });
}

// Item folders are read once per library; later changes only read the item
// folders that appeared since and drop those that went away (E-04). Changes
// inside an existing item are not re-read: trash state is checked live before
// a duplicate is reported, and a renamed file is found by listing its folder.
class DuplicateIndex {
  constructor({ metadataConcurrency = 128 } = {}) {
    this.metadataConcurrency = metadataConcurrency;
    this.libraryPath = null;
    this.records = null;
    this.loading = null;
    this.recordsMtime = null;
    this.revision = 0;
    this.stale = false;
  }

  async imagesMtime(resolvedPath) {
    try { return (await fs.stat(path.join(resolvedPath, 'images'))).mtimeMs; } catch { return null; }
  }

  warm(libraryPath) {
    if (!libraryPath) return Promise.resolve([]);
    const resolvedPath = path.resolve(libraryPath);
    if (this.libraryPath === resolvedPath) {
      if (this.loading) return this.loading;
      if (this.records) return this.stale ? this.refresh(resolvedPath) : Promise.resolve(this.records);
    }
    this.libraryPath = resolvedPath;
    this.records = null;
    this.recordsMtime = null;
    this.stale = false;
    return this.track(resolvedPath, async () => {
      // The directory time is taken first, so folders added during the read
      // make the snapshot look outdated rather than complete.
      const mtime = await this.imagesMtime(resolvedPath);
      const records = await readLibraryRecords(resolvedPath, this.metadataConcurrency).catch(() => []);
      return { records, mtime };
    });
  }

  // Brings the snapshot up to date by reading only new item folders.
  refresh(libraryPath) {
    if (!libraryPath) return Promise.resolve([]);
    const resolvedPath = path.resolve(libraryPath);
    if (this.libraryPath !== resolvedPath || !this.records) return this.warm(resolvedPath);
    if (this.loading) return this.loading.then(() => this.refresh(resolvedPath));
    const base = this.records;
    return this.track(resolvedPath, async () => {
      const mtime = await this.imagesMtime(resolvedPath);
      const imagesRoot = path.join(resolvedPath, 'images');
      let folders;
      try { folders = await fs.readdir(imagesRoot, { withFileTypes: true }); } catch { return { records: [], mtime }; }
      const known = new Map(base.map(record => [record.folder.name, record]));
      const kept = [];
      const added = [];
      for (const folder of folders) {
        if (!folder.isDirectory() || !folder.name.endsWith('.info')) continue;
        const record = known.get(folder.name);
        if (record) kept.push(record);
        else added.push(folder);
      }
      const read = await mapWithConcurrency(added, this.metadataConcurrency, async folder => {
        try {
          return { folder, metadata: JSON.parse(await fs.readFile(path.join(imagesRoot, folder.name, 'metadata.json'), 'utf8')) };
        } catch {
          return null;
        }
      });
      return { records: [...kept, ...read], mtime };
    });
  }

  track(resolvedPath, load) {
    const revision = ++this.revision;
    const loading = load().then(({ records, mtime }) => {
      if (this.libraryPath === resolvedPath && this.revision === revision) {
        this.records = records;
        this.recordsMtime = mtime;
        this.stale = false;
      }
      return records;
    });
    this.loading = loading;
    return loading.finally(() => {
      if (this.loading === loading) this.loading = null;
    });
  }

  // The library changed: the next use refreshes the snapshot incrementally.
  markStale(libraryPath = null) {
    if (libraryPath && this.libraryPath !== path.resolve(libraryPath)) return;
    this.stale = true;
  }

  // The current snapshot, or null while it is stale or still loading.
  peek(libraryPath) {
    if (!libraryPath || this.libraryPath !== path.resolve(libraryPath) || this.stale || this.loading) return null;
    return this.records;
  }

  invalidate(libraryPath = null) {
    if (libraryPath && this.libraryPath !== path.resolve(libraryPath)) return;
    this.revision += 1;
    this.records = null;
    this.recordsMtime = null;
    this.loading = null;
    this.stale = false;
  }

  async recordsFor(libraryPath) {
    const resolvedPath = path.resolve(libraryPath);
    if (this.libraryPath === resolvedPath && this.records && !this.loading) {
      if (!this.stale && await this.imagesMtime(resolvedPath) === this.recordsMtime) return this.records;
      return this.refresh(resolvedPath);
    }
    return this.warm(resolvedPath);
  }
}

async function findDuplicateImports({ paths = [], libraryPath, index = null, includeDeleted = false, metadataConcurrency = 128, hashConcurrency = 4 } = {}) {
  const accepted = [];
  for (const candidate of [...new Set(paths)]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) accepted.push({ path: path.resolve(candidate), size: stat.size });
    } catch {}
  }
  if (!accepted.length || !libraryPath) return [];
  const bySize = new Map();
  for (const entry of accepted) {
    if (!bySize.has(entry.size)) bySize.set(entry.size, []);
    bySize.get(entry.size).push(entry);
  }
  const records = index
    ? await index.recordsFor(libraryPath)
    : await readLibraryRecords(libraryPath, metadataConcurrency);
  const matchingRecords = records.map(record => {
    if (record.metadata.isDeleted && !includeDeleted) return null;
    const candidates = bySize.get(Number(record.metadata.size));
    return candidates?.length ? { ...record, candidates } : null;
  }).filter(Boolean);
  if (!matchingRecords.length) return [];

  const imagesRoot = path.join(libraryPath, 'images');
  // Hash only the files that share a size with something in the library (E-15).
  const sizeMatched = [...new Set(matchingRecords.flatMap(record => record.candidates))];
  const candidateHashes = new Map(await mapWithConcurrency(sizeMatched, hashConcurrency, async candidate => {
    try { return [candidate.path, await sha256(candidate.path)]; } catch { return null; }
  }));
  const matches = await mapWithConcurrency(matchingRecords, hashConcurrency, async record => {
    const mediaPath = await mediaPathForMetadata(imagesRoot, record.folder, record.metadata);
    if (!mediaPath) return null;
    let existingHash;
    try { existingHash = await sha256(mediaPath); } catch { return null; }
    return record.candidates
      .filter(candidate => candidateHashes.get(candidate.path) === existingHash)
      .map(candidate => ({ path: candidate.path, id: record.metadata.id, name: record.metadata.name, ext: record.metadata.ext }));
  });
  const pathOrder = new Map(accepted.map((candidate, index) => [candidate.path, index]));
  return matches.flat().sort((left, right) => {
    const order = pathOrder.get(left.path) - pathOrder.get(right.path);
    return order || String(left.id).localeCompare(String(right.id));
  });
}

module.exports = { DuplicateIndex, findDuplicateImports, mapWithConcurrency, pairImportedIdsWithFolders, readLibraryRecords, sha256 };
