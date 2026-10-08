'use strict';

function nativeSyncScript(input) {
  return `(() => {
    const input = ${JSON.stringify(input)};
    const s = typeof $bodyScope === 'object' ? $bodyScope : null;
    if (!s || s.libraryPath !== input.libraryPath) return false;
    const folder = input.folderId ? s.folderMappings[input.folderId] : null;
    if (input.folderId && (!folder || folder.password)) return false;
    if (input.kind === 'pins' || input.kind === 'items') {
      if (!folder) return false;
      const field = input.kind === 'pins' ? 'pinned' : 'order';
      const items = input.entries.map(entry => s.itemMappings[entry.id]);
      if (items.some((item,index) => !item || item.isDeleted || !item.folders?.includes(folder.id)
        || String(item[field]?.[folder.id] ?? '') !== String(input.entries[index].before ?? ''))) return false;
      items.forEach((item,index) => {
        item[field] ||= {};
        const value = input.entries[index].value;
        if (value === null) delete item[field][folder.id]; else item[field][folder.id] = value;
      });
      if (input.kind === 'items') {
        folder.orderBy = 'MANUAL'; folder.sortIncrease = true;
        s.saveFolder();
      }
    } else if (input.kind === 'cover') {
      if (!folder || (folder.coverId || null) !== input.before) return false;
      const item = input.itemId ? s.itemMappings[input.itemId] : null;
      if (input.itemId && (!item || item.isDeleted)) return false;
      if (input.itemId) folder.coverId = input.itemId; else delete folder.coverId;
      s.resetFolderCover(folder); s.saveFolder();
    } else if (input.kind === 'folders') {
      const siblings = folder ? folder.children : s.folders;
      if (!Array.isArray(siblings) || siblings.length !== input.before.length
        || siblings.some((f,index) => f.id !== input.before[index])) return false;
      const nodes = new Map(siblings.map(f => [f.id,f]));
      if (input.ids.length !== siblings.length || new Set(input.ids).size !== siblings.length || input.ids.some(id=>!nodes.has(id))) return false;
      siblings.splice(0,siblings.length,...input.ids.map(id=>nodes.get(id)));
      s.updateSidebarList(); s.saveFolder();
    } else return false;
    s.calculateImageBinding({ ignoreSort: true });
    s.rebindRefresh?.(); s.$evalAsync?.();
    return true;
  })()`;
}

// Eagle keeps folder sort mode, folder icon colour and the folder cover on the
// native folder object, and keeps per-folder pin/order maps on each item. Its
// HTTP API can write only some of those fields, so a faithful folder copy has
// to project them onto the copied folders and copied items in Eagle's own
// scope. Every key rewrite is explicit: pin/order maps are keyed by folder id,
// so copying them verbatim would attach the copy's pins to the source folder.
function cloneNativeStateScript({ libraryPath, folders = [], items = [] }) {
  const input = JSON.stringify({ libraryPath, folders, items });
  return `(() => {
    const input = ${input};
    const scope = typeof $bodyScope === 'object' ? $bodyScope : null;
    if (!scope || scope.libraryPath !== input.libraryPath) return false;
    if (!scope.folderMappings || !scope.itemMappings || typeof scope.saveFolder !== 'function') return false;
    for (const entry of input.folders) {
      const source = scope.folderMappings[entry.sourceId];
      const target = scope.folderMappings[entry.targetId];
      if (!source || !target) return false;
      if (source.orderBy) {
        target.orderBy = source.orderBy;
        target.sortIncrease = source.sortIncrease === true;
      }
      else {
        delete target.orderBy;
        delete target.sortIncrease;
      }
      if (source.iconColor) target.iconColor = source.iconColor; else delete target.iconColor;
      const cover = entry.coverItemId || null;
      if ((target.coverId || null) !== cover) {
        if (cover) target.coverId = cover; else delete target.coverId;
        if (typeof scope.resetFolderCover === 'function') scope.resetFolderCover(target);
      }
    }
    for (const entry of input.items) {
      const source = scope.itemMappings[entry.sourceId];
      const target = scope.itemMappings[entry.targetId];
      if (!source || !target) return false;
      const map = entry.map || {};
      for (const field of ['pinned', 'order']) {
        const sourceMap = source[field];
        const projected = {};
        if (sourceMap && typeof sourceMap === 'object') {
          for (const fromId of Object.keys(map)) {
            const value = sourceMap[fromId];
            if (value !== undefined && value !== null) projected[map[fromId]] = value;
          }
        }
        if (Object.keys(projected).length) target[field] = projected; else delete target[field];
      }
    }
    scope.updateSidebarList?.();
    scope.calculateImageBinding?.({ ignoreSort: true });
    scope.rebindRefresh?.(); scope.$evalAsync?.();
    scope.saveFolder();
    return true;
  })()`;
}

