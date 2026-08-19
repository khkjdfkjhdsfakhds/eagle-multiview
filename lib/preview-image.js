'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const displayableExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);

// Pick the best browser-displayable stand-in for a non-displayable original
// (PSD/TIFF/HEIC…): the largest image Eagle generated inside the item's
// .info folder, preferring any full preview over the small _thumbnail.
async function findPreviewImagePath(infoDir, originalFileName) {
  let entries;
  try {
    entries = await fs.readdir(infoDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === originalFileName) continue;
    const ext = entry.name.split('.').pop().toLowerCase();
    if (!displayableExtensions.has(ext)) continue;
    const full = path.join(infoDir, entry.name);
    try {
      const stat = await fs.stat(full);
      candidates.push({ path: full, size: stat.size, isThumbnail: /_thumbnail\.[^.]+$/i.test(entry.name) ? 1 : 0 });
    } catch {}
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.isThumbnail - b.isThumbnail) || (b.size - a.size));
  return candidates[0].path;
}

module.exports = { findPreviewImagePath, displayableExtensions };
