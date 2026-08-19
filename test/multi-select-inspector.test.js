'use strict';

// Eagle-parity batch 2: multi-select inspector shows the shared-tag
// intersection (removable per chip) and a batch rating selector.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sharedTags } = require('../src/pane-state');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

test('sharedTags returns the intersection in first-item order', () => {
  const items = [
    { tags: ['red', 'ref', 'wip'] },
    { tags: ['ref', 'red'] },
    { tags: ['red', 'done', 'ref'] }
  ];
  assert.deepEqual(sharedTags(items), ['red', 'ref']);
  assert.deepEqual(sharedTags([{ tags: ['a'] }, { tags: [] }]), []);
  assert.deepEqual(sharedTags([{ tags: ['a', 'b'] }]), ['a', 'b']);
  assert.deepEqual(sharedTags([]), []);
  assert.deepEqual(sharedTags([{ }, { tags: ['a'] }]), []);
});

test('multi-selection panel offers shared tags and batch rating controls', () => {
  assert.ok(html.includes('id="sharedTagsSection"'));
  assert.ok(html.includes('id="sharedTagChips"'));
  assert.ok(html.includes('id="batchRating"'));
  for (const value of ['0', '1', '2', '3', '4', '5']) {
    assert.ok(html.includes(`<option value="${value}">`), `batchRating must offer ${value}`);
  }
});

test('multi-select inspector renders shared tags and resets the rating select', () => {
  const start = renderer.indexOf('if (count >= 2) {');
  assert.ok(start >= 0);
  const branch = renderer.slice(start, renderer.indexOf('return;', start));
  assert.ok(branch.includes('renderSharedTags();'));
  assert.ok(branch.includes("$('#batchRating').value = '';"));
});

test('shared tag chips carry colors and a per-tag remove action', () => {
  const start = renderer.indexOf('function renderSharedTags()');
  assert.ok(start >= 0);
  const fn = renderer.slice(start, renderer.indexOf('\n}', start));
  assert.ok(fn.includes('computeSharedTags(selectedItems)'));
  assert.ok(fn.includes('state.items.filter(item => state.selected.has(item.id))'), 'one pass, no per-id linear lookups');
  assert.ok(fn.includes('data-remove-shared-tag'));
  assert.ok(fn.includes('tagChipHTML(tag'), 'chip markup is shared with the tag editors');
});

test('removing a shared tag rides the shared batch pipeline and keeps the selection', () => {
  const start = renderer.indexOf('function removeTagFromSelection(tag)');
  assert.ok(start >= 0);
  const fn = renderer.slice(start, renderer.indexOf('\n}', start));
  assert.ok(fn.includes("mutateSelectionSet([...state.selected], 'tags', { remove: [tag] }"));
  assert.ok(fn.includes('keepSelection: true'));
});

test('batch rating change sets the selection rating then clears the select', () => {
  const start = renderer.indexOf("$('#batchRating').addEventListener('change'");
  assert.ok(start >= 0);
  const handler = renderer.slice(start, renderer.indexOf('\n  });', start));
  assert.ok(handler.includes('setSelectionRating({ ids: [...state.selected], rating: Number(value) })'));
  assert.ok(handler.includes("event.target.value = '';"));
});

test('state object initializes commentsToken and metadataToken to 0 to prevent NaN token comparisons', () => {
  const stateMatch = renderer.match(/const state = \{([\s\S]*?)\n\};/);
  assert.ok(stateMatch, 'state object definition should exist');
  const stateBody = stateMatch[1];
  assert.match(stateBody, /\bcommentsToken:\s*0\b/, 'state.commentsToken must be initialized to 0');
  assert.match(stateBody, /\bmetadataToken:\s*0\b/, 'state.metadataToken must be initialized to 0');
});

