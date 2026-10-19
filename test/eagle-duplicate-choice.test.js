'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  keepImportedCopiesScript,
  startKeepingCopiesScript,
  stopKeepingCopiesScript,
  startCopyImportModeScript,
  stopCopyImportModeScript,
  restoreImportedCopiesScript
} = require('../lib/eagle-duplicate-choice');

// Same branches as Eagle 4.0's duplicate-modal save(): applyAll → saveAll,
// usingExist → rewrite the existing item, otherwise keep both.
function eagleShapedSave(scope, onKeepBoth) {
  return function save() {
    if (this.applyAll == 'true') throw new Error('applies to every duplicate');
    if (this.usingExist == 'true') throw new Error('rewrites the existing item');
    else {
      scope.addToDuplicateMapping(this.right);
      scope.raw.push(this.right);
    }
    onKeepBoth.call(this);
  };
}

// The resident keeper is what resolves duplicates Eagle only reveals after the
// whole upload queue drains. It must answer the copy's own duplicates, leave
// unrelated dialogs alone, survive repeated ticks and stop when asked.
function keeperFixture(queue, save = null) {
  const saved = [];
  const scope = { libraryPath: '/fixture.library', raw: [], addToDuplicateMapping() {} };
  const intervals = new Map();
  let nextId = 0;
  const context = () => ({
    $bodyScope: scope,
    document: { querySelector: () => queue.length ? {} : null },
    angular: { element: () => ({ isolateScope: () => ({
      usingExist: 'true', applyAll: 'true',
      get right() { return queue[0] || null; },
      save: save || eagleShapedSave(scope, function () { saved.push(this.right.id); queue.shift(); })
    }) }) },
    setInterval: (fn) => { intervals.set(++nextId, fn); return nextId; },
    clearInterval: (id) => { intervals.delete(id); }
  });
  const tick = () => { for (const fn of intervals.values()) fn(); };
  return { scope, saved, intervals, context, tick, queue };
}

test('resident keeper answers only duplicates aimed at the copied folders', () => {
  const fixture = keeperFixture([
    { id: 'foreign', folders: ['other-folder'] },
    { id: 'ours-1', folders: ['copy-folder'] },
    { id: 'ours-2', folders: ['copy-child'] }
  ]);
  vm.runInNewContext(startKeepingCopiesScript({ libraryPath: '/fixture.library', folderIds: ['copy-folder', 'copy-child'] }), fixture.context());
  fixture.tick();
  assert.deepEqual(fixture.saved, [], 'an unrelated duplicate must stay for the user');
  // Once the user settles their own dialog the copy's duplicates come forward.
  fixture.tick();
  assert.deepEqual(fixture.saved, []);
  fixture.queue.shift();
  for (let i = 0; i < 4; i += 1) { fixture.tick(); }
  assert.deepEqual(fixture.saved, ['ours-1', 'ours-2']);
  assert.equal(fixture.scope.__eaglemvCopyKeeper.handled, 2);
  // Starting again reuses the same resident state instead of stacking timers.
  const timers = fixture.intervals.size;
  vm.runInNewContext(startKeepingCopiesScript({ libraryPath: '/fixture.library', folderIds: ['copy-folder'] }), fixture.context());
  assert.equal(fixture.intervals.size, timers);
  vm.runInNewContext(stopKeepingCopiesScript({ libraryPath: '/fixture.library' }), fixture.context());
  assert.equal(fixture.intervals.size, 0);
});

test('resident keeper expires and ignores a switched library', () => {
  const fixture = keeperFixture([{ id: 'ours', folders: ['copy-folder'] }]);
  const start = startKeepingCopiesScript({ libraryPath: '/fixture.library', folderIds: ['copy-folder'], ttlMs: -1 });
  vm.runInNewContext(start, fixture.context());
  fixture.tick();
  assert.equal(fixture.intervals.size, 0, 'an expired keeper stops itself');
  assert.deepEqual(fixture.saved, []);
  const other = keeperFixture([{ id: 'ours', folders: ['copy-folder'] }]);
  other.scope.libraryPath = '/different.library';
  vm.runInNewContext(startKeepingCopiesScript({ libraryPath: '/fixture.library', folderIds: ['copy-folder'] }), other.context());
  assert.equal(other.intervals.size, 0, 'a keeper must not run against another library');
});
test('concurrent copy runs keep their own folders until each one stops', () => {
  const fixture = keeperFixture([]);
  const lib = '/fixture.library';
  vm.runInNewContext(startKeepingCopiesScript({ libraryPath: lib, runId: 'a', folderIds: ['a-folder'] }), fixture.context());
  vm.runInNewContext(startKeepingCopiesScript({ libraryPath: lib, runId: 'b', folderIds: ['b-folder'] }), fixture.context());
  assert.equal(fixture.intervals.size, 1, 'runs share one resident timer');
  fixture.queue.push({ id: 'a-1', folders: ['a-folder'] }, { id: 'b-1', folders: ['b-folder'] });
  fixture.tick(); fixture.tick();
  assert.deepEqual(fixture.saved, ['a-1', 'b-1'], 'a later run must not drop the earlier run\u2019s folders');
  vm.runInNewContext(stopKeepingCopiesScript({ libraryPath: lib, runId: 'b' }), fixture.context());
  assert.equal(fixture.intervals.size, 1, 'stopping one run keeps the keeper for the other');
  fixture.queue.push({ id: 'a-2', folders: ['a-folder'] });
  fixture.tick();
  assert.deepEqual(fixture.saved, ['a-1', 'b-1', 'a-2']);
  fixture.queue.length = 0;
  fixture.queue.push({ id: 'b-late', folders: ['b-folder'] });
  fixture.tick();
  assert.deepEqual(fixture.saved, ['a-1', 'b-1', 'a-2'], 'a finished run must not answer dialogs for its old folders');
  vm.runInNewContext(stopKeepingCopiesScript({ libraryPath: lib, runId: 'a' }), fixture.context());
  assert.equal(fixture.intervals.size, 0, 'the last run stops the timer');
});

