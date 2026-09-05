'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { loadMain } = require('../test-support/main-data-harness.cjs');
const { pairImportedIdsWithFolders } = require('../lib/duplicate-service');

test('incomplete or repeated duplicate IDs do not guess source folder identities', () => {
  const source = [{ item:{ folders:['A'] } }, { item:{ folders:['B'] } }];
  assert.deepEqual(pairImportedIdsWithFolders(['copy-b'], source), []);
  assert.deepEqual(pairImportedIdsWithFolders(['same','same'], source), []);
  assert.deepEqual(pairImportedIdsWithFolders(['copy-a','copy-b'], source), [{ id:'copy-a',folders:['A'] },{ id:'copy-b',folders:['B'] }]);
});

async function setup(t, count = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eaglemv-duplicate-remediation-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const userData = path.join(root,'user-data'); await fs.mkdir(userData);
  const main = loadMain(userData), libraryPath = path.join(root,'synthetic-library');
  const paths = await Promise.all(Array.from({length:count}, async (_, index) => { const file = path.join(root, `${index}.txt`); await fs.writeFile(file,'fixture'); return file; }));
  main.hub.library = {path:libraryPath,folders:[]};
  main.client.libraryInfo = async () => main.hub.library;
  main.client.getItem = async id => ({id,folders:[id==='source-0'?'A':'B']});
  main.client.fileURLForItem = async item => pathToFileURL(paths[Number(item.id.split('-')[1]) || 0]).toString();
  main.client.addItems = async () => Array.from({length:count},(_, index)=>`copy-${index}`);
  main.client.getItems = async ids => ids.map(id=>({id}));
  return {main,userData,libraryPath,payload:{ids:paths.map((_,index)=>`source-${index}`),libraryPath}};
}

test('accepted duplicate IDs survive a local supplemental registration write failure', async t => {
  const {main,userData,payload} = await setup(t);
  await main.getSupplementalItemStore().get(payload.libraryPath);
  await fs.writeFile(path.join(userData,'state'),'disk obstacle');
  const result = await main.rpcRegistry.get('items:duplicate')({sender:{id:1}},payload);
  assert.equal(result.count,1);
  assert.deepEqual([...result.ids],['copy-0']);
  assert.equal(result.partial,true);
  assert.ok(result.rejected.some(entry=>entry.code==='DUPLICATE_REGISTRATION'));
});

test('partial duplicate identity response reports skipped folder preservation without writes', async t => {
  const {main,payload} = await setup(t,2), writes=[];
  main.client.addItems = async () => ['copy-1'];
  main.client.updateItem = async (id,patch) => { writes.push({id,patch}); return {id,...patch}; };
  const result = await main.rpcRegistry.get('items:duplicate')({sender:{id:1}},{...payload,preserveFolders:true});
  assert.equal(result.count,2);
  assert.equal(writes.length,0);
  assert.equal(result.partial,true);
  assert.equal(result.folderAssignmentFailed,2);
  assert.ok(result.rejected.some(entry=>entry.code==='DUPLICATE_IDENTITY_UNCERTAIN'));
});
