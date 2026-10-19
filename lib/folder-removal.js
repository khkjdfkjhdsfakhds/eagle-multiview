'use strict';

// Eagle's HTTP API has no folder delete. Eagle's own entry point,
// $bodyScope.removeFolder(folder, params), does exactly what its menus do:
// the folder and its subfolders go, items only in that subtree go to the
// trash when isDeleteImages is set, items also in other folders just lose
// the membership, and Eagle saves the tree and the items itself.
//
// Before it acts it asks with its own sweetalert prompts: "删除文件夹" with
// the "把文件夹内项目丢到回收站" checkbox (only when the folder has items or
// subfolders), then "批量操作确认" when 50+ items are affected. MultiView has
// already asked the user the same questions, so while this runs, those two
// prompts are answered with the user's choice; any other prompt is left to
// Eagle. The script refuses unless removeFolder still has Eagle 4.0's shape.
const REMOVE_SHAPE_CHECK = `const removeHasShape = fn => {
      if (typeof fn !== 'function') return false;
      let source = '';
      try { source = Function.prototype.toString.call(fn).replace(/\\s+/g, ''); } catch { return false; }
      return source.includes("dialog.removeFolder.desc") && source.includes("input:'checkbox'")
        && source.includes('checkOperationSafety2(folder.descendantImageCount')
        && source.includes('params.isDeleteImages=(result==1)') && source.includes('removeFolder(folder,params)');
    };`;

// Eagle's removeFolder ends with its notice "“X”已删除。" and that notice's
// 撤销 ($rootScope.undo, alive 7 s + 5 s). `token` keeps that restore aside
// so MultiView's own 撤销 can run Eagle's (P3-05).
function folderRemovalScript({ id, libraryPath, isDeleteImages = true, token = null }) {
  const input = JSON.stringify({ id, libraryPath, isDeleteImages: Boolean(isDeleteImages), token });
  return `(() => {
    const p = ${input};
    ${REMOVE_SHAPE_CHECK}
    const s = typeof $bodyScope === 'object' ? $bodyScope : null;
    if (!s || s.libraryPath !== p.libraryPath || !s.folderMappings || !removeHasShape(s.removeFolder)) return false;
    if (typeof window.swal !== 'function') return false;
    const folder = s.folderMappings[p.id];
    if (!folder || (folder.password && !folder.isUnLock)) return false;
    // Eagle moves its own view off a deleted current folder; otherwise it
    // stays where it is, as when a subfolder card is deleted.
    let showing = false;
    for (let f = s.currentFolder, guard = 0; f && guard < 1000; f = s.folderMappings[f.parent], guard++) {
      if (f.id === p.id) { showing = true; break; }
    }
    const original = window.swal;
    let askedRemove = false, askedBulk = false, restored = false;
    const stub = function (options) {
      const prompt = options && typeof options === 'object' && options.customClass === 'alert-box';
      if (prompt && !askedRemove && options.input === 'checkbox') {
        askedRemove = true;
        return Promise.resolve(p.isDeleteImages ? 1 : 0);
      }
      if (prompt && !askedBulk && !options.input && options.allowEnterKey === false) {
        askedBulk = true;
        return Promise.resolve(true);
      }
      return original.apply(this, arguments);
    };
    Object.keys(original).forEach(key => { stub[key] = original[key]; });
    const restore = () => {
      if (restored) return;
      restored = true;
      if (window.swal === stub) window.swal = original;
    };
    window.swal = stub;
    const root = s.$root || null;
    const undoBefore = root ? root.undo : undefined;
    const started = Date.now();
    let goneAt = 0;
    const watch = setInterval(() => {
      const now = Date.now();
      if (!s.folderMappings[p.id]) {
        restore();
        goneAt ||= now;
        // The notice sets its restore 10 ms after the folder is gone.
        if (p.token && root && typeof root.undo === 'function' && root.undo !== undoBefore) {
          window.__eaglemvFolderUndo = { token: p.token, undo: root.undo };
          clearInterval(watch);
        } else if (!p.token || now - goneAt > 1500) clearInterval(watch);
      } else if (now - started > 4000) { clearInterval(watch); restore(); }
    }, 50);
    try {
      s.removeFolder(folder, showing ? {} : { ignoreSelectNext: true });
      s.$evalAsync?.();
    } catch (error) {
      clearInterval(watch);
      restore();
      throw error;
    }
    return true;
  })()`;
}

// MultiView's 撤销: runs the restore Eagle's notice holds, as its own 撤销
// link does, only while that restore is still Eagle's current one.
function folderRemovalUndoScript({ token, libraryPath }) {
  const input = JSON.stringify({ token, libraryPath });
  return `(() => {
    const p = ${input};
    const s = typeof $bodyScope === 'object' ? $bodyScope : null;
    const root = s && s.$root;
    const saved = window.__eaglemvFolderUndo;
    if (!s || s.libraryPath !== p.libraryPath || !root || !saved || saved.token !== p.token) return false;
    if (root.undo !== saved.undo) return false;
    window.__eaglemvFolderUndo = null;
    root.undo();
    try { if (typeof root.closeAll === 'function') root.closeAll(); } catch (error) {}
    if (typeof s.$evalAsync === 'function') s.$evalAsync();
    return true;
  })()`;
}

module.exports = { folderRemovalScript, folderRemovalUndoScript };
