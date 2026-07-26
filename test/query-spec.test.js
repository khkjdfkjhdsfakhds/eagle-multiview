'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  spec,
  createQuery,
  filtersActive,
  filterCount,
  matchesConstraints,
  clientConstrained,
  needsClientScan,
  itemQueryBody
} = require('../src/query-spec');

test('createQuery keeps the historical shape and defaults', () => {
  assert.deepEqual(createQuery(), {
    folderId: null,
    smartFolderId: null,
    search: '',
    searchScope: '',
    tags: [],
    ext: '',
    rating: null,
    annotation: '',
    url: '',
    shape: '',
    color: '',
    size: null,
    added: null,
    pixels: null
  });
  const normalized = createQuery({ tags: ['a', 'a', '', 'b'], rating: '3', search: 42, folderId: '' });
  assert.deepEqual(normalized.tags, ['a', 'b']);
  assert.equal(normalized.rating, null);
  assert.equal(normalized.search, '42');
  assert.equal(normalized.folderId, null);
  // View context flags are merged at refresh time, never stored in the query.
  assert.equal('unfiled' in createQuery({ unfiled: true }), false);
});

test('filtersActive/filterCount track user-visible filters only', () => {
  assert.equal(filtersActive({}), false);
  assert.equal(filtersActive({ folderId: 'F' }), false);
  assert.equal(filtersActive({ search: '  ' }), false);
  assert.equal(filtersActive({ search: 'x' }), true);
  assert.equal(filterCount({ search: 'x', tags: ['t'], ext: 'png', rating: 0, annotation: 'a', url: 'u', shape: 'square', color: '#e5484d' }), 8);
  assert.equal(filterCount({ rating: null }), 0);
});

test('matchesConstraints derives every client-side predicate from the table', () => {
  const item = {
    id: 'IT1',
    folders: ['F1'],
    tags: ['red', 'dot'],
    ext: 'PNG',
    star: 3,
    annotation: '获奖 作品',
    url: 'https://Example.com/page',
    width: 2400,
    height: 900,
    palettes: [{ color: [229, 72, 77], ratio: 60 }]
  };
  assert.equal(matchesConstraints(item, {}), true);
  assert.equal(matchesConstraints({ ...item, isDeleted: true }, {}), false);
  assert.equal(matchesConstraints(item, { folderId: 'F1' }), true);
  assert.equal(matchesConstraints(item, { folderId: 'F2' }), false);
  assert.equal(matchesConstraints(item, { unfiled: true }), false);
  assert.equal(matchesConstraints({ ...item, folders: [] }, { unfiled: true }), true);
  assert.equal(matchesConstraints(item, { isUntagged: true }), false);
  assert.equal(matchesConstraints(item, { tags: ['red'] }), true);
  assert.equal(matchesConstraints(item, { tags: ['red', 'missing'] }), false);
  assert.equal(matchesConstraints(item, { ext: 'png' }), true);
  assert.equal(matchesConstraints(item, { rating: 3 }), true);
  assert.equal(matchesConstraints(item, { rating: 0 }), false);
  assert.equal(matchesConstraints({ ...item, star: undefined }, { rating: 0 }), true);
  assert.equal(matchesConstraints(item, { annotation: '获奖' }), true);
  assert.equal(matchesConstraints(item, { url: 'example.COM' }), true);
  assert.equal(matchesConstraints(item, { shape: 'panoramic-landscape' }), true);
  assert.equal(matchesConstraints(item, { shape: 'portrait' }), false);
  assert.equal(matchesConstraints(item, { color: '#e5484d' }), true);
  assert.equal(matchesConstraints(item, { color: '#0090ff' }), false);
  const smartQuery = { smartFolderId: 'SF' };
  assert.equal(matchesConstraints(item, smartQuery, { smartFolderIds: new Set(['IT1']) }), true);
  assert.equal(matchesConstraints(item, smartQuery, { smartFolderIds: new Set() }), false);
  assert.equal(matchesConstraints(item, smartQuery, {}), false);
});

