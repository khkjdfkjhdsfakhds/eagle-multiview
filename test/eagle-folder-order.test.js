'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { folderToFrontScript, folderSiblingOrderScript } = require('../lib/eagle-folder-order');

for (const parent of [null, 'parent']) test(`native new-folder ordering preserves siblings (${parent || 'root'})`, () => {
  const siblings = [{ id: 'old-a', children: [{ id: 'child' }] }, { id: 'old-b' }, { id: 'new' }];
  let saved = 0;
  const scope = { libraryPath: '/fixture.library', folders: siblings,
    folderMappings: { parent: { children: siblings } },
    saveFolder: () => saved++, updateSidebarList() {}, calculateImageBinding() {} };
  const script = folderToFrontScript({ libraryPath: scope.libraryPath, parent, id: 'new', siblingIds: siblings.map(f=>f.id) });
  assert.equal(vm.runInNewContext(script, { $bodyScope: scope }), true);
  assert.deepEqual(siblings.map(f=>f.id), ['new','old-a','old-b']);
  assert.equal(siblings[1].children[0].id, 'child');
  assert.equal(saved, 1);
  assert.equal(vm.runInNewContext(script, { $bodyScope: scope }), false, 'stale reorder must not replay');
  scope.libraryPath = '/other.library';
  assert.equal(vm.runInNewContext(script, { $bodyScope: scope }), false);
  assert.equal(saved, 1);
});

test('native order refuses an intervening sibling insertion', () => {
  const siblings = [{id:'old'}, {id:'new'}, {id:'external'}];
  let saved = 0;
  const scope = { libraryPath:'/fixture.library', folders:siblings, saveFolder:()=>saved++, updateSidebarList(){}, calculateImageBinding(){} };
  const result = vm.runInNewContext(folderToFrontScript({libraryPath:scope.libraryPath,id:'new',siblingIds:['old','new']}), {$bodyScope:scope});
  assert.equal(result,false); assert.equal(saved,0);
  assert.deepEqual(siblings.map(f=>f.id),['old','new','external']);
});

test('native copied-folder ordering preserves the source child sequence', () => {
  const siblings = [{ id: 'copy-b' }, { id: 'copy-a' }, { id: 'copy-c' }];
  let saved = 0;
  const scope = { libraryPath: '/fixture.library', folders: [{ id: 'parent', children: siblings }],
    folderMappings: { parent: { children: siblings } }, saveFolder: () => saved++, updateSidebarList() {}, calculateImageBinding() {} };
  const script = folderSiblingOrderScript({ libraryPath: scope.libraryPath, parent: 'parent', ids: ['copy-a', 'copy-b', 'copy-c'] });
  assert.equal(vm.runInNewContext(script, { $bodyScope: scope }), true);
  assert.deepEqual(siblings.map(folder => folder.id), ['copy-a', 'copy-b', 'copy-c']);
  assert.equal(saved, 1);
  assert.equal(vm.runInNewContext(script, { $bodyScope: scope }), true, 'reapplying the confirmed order is harmless');
});
