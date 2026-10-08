'use strict';

// Submitted through Eagle's script API. Eagle itself owns persistence; never
// read or write its library files here. Reject a changed library or sibling list.
function folderToFrontScript({ libraryPath, parent = null, id, siblingIds }) {
  const input = JSON.stringify({ libraryPath, parent, id, siblingIds });
  return `(() => {
    const input = ${input};
    const scope = typeof $bodyScope === 'object' ? $bodyScope : null;
    if (!scope || scope.libraryPath !== input.libraryPath
      || typeof scope.saveFolder !== 'function' || typeof scope.updateSidebarList !== 'function'
      || typeof scope.calculateImageBinding !== 'function') return false;
    const siblings = input.parent ? scope.folderMappings[input.parent]?.children : scope.folders;
    if (!Array.isArray(siblings) || siblings.length !== input.siblingIds.length
      || siblings.some((folder, index) => folder.id !== input.siblingIds[index])) return false;
    const index = siblings.findIndex(folder => folder.id === input.id);
    if (index < 0) return false;
    if (index > 0) siblings.unshift(siblings.splice(index, 1)[0]);
    scope.updateSidebarList();
    scope.calculateImageBinding({ ignoreSort: true });
    scope.saveFolder();
    scope.$evalAsync?.();
    return true;
  })()`;
}

function folderSiblingOrderScript({ libraryPath, parent = null, ids }) {
  const input = JSON.stringify({ libraryPath, parent, ids });
  return `(() => {
    const input = ${input};
    const scope = typeof $bodyScope === 'object' ? $bodyScope : null;
    if (!scope || scope.libraryPath !== input.libraryPath || typeof scope.saveFolder !== 'function'
      || typeof scope.updateSidebarList !== 'function' || typeof scope.calculateImageBinding !== 'function') return false;
    const siblings = input.parent ? scope.folderMappings[input.parent]?.children : scope.folders;
    if (!Array.isArray(siblings) || siblings.length !== input.ids.length
      || new Set(input.ids).size !== input.ids.length || siblings.some(folder => !input.ids.includes(folder.id))) return false;
    const byId = new Map(siblings.map(folder => [folder.id, folder]));
    siblings.splice(0, siblings.length, ...input.ids.map(id => byId.get(id)));
    scope.updateSidebarList();
    scope.calculateImageBinding({ ignoreSort: true });
    scope.saveFolder();
    scope.$evalAsync?.();
    return true;
  })()`;
}

async function setFolderSiblingOrder({ client, ensureLibraryPath, libraryPath, parent = null, ids }) {
  if (!Array.isArray(ids) || ids.length < 2) return true;
  await ensureLibraryPath(libraryPath);
  await client.request('/api/script/inject', { method: 'POST', body: {
    script: folderSiblingOrderScript({ libraryPath, parent, ids })
  } });
  const find = nodes => nodes.flatMap(folder => [folder, ...find(folder.children || [])]);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await ensureLibraryPath(libraryPath);
    const tree = await client.folderTree();
    const siblings = parent === null ? tree : find(tree).find(folder => folder.id === parent)?.children;
    if (JSON.stringify((siblings || []).map(folder => folder.id)) === JSON.stringify(ids)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function moveCreatedFolderToFront({ client, ensureLibraryPath, libraryPath, parent, id, siblings }) {
  if (!id) return false;
  if (siblings[0]?.id === id) return true;
  await ensureLibraryPath(libraryPath);
  await client.request('/api/script/inject', { method: 'POST', body: {
    script: folderToFrontScript({ libraryPath, parent, id, siblingIds: siblings.map(folder => folder.id) })
  } });
  // The script endpoint acknowledges dispatch, not completion. Verify by API.
  for (let attempt = 0; attempt < 12; attempt++) {
    await ensureLibraryPath(libraryPath);
    const tree = await client.folderTree();
    const find = nodes => nodes.flatMap(folder => [folder, ...find(folder.children || [])]);
    const current = parent ? find(tree).find(folder => folder.id === parent)?.children : tree;
    if (current?.[0]?.id === id) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

module.exports = { folderToFrontScript, folderSiblingOrderScript, moveCreatedFolderToFront, setFolderSiblingOrder };