test('an unexpected Eagle save() shape leaves the duplicate dialog to the user', () => {
  // A save() that no longer has the keep-both branch could rewrite the
  // existing item instead; neither the keeper nor the one-shot answer may call it.
  let called = 0;
  const changed = function save() { called += 1; this.usingExist = 'true'; };
  const fixture = keeperFixture([{ id: 'ours', folders: ['copy-folder'] }], changed);
  vm.runInNewContext(startKeepingCopiesScript({ libraryPath: '/fixture.library', folderIds: ['copy-folder'] }), fixture.context());
  fixture.tick(); fixture.tick();
  assert.equal(called, 0);
  assert.equal(fixture.scope.__eaglemvCopyKeeper.handled, 0);
  const dialog = { right: { id: 'ours' }, usingExist: 'true', applyAll: 'false', save: changed };
  const timers = [];
  vm.runInNewContext(keepImportedCopiesScript({ libraryPath: '/fixture.library', ids: ['ours'] }), {
    $bodyScope: { libraryPath: '/fixture.library' }, document: { querySelector: () => ({}) },
    angular: { element: () => ({ isolateScope: () => dialog }) }, setTimeout: fn => timers.push(fn)
  });
  assert.equal(called, 0);
  assert.equal(timers.length, 0, 'it stops instead of polling a dialog it will not answer');
  assert.equal(dialog.usingExist, 'true');
});

test('copy import mode leaves an unexpected isDuplicateImage alone', () => {
  const scope = { libraryPath: '/fixture.library', isDuplicateImage: image => Boolean(image?.seen) };
  const original = scope.isDuplicateImage;
  const result = vm.runInNewContext(startCopyImportModeScript({ libraryPath: '/fixture.library', folderIds: ['copy-folder'] }), { $bodyScope: scope });
  assert.equal(result, false);
  assert.equal(scope.isDuplicateImage, original);
  assert.equal(scope.__eaglemvCopyImportMode, undefined);
});

test('copy import mode stays patched until the last concurrent run stops', () => {
  const existing = { id: 'existing', name: 'same.txt', folders: ['other-folder'] };
  const scope = {
    libraryPath: '/fixture.library',
    duplicateMappings: { 'same.txt': existing },
    isDuplicateImage(image) { return this.duplicateMappings[image?.name] || false; }
  };
  const original = scope.isDuplicateImage;
  const lib = '/fixture.library';
  vm.runInNewContext(startCopyImportModeScript({ libraryPath: lib, runId: 'a', folderIds: ['a-folder'] }), { $bodyScope: scope });
  vm.runInNewContext(startCopyImportModeScript({ libraryPath: lib, runId: 'b', folderIds: ['b-folder'] }), { $bodyScope: scope });
  assert.equal(scope.isDuplicateImage({ name: 'same.txt', folders: ['a-folder'] }), false);
  assert.equal(scope.isDuplicateImage({ name: 'same.txt', folders: ['b-folder'] }), false);
  vm.runInNewContext(stopCopyImportModeScript({ libraryPath: lib, runId: 'b' }), { $bodyScope: scope });
  assert.equal(scope.isDuplicateImage({ name: 'same.txt', folders: ['a-folder'] }), false, 'stopping B must not unpatch A');
  assert.equal(scope.isDuplicateImage({ name: 'same.txt', folders: ['b-folder'] }), existing, 'B\u2019s folders go back to Eagle\u2019s check');
  vm.runInNewContext(stopCopyImportModeScript({ libraryPath: lib, runId: 'a' }), { $bodyScope: scope });
  assert.equal(scope.isDuplicateImage, original);
  assert.equal(scope.__eaglemvCopyImportMode, undefined);
});

