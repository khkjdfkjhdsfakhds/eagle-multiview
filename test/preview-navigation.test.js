'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');

test('preview up and down follow the source grid geometry', () => {
  const helper = renderer.slice(
    renderer.indexOf('function previewDirectionalItemId(key)'),
    renderer.indexOf('// --- Preview view options')
  );
  assert.ok(helper.includes("querySelector(`#itemGrid .item-card[data-id=\"${CSS.escape(state.previewId)}\"]`)"),
    'the open item is located in the active source grid');
  assert.ok(helper.includes("querySelectorAll('#itemGrid .item-card')"),
    'folders are excluded because preview navigation moves only between items');
  assert.ok(helper.includes('directionalCard(cards, current, key)?.dataset.id'),
    'vertical preview navigation shares the grid spatial-neighbour rule');
  assert.ok(helper.includes("if (!nextId && key === 'ArrowDown' && state.hasMore)"),
    'moving down can load the next page before retrying');
});

test('plain preview arrows route horizontal and vertical movement separately', () => {
  const handler = renderer.slice(
    renderer.indexOf("document.addEventListener('keydown'"),
    renderer.indexOf('// --- Web access settings')
  );
  assert.ok(handler.includes("['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)"));
  assert.ok(handler.includes("if (event.key === 'ArrowLeft') movePreview(-1);"));
  assert.ok(handler.includes("else if (event.key === 'ArrowRight') movePreview(1);"));
  assert.ok(handler.includes('else movePreviewVertically(event.key);'));
  assert.match(handler, /previewOpen && !editable && !primaryKey && !event\.shiftKey && !event\.altKey/,
    'modified arrow shortcuts must not also move the preview');
});

test('grid and preview use one directional-card ranking rule', () => {
  const ranking = renderer.slice(
    renderer.indexOf('function directionalCard(cards, current, key)'),
    renderer.indexOf('function moveCardFocus(key)')
  );
  assert.ok(ranking.includes("key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1"));
  assert.ok(ranking.includes('Math.abs(a.primary) + a.secondary * 2'),
    'nearby candidates in the requested direction are ranked by primary and cross-axis distance');
  assert.ok(renderer.includes('directionalCard(cards, current, key) || current'),
    'ordinary grid keyboard movement uses the same rule');
});
