'use strict';

// GUI-regression fix (2026-07-26): the eaglemv:// protocol must serve real
// Content-Type/CORS headers, and PDF previews must use a direct file:// URL —
// Chromium's PDF viewer refuses custom-protocol streams, which left the
// batch-1 "plugins: true" fix rendering a blank page. Verified live via CDP.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mimeForPath, mimeByExtension } = require('../lib/media-mime');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');

test('mimeForPath maps preview-relevant extensions and tolerates junk', () => {
  assert.equal(mimeForPath('/x/y/report.PDF'), 'application/pdf');
  assert.equal(mimeForPath('file:///a/b/photo.jpg'), 'image/jpeg');
  assert.equal(mimeForPath('clip.mp4'), 'video/mp4');
  assert.equal(mimeForPath('note.txt'), 'text/plain; charset=utf-8');
  assert.equal(mimeForPath('archive.xyz'), '');
  assert.equal(mimeForPath(''), '');
  assert.equal(mimeForPath(null), '');
  assert.equal(mimeByExtension.pdf, 'application/pdf');
});

test('the media protocol rewrites headers with MIME, CORS and ranges', () => {
  const start = main.indexOf("protocol.handle('eaglemv'");
  assert.ok(start >= 0);
  const handler = main.slice(start, start + 1600);
  assert.ok(handler.includes('mimeForPath(fileURL.pathname || fileURL)'));
  assert.ok(handler.includes("headers.set('Content-Type', mime)"));
  assert.ok(handler.includes("headers.set('Access-Control-Allow-Origin', '*')"));
  assert.ok(handler.includes("headers.set('Accept-Ranges', 'bytes')"));
  // Range forwarding from batch 1 must survive, and the wrapped Response
  // must preserve the upstream status for 206 partial content.
  assert.ok(handler.includes("request.headers.get('Range')"));
  assert.ok(handler.includes('status: response.status'));
});

test('PDF previews resolve a main-minted file URL instead of the custom protocol', () => {
  assert.ok(renderer.includes('data-pdf-item="${escapeHTML(item.id)}"'));
  assert.ok(!renderer.includes('<embed src="${url}" type="application/pdf"'), 'embed must not point at eaglemv://');
  const start = renderer.indexOf('function setupPreviewMedia()');
  const fn = renderer.slice(start, renderer.indexOf('\n}', start));
  assert.ok(fn.includes("embed[data-pdf-item]"));
  assert.ok(fn.includes('window.eagleMV.fileURL(pdfEmbed.dataset.pdfItem)'));
  assert.ok(fn.includes('owner.previewToken === ownerToken'), 'stale preview loads must check the originating pane token');
  assert.ok(fn.includes('!validOwner() || !pdfEmbed.isConnected'), 'retired or replaced owner previews must not attach');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const handler = main.slice(main.indexOf("handleRPC('item:file-url'"), main.indexOf('\n  });', main.indexOf("handleRPC('item:file-url'")));
  assert.ok(handler.includes('pathToFileURL(filePath).toString()'), 'URL minting stays in the main process');
});
