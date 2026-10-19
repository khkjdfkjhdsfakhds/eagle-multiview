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
    tagsExclude: [],
    tagLogic: 'OR',
    noTags: false,
    folderInclude: [],
    folderExclude: [],
    folderLogic: 'OR',
    ext: [],
    extExclude: [],
    rating: [],
    annotation: '',
    annotationState: '',
    url: '',
    urlState: '',
    shape: [],
    shapeWidth: null,
    shapeHeight: null,
    color: '',
    size: null,
    added: null,
    addedPresets: [],
    addedMonths: [],
    modified: null,
    modifiedPresets: [],
    modifiedMonths: [],
    duration: null,
    durationUnit: 's',
    comments: '',
    commentsText: '',
    pixels: null,
    width: null,
    height: null
  });
  // A remembered single-format filter from before the format list.
  assert.deepEqual(createQuery({ ext: '.PNG' }).ext, ['png']);
  const normalized = createQuery({ tags: ['a', 'a', '', 'b'], rating: '3', search: 42, folderId: '' });
  assert.deepEqual(normalized.tags, ['a', 'b']);
  assert.deepEqual(normalized.rating, [3], 'a stored rating reads as one ticked rating');
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

test('shape follows Eagle\'s filter menu: 横图/竖图 include 细长, 细长 from 2.5:1, ratios exact', () => {
  const shapeOf = (width, height) => ['square', 'landscape', 'portrait', 'panoramic-landscape', 'panoramic-portrait', '4:3', '3:4', '16:9', '9:16']
    .filter(shape => matchesConstraints({ id: 's', width, height }, { shape: [shape] }));
  assert.deepEqual(shapeOf(2200, 1000), ['landscape']);
  assert.deepEqual(shapeOf(2500, 1000), ['landscape', 'panoramic-landscape']);
  assert.deepEqual(shapeOf(1000, 2200), ['portrait']);
  assert.deepEqual(shapeOf(1000, 2500), ['portrait', 'panoramic-portrait']);
  assert.deepEqual(shapeOf(1001, 1000), ['landscape']);
  assert.deepEqual(shapeOf(1000, 1000), ['square']);
  assert.deepEqual(shapeOf(1600, 900), ['landscape', '16:9']);
  assert.deepEqual(shapeOf(300, 400), ['portrait', '3:4']);
  // Several shapes are any-of; 自定 matches its exact ratio.
  assert.equal(matchesConstraints({ id: 's', width: 100, height: 100 }, { shape: ['portrait', 'square'] }), true);
  assert.equal(matchesConstraints({ id: 's', width: 200, height: 100 }, { shape: ['custom'], shapeWidth: 2, shapeHeight: 1 }), true);
  assert.equal(matchesConstraints({ id: 's', width: 300, height: 100 }, { shape: ['custom'], shapeWidth: 2, shapeHeight: 1 }), false);
});

