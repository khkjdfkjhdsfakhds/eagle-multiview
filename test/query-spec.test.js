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
    tags: [],
    ext: '',
    rating: null,
    annotation: '',
    url: '',
    shape: '',
    color: ''
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
