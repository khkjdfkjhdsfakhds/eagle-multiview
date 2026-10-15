'use strict';

// Folder colour and description go through /api/v2/folder/update, whose
// handler (Eagle's `folder.save`) treats a missing iconColor as "clear" and a
// parent different from the stored one as "move". The fake below follows that
// handler, so a write that forgets either field shows up as a lost colour or a
// folder that jumped to the root.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DataHub } = require('../lib/data-hub');

function findWithParent(nodes, id, parent = undefined) {
  for (const folder of nodes) {
    if (folder.id === id) return { folder, parent, siblings: nodes };
    const found = findWithParent(folder.children || [], id, folder.id);
    if (found) return found;
  }
  return null;
}

class EagleFolderClient {
  constructor(folders) {
    this.folders = structuredClone(folders);
    this.bodies = [];
  }
  async libraryInfo() { return { path: '/library', modificationTime: 1 }; }
  async folderTree() { return structuredClone(this.folders); }
  async updateFolderProperties(id, patch) {
    const data = { id, ...structuredClone(patch) };
    this.bodies.push(data);
    const location = findWithParent(this.folders, id);
    if (!location) return undefined;
    const { folder } = location;
    folder.description = data.description ?? folder.description;
    if (data.iconColor !== folder.iconColor) folder.iconColor = data.iconColor;
    if (data.parent !== location.parent) {
      // Eagle re-parents (or, for null, moves to the end of the root list).
      location.siblings.splice(location.siblings.indexOf(folder), 1);
      const target = data.parent == null ? this.folders : findWithParent(this.folders, data.parent).folder.children;
      target.push(folder);
    }
    if (folder.iconColor === undefined) delete folder.iconColor;
    return structuredClone(folder);
  }
}

function setup(folders) {
  const client = new EagleFolderClient(folders);
  const hub = new DataHub(client);
  hub.library = { path: '/library', folders: structuredClone(folders) };
  const changes = [];
  hub.on('library-changed', payload => changes.push(payload));
  return { client, hub, changes };
}

const tree = () => [
  { id: 'R1', name: '根一', description: '', iconColor: 'blue', children: [
    { id: 'C', name: '子', description: '旧描述', iconColor: 'red', children: [] }
  ] },
  { id: 'R2', name: '根二', description: '', children: [] }
];

test('colouring a subfolder keeps it under its parent and publishes the colour', async () => {
  const { client, hub, changes } = setup(tree());
  const result = await hub.updateFolderProperties({ id: 'C', patch: { iconColor: 'green' }, base: { iconColor: 'red' }, libraryPath: '/library', origin: 7 });
  assert.equal(result.ok, true);
  assert.deepEqual(client.bodies, [{ id: 'C', iconColor: 'green', parent: 'R1' }]);
  assert.equal(client.folders[0].children[0].id, 'C');
  assert.equal(client.folders[0].children[0].iconColor, 'green');
  assert.equal(client.folders[0].children[0].description, '旧描述');
  assert.equal(changes.at(-1).library.folders[0].children[0].iconColor, 'green');
  assert.equal(changes.at(-1).origin, 7);
});

test('colouring a root folder sends no parent, so it keeps its place in the root list', async () => {
  const { client, hub } = setup(tree());
  await hub.updateFolderProperties({ id: 'R1', patch: { iconColor: 'pink' }, base: { iconColor: 'blue' }, libraryPath: '/library' });
  assert.deepEqual(client.bodies, [{ id: 'R1', iconColor: 'pink' }]);
  assert.deepEqual(client.folders.map(folder => folder.id), ['R1', 'R2']);
});

test('editing the description resends the current colour so it is not cleared', async () => {
  const { client, hub, changes } = setup(tree());
  await hub.updateFolderProperties({ id: 'C', patch: { description: '新描述' }, base: { description: '旧描述' }, libraryPath: '/library' });
  assert.deepEqual(client.bodies, [{ id: 'C', iconColor: 'red', description: '新描述', parent: 'R1' }]);
  assert.equal(client.folders[0].children[0].iconColor, 'red');
  assert.equal(changes.at(-1).library.folders[0].children[0].description, '新描述');
});

test('“无” clears the colour by leaving iconColor out, as Eagle itself does', async () => {
  const { client, hub, changes } = setup(tree());
  await hub.updateFolderProperties({ id: 'C', patch: { iconColor: '' }, base: { iconColor: 'red' }, libraryPath: '/library' });
  assert.deepEqual(client.bodies, [{ id: 'C', parent: 'R1' }]);
  assert.equal('iconColor' in client.folders[0].children[0], false);
  assert.equal(changes.at(-1).library.folders[0].children[0].iconColor || '', '');
});

test('a description changed elsewhere is a conflict until forced', async () => {
  const { client, hub } = setup(tree());
  const conflict = await hub.updateFolderProperties({ id: 'C', patch: { description: '我的' }, base: { description: '更早的' }, libraryPath: '/library' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  assert.deepEqual(conflict.conflicts, [{ field: 'description', base: '更早的', current: '旧描述', next: '我的' }]);
  assert.equal(client.bodies.length, 0);
  const forced = await hub.updateFolderProperties({ id: 'C', patch: { description: '我的' }, base: { description: '更早的' }, force: true, libraryPath: '/library' });
  assert.equal(forced.ok, true);
  assert.equal(client.folders[0].children[0].description, '我的');
});

test('a missing colour and an empty one are the same base', async () => {
  const { hub } = setup(tree());
  const result = await hub.updateFolderProperties({ id: 'R2', patch: { iconColor: 'aqua' }, base: { iconColor: '' }, libraryPath: '/library' });
  assert.equal(result.ok, true);
});

test('rejects colours Eagle does not offer and unknown fields', async () => {
  const { client, hub } = setup(tree());
  await assert.rejects(hub.updateFolderProperties({ id: 'C', patch: { iconColor: '#ff0000' }, base: {}, libraryPath: '/library' }), /颜色/);
  await assert.rejects(hub.updateFolderProperties({ id: 'C', patch: { name: 'x' }, base: {}, libraryPath: '/library' }), /不支持/);
  await assert.rejects(hub.updateFolderProperties({ id: 'C', patch: { description: 'x'.repeat(10001) }, base: {}, libraryPath: '/library' }), /描述/);
  await assert.rejects(hub.updateFolderProperties({ id: 'gone', patch: { iconColor: 'red' }, base: {}, libraryPath: '/library' }), /不存在/);
  assert.equal(client.bodies.length, 0);
});
