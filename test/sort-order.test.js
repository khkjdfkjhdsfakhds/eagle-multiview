'use strict';

// Eagle-parity batch 2: sort options (rating/type), direction toggle, and
// full-folder backfill so non-default sorts are exact instead of page-local.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compareBySort, defaultSortDir, effectiveSortDir } = require('../src/pane-state');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

const items = [
  { id: 'a', name: '苹果', ext: 'png', size: 300, star: 2, width: 10, height: 10, modificationTime: 3, btime: 20 },
  { id: 'b', name: 'banana', ext: 'jpg', size: 100, star: 5, width: 30, height: 30, modificationTime: 1, btime: 30 },
  { id: 'c', name: 'Cherry', ext: 'png', size: 200, width: 20, height: 20, modificationTime: 2, btime: 10 }
];
const sortIds = (sort, dir) => [...items].sort((a, b) => compareBySort(sort, dir, a, b)).map(item => item.id);

test('every sort has an Eagle-style default direction', () => {
  assert.equal(defaultSortDir('name'), 'asc');
  assert.equal(defaultSortDir('type'), 'asc');
  assert.equal(defaultSortDir('newest'), 'desc');
  assert.equal(defaultSortDir('size'), 'desc');
  assert.equal(defaultSortDir('resolution'), 'desc');
  assert.equal(defaultSortDir('rating'), 'desc');
  assert.equal(effectiveSortDir('name', 'auto'), 'asc');
  assert.equal(effectiveSortDir('name', 'desc'), 'desc');
  assert.equal(effectiveSortDir('rating', 'auto'), 'desc');
});

test('auto direction matches the previous sort behaviour', () => {
  assert.deepEqual(sortIds('newest', 'auto'), ['a', 'c', 'b']);
  assert.deepEqual(sortIds('size', 'auto'), ['a', 'c', 'b']);
  assert.deepEqual(sortIds('resolution', 'auto'), ['b', 'c', 'a']);
  // zh-CN collation orders 汉字 by pinyin ahead of Latin, same as the old inline sort
  assert.deepEqual(sortIds('name', 'auto'), ['a', 'b', 'c']);
});

test('explicit direction flips any sort', () => {
  assert.deepEqual(sortIds('size', 'asc'), ['b', 'c', 'a']);
  assert.deepEqual(sortIds('name', 'desc'), ['c', 'b', 'a']);
});

test('rating sorts missing stars as zero and keeps Eagle order for ties', () => {
  assert.deepEqual(sortIds('rating', 'auto'), ['b', 'a', 'c']);
  assert.deepEqual(sortIds('rating', 'asc'), ['c', 'a', 'b']);
  const tied = [{ id: 'x', star: 3 }, { id: 'y', star: 3 }];
  assert.equal(compareBySort('rating', 'auto', tied[0], tied[1]), 0);
});

test('type groups by extension and default sort keeps Eagle order', () => {
  assert.deepEqual(sortIds('type', 'auto'), ['b', 'a', 'c']);
  assert.equal(compareBySort('type', 'auto', items[0], items[2]), 0);
  assert.equal(compareBySort('default', 'auto', items[0], items[1]), 0);
});

test('添加日期 sorts by btime, independently of the file modification time', () => {
  // Eagle keeps these as two separate sorts because they disagree in practice:
  // an old file imported today is newest by btime and oldest by mtime.
  assert.deepEqual(sortIds('added', 'auto'), ['b', 'a', 'c'], 'newest import first by default');
  assert.deepEqual(sortIds('added', 'asc'), ['c', 'a', 'b']);
  assert.notDeepEqual(sortIds('added', 'auto'), sortIds('newest', 'auto'));
  assert.equal(defaultSortDir('added'), 'desc');
  assert.equal(compareBySort('added', 'auto', { id: 'x', btime: 5 }, { id: 'y', btime: 5 }), 0);
  // Items predating the field sort as epoch rather than throwing them around.
  assert.equal(compareBySort('added', 'asc', { id: 'x' }, { id: 'y', btime: 1 }), -1);
});

