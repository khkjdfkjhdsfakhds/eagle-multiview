'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
let inspection;
async function inspectorProbe() {
  if (!inspection) inspection = (async () => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/interaction-regression-probe.cjs'), '--scenario=inspectorRemoteRebase', '--scenario=inspectorRemoteLateIntent', '--scenario=inspectorLateIntentNoRemote', '--scenario=inspectorExplicitFieldRevert', '--scenario=textStoreLifecycle', '--scenario=importDuplicateFailures'], { env, timeout: 40000, maxBuffer: 2 * 1024 * 1024 });
    return Object.fromEntries(stdout.split('\n').filter(line => line.startsWith('INTERACTION_AUDIT ')).map(line => {
      const value = JSON.parse(line.slice(18)); assert.ok(!value.error, value.error); return [value.name, value.result];
    }));
  })();
  return inspection;
}
test('metadata ACK rebases every untouched field instead of undoing another window', async () => {
  const r = (await inspectorProbe()).inspectorRemoteRebase;
  assert.deepEqual(r.patches, [{ name: 'user name' }]);
  assert.equal(r.item.annotation, 'remote annotation');
  assert.equal(r.annotation, 'remote annotation');
  assert.deepEqual(r.tags, ['remote tag']);
  assert.equal(r.star, '4');
  assert.equal(r.url, 'https://example.com/remote');
  assert.equal(r.name, 'user name  ');
  assert.equal(r.caret, 3);
});
test('late first-time field input retains its seen baseline and conflicts with unseen remote changes', async () => {
  const r = (await inspectorProbe()).inspectorRemoteLateIntent;
  assert.deepEqual(r.patches, [{ name: 'first name' }, { name: 'Item 001', annotation: 'late user annotation' }]);
  assert.equal(r.item.url, 'https://example.com/remote');
  assert.equal(r.item.annotation, 'remote annotation');
  assert.equal(r.requests[1].base.annotation, '');
  assert.equal(r.annotation, 'late user annotation');
  assert.equal(r.dirty, true);
  assert.match(r.conflict, /外部内容已变化/);
  assert.equal(r.confirmations, 0);
  assert.equal(r.focused, true); assert.equal(r.caret, 3);
});
test('late new-field edits without remote changes and own sent-field reverts save normally', async () => {
  const r = (await inspectorProbe()).inspectorLateIntentNoRemote;
  assert.deepEqual(r.patches, [{ name: 'first name' }, { name: 'Item 001', annotation: 'late user annotation' }]);
  assert.equal(r.item.name, 'Item 001');
  assert.equal(r.item.annotation, 'late user annotation');
  assert.equal(r.dirty, false);
});
test('canceling an unsent field edit adopts the remote value and URL ACK keeps live whitespace/caret', async () => {
  const r = (await inspectorProbe()).inspectorExplicitFieldRevert;
  assert.equal(r.reverted, 'https://example.com/remote');
  assert.equal(r.displayAfterRevert, 'https://example.com/remote');
  assert.equal(r.dirtyAfterRevert, false);
  assert.deepEqual(r.patches, [{ name: 'first name' }, { url: 'https://example.com/user' }]);
  assert.equal(r.value, 'https://example.com/user  ');
  assert.equal(r.caret, 5);
  assert.equal(r.star, 4);
});
test('clean TXT close/reopen starts a writable host draft lifecycle and reload restores it', async () => {
  const { beforeReload: r, afterReload } = (await inspectorProbe()).textStoreLifecycle;
  assert.notEqual(r.draftId, r.previousId);
  assert.equal(r.record?.content, 'new lifecycle draft');
  assert.equal(afterReload.draftId, r.draftId);
  assert.equal(afterReload.panes[0].textContent, 'new lifecycle draft');
});
test('TXT host draft RPC sends one content copy for put and only identity for removal', async () => {
  const r = (await inspectorProbe()).textStoreLifecycle.beforeReload;
  assert.deepEqual(r.putKeys, ['base', 'content', 'draftId', 'id', 'libraryPath', 'revision']);
  assert.deepEqual(r.removeKeys, ['draftId', 'id', 'libraryPath', 'revision']);
});
test('import reports mixed and complete existing-duplicate assignment failure, not empty input', async () => {
  const messages = (await inspectorProbe()).importDuplicateFailures;
  assert.match(messages[0], /接收 1 个素材.*1 个重复素材.*失败/);
  assert.match(messages[1], /接收 0 个素材.*2 个重复素材.*失败/);
  assert.equal(messages[2], '没有可导入的文件');
});
test('ordinary HTTP window.open children own separate drafts while each reload keeps its identity', { timeout: 50000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/text-opener-probe.cjs')], { env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  const r = JSON.parse(stdout.split('\n').find(line=>line.startsWith('TEXT_OPENER ')).slice(12));
  assert.equal(r.before.secure, false);
  const keys = new Set([r.before.key]);
  for (const child of r.children) {
    assert.equal(child.initial.secure, false);
    assert.equal(child.initial.hasOpener, true, 'test must exercise opener storage cloning');
    assert.ok(!keys.has(child.initial.key), `${child.mode} shares an earlier window identity`); keys.add(child.initial.key);
    assert.equal(child.initial.text, 'original', `${child.mode} must offer other drafts, not silently adopt them`);
    assert.ok(child.initial.recoveries >= 1);
    assert.equal(child.afterReload.key, child.initial.key);
    assert.equal(child.afterReload.draftId, child.initial.draftId);
    assert.equal(child.afterReload.text, child.mode + '-child draft');
  }
  assert.equal(r.records.length, 4);
  assert.equal(r.records.find(record=>record.draftId===r.before.draftId)?.content, 'parent-only draft');
});
