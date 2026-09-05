'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSiteImportService } = require('../lib/site-import');

const profile = 'https://www.artstation.com/fixture_artist';
const imageURL = 'https://cdna.artstation.com/p/assets/images/images/001/002/003/large/fixture.jpg';
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }

test('discovers one explicit author page and preserves full project assets and provenance without importing', async () => {
  const calls = [];
  const service = createSiteImportService({ fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/users/fixture_artist/projects.json?page=1')) {
      return json({ total_count: 2, data: [{ hash_id: 'abc123', title: 'Fixture project' }] });
    }
    if (url.endsWith('/projects/abc123.json')) {
      return json({ id: 42, assets: [
        { id: 2, position: 2, width: 1200, height: 800, image_url: imageURL.replace('fixture.jpg', 'second.png') },
        { id: 1, position: 1, width: 1600, height: 900, image_url: imageURL }
      ] });
    }
    throw new Error(`Unexpected request ${url}`);
  } });
  const result = await service.discover({ url: profile });
  assert.equal(result.author, 'fixture_artist');
  assert.equal(result.site, 'artstation');
  assert.equal(result.sourceUrl, profile);
  assert.deepEqual(result.assets.map(asset => asset.id), ['artstation:abc123:1', 'artstation:abc123:2']);
  assert.equal(result.assets[0].url, imageURL);
  assert.equal(result.assets[0].website, 'https://www.artstation.com/artwork/abc123');
  assert.equal(result.assets[0].name, 'Fixture project');
  assert.equal(result.assets[0].width, 1600);
  assert.equal(result.nextPage, 2);
  assert.equal(result.complete, false);
  assert.deepEqual(result.failures, []);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.options.credentials === 'omit' && call.options.redirect === 'error'));
});

test('rejects non-profile and forged URLs before network activity, and normalizes a bare official profile', async () => {
  const calls = [];
  const service = createSiteImportService({ fetch: async url => { calls.push(url); return json({ total_count: 0, data: [] }); } });
  for (const url of ['http://www.artstation.com/fixture', 'https://artstation.com.evil.test/fixture',
    'https://user:password@www.artstation.com/fixture', 'https://www.artstation.com:444/fixture',
    'https://www.artstation.com/artwork/abc123', 'https://www.artstation.com/users',
    'https://www.artstation.com/', 'file:///tmp/fixture', 'https://127.0.0.1/fixture',
    'https://www.artstation.com/fixture%2f..', 'https://www.artstation.com/one/../fixture']) {
    await assert.rejects(service.discover({ url }), { code: 'SITE_URL_INVALID' });
  }
  assert.deepEqual(calls, []);
  const result = await service.discover({ url: 'www.artstation.com/fixture_artist/?sort_by=date#top' });
  assert.equal(result.sourceUrl, profile);
  assert.equal(result.complete, true);
  assert.equal(result.nextPage, null);
});

test('loads only requested continuation pages, deduplicates repeated projects/assets and stops at an empty page', async () => {
  const calls = [];
  const service = createSiteImportService({ fetch: async url => {
    calls.push(url);
    if (url.includes('page=2')) return json({ total_count: 80, data: [{ hash_id: 'same', title: 'Same' }, { hash_id: 'same', title: 'Same' }] });
    if (url.includes('page=3')) return json({ total_count: 80, data: [] });
    return json({ assets: [{ id: 5, image_url: imageURL }, { id: 5, image_url: imageURL }] });
  } });
  const result = await service.discover({ url: profile, startPage: 2, maxPages: 2 });
  assert.equal(result.assets.length, 1);
  assert.equal(result.complete, true);
  assert.equal(result.nextPage, null);
  assert.equal(calls.filter(url => url.includes('/projects/same.json')).length, 1);
  assert.equal(calls.length, 3);
  for (const options of [{ startPage: 0 }, { startPage: 1.5 }, { maxPages: 0 }, { maxPages: 100000 }, { startPage: Infinity }]) {
    await assert.rejects(service.discover({ url: profile, ...options }), { code: 'SITE_PAGE_INVALID' });
  }
  assert.equal(calls.length, 3);
});

test('excludes forged project paths, foreign/local image URLs and embedded video covers', async () => {
  const calls = [];
  const badUrls = ['https://evil.test/a.jpg', 'http://cdna.artstation.com/a.jpg',
    'https://cdna.artstation.com.evil.test/a.jpg', 'https://127.0.0.1/a.jpg',
    'https://cdna.artstation.com:444/a.jpg', 'https://user:pass@cdna.artstation.com/a.jpg',
    'https://cdna.artstation.com/a.svg', 'https://cdna.artstation.com/a.mp4'];
  const service = createSiteImportService({ fetch: async url => {
    calls.push(url);
    if (url.includes('/users/')) return json({ total_count: 2, data: [{ hash_id: '../users/secret' }, { hash_id: 'good', title: 'Images' }] });
    return json({ assets: [
      ...badUrls.map((image_url, id) => ({ id, image_url })),
      { id: 99, image_url: imageURL, player_embedded: '<iframe src="http://localhost/"></iframe>' },
      { id: 100, image_url: imageURL, width: 100, height: 100 }
    ] });
  } });
  const result = await service.discover({ url: profile });
  assert.deepEqual(result.assets.map(asset => asset.id), ['artstation:good:100']);
  assert.equal(result.failures.length, 10);
  assert.ok(result.failures.some(failure => failure.code === 'SITE_PROJECT_INVALID'));
  assert.ok(result.failures.some(failure => failure.code === 'SITE_ASSET_UNSUPPORTED'));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.startsWith('https://www.artstation.com/')));
});