test('pane markup offers rating/type options and a direction toggle', () => {
  assert.ok(renderer.includes('<option value="added">添加日期</option>'));
  assert.ok(renderer.includes('<option value="rating">评分</option>'));
  assert.ok(renderer.includes('<option value="type">文件类型</option>'));
  assert.ok(renderer.includes('id="sortDirButton"'));
  assert.ok(renderer.includes("'#sortDirButton'"), 'direction button must be pane-scoped');
  assert.match(styles, /\.sort-dir-button\s*\{/);
});

test('pane state tracks sortDir and syncs it across layouts', () => {
  assert.ok(renderer.includes("sortDir: 'auto',"));
  assert.ok(renderer.includes("sortDir: source.sortDir || 'auto',"));
  assert.match(renderer, /'sort', 'sortDir', 'randomSeed', 'viewMode', 'viewTitle'/);
  assert.ok(renderer.includes('function renderSortControls()'));
  assert.ok(renderer.includes('function commitSortChange()'), 'persist-and-rerender lives in one helper');
});

test('non-default sorts backfill the whole folder up to the cap', () => {
  assert.ok(renderer.includes('const SORT_FETCH_CAP = 3000;'));
  const start = renderer.indexOf('const sortBackfillActive');
  assert.ok(start >= 0);
  const block = renderer.slice(start, start + 1800);
  assert.ok(block.includes('state.items.length < SORT_FETCH_CAP'));
  // Backfill pages render quietly; the grid rebuilds once when it settles.
  assert.ok(block.includes('quiet: nextQuiet'));
  assert.ok(block.includes('if (quiet) renderGrid({ preserveScroll: true });'));
  // The cap notice keys off (view, sort) so no reset bookkeeping is needed.
  assert.ok(block.includes('pane.sortCapNoticeKey !== capKey'));
});

test('changing the sort resets direction and starts the backfill', () => {
  const start = renderer.indexOf("query('#sortSelect').addEventListener('change'");
  assert.ok(start >= 0);
  const handler = renderer.slice(start, renderer.indexOf('\n  });', start));
  assert.ok(handler.includes("state.sortDir = 'auto';"));
  assert.ok(handler.includes('commitSortChange();'));
  assert.ok(handler.includes("state.sort !== 'default' && state.hasMore"));
});

test('随机 shuffles stably and reshuffles on demand', () => {
  const { randomRank } = require('../src/pane-state');
  const pool = Array.from({ length: 40 }, (_, index) => ({ id: `id-${index}` }));
  const order = seed => [...pool].sort((a, b) => compareBySort('random', 'auto', a, b, { seed })).map(item => item.id);

  // Stable: the grid re-sorts on every lazy page, so the same seed must give
  // the same order or the view would reshuffle under the reader.
  assert.deepEqual(order('seed-a'), order('seed-a'));
  assert.notDeepEqual(order('seed-a'), order('seed-b'), 'a new seed deals a new order');
  assert.notDeepEqual(order('seed-a'), pool.map(item => item.id), 'and it is not the input order');

  // Direction is meaningless for a shuffle; the button reshuffles instead.
  assert.deepEqual(order('seed-a'), [...pool].sort((a, b) => compareBySort('random', 'desc', a, b, { seed: 'seed-a' })).map(i => i.id));
  // A comparator that is not a total order would make sort() unstable.
  assert.equal(compareBySort('random', 'auto', pool[0], pool[0], { seed: 's' }), 0);
  assert.equal(
    Math.sign(compareBySort('random', 'auto', pool[1], pool[2], { seed: 's' })),
    -Math.sign(compareBySort('random', 'auto', pool[2], pool[1], { seed: 's' }))
  );
  // Ranks spread out rather than colliding into a few buckets.
  assert.ok(new Set(pool.map(item => randomRank('seed-a', item.id))).size >= 39);
});

test('the shuffle is wired to the pane and the direction button', () => {
  assert.ok(renderer.includes('<option value="random">随机</option>'));
  assert.ok(renderer.includes('function nextRandomSeed()'));
  assert.ok(renderer.includes("randomSeed: source.randomSeed || nextRandomSeed(),"));
  assert.ok(renderer.includes("if (state.sort === 'random') state.randomSeed = nextRandomSeed();"), '选中随机时重新洗牌');
  assert.ok(renderer.includes("dirButton.textContent = '⟳';"), '方向钮在随机时变成重新洗牌');
  assert.ok(renderer.includes("compareItemsBySort(state.sort, state.sortDir, a, b, { seed: state.randomSeed })"));
});
