'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');

// Regression guard: leaving a folder used to reset the parent view's scroll
// position and loaded pages, forcing the user to scroll all the way down again.

test('panes carry per-view scroll memory through the state proxy', () => {
  assert.match(renderer, /'viewMemory', 'restoreScroll'/, 'proxy keys forward to the active pane');
  assert.ok(renderer.includes('viewMemory: new Map(source.viewMemory || []),'), 'split panes inherit the memory');
  assert.ok(renderer.includes('restoreScroll: null'));
});

test('navigate remembers the departing view and arms restore for back-style navigation', () => {
  assert.ok(renderer.includes('function rememberViewPosition()'));
  assert.ok(renderer.includes('if (changed) rememberViewPosition();'));
  assert.ok(renderer.includes(
    'state.restoreScroll = changed && restoreScroll ? state.viewMemory.get(descriptorKey(view)) || null : null;'
  ), 'restore only arms when the caller asks for it and the view actually changes');
  // Memory is bounded and top-of-list departures clear the entry.
  assert.ok(renderer.includes('const VIEW_MEMORY_LIMIT = 50;'));
  assert.ok(renderer.includes('while (memory.size > VIEW_MEMORY_LIMIT) memory.delete(memory.keys().next().value);'));
  assert.ok(renderer.includes('count: Math.min(state.items.length, SORT_FETCH_CAP)'));
});

test('back, forward, up, and breadcrumb navigation all restore the scroll position', () => {
  assert.ok(renderer.includes(
    "navigate(target.view, { record: false, skipDiscard: true, restoreScroll: true })"
  ), 'history navigation restores');
  assert.ok(renderer.includes('if (parent) navigate(parent, { restoreScroll: true });'), 'navigateUp restores');
  assert.ok(renderer.includes(
    'const crumb = breadcrumb._crumbs?.[Number(button.dataset.crumbIndex)];'
  ), 'breadcrumb restores');
  assert.ok(renderer.includes(
    "if (crumb) navigate(crumb.view, { restoreScroll: true });"
  ), 'breadcrumb uses the owning pane');
});

test('refresh backfills to the remembered count before jumping back', () => {
  const start = renderer.indexOf('const restoreTarget = pane.restoreScroll;');
  assert.ok(start >= 0);
  const block = renderer.slice(start, start + 1200);
  assert.ok(block.includes('state.hasMore && state.items.length < restoreTarget.count'), 'keeps paging until the count is in');
  assert.ok(block.includes('needsViewportFill || continueBackfill || continueRestore'));
  assert.ok(block.includes('scroller.scrollTop = restoreTarget.scrollTop;'), 'lands on the remembered offset');
  assert.ok(block.includes('pane.restoreScroll = null;'), 'restore is one-shot');
});
