'use strict';
window.createSelectedFeatureUI = function ({ api, context, refresh, notify, canStart }) {
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
    if (target !== undefined && (target === source.parent || excluded.has(target))) return;
    const executeMove = async parentId => {
      if (context().libraryPath !== ctx.libraryPath) throw new Error('资料库已切换，请重新选择。');
      const result = await api.moveFolder({ id, parentId, baseParentId: source.parent, libraryPath: ctx.libraryPath });
      if (context().libraryPath !== ctx.libraryPath) throw new Error('资料库已切换；移动请求针对原库，请回到原库核对结果。');
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
    search.addEventListener('input', renderTargets);
    select.addEventListener('change', () => { selectedTarget = select.value; });
    renderTargets(); label.append(select); form.body.append(search, label);
    const submit = element('button', '移动', { type: 'button', 'data-feature-submit': '' }); form.footer.append(submit);
    submit.onclick = async () => {
      if (submit.disabled) return;
      const parentId = select.value || null;
      if (context().libraryPath !== ctx.libraryPath) {
        form.status.textContent = '资料库已切换，请关闭后重新选择。';
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
  const FOLDER_TYPE = 'application/x-eagle-multiview-folder-node';
  let dragAttached = false;
  let activeFolderDrag = null;
  let highlighted = null;
  const clearFeedback = () => { highlighted?.removeAttribute('data-folder-node-drop'); highlighted = null; };
  function attachFolderDrag() {
    if (dragAttached) return;
    dragAttached = true;
    const isFolderDrag = event => Array.from(event.dataTransfer?.types || []).includes(FOLDER_TYPE);
    const destination = event => event.target.closest?.('[data-folder-node-id], [data-folder-node-root]');
    const targetId = node => node.hasAttribute('data-folder-node-root') ? null : node.dataset.folderNodeId;
    const allowed = (payload, target, ctx) => {
      if (!payload || payload.libraryPath !== ctx.libraryPath) return false;
      const entries = walk(ctx.folders);
      if (target !== null && !entries.some(entry => entry.folder.id === target)) return false;
      const source = entries.find(entry => entry.folder.id === payload.id);
      if (!source || target === payload.baseParentId) return false;
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
      event.dataTransfer.effectAllowed = 'move';
      // Only logical-folder drags are captured. Existing item/native-file
      // drag and import handlers receive all their original events unchanged.
      event.stopImmediatePropagation();
    }, true);
    document.addEventListener('dragover', event => {
      if (!isFolderDrag(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      clearFeedback();
      const node = destination(event);
      if (!node) { event.dataTransfer.dropEffect = 'none'; return; }
      // Cross-window drag data can be protected until drop, so validate it
      // there; same-window drags can already exclude self and descendants.
      const valid = !moving && !activeDialog && canStart() && (!activeFolderDrag || allowed(activeFolderDrag, targetId(node), context()));
      highlighted = node;
      node.dataset.folderNodeDrop = valid ? 'allowed' : 'blocked';
      event.dataTransfer.dropEffect = valid ? 'move' : 'none';
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
      const node = destination(event), ctx = context();
      if (!node || typeof payload?.id !== 'string' ||
          !(payload.baseParentId === null || typeof payload.baseParentId === 'string') ||
          !allowed(payload, targetId(node), ctx)) return;
      // Release submits once; hover never writes. The source parent remains
      // frozen from dragstart rather than silently rebasing a concurrent move.
      moveFolder(payload.id, targetId(node), { ...ctx, sourceId: payload.id, sourceParentId: payload.baseParentId })
        .catch(error => notify(error.message));
    }, true);
    document.addEventListener('dragend', event => {
      if (!activeFolderDrag && !isFolderDrag(event)) return;
      clearFeedback(); activeFolderDrag = null;
      event.stopImmediatePropagation();
    }, true);
  }
  return { moveFolder, attachFolderDrag };
};