test('clientConstrained mirrors the old queryTextItems check; search alone is server-side', () => {
  assert.equal(clientConstrained({ search: 'words' }), false);
  for (const query of [
    { folderId: 'F' }, { smartFolderId: 'S' }, { unfiled: true }, { isUntagged: true },
    { tags: ['t'] }, { ext: 'png' }, { rating: 2 }, { annotation: 'a' }, { url: 'u' },
    { shape: 'square' }, { color: '#fff' }
  ]) {
    assert.equal(clientConstrained(query), true, JSON.stringify(query));
  }
});

test('needsClientScan routes only Eagle-API-blind fields to the scan pipeline', () => {
  assert.equal(needsClientScan({ color: '#e5484d' }), true);
  assert.equal(needsClientScan({ ext: 'png', rating: 5, shape: 'square' }), false);
});

test('itemQueryBody produces the historical API body', () => {
  assert.deepEqual(itemQueryBody({
    folderId: 'F',
    smartFolderId: 'S',
    unfiled: true,
    isUntagged: true,
    search: '  red  dot ',
    tags: ['t1'],
    ext: 'png',
    rating: 4,
    annotation: ' note ',
    url: ' http ',
    shape: 'square',
    color: '#e5484d'
  }), {
    folders: ['F'],
    smartFolders: ['S'],
    isUnfiled: true,
    isUntagged: true,
    keywords: ['red', 'dot'],
    tags: ['t1'],
    ext: 'png',
    rating: 4,
    annotation: 'note',
    url: 'http',
    shape: 'square'
  });
  assert.deepEqual(itemQueryBody({}), {});
  // rating 0 is a real filter and must reach the body.
  assert.deepEqual(itemQueryBody({ rating: 0 }), { rating: 0 });
});

test('every spec row is fully declared', () => {
  for (const entry of spec) {
    assert.equal(typeof entry.key, 'string');
    assert.equal(typeof entry.normalize, 'function');
    assert.equal(typeof entry.isActive, 'function');
    assert.ok(entry.match || entry.applyBody, `${entry.key} 既无 match 也无 applyBody`);
    if (entry.clientOnly) assert.equal(entry.applyBody, undefined, `${entry.key} 是 clientOnly 却声明了 applyBody`);
  }
});

test('range filters store one {min, max} key so the badge counts them once', () => {
  const query = createQuery({ size: { min: 5 * 1024 * 1024 } });
  assert.deepEqual(query.size, { min: 5 * 1024 * 1024, max: null });
  assert.equal(filterCount(query), 1, 'a half-open range is one filter, not two');
  assert.equal(filterCount(createQuery({ size: { min: 1, max: 2 } })), 1);
  // Empty ends collapse the whole range away, so clearing both inputs clears
  // the filter rather than leaving {min: null, max: null} behind.
  assert.equal(createQuery({ size: { min: null, max: null } }).size, null);
  assert.equal(createQuery({ size: { min: 'x', max: '' } }).size, null);
  assert.equal(filtersActive(createQuery({ size: null })), false);
});

test('size / pixels / added match the right field on each item', () => {
  const item = { id: 'a', size: 10 * 1024 * 1024, width: 4000, height: 2000, btime: 2000 };
  const matches = query => matchesConstraints(item, createQuery(query));
  assert.equal(matches({ size: { min: 5 * 1024 * 1024 } }), true);
  assert.equal(matches({ size: { min: 20 * 1024 * 1024 } }), false);
  assert.equal(matches({ size: { max: 5 * 1024 * 1024 } }), false);
  assert.equal(matches({ size: { min: 1, max: 20 * 1024 * 1024 } }), true);
  // 4000x2000 = 8 megapixels
  assert.equal(matches({ pixels: { min: 7e6 } }), true);
  assert.equal(matches({ pixels: { min: 9e6 } }), false);
  assert.equal(matches({ pixels: { max: 9e6 } }), true);
  assert.equal(matches({ added: { min: 1000, max: 3000 } }), true);
  assert.equal(matches({ added: { min: 3000 } }), false);
  assert.equal(matches({ added: { max: 1000 } }), false);
  // Items missing the field count as zero rather than dropping out silently.
  assert.equal(matchesConstraints({ id: 'b' }, createQuery({ size: { max: 10 } })), true);
  assert.equal(matchesConstraints({ id: 'b' }, createQuery({ size: { min: 10 } })), false);
});