function projectSourceItemNativeState(item, map = {}) {
  const project = field => {
    const values = item?.[field];
    const projected = {};
    if (values && typeof values === 'object') {
      for (const [fromId, toId] of Object.entries(map)) {
        const value = values[fromId];
        if (value !== undefined && value !== null) projected[toId] = value;
      }
    }
    return projected;
  };
  return { pinned: project('pinned'), order: project('order') };
}

function projectTargetItemNativeState(item, map = {}) {
  const project = field => {
    const values = item?.[field];
    const projected = {};
    if (values && typeof values === 'object') {
      for (const toId of Object.values(map)) {
        const value = values[toId];
        if (value !== undefined && value !== null) projected[toId] = value;
      }
    }
    return projected;
  };
  return { pinned: project('pinned'), order: project('order') };
}

function itemNativeStateMatches(sourceItem, targetItem, map = {}) {
  return JSON.stringify(projectSourceItemNativeState(sourceItem, map))
    === JSON.stringify(projectTargetItemNativeState(targetItem, map));
}

function folderNativeStateMatches(sourceFolder, targetFolder, { coverItemId = null } = {}) {
  const expectedOrderBy = sourceFolder?.orderBy || null;
  const actualOrderBy = targetFolder?.orderBy || null;
  if (expectedOrderBy !== actualOrderBy) return false;
  if (expectedOrderBy && (sourceFolder.sortIncrease === true) !== (targetFolder?.sortIncrease === true)) return false;
  return String(coverItemId || '') === String(targetFolder?.coverId || '');
}

// Eagle exposes a folder cover twice: an explicit `coverId` written by its own
// "set as cover" action, and a cached `covers` markup that also carries the
// image Eagle derived as the default cover. A faithful copy has to show the
// same image whichever of the two the source currently uses.
function folderCoverItemId(folder) {
  if (folder?.coverId) return folder.coverId;
  for (const markup of folder?.covers || []) {
    if (typeof markup !== 'string') continue;
    const match = markup.match(/\/images\/([^/]+)\.info\//);
    if (match) {
      try { return decodeURIComponent(match[1]); } catch { return match[1]; }
    }
  }
  return null;
}

// Eagle derives a folder's default cover from the first image of that folder in
// its own raw item order and caches the result as markup on the folder object.
// An import prepends the new files with fresh timestamps, so the binding pass
// Eagle runs while a copy is still being patched derives the copies' covers from
// the import order. Re-running the sorted binding once every copied item carries
// its source metadata is what makes a copied folder show the same cover image as
// its source. The binding is debounced inside Eagle and only reaches disk through
// saveFolder, so callers wait briefly before reading covers back.
function refreshFolderCoversScript({ libraryPath }) {
  return `(() => {
    const scope = typeof $bodyScope === 'object' ? $bodyScope : null;
    if (!scope || scope.libraryPath !== ${JSON.stringify(libraryPath)}) return false;
    if (typeof scope.calculateImageBinding !== 'function'
      || typeof scope.saveFolder !== 'function') return false;
    scope.calculateImageBinding({ ignoreSort: false }, () => {
      scope.rebindRefresh?.();
      scope.$evalAsync?.();
      scope.saveFolder();
    });
    return true;
  })()`;
}

async function executeNativeSync({ client, ensureLibraryPath, input, verify, persistIds = [] }) {
  await ensureLibraryPath(input.libraryPath);
  await client.request('/api/script/inject', { method:'POST', body:{script:nativeSyncScript(input)} });
  let matched = false;
  for (let attempt=0;attempt<15;attempt++) {
    await ensureLibraryPath(input.libraryPath);
    if (await verify()) {matched=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if (!matched) throw new Error('Eagle 状态已变化或未确认同步，请刷新后重试');
  // The normal item-save API persists the current native object without
  // replacing names, tags, memberships or other folders' pin/order fields.
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,persistIds.length)},async()=>{
    while(cursor<persistIds.length) {
      const id=persistIds[cursor++];
      await ensureLibraryPath(input.libraryPath);
      await client.updateItem(id,{});
    }
  }));
  await ensureLibraryPath(input.libraryPath);
  if (!await verify()) throw new Error('同步期间 Eagle 状态再次变化，请刷新后核对');
}

function moveRelative(ids, selectedIds, anchorId, position) {
  const selected=new Set(selectedIds);
  if (!selected.size || selected.has(anchorId) || !ids.includes(anchorId) || [...selected].some(id=>!ids.includes(id))) throw new Error('排序目标已失效，请刷新后重试');
  const block=ids.filter(id=>selected.has(id)), rest=ids.filter(id=>!selected.has(id));
  const at=rest.indexOf(anchorId)+(position==='after'?1:0);
  return [...rest.slice(0,at),...block,...rest.slice(at)];
}

module.exports={nativeSyncScript,cloneNativeStateScript,refreshFolderCoversScript,folderCoverItemId,projectSourceItemNativeState,projectTargetItemNativeState,itemNativeStateMatches,folderNativeStateMatches,executeNativeSync,moveRelative};