test('reports request/shape failures without losing other discovered projects or calling an error page success', async () => {
  const service = createSiteImportService({ fetch: async url => {
    if (url.includes('/users/')) return json({ total_count: 3, data: [{ hash_id: 'denied' }, { hash_id: 'broken' }, { hash_id: 'good', title: 'Good' }] });
    if (url.includes('/denied.')) return json({ error: 'denied' }, 403);
    if (url.includes('/broken.')) return new Response('<html>not json</html>', { headers: { 'content-type': 'text/html' } });
    return json({ assets: [{ id: 1, image_url: imageURL }] });
  } });
  const result = await service.discover({ url: profile });
  assert.equal(result.assets.length, 1);
  assert.deepEqual(result.failures.map(failure => failure.code), ['SITE_HTTP_ERROR', 'SITE_RESPONSE_INVALID']);
  assert.equal(result.partial, true);
  const listFailure = createSiteImportService({ fetch: async () => json({ error: 'limited' }, 429) });
  await assert.rejects(listFailure.discover({ url: profile }), { code: 'SITE_HTTP_ERROR' });
  const malformed = createSiteImportService({ fetch: async () => json({ data: 'not an array' }) });
  await assert.rejects(malformed.discover({ url: profile }), { code: 'SITE_RESPONSE_INVALID' });
});

test('supports cancellation before and during requests and bounds a stalled discovery even if transport ignores abort', async () => {
  let calls = 0;
  const stopped = new AbortController();
  stopped.abort();
  const service = createSiteImportService({ fetch: async () => { calls++; return new Promise(() => {}); }, limits: { timeoutMs: 20 } });
  await assert.rejects(service.discover({ url: profile, signal: stopped.signal }), { code: 'ABORT_ERR' });
  assert.equal(calls, 0);
  const pendingController = new AbortController();
  const pending = service.discover({ url: profile, signal: pendingController.signal });
  pendingController.abort();
  await assert.rejects(pending, { code: 'ABORT_ERR' });
  await assert.rejects(service.discover({ url: profile }), { code: 'SITE_TIMEOUT' });
});

test('bounds response bytes including streamed bodies and total discovery bytes', async () => {
  for (const mode of ['header', 'stream', 'total']) {
    const service = createSiteImportService({ limits: { maxResponseBytes: mode === 'total' ? 1000 : 80, maxTotalBytes: 140 }, fetch: async url => {
      if (mode === 'header') return new Response('small', { headers: { 'content-length': '9999' } });
      if (mode === 'stream') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(81))); controller.close(); } }));
      if (url.includes('/users/')) return json({ total_count: 1, data: [{ hash_id: 'good' }] });
      return json({ assets: [{ id: 1, image_url: imageURL }] });
    } });
    if (mode === 'total') {
      const result = await service.discover({ url: profile });
      assert.equal(result.assets.length, 0);
      assert.equal(result.failures[0].code, 'SITE_RESPONSE_LIMIT');
      assert.equal(result.truncated, true);
    } else {
      await assert.rejects(service.discover({ url: profile }), { code: 'SITE_RESPONSE_LIMIT' });
    }
  }
});

test('reports project and asset caps explicitly, skips malformed assets and gives stable fallback identities', async () => {
  const fetch = async url => url.includes('/users/')
    ? json({ total_count: 2, data: [{ hash_id: 'one', title: { unexpected: true } }, { hash_id: 'two' }] })
    : json({ assets: [null, { image_url: imageURL }, { image_url: imageURL.replace('fixture.jpg', 'second.jpg') }] });
  const limitedProjects = await createSiteImportService({ fetch, limits: { maxProjects: 1 } }).discover({ url: profile });
  assert.equal(limitedProjects.truncated, true);
  assert.equal(limitedProjects.complete, false);
  assert.equal(limitedProjects.nextPage, null);
  assert.ok(limitedProjects.failures.some(failure => failure.code === 'SITE_PROJECT_LIMIT'));
  const service = createSiteImportService({ fetch, limits: { maxAssets: 1 } });
  const first = await service.discover({ url: profile });
  const second = await service.discover({ url: profile });
  assert.equal(first.assets.length, 1);
  assert.equal(first.assets[0].id, second.assets[0].id);
  assert.notEqual(first.assets[0].assetId, 'undefined');
  assert.equal(typeof first.assets[0].name, 'string');
  assert.equal(first.truncated, true);
  assert.ok(first.failures.some(failure => failure.code === 'SITE_ASSET_LIMIT'));
});

test('preserves the preceding page when a later list request fails, with a retryable continuation', async () => {
  const service = createSiteImportService({ fetch: async url => {
    if (url.includes('page=1')) return json({ total_count: 100, data: [{ hash_id: 'good', title: 'Good' }] });
    if (url.includes('page=2')) throw new Error('fixture network failed');
    return json({ assets: [{ id: 1, image_url: imageURL }] });
  } });
  const result = await service.discover({ url: profile, maxPages: 2 });
  assert.equal(result.assets.length, 1);
  assert.equal(result.partial, true);
  assert.equal(result.complete, false);
  assert.equal(result.nextPage, 2);
  assert.equal(result.failures[0].code, 'SITE_REQUEST_FAILED');
});
