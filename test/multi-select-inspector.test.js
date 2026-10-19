'use strict';

// Eagle-parity: the multi-select inspector mirrors the single one — stacked
// thumbnails, 已选 N 个文件, batch 注释/链接, shared tags and folders, stars and
// the total size (group 6 B).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sharedTags, sharedFolders, sharedFieldValue } = require('../src/pane-state');

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

test('sharedFolders returns the folders every item is in, in first-item order', () => {
  assert.deepEqual(sharedFolders([{ folders: ['A', 'B', 'C'] }, { folders: ['C', 'A'] }]), ['A', 'C']);
  assert.deepEqual(sharedFolders([{ folders: ['A'] }, {}]), []);
  assert.deepEqual(sharedFolders([]), []);
});

test('sharedFieldValue shows the common value, or empty when the items differ', () => {
  assert.deepEqual(sharedFieldValue([{ url: 'https://a' }, { url: 'https://a' }], 'url'), { value: 'https://a', mixed: false });
  assert.deepEqual(sharedFieldValue([{ url: 'https://a' }, { url: 'https://b' }], 'url'), { value: '', mixed: true });
  // Eagle omits an empty note and a zero rating from the item.
  assert.deepEqual(sharedFieldValue([{}, { annotation: '' }], 'annotation'), { value: '', mixed: false });
  assert.deepEqual(sharedFieldValue([{ star: 3 }, { star: 3 }], 'star'), { value: 3, mixed: false });
  assert.deepEqual(sharedFieldValue([{ star: 3 }, {}], 'star'), { value: 0, mixed: true });
});

test('multi-selection panel has Eagle\'s structure, not a separate batch form', () => {
  const start = html.indexOf('id="multiSelection"');
  const panel = html.slice(start, html.indexOf('</aside>', start));
  const order = ['id="multiPreview"', '已选 <span id="multiCount">', 'id="batchAnnotation"', 'id="batchURL"',
    'id="sharedTagChips"', 'id="batchTagInput"', 'id="batchFolderChips"', 'id="batchStars"', 'id="batchMeta"', 'id="batchTrashButton"'];
  let at = -1;
  for (const marker of order) {
    const next = panel.indexOf(marker);
    assert.ok(next > at, `${marker} out of order`);
    at = next;
  }
  assert.ok(!html.includes('id="batchRating"'), 'the rating select gave way to stars');
  assert.ok(!html.includes('id="batchTagButton"'), 'Return applies a tag, as in Eagle');
});

test('single-item inspector follows Eagle\'s order', () => {
  const start = html.indexOf('id="inspectorContent"');
  const panel = html.slice(start, html.indexOf('id="multiSelection"', start));
  const order = ['id="itemName"', 'id="itemAnnotation"', 'id="itemURL"', 'id="itemTagInput"', 'id="itemFolderChips"',
    'id="itemCommentsSection"', 'id="itemStars"', 'id="itemMeta"', 'id="generationMetadataSection"'];
  let at = -1;
  for (const marker of order) {
    const next = panel.indexOf(marker);
    assert.ok(next > at, `${marker} out of order`);
    at = next;
  }
  assert.match(panel, /<select id="itemRating"[^>]* hidden/, 'stars write the hidden select the save reads');
});

test('multi-select inspector renders through renderMultiSelection', () => {
  const start = renderer.indexOf('if (count >= 2) {');
  assert.ok(start >= 0);
  const branch = renderer.slice(start, renderer.indexOf('return;', start));
  assert.ok(branch.includes('renderMultiSelection(count);'));
  const fn = renderer.slice(renderer.indexOf('function renderMultiSelection(count)'), renderer.indexOf('\n}', renderer.indexOf('function renderMultiSelection(count)')));
  assert.ok(fn.includes('renderSharedTags();'));
  assert.ok(fn.includes('const summary = currentSelectionSummary();'), 'one summary, local or from the main process (P6-02)');
  assert.ok(fn.includes('inspectorFolderChipsHTML(summary?.folders || [])'));
  assert.ok(fn.includes("count >= BULK_CONFIRM_THRESHOLD"), '100+ shows the warning colour');
  assert.ok(fn.includes('document.activeElement !== annotationField'), 'a refresh keeps text being typed');
  assert.ok(fn.includes("url.mixed ? '多个链接'"));
});