test('ranges are client-only: the Eagle API ignores every range parameter', () => {
  for (const key of ['size', 'pixels', 'added']) {
    const query = createQuery({ [key]: { min: 1 } });
    assert.equal(needsClientScan(query), true, `${key} must route through the scan pipeline`);
    assert.equal(clientConstrained(query), true);
    // Nothing range-shaped may leak into the server body.
    assert.deepEqual(itemQueryBody(query), {});
  }
});

test('the filter panel and the spec table stay in step', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  const indexHTML = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  // Two inputs per range key, each declaring which end it drives.
  for (const [key, min, max] of [['size', '#sizeMinFilter', '#sizeMaxFilter'],
                                 ['pixels', '#pixelsMinFilter', '#pixelsMaxFilter'],
                                 ['added', '#addedFromFilter', '#addedToFilter']]) {
    assert.ok(renderer.includes(`{ key: '${key}', part: 'min', selector: '${min}'`), `${key} min binding`);
    assert.ok(renderer.includes(`{ key: '${key}', part: 'max', selector: '${max}'`), `${key} max binding`);
    assert.ok(indexHTML.includes(`id="${min.slice(1)}"`), `${min} input`);
    assert.ok(indexHTML.includes(`id="${max.slice(1)}"`), `${max} input`);
  }
  // A part-binding merges into the existing range instead of replacing it.
  assert.ok(renderer.includes('? normalizeQueryRange({ ...pane.query[binding.key], [binding.part]: parsed })'));
  // Dates are parsed in local time and the end of the range covers its day.
  assert.ok(renderer.includes("const date = new Date(`${value}T00:00:00`);"));
  assert.ok(renderer.includes('return end ? date.getTime() + 86399999 : date.getTime();'));
});

test('search scope narrows the search to one field and is inert without text', () => {
  const item = {
    id: 'a', name: '海边黄昏', ext: 'png', tags: ['风景', '参考'],
    annotation: '这张的构图很好', url: 'https://example.com/sunset'
  };
  const matches = query => matchesConstraints(item, createQuery(query));

  // No text: the scope constrains nothing and must not drag the query into
  // the client scan pipeline.
  assert.equal(matches({ searchScope: 'name' }), true);
  assert.equal(needsClientScan(createQuery({ searchScope: 'name' })), false);
  assert.equal(clientConstrained(createQuery({ searchScope: 'name' })), false);

  // With text, each scope looks only at its own field.
  assert.equal(matches({ search: '黄昏', searchScope: 'name' }), true);
  assert.equal(matches({ search: '黄昏', searchScope: 'tags' }), false);
  assert.equal(matches({ search: '风景', searchScope: 'tags' }), true);
  assert.equal(matches({ search: '构图', searchScope: 'annotation' }), true);
  assert.equal(matches({ search: '构图', searchScope: 'url' }), false);
  assert.equal(matches({ search: 'sunset', searchScope: 'url' }), true);
  // The extension is part of the name scope, as it is in the card label.
  assert.equal(matches({ search: 'png', searchScope: 'name' }), true);
  // Every term has to land, and matching is case-insensitive.
  assert.equal(matches({ search: 'SUNSET example', searchScope: 'url' }), true);
  assert.equal(matches({ search: 'sunset 黄昏', searchScope: 'url' }), false);
  // An unknown scope degrades to no scoping rather than matching nothing.
  assert.equal(createQuery({ searchScope: 'nope' }).searchScope, '');
  assert.equal(createQuery({}).searchScope, '');
  assert.equal(matches({ search: '黄昏', searchScope: 'nope' }), true);

  // A live scope routes through the scan pipeline and never reaches the body.
  const scoped = createQuery({ search: '黄昏', searchScope: 'name' });
  assert.equal(needsClientScan(scoped), true);
  assert.equal(itemQueryBody(scoped).searchScope, undefined);
  // The scope is not a filter badge entry; Eagle shows it with the search box.
  assert.equal(filterCount(scoped), 1, 'only the search text counts');
});
