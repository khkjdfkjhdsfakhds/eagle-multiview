'use strict';
window.createSelectedFeatureUI = function ({ api, context, refresh, notify, canStart, cloneSortMemory = () => {} }) {
  let activeDialog = null;
  let moving = false;
  function element(tag, text, attrs = {}) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }
  function dialog(title) {
    if (activeDialog) return null;
    const previousFocus = document.activeElement;
    const node = element('dialog', '', { class: 'feature-dialog', 'aria-label': title });
    node.append(element('h2', title));
    const status = element('p', '', { role: 'status', class: 'feature-status' });
    const body = element('div', '', { class: 'feature-body' });
    const footer = element('div', '', { class: 'feature-footer' });
    const cancel = element('button', '取消', { type: 'button', 'data-feature-cancel': '' });
    footer.append(cancel); node.append(body, status, footer);
    document.body.append(node); activeDialog = node;
    let onCancel = () => {}, locked = false;
    const close = () => { if (!node.open) return; node.close(); node.remove(); activeDialog = null; previousFocus?.focus?.(); };
    cancel.onclick = () => { if (!locked) { onCancel(); close(); } };
    node.addEventListener('cancel', event => { event.preventDefault(); if (!locked) { onCancel(); close(); } });
    node.showModal();
    return { node, body, footer, cancel, status, close, setCancel: fn => { onCancel = fn; },
      lock: value => { locked = value; cancel.disabled = value; } };
  }
  function walk(folders, parent = null, path = [], out = []) {
    for (const folder of folders || []) {
      out.push({ folder, parent, path: [...path, folder.name].join(' / ') });
      walk(folder.children, folder.id, [...path, folder.name], out);
    }
    return out;
  }
  async function moveFolder(id, target = undefined, frozen = null) {
    if (!api.moveFolder || !canStart() || moving || activeDialog) return;
    const ctx = { ...(frozen || context()) };
    const entries = walk(ctx.folders);
    const source = entries.find(entry => entry.folder.id === id);
    if (!source) return;
    if (target !== undefined && target !== null && !entries.some(entry => entry.folder.id === target)) {
      notify('目标文件夹已不存在，请刷新后重新选择。'); return;
    }
    if (frozen?.sourceId === id && Object.hasOwn(frozen, 'sourceParentId')) source.parent = frozen.sourceParentId;
    const excluded = new Set(walk([source.folder]).map(entry => entry.folder.id));
    if (target !== undefined && ((!frozen?.placement && target === source.parent) || excluded.has(target))) return;
    const executeMove = async parentId => {
      if (context().libraryPath !== ctx.libraryPath) throw new Error('资源库已切换，请重新选择。');
      const result = await api.moveFolder({ id, parentId, baseParentId: source.parent, libraryPath: ctx.libraryPath, ...frozen?.placement });
      if (context().libraryPath !== ctx.libraryPath) throw new Error('资源库已切换；移动请求针对原库，请回到原库核对结果。');
      if (result?.conflict) throw new Error('文件夹已在其他窗口移动，请刷新后重新选择目标。');
      if (!result?.ok) throw new Error('Eagle 尚未确认移动结果，请先刷新核对。');
      return result;
    };
    const refreshAfterMove = async result => {
      try { await refresh(); }
      catch (error) { notify(`文件夹已移动，但视图刷新失败：${error.message}。请刷新核对，不必重复移动。`, 6000); return; }
      notify(result.noop ? '文件夹已在目标位置' : '文件夹已移动');
    };
    // Dragging already selects the destination. Submit on release without
    // a modal, retaining the same API conflict and readback checks as the menu.
    if (target !== undefined) {
      moving = true;
      try {
        notify('正在移动文件夹…');
        await refreshAfterMove(await executeMove(target));
      } catch (error) { notify(error.message, 6000); }
      finally { moving = false; }
      return;
    }
    const form = dialog('移动文件夹本身'); if (!form) return;
    form.body.append(element('p', '保留文件夹及子文件夹、素材归属，仅更改所属层级。'), element('p', source.path));
    const search = element('input', '', { type: 'search', 'aria-label': '搜索目标文件夹', placeholder: '搜索文件夹名称或完整路径' });
    const label = element('label', '目标文件夹');
    const select = element('select', '', { 'aria-label': '目标文件夹' });
    let selectedTarget = target === undefined ? (source.parent || '') : (target || '');
    const renderTargets = () => {
      const query = search.value.trim().toLocaleLowerCase();
      select.replaceChildren(element('option', '资源库根目录', { value: '' }));
      for (const entry of entries) {
        if (excluded.has(entry.folder.id)) continue;
        const matches = entry.path.toLocaleLowerCase().includes(query);
        if (matches || entry.folder.id === selectedTarget) {
          select.append(element('option', matches ? entry.path : `当前选择：${entry.path}`, { value: entry.folder.id }));
        }
      }
      // Filtering never silently changes the destination to root.
      select.value = selectedTarget;
    };
    const submit = element('button', '移动', { type: 'button', 'data-feature-submit': '' });
    // The current parent is not a move; 移动 waits for another target (F-06).
    const syncSubmit = () => { submit.disabled = !frozen?.placement && select.value === (source.parent || ''); };
    search.addEventListener('input', () => { renderTargets(); syncSubmit(); });
    select.addEventListener('change', () => { selectedTarget = select.value; syncSubmit(); });
    renderTargets(); syncSubmit(); label.append(select); form.body.append(search, label);
    form.footer.append(submit);
    // Return submits from the search box or the list; focus starts in search (F-06).
    for (const field of [search, select]) field.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submit.click(); }
    });
    search.focus();
    submit.onclick = async () => {
      if (submit.disabled) return;
      const parentId = select.value || null;
      if (context().libraryPath !== ctx.libraryPath) {
        form.status.textContent = '资源库已切换，请关闭后重新选择。';
        submit.disabled = true; select.disabled = true; search.disabled = true; form.cancel.textContent = '关闭';
        return;
      }
      submit.disabled = true; select.disabled = true; search.disabled = true; form.lock(true);
      form.status.textContent = '正在移动并核对 Eagle 层级…';
      moving = true;
      try {
        const result = await executeMove(parentId);
        form.close();
        await refreshAfterMove(result);
      } catch (error) {
        form.status.textContent = error.message;
        // A fresh source snapshot is required for another move attempt.
        form.lock(false); form.cancel.textContent = '关闭';
      } finally { moving = false; }
    };
  }
  // Eagle itself has no folder copy. MultiView's copies the whole subtree and
  // the API cannot delete folders afterwards, so every copy asks first and
  // says how much it will create (F-03). Without a target (the context menu)
  // the dialog also picks the destination.
  async function copyFolder(id, target = undefined, frozen = null, placement = null) {
    if (!api.copyFolder || !canStart() || moving || activeDialog) return;
    const ctx = { ...(frozen || context()) };
    const entries = walk(ctx.folders);
    const source = entries.find(entry => entry.folder.id === id);
    if (!source) return;
    if (target !== undefined && target !== null && !entries.some(entry => entry.folder.id === target)) {
      notify('目标文件夹已不存在，请刷新后重新选择。'); return;
    }
    const excluded = new Set(walk([source.folder]).map(entry => entry.folder.id));
    if (target !== undefined && excluded.has(target)) { notify('不能复制到自身或其子文件夹。'); return; }
    const form = dialog('复制文件夹'); if (!form) return;
    form.body.append(element('p', source.path));
    let select = null, search = null;
    if (target === undefined) {
      search = element('input', '', { type: 'search', 'aria-label': '搜索目标文件夹', placeholder: '搜索文件夹名称或完整路径' });
      const label = element('label', '复制到');
      select = element('select', '', { 'aria-label': '复制到' });
      let selectedTarget = source.parent || '';
      const renderTargets = () => {
        const query = search.value.trim().toLocaleLowerCase();
        select.replaceChildren(element('option', '资源库根目录', { value: '' }));
        for (const entry of entries) {
          if (excluded.has(entry.folder.id)) continue;
          const matches = entry.path.toLocaleLowerCase().includes(query);
          if (matches || entry.folder.id === selectedTarget) {
            select.append(element('option', matches ? entry.path : `当前选择：${entry.path}`, { value: entry.folder.id }));
          }
        }
        select.value = selectedTarget;
      };
      search.addEventListener('input', renderTargets);
      select.addEventListener('change', () => { selectedTarget = select.value; });
      renderTargets(); label.append(select); form.body.append(search, label);
    } else {
      const targetPath = target === null ? '资源库根目录' : entries.find(entry => entry.folder.id === target).path;
      const anchor = placement && entries.find(entry => entry.folder.id === placement.anchorId)?.folder.name;
      form.body.append(element('p', `复制到：${targetPath}${anchor ? `（放在“${anchor}”${placement.position === 'before' ? '之前' : '之后'}）` : ''}`));
    }
    const summary = element('p', '正在统计要复制的内容…', { 'data-copy-summary': '' });
    form.body.append(summary, element('p', '复制无法在 MultiView 中撤销：Eagle 接口不能删除文件夹，多余的副本需要在 Eagle 中手动删除。'));
    const submit = element('button', '复制', { type: 'button', 'data-feature-submit': '' });
    submit.disabled = true; form.footer.append(submit);
    // Return must never start a copy on its own.
    if (target !== undefined) form.cancel.focus();
    let plan = null;
    Promise.resolve(api.copyFolderPlan
      ? api.copyFolderPlan({ sourceId: id, parentId: null, libraryPath: ctx.libraryPath })
      : { ok: true, folderCount: excluded.size, itemCount: null }).then(result => {
      if (!form.node.isConnected || !result?.ok) return;
      plan = result;
      summary.textContent = `将复制 ${result.folderCount} 个文件夹${result.itemCount === null ? '' : `、${result.itemCount} 个素材`}，连同子文件夹层级、排序、置顶、封面和标签。`;
      submit.disabled = false;
    }, error => {
      if (form.node.isConnected) summary.textContent = `无法统计要复制的内容：${error.message}`;
    });
    submit.onclick = async () => {
      if (submit.disabled || !plan) return;
      const parentId = select ? (select.value || null) : target;
      if (context().libraryPath !== ctx.libraryPath) {
        form.status.textContent = '资源库已切换，请关闭后重新选择。';
        submit.disabled = true; form.cancel.textContent = '关闭';
        return;
      }
      submit.disabled = true; form.lock(true);
      if (select) { select.disabled = true; search.disabled = true; }
      form.status.textContent = '正在复制，完成前请勿关闭窗口…';
      moving = true;
      try {
        const result = await api.copyFolder({ sourceId: id, parentId, libraryPath: ctx.libraryPath,
          ...(placement && parentId === target ? { anchorId: placement.anchorId, position: placement.position } : {}) });
        if (!result?.ok) throw new Error('Eagle 尚未确认复制结果，请先刷新核对。');
        form.close();
        // The copies keep the sorts MultiView remembers for their sources.
        cloneSortMemory(ctx.libraryPath, result.folderMap);
        try { await refresh(); }
        catch (error) { notify(`文件夹已复制，但视图刷新失败：${error.message}。请刷新核对。`, 6000); return; }
        notify(`已复制 ${result.folderCount} 个文件夹和 ${result.copiedItems} 个素材${result.placed === false ? '；未能放到指定位置' : ''}`);
      } catch (error) {
        // The copy may be half done; never offer a one-click retry.
        form.status.textContent = error.message;
        form.lock(false); form.cancel.textContent = '关闭';
      } finally { moving = false; }
    };
  }
  const FOLDER_TYPE = 'application/x-eagle-multiview-folder-node';
  let dragAttached = false;
  let activeFolderDrag = null;
  let highlighted = null;
  const clearFeedback = () => {
    highlighted?.removeAttribute('data-folder-node-drop');
    highlighted?.removeAttribute('data-manual-drop');
    highlighted = null;
  };
  function attachFolderDrag() {
    if (dragAttached) return;
    dragAttached = true;
    const isFolderDrag = event => Array.from(event.dataTransfer?.types || []).includes(FOLDER_TYPE);
    const destination = event => {
      let node = event.target.closest?.('[data-folder-node-id], [data-folder-node-root], [data-crumb-folder-id], [data-crumb-root]');
      // The space immediately below the final visible child is its after slot.
      if (!node && event.target.closest?.('#folderTree')) {
        node = [...document.querySelectorAll('#folderTree .folder-row[data-folder-node-id]')].reverse().find(row => {
          const rect = row.getBoundingClientRect();
          return rect.height && event.clientY >= rect.bottom && event.clientY <= rect.bottom + 20;
        });
      }
      if (!node) {
        const pane = event.target.closest?.('.content-pane[data-pane-id]');
        if (!pane) return null;
        const parentId = context().paneDestination?.(pane.dataset.paneId);
        return parentId === undefined ? null : { node: pane, parentId };
      }
      const parentId = node.hasAttribute('data-folder-node-root') || node.hasAttribute('data-crumb-root')
        ? null : node.dataset.crumbFolderId || node.dataset.folderNodeId;
      if (node.matches('.folder-row[data-folder-node-id]')) {
        const rect = node.getBoundingClientRect();
        const point = (event.clientY - rect.top) / rect.height;
        if (point <= .25 || point >= .75) {
          const entries = walk(context().folders);
          const entry = entries.find(entry => entry.folder.id === parentId);
          if (!entry) return null;
          const ctx = context();
          const rawSiblings = entry.parent === null ? ctx.folders : entries.find(item => item.folder.id === entry.parent)?.folder.children || [];
          const siblings = ctx.folderOrder ? ctx.folderOrder(entry.parent, rawSiblings) : rawSiblings;
          return { node, parentId: entry.parent, placement: { anchorId: parentId,
            position: point <= .25 ? 'before' : 'after', targetSiblingIds: siblings.map(folder => folder.id),
            baseSiblingIds: rawSiblings.map(folder => folder.id) } };
        }
      }
      return { node, parentId };
    };
    const allowed = (payload, destination, ctx, { copy = false } = {}) => {
      const target = destination.parentId;
      if (!payload || payload.libraryPath !== ctx.libraryPath) return false;
      const entries = walk(ctx.folders);
      if (target !== null && !entries.some(entry => entry.folder.id === target)) return false;
      const source = entries.find(entry => entry.folder.id === payload.id);
      // A copy may land right next to its source; a move onto itself is a no-op.
      if (!source || (!copy && !destination.placement && target === payload.baseParentId)
        || (!copy && destination.placement?.anchorId === payload.id)) return false;
      return !walk([source.folder]).some(entry => entry.folder.id === target);
    };
    document.addEventListener('dragstart', event => {
      const sourceNode = event.target.closest?.('[data-folder-node-id]');
      if (!sourceNode || !event.dataTransfer) { activeFolderDrag = null; clearFeedback(); return; }
      const ctx = context();
      const source = walk(ctx.folders).find(entry => entry.folder.id === sourceNode.dataset.folderNodeId);
      if (!source || !ctx.libraryPath || activeDialog || moving || !canStart()) { event.preventDefault(); return; }
      activeFolderDrag = { id: source.folder.id, libraryPath: ctx.libraryPath, baseParentId: source.parent };
      event.dataTransfer.setData(FOLDER_TYPE, JSON.stringify(activeFolderDrag));
      event.dataTransfer.effectAllowed = 'copyMove';
      // Only logical-folder drags are captured. Existing item/native-file
      // drag and import handlers receive all their original events unchanged.
      event.stopImmediatePropagation();
    }, true);
    document.addEventListener('dragover', event => {
      if (!isFolderDrag(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      clearFeedback();
      const target = destination(event);
      if (!target) { event.dataTransfer.dropEffect = 'none'; return; }
      // Cross-window drag data can be protected until drop, so validate it
      // there; same-window drags can already exclude self and descendants.
      const valid = !moving && !activeDialog && canStart() && (!activeFolderDrag || allowed(activeFolderDrag, target, context(), { copy: event.altKey }));
      highlighted = target.node;
      if (valid && target.placement) target.node.dataset.manualDrop = `vertical-${target.placement.position}`;
      else target.node.dataset.folderNodeDrop = valid ? 'allowed' : 'blocked';
      event.dataTransfer.dropEffect = valid ? (event.altKey ? 'copy' : 'move') : 'none';
    }, true);
    document.addEventListener('dragleave', event => {
      if (!isFolderDrag(event)) return;
      if (highlighted && !highlighted.contains(event.relatedTarget)) clearFeedback();
      event.stopImmediatePropagation();
    }, true);
    document.addEventListener('drop', event => {
      if (!isFolderDrag(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      clearFeedback();
      let payload;
      try { payload = JSON.parse(event.dataTransfer.getData(FOLDER_TYPE)); } catch { activeFolderDrag = null; return; }
      activeFolderDrag = null;
      const target = destination(event), ctx = context();
      if (!target || typeof payload?.id !== 'string' ||
          !(payload.baseParentId === null || typeof payload.baseParentId === 'string') ||
          !allowed(payload, target, ctx, { copy: event.altKey })) return;
      // Release submits once; hover never writes. The source parent remains
      // frozen from dragstart rather than silently rebasing a concurrent move.
      const copy = event.altKey;
      setTimeout(() => (copy
        ? copyFolder(payload.id, target.parentId, ctx, target.placement)
        : moveFolder(payload.id, target.parentId, { ...ctx, sourceId: payload.id,
          sourceParentId: payload.baseParentId, placement: target.placement }))
        .catch(error => notify(error.message)), 0);
    }, true);
    document.addEventListener('dragend', event => {
      if (!activeFolderDrag && !isFolderDrag(event)) return;
      clearFeedback(); activeFolderDrag = null;
      event.stopImmediatePropagation();
    }, true);
  }
  return { moveFolder, copyFolder, attachFolderDrag };
};
