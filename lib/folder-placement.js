'use strict';

// Run inside Eagle through its HTTP script endpoint; Eagle owns persistence.
function folderPlacementScript(input) {
  return `(() => {
    const p = ${JSON.stringify(input)};
    const s = typeof $bodyScope === 'object' ? $bodyScope : null;
    if (!s || s.libraryPath !== p.libraryPath || typeof s.saveFolder !== 'function'
      || typeof s.updateSidebarList !== 'function' || typeof s.calculateImageBinding !== 'function') return false;
    const locate = (nodes, id, parent = null) => {
      for (const folder of nodes || []) {
        if (folder.id === id) return {folder, nodes, parent};
        const found = locate(folder.children, id, folder.id);
        if (found) return found;
      }
    };
    const source = locate(s.folders, p.id);
    const parent = p.parentId === null ? null : locate(s.folders, p.parentId)?.folder;
    const target = p.parentId === null ? s.folders : parent?.children;
    if (!source || source.parent !== p.baseParentId || !Array.isArray(target)
      || p.parentId === p.id || locate(source.folder.children, p.parentId)) return false;
    if (JSON.stringify(target.map(f => f.id)) !== JSON.stringify(p.baseSiblingIds)
      || p.anchorId === p.id || !target.some(f => f.id === p.anchorId)) return false;
    const byId = new Map(target.map(folder => [folder.id, folder]));
    byId.set(source.folder.id, source.folder);
    const ids = p.targetSiblingIds.filter(folderId => folderId !== p.id);
    ids.splice(ids.indexOf(p.anchorId) + (p.position === 'after' ? 1 : 0), 0, p.id);
    const desired = ids.map(folderId => byId.get(folderId));
    if (desired.length !== target.length + (source.nodes === target ? 0 : 1) || desired.some(folder => !folder)) return false;
    source.nodes.splice(source.nodes.indexOf(source.folder), 1);
    target.splice(0, target.length, ...desired);
    source.folder.parent = p.parentId;
    s.updateSidebarList();
    s.calculateImageBinding({ignoreSort: true});
    s.saveFolder();
    s.$evalAsync?.();
    return true;
  })()`;
}

module.exports = { folderPlacementScript };
