'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
let resultPromise;
function probe() {
  resultPromise ||= (async () => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/tag-color-sync-probe.cjs')], { env, timeout: 25000 });
    const line = stdout.split('\n').find(row => row.startsWith('TAG_COLOR_SYNC '));
    assert.ok(line, stdout);
    return JSON.parse(line.slice('TAG_COLOR_SYNC '.length));
  })();
  return resultPromise;
}
function assertDraftsUnchanged(rows) {
  assert.equal(rows.length, 2);
  rows.forEach((row, index) => {
    assert.equal(row.inputUnreplaced, true, 'editable DOM node survives notification');
    assert.equal(row.annotationUnreplaced, true);
    assert.equal(row.focused, true, 'document focus remains in the active editor');
    assert.equal(row.caret, index ? 5 : 4);
    assert.equal(row.value, index ? 'Unsaved TXT draft' : 'Partial new tag');
    assert.equal(row.dirty, true);
    assert.deepEqual(row.tags, ['Shared tag']);
    assert.deepEqual(row.unhandled, []);
    if (index) { assert.equal(row.preview, 'text-1'); assert.equal(row.text, 'Unsaved TXT draft'); }
    else assert.equal(row.annotation, 'Unsaved metadata draft');
  });
}
function assertColors(rows, color) {
  for (const row of rows) {
    assert.deepEqual(row.colors, { 'Shared tag': color });
    assert.ok(row.chips.length > 0, 'at least one rendered chip is examined per window');
    assert.ok(row.chips.every(value => value === color), `all rendered chips must be ${color}, got ${row.chips}`);
  }
}
test('UW-07: same-library color broadcast recolors two real renderers without replacing metadata or TXT drafts', { timeout: 30000 }, async () => {
  const result = await probe();
  assertColors(result.sameLibrary.before, '#112233');
  assertDraftsUnchanged(result.sameLibrary.before);
  assert.deepEqual(result.sameLibrary.saved, { 'Shared tag': '#abcdef' });
  assertColors(result.sameLibrary.after, '#abcdef');
  assertDraftsUnchanged(result.sameLibrary.after);
  assert.deepEqual(result.popups, []);
  assert.deepEqual(result.errors, []);
});
test('UW-07: late payloads reread committed colors and foreign-library notifications are ignored', async () => {
  const result = await probe();
  assertColors(result.oldPayload, '#abcdef');
  assertDraftsUnchanged(result.oldPayload);
  assert.equal(result.foreign.reads, 0);
  assertColors(result.foreign.snapshots, '#abcdef');
  assertDraftsUnchanged(result.foreign.snapshots);
});
test('UW-07: delayed old-library color reads cannot overwrite new-library views or either saved draft', async () => {
  const result = await probe();
  assertColors(result.afterLibrarySwitch, '#445566');
  for (const row of result.afterLibrarySwitch) {
    assert.equal(row.library, '/synthetic/tag-sync-B.library');
    assert.deepEqual(row.unhandled, []);
  }
  assert.deepEqual(result.retained.metadata, [{ libraryPath: '/synthetic/tag-sync-A.library', id: 'image-1', annotation: 'Unsaved metadata draft' }]);
  assert.deepEqual(result.retained.text, [{ libraryPath: '/synthetic/tag-sync-A.library', id: 'text-1', content: 'Unsaved TXT draft' }]);
});
