'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

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
  const expected = path.join(directory, `${metadata.name}${extension}`);
  try {
    await fs.access(expected);
    return expected;
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

class DuplicateIndex {
  constructor({ metadataConcurrency = 128 } = {}) {
    this.metadataConcurrency = metadataConcurrency;
    this.libraryPath = null;
    this.records = null;
    this.loading = null;
    this.revision = 0;
  }

  warm(libraryPath) {
    if (!libraryPath) return Promise.resolve([]);
    const resolvedPath = path.resolve(libraryPath);
    if (this.libraryPath === resolvedPath) {
      if (this.records) return Promise.resolve(this.records);
      if (this.loading) return this.loading;
    }
    this.libraryPath = resolvedPath;
    this.records = null;
    const revision = ++this.revision;
    const loading = readLibraryRecords(resolvedPath, this.metadataConcurrency)
      .catch(() => [])
      .then(records => {
        if (this.libraryPath === resolvedPath && this.revision === revision) this.records = records;
        return records;
      });
    this.loading = loading;
    return loading.finally(() => {
      if (this.loading === loading) this.loading = null;
    });
  }

  invalidate(libraryPath = null) {
    if (libraryPath && this.libraryPath !== path.resolve(libraryPath)) return;
    this.revision += 1;
    this.records = null;
    this.loading = null;
  }

  recordsFor(libraryPath) {
    return this.warm(libraryPath);
  }
}

async function findDuplicateImports({ paths = [], libraryPath, index = null, metadataConcurrency = 128, hashConcurrency = 4 } = {}) {
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
    if (record.metadata.isDeleted) return null;
    const candidates = bySize.get(Number(record.metadata.size));
    return candidates?.length ? { ...record, candidates } : null;
  }).filter(Boolean);
  if (!matchingRecords.length) return [];

  const imagesRoot = path.join(libraryPath, 'images');
  const candidateHashes = new Map(await mapWithConcurrency(accepted, hashConcurrency, async candidate => {
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
