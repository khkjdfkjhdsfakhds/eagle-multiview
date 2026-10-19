'use strict';

// Restores behind Eagle's 撤销 notices that its HTTP API cannot undo
// (P3-05). Each puts back the very object Eagle's own restore callback
// would, through the same /api/script/inject the sort sync already uses,
// and changes nothing when Eagle's state is not the shape it expects.

// 撤销 of a smart-folder removal. Eagle's notice "“X”已删除。" puts
// the same smart folder back where it was, children included, and saves
// (removeSmartFolder's restore callback). The API has no such call and its
// create makes a new id, so the folder as read just before the removal is put
// back into Eagle's tree the way Eagle's callback does it.

function locateSmartFolder(nodes, id, parentId = null) {
  for (const [index, folder] of (nodes || []).entries()) {
    if (folder?.id === id) return { folder, parentId, index };
    const found = locateSmartFolder(folder?.children, id, folder?.id ?? null);
    if (found) return found;
  }
  return null;
}

function smartFolderRestoreScript({ libraryPath, folder, parentId = null, index = 0 }) {
  const input = JSON.stringify({ libraryPath, folder, parentId, index });
  return `(() => {
    const p = ${input};
    const s = typeof $bodyScope === 'object' ? $bodyScope : null;
    if (!s || s.libraryPath !== p.libraryPath || !Array.isArray(s.smartFolders) || !s.smartFolderMappings) return false;
    if (typeof s.updateSidebarList !== 'function' || typeof s.saveFolderDebounce !== 'function') return false;
    if (s.smartFolderMappings[p.folder.id]) return true;
    const parent = p.parentId ? s.smartFolderMappings[p.parentId] : null;
    if (p.parentId && !parent) return false;
    const siblings = parent ? (parent.children = parent.children || []) : s.smartFolders;
    const restore = (node, parentId) => {
      const copy = { ...node };
      if (parentId) copy.parent = parentId; else delete copy.parent;
      copy.children = (node.children || []).map(child => restore(child, copy.id));
      s.smartFolderMappings[copy.id] = copy;
      return copy;
    };
    const sf = restore(p.folder, p.parentId);
    siblings.splice(Math.max(0, Math.min(p.index, siblings.length)), 0, sf);
    if (typeof s.smartFolderCount === 'function') {
      const count = node => { try { node.imageCount = s.smartFolderCount(node); } catch (error) {} (node.children || []).forEach(count); };
      count(sf);
    }
    s.updateSidebarList();
    s.saveFolderDebounce();
    if (typeof s.$evalAsync === 'function') s.$evalAsync();
    return true;
  })()`;
}

// 撤销 of 标注已删除。: the comment goes back into the item at its old
// place, as Eagle's removeHighlightAnnotation callback does.
function commentRestoreScript({ libraryPath, id, comment, index = 0 }) {
  const input = JSON.stringify({ libraryPath, id, comment, index });
  return `(() => {
    const p = ${input};
    const s = typeof $bodyScope === 'object' ? $bodyScope : null;
    if (!s || s.libraryPath !== p.libraryPath || !s.itemMappings || typeof ayncsImagesChange !== 'function') return false;
    const item = s.itemMappings[p.id];
    if (!item) return false;
    if (!Array.isArray(item.comments)) item.comments = [];
    if (item.comments.some(entry => entry && entry.id === p.comment.id)) return true;
    item.comments.splice(Math.max(0, Math.min(p.index, item.comments.length)), 0, { ...p.comment });
    ayncsImagesChange([item]);
    if (typeof s.$broadcast === 'function') {
      s.$broadcast('REBIND_REFRESH', true);
      if (typeof p.comment.duration === 'number') s.$broadcast('REFRESH_VIDEO_COMMENTS');
    }
    return true;
  })()`;
}

module.exports = { commentRestoreScript, locateSmartFolder, smartFolderRestoreScript };
