'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const cases = ['textRestartRecovery', 'textAutoSaveTyping', 'textConflictAndEmpty', 'textImeAndPending', 'inspectorFailureRestore', 'modalFocus', 'asyncTextPane', 'dirtyTextLayout', 'dirtyTextWindowClose', 'dirtyTextReload', 'refreshSelection', 'slideshowPane', 'pinsDiscardDraft', 'focusedInFlightDraftNavigation', 'inFlightTypingStaysControl', 'activeTextCancelControls', 'savedTextCloseControl', 'historyQuery', 'multiSelectFilteredOut', 'duplicateNavigates'];
cases.push('inspectorRestartRecovery');
cases.push('webHttpBootstrap');
let results;
async function probe() {
  if (!results) results = (async () => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/interaction-regression-probe.cjs'), ...cases.map(name => `--scenario=${name}`)], { env, timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
    const parsed = Object.fromEntries(stdout.split('\n').filter(line => line.startsWith('INTERACTION_AUDIT ')).map(line => { const value = JSON.parse(line.slice(18)); assert.ok(!value.error, `${value.name}: ${value.error}`); return [value.name, value.result]; }));
    for (const name of cases) assert.ok(parsed[name], `missing ${name}`);
    return parsed;
  })();
  return results;
}
test('TXT async read renders in its originating pane after another pane activates', { timeout: 100000 }, async () => {
  const r = (await probe()).asyncTextPane;
  assert.equal(r.panes[0].textContent, 'original');
  assert.doesNotMatch(r.firstMedia, /正在读取/);
});
test('retiring panes and closing the window protect non-active TXT drafts', async () => {
  const r = await probe();
  assert.equal(r.dirtyTextLayout.after.length, 2);
  assert.equal(r.dirtyTextLayout.after[1].textContent, 'UNSAVED AUDIT DRAFT');
  assert.ok(r.dirtyTextWindowClose.calls.some(call => call.kind === 'cancel-close'));
  assert.ok(!r.dirtyTextWindowClose.calls.some(call => call.kind === 'confirm-close'));
});
test('reloading preserves a synchronous TXT draft and warns before leaving', async () => {
  const r = (await probe()).dirtyTextReload;
  // Chromium may suppress its native prompt without a trusted user gesture;
  // verify the cancellable boundary separately and actually reload below.
  assert.equal(r.beforeReload.guardPrevented, true);
  assert.equal(r.afterReload.panes[0].textContent, 'UNSAVED BEFORE RELOAD');
  assert.equal(r.afterReload.panes[0].textDirty, true);
});
test('refresh preserves loaded page-two selection, but query changes remove invisible multi-selection', async () => {
  const r = await probe();
  assert.deepEqual(r.refreshSelection.after[0].selected, ['item-200']);
  assert.ok(r.refreshSelection.after[0].count >= r.refreshSelection.before[0].count);
  assert.equal(r.refreshSelection.savedStar, 3);
  assert.deepEqual(r.multiSelectFilteredOut.selected, []);
});
test('slideshow advances only its owner pane after focus moves', async () => {
  const r = (await probe()).slideshowPane;
  assert.equal(r.after[0].preview, 'item-2');
  assert.equal(r.after[1].preview, 'item-5');
  assert.equal(r.after[1].slideshowTimer, false);
});
test('unrelated pin broadcasts and in-flight navigation retain all inspector input', async () => {
  const r = await probe();
  assert.equal(r.pinsDiscardDraft.mutations.at(-1).patch.annotation, 'UNSAVED BEFORE PIN EVENT');
  assert.equal(r.focusedInFlightDraftNavigation.stored, 'second after focus');
  assert.equal(r.inFlightTypingStaysControl.stored, 'second retained');
  assert.equal(r.inFlightTypingStaysControl.focused, true);
});
test('TXT cancellation retains content, while confirmed saved content closes normally', async () => {
  const r = await probe();
  assert.equal(r.activeTextCancelControls.afterWindowCancel[0].textContent, 'cancel keeps draft');
  assert.ok(r.savedTextCloseControl.calls.some(call => call.kind === 'confirm-close'));
});
test('history restores the query left behind and delayed duplicates do not cross folders', async () => {
  const r = await probe();
  assert.equal(r.historyQuery.restoredSearch, 'Item 00');
  assert.equal(r.historyQuery.input, 'Item 00');
  assert.equal(r.duplicateNavigates.after.view, 'folder-b');
  assert.equal(r.duplicateNavigates.after.copiedVisible, false);
});
test('TXT autosave queues late typing without disabling or replacing the editor, even after pane switch', async () => {
  const r = (await probe()).textAutoSaveTyping;
  assert.equal(r.text, 'second text');
  assert.equal(r.editableDuringSave, true);
  assert.equal(r.sameEditor, true);
  assert.equal(r.caret, 4);
  assert.equal(r.maxInFlight, 1);
  assert.deepEqual(r.panes[1].selected, ['item-2']);
});
test('TXT conflict and empty-body failure preserve local content without automatic overwrite prompts', async () => {
  const r = (await probe()).textConflictAndEmpty;
  assert.equal(r.conflict.text, 'my conflicting draft');
  assert.equal(r.conflict.dirty, true);
  assert.equal(r.conflict.confirmations, 0);
  assert.equal(r.empty.text, '');
  assert.equal(r.empty.dirty, true);
  assert.match(r.empty.status, /空正文/);
  assert.equal(r.stored, 'original');
  assert.equal(r.calls.length, 1);
});
test('IME composition delays TXT autosave and pending thumbnail completion reports written content correctly', async () => {
  const r = (await probe()).textImeAndPending;
  assert.equal(r.during, 0);
  assert.equal(r.stored, '中文输入');
  assert.match(r.status, /正文已保存.*刷新待确认/);
  assert.equal(r.focused, true);
});
test('failed metadata save is restored on returning to the item and can be retried', async () => {
  const r = (await probe()).inspectorFailureRestore;
  assert.equal(r.restored, 'recover failed draft');
  assert.equal(r.stored, 'recover failed draft');
});
test('destroying and reopening a window exposes its draft as a separate explicitly restored session', async () => {
  const r = (await probe()).textRestartRecovery;
  assert.notEqual(r.before.draftId, r.draftId);
  assert.equal(r.text, 'draft surviving new window');
  assert.equal(r.dirty, true);
  assert.equal(r.saves, 0);
  assert.equal(r.candidates, 1);
});
test('modal Tab and Shift-Tab stay inside; Escape closes and restores the original control', async () => {
  const r = (await probe()).modalFocus;
  assert.deepEqual(r.tabInside, Array(8).fill(true));
  assert.equal(r.closed, true);
  assert.equal(r.restored, r.origin);
});
test('failed metadata drafts permit explicit backed-up close and recover into a new window without auto-submit', async () => {
  const r = (await probe()).inspectorRestartRecovery;
  assert.equal(r.before.confirmed, true);
  assert.equal(r.text, 'metadata retained after exit');
  assert.equal(r.dirty, true);
  assert.equal(r.saves, 0);
});
test('the complete renderer boots on a real non-secure HTTP origin without randomUUID', async () => {
  const r = (await probe()).webHttpBootstrap;
  assert.equal(r.secure, false);
  assert.equal(r.uuid, 'undefined');
  assert.equal(r.randomValues, 'function');
  assert.equal(r.platform, 'web');
  assert.ok(r.loaded > 0);
});