test('shared tag chips carry colors and a per-tag remove action', () => {
  const start = renderer.indexOf('function renderSharedTags()');
  assert.ok(start >= 0);
  const fn = renderer.slice(start, renderer.indexOf('\n}', start));
  assert.ok(fn.includes('currentSelectionSummary()?.tags'));
  const summary = renderer.slice(renderer.indexOf('function currentSelectionSummary('), renderer.indexOf('\n}', renderer.indexOf('function currentSelectionSummary(')));
  assert.ok(summary.includes('pane.items.filter(item => pane.selected.has(item.id))'), 'one pass, no per-id linear lookups');
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

test('stars: clicking the lit one clears, others set; both inspectors share it', () => {
  const fn = renderer.slice(renderer.indexOf('function nextStarRating'), renderer.indexOf('\n}', renderer.indexOf('function nextStarRating')));
  const nextStarRating = new Function(`${fn}\n}; return nextStarRating;`)();
  assert.equal(nextStarRating('3', '3'), 0);
  assert.equal(nextStarRating('3', '5'), 5);
  assert.equal(nextStarRating(0, '1'), 1);
  const single = renderer.slice(renderer.indexOf("$('#itemStars').addEventListener('click'"), renderer.indexOf('\n  });', renderer.indexOf("$('#itemStars').addEventListener('click'")));
  assert.ok(single.includes("select.dispatchEvent(new Event('change'))"), 'single item saves through the existing rating path');
  const batch = renderer.slice(renderer.indexOf("$('#batchStars').addEventListener('click'"), renderer.indexOf('\n  });', renderer.indexOf("$('#batchStars').addEventListener('click'")));
  assert.ok(batch.includes('confirmBulkEdit(ids.length)'));
  assert.ok(batch.includes('setSelectionRating({ ids, rating: nextStarRating('));
});

test('folder chips open the folder, remove only that folder, and add via the picker', () => {
  const fn = renderer.slice(renderer.indexOf('function handleInspectorFolderClick'), renderer.indexOf('\n}', renderer.indexOf('function handleInspectorFolderClick')));
  assert.ok(fn.includes("mutateSelectionSet(ids, 'folders', { remove: [folderId] }"), 'not paneFolderScope: the subtree stays');
  assert.ok(fn.includes('keepSelection: true'));
  assert.ok(fn.includes('openItemLocation(ids[0], open.dataset.openFolder)'));
  assert.ok(fn.includes('showFolderAssignmentPicker(ids, { anchor: add, keepSelection: true })'));
  const chips = renderer.slice(renderer.indexOf('function inspectorFolderChipsHTML'), renderer.indexOf('\n}', renderer.indexOf('function inspectorFolderChipsHTML')));
  assert.ok(chips.includes('folderColorValue(folder)'), 'chip dot takes the folder colour');
  assert.ok(chips.includes("path.map(entry => entry.name).join(' / ')"), 'hover shows the full path');
  assert.ok(renderer.includes("addSelectionToFolder({ ids, folderId: payload.folderId, keepSelection: Boolean(data.keepSelection) })"));
});

test('batch note and link apply only when changed, to the items selected at focus', () => {
  const fn = renderer.slice(renderer.indexOf('function commitBatchFieldEdit'), renderer.indexOf('\n}', renderer.indexOf('function commitBatchFieldEdit')));
  assert.ok(fn.includes('ids: edit.ids'));
  assert.ok(fn.includes('changed && edit.ids.length >= 2 && confirmBulkEdit(edit.ids.length)'));
  const apply = renderer.slice(renderer.indexOf('async function setSelectionFields'), renderer.indexOf('\n}', renderer.indexOf('async function setSelectionFields')));
  assert.ok(apply.includes('window.eagleMV.mutate({ id, patch, base: item, libraryPath })'), 'field-level conflict check');
  assert.ok(apply.includes('const editsSelection = sameSelection(pane, new Set(ids));'), 'a blur after a click leaves the new selection alone');
});

test('a multi-select tag applies on Return, never on blur', () => {
  assert.ok(renderer.includes("if (kind === 'batch' && event.key === 'Enter') applyBatchTags();"));
  assert.ok(renderer.includes("if (kind !== 'batch') commitTagInput(kind);"));
  assert.ok(renderer.includes("if (kind === 'batch') applyBatchTags();"), 'choosing a suggestion applies it too');
  const fn = renderer.slice(renderer.indexOf('async function applyBatchTags'), renderer.indexOf('\n}', renderer.indexOf('async function applyBatchTags')));
  assert.ok(fn.includes('confirmBulkEdit(ids.length)'));
});

test('edits of 100 or more items ask first, like Eagle', () => {
  assert.ok(renderer.includes('const BULK_CONFIRM_THRESHOLD = 100;'));
  const fn = renderer.slice(renderer.indexOf('function confirmBulkEdit'), renderer.indexOf('\n}', renderer.indexOf('function confirmBulkEdit')));
  assert.ok(fn.includes('这个操作会影响'));
});

test('state object initializes commentsToken and metadataToken to 0 to prevent NaN token comparisons', () => {
  const stateMatch = renderer.match(/const state = \{([\s\S]*?)\n\};/);
  assert.ok(stateMatch, 'state object definition should exist');
  const stateBody = stateMatch[1];
  assert.match(stateBody, /\bcommentsToken:\s*0\b/, 'state.commentsToken must be initialized to 0');
  assert.match(stateBody, /\bmetadataToken:\s*0\b/, 'state.metadataToken must be initialized to 0');
});

