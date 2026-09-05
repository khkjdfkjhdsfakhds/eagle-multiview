'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

let results;
async function probe() {
  if (!results) results = (async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/interaction-regression-probe.cjs'), '--scenario=inspectorOwnSaveEcho', '--scenario=inspectorPollEchoAndExternalConflict', '--scenario=inspectorResolvedConflict', '--scenario=inspectorResolvedThenLateConflict'], { env, timeout: 16000 });
  return Object.fromEntries(stdout.split('\n').filter(row => row.startsWith('INTERACTION_AUDIT ')).map(line => {
    const result = JSON.parse(line.slice(18));
    assert.ok(!result.error, result.error);
    return [result.name, result.result];
  }));
  })();
  return results;
}

test('own metadata save and equivalent query echo do not claim another window edited the item', { timeout: 20000 }, async () => {
  assert.deepEqual((await probe()).inspectorOwnSaveEcho, { value: 'own annotation', stored: 'own annotation', dirty: false, stale: false, focused: true, caret: 4 });
});
test('watched-item timestamp echoes stay quiet, while real external tags and notes retain warnings and conflict protection', async () => {
  assert.deepEqual((await probe()).inspectorPollEchoAndExternalConflict, {
    timeOnlyStale: false,
    externalTagsStale: true,
    accepted: { stale: false, tags: ['outside tag'], dirty: false },
    externalNoteStale: true,
    conflict: true, dirty: true, value: 'local draft', stored: 'outside note', focused: true, caret: 3
  });
});
test('confirmed conflict overwrite removes only its resolved action panel without replacing the editor', async () => {
  assert.deepEqual((await probe()).inspectorResolvedConflict, {
    dirty: false, stored: 'local draft', value: 'local draft', focused: true, caret: 3, stale: false, conflictButtons: false
  });
});
test('a late unsent field conflict after overwrite still preserves the new draft and conflict actions', async () => {
  assert.deepEqual((await probe()).inspectorResolvedThenLateConflict, {
    dirty: true, storedName: 'outside name', storedAnnotation: 'local draft', name: 'late local name',
    focused: true, caret: 2, stale: true, conflictButtons: true, forces: [false, true, false]
  });
});