test('ratings tick any number, 注释/链接 take 有/没有 with keywords, 尺寸 takes width and height', () => {
  const item = { id: 'r', star: 4, annotation: 'Blue Sky, sea', url: '', width: 1200, height: 800 };
  assert.equal(matchesConstraints(item, { rating: [5, 4] }), true);
  assert.equal(matchesConstraints(item, { rating: [0] }), false);
  assert.equal(matchesConstraints({ id: 'u' }, { rating: [0, 5] }), true);
  assert.equal(matchesConstraints(item, { annotationState: 'has' }), true);
  assert.equal(matchesConstraints(item, { annotationState: 'has', annotation: 'blue, SEA' }), true);
  assert.equal(matchesConstraints(item, { annotationState: 'has', annotation: 'blue, land' }), false);
  assert.equal(matchesConstraints(item, { annotationState: 'none' }), false);
  assert.equal(matchesConstraints(item, { urlState: 'none' }), true);
  assert.equal(matchesConstraints(item, { urlState: 'has' }), false);
  assert.equal(matchesConstraints(item, { width: { min: 1000 }, height: { max: 800 } }), true);
  assert.equal(matchesConstraints(item, { width: { max: 1000 } }), false);
  // The API answers one rating and 有 with one keyword; the rest scan.
  assert.equal(needsClientScan({ rating: [4] }), false);
  assert.equal(needsClientScan({ rating: [4, 5] }), true);
  assert.equal(needsClientScan({ annotation: 'sky' }), false);
  assert.equal(needsClientScan({ annotation: 'sky,sea', annotationState: 'has' }), true);
  assert.equal(needsClientScan({ urlState: 'none' }), true);
  assert.equal(needsClientScan({ width: { min: 10 } }), true);
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
  assert.equal(matchesConstraints(item, { tags: ['red', 'missing'] }), true, 'Eagle starts on 任意 (OR)');
  assert.equal(matchesConstraints(item, { tags: ['red', 'missing'], tagLogic: 'AND' }), false);
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

test('folder search leaves descendant ids to the local match, not the API body', () => {
  // The API keeps only items in every listed folder; sending the subtree
  // would return the items filed in all of them, usually none.
  assert.deepEqual(itemQueryBody({ folderId: 'parent', folderIds: ['parent', 'child', 'deep'], search: 'needle' }), {
    keywords: ['needle']
  });
});

test('every spec row is fully declared', () => {
  for (const entry of spec) {
    assert.equal(typeof entry.key, 'string');
    assert.equal(typeof entry.normalize, 'function');
    // A companion row only stores a setting another row reads.
    if (!entry.isActive && !entry.match && !entry.applyBody && !entry.filter && !entry.clientOnly) continue;
    assert.equal(typeof entry.isActive, 'function');
    assert.ok(entry.match || entry.applyBody, `${entry.key} 既无 match 也无 applyBody`);
    // A per-value clientOnly (tags, formats) still sends what the API can
    // evaluate; an unconditional one never reaches the body.
    if (entry.clientOnly === true) assert.equal(entry.applyBody, undefined, `${entry.key} 是 clientOnly 却声明了 applyBody`);
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
  // 添加日期 is Eagle's modificationTime; btime is the file's creation date.
  const item = { id: 'a', size: 10 * 1024 * 1024, width: 4000, height: 2000, modificationTime: 2000, btime: 9000 };
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
                                 ['width', '#widthMinFilter', '#widthMaxFilter'],
                                 ['height', '#heightMinFilter', '#heightMaxFilter'],
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
  // The end is the next local midnight minus 1 ms, so a DST day of 23 or 25
  // hours is still covered exactly (B1-05).
  assert.ok(renderer.includes('return end ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() - 1 : date.getTime();'));
  assert.ok(!renderer.includes('86399999'));
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

test('a folder widened to its subtree is matched locally: the API ANDs several folders (P1-06)', () => {
  const widened = { folderId: 'A', folderIds: ['A', 'B'] };
  assert.equal(needsClientScan(widened), true);
  assert.equal('folders' in itemQueryBody(widened), false, 'several folders must not reach the API, which requires all of them');
  assert.equal(matchesConstraints({ id: '1', folders: ['B'] }, widened), true);
  assert.equal(matchesConstraints({ id: '2', folders: ['A', 'C'] }, widened), true);
  assert.equal(matchesConstraints({ id: '3', folders: ['C'] }, widened), false);
  const single = { folderId: 'A', folderIds: ['A'] };
  assert.equal(needsClientScan(single), false);
  assert.deepEqual(itemQueryBody(single).folders, ['A']);
  assert.equal('folderIds' in createQuery(widened), false, 'the subtree is derived per view, never stored with filters');
});

test('tag rules follow Eagle: 任意 / 全部 / 完全相同, excluded tags and 未标签', () => {
  const items = {
    ab: { id: 'ab', tags: ['a', 'b'] },
    a: { id: 'a', tags: ['a'] },
    c: { id: 'c', tags: ['c'] },
    none: { id: 'none', tags: [] }
  };
  const pass = query => Object.values(items).filter(item => matchesConstraints(item, createQuery(query))).map(item => item.id);
  assert.deepEqual(pass({ tags: ['a', 'c'] }), ['ab', 'a', 'c']);
  assert.deepEqual(pass({ tags: ['a', 'b'], tagLogic: 'AND' }), ['ab']);
  assert.deepEqual(pass({ tags: ['a'], tagLogic: 'EQUAL' }), ['a']);
  // OR with an excluded tag keeps anything that lacks it (Eagle's union).
  assert.deepEqual(pass({ tagsExclude: ['a'] }), ['c', 'none']);
  assert.deepEqual(pass({ tags: ['c'], tagsExclude: ['a'], tagLogic: 'AND' }), ['c']);
  assert.deepEqual(pass({ noTags: true }), ['none']);
  assert.deepEqual(pass({ tags: ['c'], noTags: true }), ['c', 'none']);
  assert.deepEqual(pass({ tags: ['c'], noTags: true, tagLogic: 'AND' }), []);
  // One badge entry for the whole tag rule.
  assert.equal(filterCount(createQuery({ tags: ['a', 'b'], tagsExclude: ['c'], noTags: true })), 1);
  // The API's tags parameter only serves rules it cannot widen past.
  assert.deepEqual(itemQueryBody(createQuery({ tags: ['a'] })).tags, ['a']);
  assert.equal(needsClientScan(createQuery({ tags: ['a'] })), false);
  assert.equal(needsClientScan(createQuery({ tags: ['a', 'b'] })), true);
  assert.equal(itemQueryBody(createQuery({ tags: ['a', 'b'] })).tags, undefined);
  assert.deepEqual(itemQueryBody(createQuery({ tags: ['a', 'b'], tagLogic: 'AND' })).tags, ['a', 'b']);
  assert.equal(needsClientScan(createQuery({ tags: ['a', 'b'], tagLogic: 'AND' })), false);
  assert.deepEqual(itemQueryBody(createQuery({ tags: ['a'], tagLogic: 'EQUAL' })).tags, ['a'], 'EQUAL is narrowed by the AND body');
  assert.equal(needsClientScan(createQuery({ tags: ['a'], tagLogic: 'EQUAL' })), true);
  assert.equal(itemQueryBody(createQuery({ tags: ['a'], noTags: true })).tags, undefined);
});

test('folder filter: direct membership, include / exclude, 未分类', () => {
  const items = [
    { id: 'x', folders: ['F1'] },
    { id: 'xy', folders: ['F1', 'F2'] },
    { id: 'y', folders: ['F2'] },
    { id: 'none', folders: [] }
  ];
  const pass = query => items.filter(item => matchesConstraints(item, createQuery(query))).map(item => item.id);
  assert.deepEqual(pass({ folderInclude: ['F1', 'F2'] }), ['x', 'xy', 'y']);
  assert.deepEqual(pass({ folderInclude: ['F1', 'F2'], folderLogic: 'AND' }), ['xy']);
  assert.deepEqual(pass({ folderInclude: ['F1'], folderLogic: 'EQUAL' }), ['x']);
  assert.deepEqual(pass({ folderExclude: ['F1'] }), ['y', 'none']);
  assert.deepEqual(pass({ folderInclude: ['NoFolders'] }), ['none']);
  assert.equal(needsClientScan(createQuery({ folderInclude: ['F1'] })), true);
  assert.deepEqual(itemQueryBody(createQuery({ folderInclude: ['F1'] })), {});
  assert.equal(filterCount(createQuery({ folderInclude: ['F1'], folderExclude: ['F2'] })), 1);
});

test('format list: several formats and excluded ones', () => {
  const items = ['png', 'JPG', 'mp4'].map(ext => ({ id: ext, ext }));
  const pass = query => items.filter(item => matchesConstraints(item, createQuery(query))).map(item => item.id);
  assert.deepEqual(pass({ ext: ['png', 'jpg'] }), ['png', 'JPG']);
  assert.deepEqual(pass({ extExclude: ['mp4'] }), ['png', 'JPG']);
  assert.equal(needsClientScan(createQuery({ ext: ['png'] })), false);
  assert.deepEqual(itemQueryBody(createQuery({ ext: ['png'] })), { ext: 'png' });
  assert.equal(needsClientScan(createQuery({ ext: ['png', 'jpg'] })), true);
  assert.deepEqual(itemQueryBody(createQuery({ ext: ['png', 'jpg'] })), {});
  assert.equal(needsClientScan(createQuery({ ext: ['png'], extExclude: ['jpg'] })), true);
});

test('dates: quick ranges widen each other and the custom range; months narrow', () => {
  const { matchDateRules } = require('../src/query-spec');
  const now = new Date(2026, 9, 17, 15, 0, 0).getTime();
  const day = 86400000;
  const at = (offsetDays, field = 'modificationTime') => ({ [field]: now - offsetDays * day });
  const added = (item, query) => matchDateRules('added', item, createQuery(query), now);
  assert.equal(added(at(0), { addedPresets: ['today'] }), true);
  assert.equal(added(at(1), { addedPresets: ['today'] }), false);
  assert.equal(added(at(1), { addedPresets: ['yesterday'] }), true);
  assert.equal(added(at(6), { addedPresets: ['last7'] }), true);
  assert.equal(added(at(8), { addedPresets: ['last7'] }), false);
  assert.equal(added(at(8), { addedPresets: ['last7', 'last30'] }), true);
  // A custom range is one more option alongside the quick ones.
  const old = now - 400 * day;
  assert.equal(added({ modificationTime: old }, { addedPresets: ['last7'], added: { min: old - day, max: old + day } }), true);
  assert.equal(added(at(0), { addedMonths: ['2026/10'] }), true);
  assert.equal(added(at(0), { addedMonths: ['2026/09'] }), false);
  // 修改日期 reads the file's mtime, falling back to the added time.
  const modified = (item, query) => matchDateRules('modified', item, createQuery(query), now);
  assert.equal(modified({ modificationTime: now, mtime: now - 40 * day }, { modifiedPresets: ['last30'] }), false);
  assert.equal(modified({ modificationTime: now }, { modifiedPresets: ['today'] }), true);
  assert.equal(filterCount(createQuery({ addedPresets: ['today'], addedMonths: ['2026/10'] })), 1);
  assert.equal(needsClientScan(createQuery({ modifiedPresets: ['today'] })), true);
  assert.deepEqual(itemQueryBody(createQuery({ modifiedPresets: ['today'] })), {});
});

test('duration and 标注 filters', () => {
  const clip = { id: 'clip', duration: 90 };
  const still = { id: 'still' };
  const matches = (item, query) => matchesConstraints(item, createQuery(query));
  assert.equal(matches(clip, { duration: { min: 60 } }), true);
  assert.equal(matches(clip, { duration: { max: 60 } }), false);
  assert.equal(matches(still, { duration: { max: 60 } }), false, 'an image has no duration to compare');
  const noted = { id: 'n', comments: [{ annotation: '左手 需要修' }, { annotation: '背景' }] };
  assert.equal(matches(noted, { comments: 'has' }), true);
  assert.equal(matches(still, { comments: 'has' }), false);
  assert.equal(matches(still, { comments: 'none' }), true);
  assert.equal(matches(noted, { comments: 'has', commentsText: '左手,背景' }), true);
  assert.equal(matches(noted, { comments: 'has', commentsText: '左手, 天空' }), false);
  // The keywords alone filter nothing, as Eagle greys them out.
  assert.equal(filtersActive(createQuery({ commentsText: '左手' })), false);
});
