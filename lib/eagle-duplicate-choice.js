'use strict';

// Resolve only IDs from this accepted import using Eagle's own duplicate
// dialog action. Never apply an all-files choice to unrelated native imports.
function keepImportedCopiesScript({ libraryPath, ids }) {
  return `(() => {
    const input = ${JSON.stringify({ libraryPath, ids })};
    const allowed = new Set(input.ids);
    let attempts = 0;
    const resolve = () => {
      if (++attempts > 100 || typeof $bodyScope !== 'object' || $bodyScope.libraryPath !== input.libraryPath) return;
      const element = document.querySelector('duplicate-modal');
      const dialog = element && typeof angular === 'object' ? angular.element(element).isolateScope() : null;
      if (dialog && typeof dialog.save === 'function') {
        while (dialog.right && allowed.has(dialog.right.id)) {
          const id = dialog.right.id;
          const usingExist = dialog.usingExist, applyAll = dialog.applyAll;
          dialog.usingExist = 'false'; dialog.applyAll = 'false';
          try { dialog.save(); } finally { dialog.usingExist = usingExist; dialog.applyAll = applyAll; }
          allowed.delete(id);
        }
      }
      if (allowed.size) setTimeout(resolve, 100);
    };
    resolve();
  })()`;
}

// Eagle opens its duplicate dialog only after the whole upload queue drains, so
// a single short polling window is not enough for a large folder copy: late
// duplicates stay unanswered and their imported files exist on disk without
// ever entering Eagle's visible list. The keeper stays resident for the whole
// copy run and answers every duplicate whose target folder is one of the
// folders this copy just created, plus any id the caller explicitly registered.
function startKeepingCopiesScript({ libraryPath, folderIds = [], ids = [], ttlMs = 600000 }) {
  const input = JSON.stringify({ libraryPath, folderIds, ids, ttlMs });
  return `(() => {
    const input = ${input};
    const scope = typeof $bodyScope === 'object' ? $bodyScope : null;
    if (!scope || scope.libraryPath !== input.libraryPath) return false;
    const state = scope.__eaglemvCopyKeeper = scope.__eaglemvCopyKeeper || {};
    // Each copy run owns exactly its own folders; a finished run must never
    // leave later dialogs (including the user's own imports into an older copy)
    // answered without asking.
    state.folders = {};
    state.ids = {};
    if (typeof state.handled !== 'number') state.handled = 0;
    for (const id of input.folderIds) state.folders[id] = true;
    for (const id of input.ids) state.ids[id] = true;
    state.deadline = Date.now() + input.ttlMs;
    const owns = right => state.ids[right.id] === true
      || (Array.isArray(right.folders) && right.folders.some(id => state.folders[id] === true));
    const tick = () => {
      if (Date.now() > state.deadline) { clearInterval(state.timer); state.timer = null; return; }
      const element = document.querySelector('duplicate-modal');
      const dialog = element && typeof angular === 'object' ? angular.element(element).isolateScope() : null;
      if (!dialog || typeof dialog.save !== 'function' || !dialog.right || !owns(dialog.right)) return;
      state.handled++;
      const usingExist = dialog.usingExist, applyAll = dialog.applyAll;
      dialog.usingExist = 'false'; dialog.applyAll = 'false';
      try { dialog.save(); } finally { dialog.usingExist = usingExist; dialog.applyAll = applyAll; }
    };
    if (!state.timer) state.timer = setInterval(tick, 50);
    return true;
  })()`;
}

function stopKeepingCopiesScript({ libraryPath }) {
  return `(() => {
    const scope = typeof $bodyScope === 'object' ? $bodyScope : null;
    if (!scope || scope.libraryPath !== ${JSON.stringify(libraryPath)}) return false;
    const state = scope.__eaglemvCopyKeeper;
    if (state && state.timer) { clearInterval(state.timer); state.timer = null; }
    return true;
  })()`;
}

// Eagle queues a duplicate instead of adding it, and only asks the user once
// the whole upload queue drains. A copy must not depend on that timing: while
// the copy runs, imports aimed at the folders it just created are treated as
// new files, which is exactly the "keep both" outcome the user picked. The
// patch is in-memory only, limited to those folders and self-expiring.
function startCopyImportModeScript({ libraryPath, folderIds = [], ttlMs = 900000 }) {
  const input = JSON.stringify({ libraryPath, folderIds, ttlMs });
  return `(() => {
    const input = ${input};
    const scope = typeof $bodyScope === 'object' ? $bodyScope : null;
    if (!scope || scope.libraryPath !== input.libraryPath) return false;
    if (typeof scope.isDuplicateImage !== 'function') return false;
    const state = scope.__eaglemvCopyImportMode = scope.__eaglemvCopyImportMode
      || { folders:{}, original:scope.isDuplicateImage, patched:false };
    if (!state.folders) state.folders = {};
    for (const id of input.folderIds) state.folders[id] = true;
    state.deadline = Date.now() + input.ttlMs;
    if (state.patched) return true;
    const original = state.original;
    scope.isDuplicateImage = function (image) {
      if (Date.now() > state.deadline) return original.apply(this, arguments);
      const folders = Array.isArray(image?.folders) ? image.folders : [];
      if (folders.some(id => state.folders[id] === true)) return false;
      return original.apply(this, arguments);
    };
    state.patched = true;
    return true;
  })()`;
}

function stopCopyImportModeScript({ libraryPath }) {
  return `(() => {
    const scope = typeof $bodyScope === 'object' ? $bodyScope : null;
    if (!scope || scope.libraryPath !== ${JSON.stringify(libraryPath)}) return false;
    const state = scope.__eaglemvCopyImportMode;
    if (!state) return true;
    if (state.patched && typeof state.original === 'function') scope.isDuplicateImage = state.original;
    state.patched = false;
    delete scope.__eaglemvCopyImportMode;
    return true;
  })()`;
}

// Last resort for an import Eagle accepted but never added to its visible list
// because its duplicate decision never landed: the item already exists with the
// right file and folders, so restoring it is exactly what "keep both" does.
function restoreImportedCopiesScript({ libraryPath, ids = [] }) {
  const input = JSON.stringify({ libraryPath, ids });
  return `(() => {
    const input = ${input};
    const scope = typeof $bodyScope === 'object' ? $bodyScope : null;
    if (!scope || scope.libraryPath !== input.libraryPath) return false;
    if (!Array.isArray(scope.raw) || !scope.itemMappings) return false;
    let restored = 0;
    for (const id of input.ids) {
      const item = scope.itemMappings[id];
      if (!item || item.isDeleted) continue;
      if (scope.raw.indexOf(item) === -1) { scope.raw.unshift(item); restored += 1; }
      if (typeof scope.addToDuplicateMapping === 'function') scope.addToDuplicateMapping(item);
    }
    if (!restored) return false;
    scope.calculateImageBinding?.({ ignoreSort: true });
    scope.rebindRefresh?.(true);
    scope.$evalAsync?.();
    return true;
  })()`;
}

module.exports = {
  keepImportedCopiesScript,
  startKeepingCopiesScript,
  stopKeepingCopiesScript,
  startCopyImportModeScript,
  stopCopyImportModeScript,
  restoreImportedCopiesScript
};
