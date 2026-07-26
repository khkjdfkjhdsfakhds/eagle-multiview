'use strict';

// Batch 3: filter by dominant color. The Eagle API has no color parameter,
// so matching runs client-side over item.palettes and color queries scan
// server pages incrementally like the constrained text search.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EagleClient } = require('../lib/eagle-client');
const { createQuery, filterCount, filtersActive } = require('../src/pane-state');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

test('parses hex colors and rejects junk', () => {
  assert.deepEqual(EagleClient.parseHexColor('#e5484d'), [229, 72, 77]);
  assert.deepEqual(EagleClient.parseHexColor('0090FF'), [0, 144, 255]);
  assert.deepEqual(EagleClient.parseHexColor('#abc'), [170, 187, 204]);
  assert.equal(EagleClient.parseHexColor('#12345'), null);
  assert.equal(EagleClient.parseHexColor('red'), null);
  assert.equal(EagleClient.parseHexColor(''), null);
});

test('matches items whose palette lies near the requested color', () => {
  const reddish = { palettes: [{ color: [220, 60, 70], ratio: .4 }, { color: [20, 20, 20], ratio: .6 }] };
  const blueish = { palettes: [{ color: [10, 140, 250], ratio: .8 }] };
  const bare = { palettes: [] };
  assert.equal(EagleClient.matchesColor(reddish, '#e5484d'), true);
  assert.equal(EagleClient.matchesColor(blueish, '#e5484d'), false);
  assert.equal(EagleClient.matchesColor(blueish, '#0090ff'), true);
  assert.equal(EagleClient.matchesColor(bare, '#e5484d'), false);
  assert.equal(EagleClient.matchesColor(reddish, 'junk'), false);
  const query = createQuery({ color: '#e5484d' });
  assert.equal(EagleClient.matchesSearchConstraints({ ...reddish, isDeleted: false }, query), true);
  assert.equal(EagleClient.matchesSearchConstraints({ ...blueish, isDeleted: false }, query), false);
});

test('color queries scan server pages and filter client-side', async () => {
  const client = new EagleClient();
  const calls = [];
  const red = index => ({ id: `R${index}`, folders: ['F1'], palettes: [{ color: [225, 70, 75] }] });
  const gray = index => ({ id: `G${index}`, folders: ['F1'], palettes: [{ color: [128, 128, 128] }] });
  const pageOne = [red(1), gray(1), red(2), ...Array.from({ length: 997 }, (_, i) => gray(100 + i))];
  const pageTwo = [red(3), gray(2)];
  client.request = async (url, options) => {
    calls.push(options.body.offset);
    assert.deepEqual(options.body.folders, ['F1']);
    if (options.body.offset === 0) return { data: pageOne, total: 1002 };
    return { data: pageTwo, total: 1002 };
  };
  const result = await client.queryItems({ folderId: 'F1', color: '#e5484d', offset: 0, limit: 160 });
  assert.deepEqual(result.data.map(item => item.id), ['R1', 'R2', 'R3']);
  assert.equal(result.total, 3);
  assert.equal(result.estimated, false);
  assert.equal(result.hasMore, false);
  assert.deepEqual(calls, [0, 1000], 'must keep scanning until the folder is exhausted');
});

test('color filtering inside a smart folder resolves its member ids first', () => {
  // Regression: the first cut skipped smartFolderItemIds, so the constraint
  // check rejected every item and smart-folder color filters returned zero.
  const client = new EagleClient();
  const calls = [];
  client.request = async (url, options) => {
    calls.push(url.split('?')[0]);
    if (url.startsWith('/api/v2/smartFolder/getItems')) return { data: [{ id: 'R1' }, { id: 'G1' }], total: 2 };
    return {
      data: [
        { id: 'R1', palettes: [{ color: [225, 70, 75] }] },
        { id: 'G1', palettes: [{ color: [128, 128, 128] }] },
        { id: 'R9', palettes: [{ color: [225, 70, 75] }] }
      ],
      total: 3
    };
  };
  return client.queryItems({ smartFolderId: 'SF1', color: '#e5484d', offset: 0, limit: 160 }).then(result => {
    assert.deepEqual(result.data.map(item => item.id), ['R1'], 'members outside the smart folder must stay excluded');
    assert.ok(calls.includes('/api/v2/smartFolder/getItems'));
  });
});

test('query state counts the color filter and the UI can clear it', () => {
  assert.equal(filterCount(createQuery({ color: '#e5484d' })), 1);
  assert.equal(filtersActive(createQuery({ color: '#e5484d' })), true);
  assert.ok(html.includes('id="colorFilter"'));
  assert.ok(renderer.includes('function renderColorFilter()'));
  assert.ok(renderer.includes("pane.query.color = swatch.dataset.filterColor || '';"));
  assert.ok(renderer.includes("state.query.color = '';"), 'clearFilters must reset the color');
  const constrained = fs.readFileSync(path.join(__dirname, '..', 'lib', 'eagle-client.js'), 'utf8');
  assert.ok(constrained.includes('query.shape || query.color'), 'text search must stay client-filtered with color');
});

test('alt-clicking a palette swatch applies the color filter, plain click still copies', () => {
  const start = renderer.indexOf("$('#itemPalette').addEventListener('click'");
  const handler = renderer.slice(start, renderer.indexOf('\n  });', start));
  assert.ok(handler.includes('event.altKey'));
  assert.ok(handler.includes('pane.query.color = swatch.dataset.color;'));
  assert.ok(handler.includes('schedulePaneFilterRefresh(paneId)'));
  assert.ok(handler.includes('window.eagleMV.copyText(swatch.dataset.color)'));
});
