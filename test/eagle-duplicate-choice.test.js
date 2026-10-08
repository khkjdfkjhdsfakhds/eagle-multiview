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

// The resident keeper is what resolves duplicates Eagle only reveals after the
// whole upload queue drains. It must answer the copy's own duplicates, leave
// unrelated dialogs alone, survive repeated ticks and stop when asked.
function keeperFixture(queue) {
  const saved = [];
  const scope = { libraryPath: '/fixture.library' };
  const intervals = new Map();
  let nextId = 0;
  const context = () => ({
    $bodyScope: scope,
    document: { querySelector: () => queue.length ? {} : null },
    angular: { element: () => ({ isolateScope: () => ({
      usingExist: 'true', applyAll: 'true',
      get right() { return queue[0] || null; },
      save() { assert.equal(this.usingExist, 'false'); assert.equal(this.applyAll, 'false'); saved.push(this.right.id); queue.shift(); }
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
test('a new copy run stops owning the previous run\u2019s folders', () => {
  const fixture = keeperFixture([{ id: 'later', folders: ['first-copy-folder'] }]);
  vm.runInNewContext(startKeepingCopiesScript({ libraryPath: '/fixture.library', folderIds: ['first-copy-folder'] }), fixture.context());
  vm.runInNewContext(startKeepingCopiesScript({ libraryPath: '/fixture.library', folderIds: ['second-copy-folder'] }), fixture.context());
  fixture.tick();
  assert.deepEqual(fixture.saved, [], 'the finished run must not answer dialogs for its old folders');
  fixture.queue.unshift({ id: 'ours', folders: ['second-copy-folder'] });
  fixture.tick();
  assert.deepEqual(fixture.saved, ['ours']);
});

test('native keep-both chooses only this import and never applies to all duplicates', () => {
  const copies = [{id:'ours'}, {id:'other'}], saved = [];
  const dialog = { duplicates:copies, right:copies[0], usingExist:'true', applyAll:'true',
    save() { assert.equal(this.usingExist,'false'); assert.equal(this.applyAll,'false'); saved.push(this.right.id); this.duplicates.shift(); this.right=this.duplicates[0]; } };
  const timers=[];
  const context = {$bodyScope:{libraryPath:'/fixture.library'},document:{querySelector:()=>({})},angular:{element:()=>({isolateScope:()=>dialog})},setTimeout:fn=>timers.push(fn)};
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
    isDuplicateImage(image) { return image?.name === existing.name ? existing : false; }
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
  const scope = { libraryPath: '/fixture.library', isDuplicateImage: () => 'duplicate' };
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