test('native keep-both chooses only this import and never applies to all duplicates', () => {
  const copies = [{id:'ours'}, {id:'other'}], saved = [];
  const scope = {libraryPath:'/fixture.library', raw:[], addToDuplicateMapping() {}};
  const dialog = { duplicates:copies, right:copies[0], usingExist:'true', applyAll:'true',
    save: eagleShapedSave(scope, function () { saved.push(this.right.id); this.duplicates.shift(); this.right=this.duplicates[0]; }) };
  const timers=[];
  const context = {$bodyScope:scope,document:{querySelector:()=>({})},angular:{element:()=>({isolateScope:()=>dialog})},setTimeout:fn=>timers.push(fn)};
  vm.runInNewContext(keepImportedCopiesScript({libraryPath:'/fixture.library',ids:['ours']}),context);
  assert.deepEqual(saved,['ours']); assert.equal(dialog.right.id,'other');
  assert.equal(dialog.applyAll,'true'); assert.equal(dialog.usingExist,'true');
  assert.equal(timers.length,0);
});
test('native keep-both stops on library change and expires without a matching dialog', () => {
  let polls=0; const timers=[];
  const context={$bodyScope:{libraryPath:'/fixture.library'},document:{querySelector:()=>{polls++;return null;}},setTimeout:fn=>timers.push(fn)};
  const script=keepImportedCopiesScript({libraryPath:'/fixture.library',ids:['ours']});
  vm.runInNewContext(script,context);
  while(timers.length)timers.shift()();
  assert.equal(polls,100);
  context.$bodyScope.libraryPath='/different.library';
  vm.runInNewContext(script,context); assert.equal(polls,100);
});

test('copy import mode keeps the copy out of the duplicate queue and reverts cleanly', () => {
  const existing = { id: 'existing', name: 'same.txt', folders: ['other-folder'] };
  const scope = {
    libraryPath: '/fixture.library',
    duplicateMappings: { 'same.txt': existing },
    isDuplicateImage(image) { return this.duplicateMappings[image?.name] || false; }
  };
  const context = () => ({ $bodyScope: scope });
  const original = scope.isDuplicateImage;
  vm.runInNewContext(startCopyImportModeScript({ libraryPath: '/fixture.library', folderIds: ['copy-folder'] }), context());
  assert.notEqual(scope.isDuplicateImage, original);
  assert.equal(scope.isDuplicateImage({ id: 'ours', name: 'same.txt', folders: ['copy-folder'] }), false);
  assert.equal(scope.isDuplicateImage({ id: 'theirs', name: 'same.txt', folders: ['other-folder'] }), existing);
  vm.runInNewContext(stopCopyImportModeScript({ libraryPath: '/fixture.library' }), context());
  assert.equal(scope.isDuplicateImage, original, 'the original check must come back');
  assert.equal(scope.__eaglemvCopyImportMode, undefined);
});

test('copy import mode expires on its own and ignores other libraries', () => {
  const scope = { libraryPath: '/fixture.library', duplicateMappings: { any: 'duplicate' }, isDuplicateImage() { return this.duplicateMappings.any; } };
  const original = scope.isDuplicateImage;
  vm.runInNewContext(startCopyImportModeScript({ libraryPath: '/fixture.library', folderIds: ['copy-folder'], ttlMs: -1 }), { $bodyScope: scope });
  assert.equal(scope.isDuplicateImage({ folders: ['copy-folder'] }), 'duplicate', 'an expired patch must not change the answer');
  const other = { libraryPath: '/different.library', isDuplicateImage: () => 'duplicate' };
  const untouched = other.isDuplicateImage;
  vm.runInNewContext(startCopyImportModeScript({ libraryPath: '/fixture.library', folderIds: ['copy-folder'] }), { $bodyScope: other });
  assert.equal(other.isDuplicateImage, untouched);
  assert.equal(typeof scope.isDuplicateImage, 'function');
  assert.equal(typeof original, 'function');
});

test('restore puts an accepted but invisible import back into the visible list', () => {
  const item = { id: 'restored', folders: ['copy-folder'], isDeleted: false };
  const removed = { id: 'removed', isDeleted: true };
  const scope = {
    libraryPath: '/fixture.library', raw: [], itemMappings: { restored: item, removed },
    addToDuplicateMapping(image) { this.mapped = image; },
    calculateImageBinding() { this.bound = true; }, rebindRefresh() {}, $evalAsync() {}
  };
  vm.runInNewContext(restoreImportedCopiesScript({ libraryPath: '/fixture.library', ids: ['restored', 'removed'] }), { $bodyScope: scope });
  assert.deepEqual(scope.raw, [item]);
  assert.equal(scope.mapped, item);
  assert.equal(scope.bound, true);
  const again = vm.runInNewContext(restoreImportedCopiesScript({ libraryPath: '/fixture.library', ids: ['restored'] }), { $bodyScope: scope });
  assert.equal(again, false, 'a visible item is left alone');
  assert.deepEqual(scope.raw, [item]);
});
