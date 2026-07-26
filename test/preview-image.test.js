'use strict';

// Batch 3: PSD/TIFF/HEIC previews use the largest displayable image Eagle
// generated in the item's .info folder (eaglemv://preview/<id>).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { findPreviewImagePath } = require('../lib/preview-image');

const rendererSource = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const mainSource = require('node:fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

async function makeInfoDir(t, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-info-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), Buffer.alloc(bytes, 1));
  }
  return dir;
}

test('prefers the large generated preview over the small thumbnail', async t => {
  const dir = await makeInfoDir(t, {
    'artwork.psd': 5_000_000,
    'artwork_thumbnail.png': 40_000,
    'artwork.png': 900_000,
    'metadata.json': 300
  });
  assert.equal(await findPreviewImagePath(dir, 'artwork.psd'), path.join(dir, 'artwork.png'));
});

test('falls back to the thumbnail when no larger preview exists', async t => {
  const dir = await makeInfoDir(t, {
    'photo.heic': 3_000_000,
    'photo_thumbnail.png': 42_000,
    'metadata.json': 300
  });
  assert.equal(await findPreviewImagePath(dir, 'photo.heic'), path.join(dir, 'photo_thumbnail.png'));
});

test('never returns the original file and survives missing folders', async t => {
  const dir = await makeInfoDir(t, { 'scan.tiff': 1_000_000, 'metadata.json': 300 });
  assert.equal(await findPreviewImagePath(dir, 'scan.tiff'), null);
  assert.equal(await findPreviewImagePath(path.join(dir, 'missing'), 'x.psd'), null);
});

test('picks the largest candidate among several previews', async t => {
  const dir = await makeInfoDir(t, {
    'design.psd': 9_000_000,
    'design_thumbnail.png': 30_000,
    'design (1).jpg': 200_000,
    'design_large.png': 1_500_000
  });
  assert.equal(await findPreviewImagePath(dir, 'design.psd'), path.join(dir, 'design_large.png'));
});

test('renderer routes PSD/TIFF/HEIC previews through eaglemv://preview', () => {
  assert.ok(rendererSource.includes("['psd', 'tif', 'tiff', 'heic', 'heif'].includes(ext)"));
  assert.ok(rendererSource.includes('eaglemv://preview/${encodeURIComponent(item.id)}'));
});

test('main resolves preview media with a thumbnail fallback', () => {
  const start = mainSource.indexOf("if (kind === 'preview')");
  assert.ok(start >= 0);
  const branch = mainSource.slice(start, start + 700);
  assert.ok(branch.includes('findPreviewImagePath(path.dirname(filePath), path.basename(filePath))'));
  assert.ok(branch.includes("resolveMediaURL('thumb', id)"));
});
