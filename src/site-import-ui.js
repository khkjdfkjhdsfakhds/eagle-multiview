'use strict';
window.createSiteImportUI = function ({ api, context, canStart, refresh, notify }) {
  let active = null;
  const make = (tag, text, attrs = {}) => {
    const node = document.createElement(tag); if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  function open() {
    if (active || !canStart()) return;
    const initial = context(), previous = document.activeElement;
    const dialog = make('dialog', '', { class: 'feature-dialog', 'aria-label': 'ArtStation 站点导入' });
    active = dialog;
    const url = make('input', '', { type: 'url', placeholder: 'https://www.artstation.com/作者名', 'aria-label': 'ArtStation 作者主页', 'data-site-url': '' });
    const destination = make('select', '', { 'aria-label': '导入目标文件夹' });
    destination.append(make('option', '资源库根目录（未分类）', { value: '' }));
    const walk = (folders, prefix = '') => { for (const folder of folders || []) {
      const name = prefix + folder.name;
      destination.append(make('option', name, { value: folder.id })); walk(folder.children, name + ' / ');
    } };
    walk(initial.folders); destination.value = initial.folderId || '';
    const discover = make('button', '识别作品', { type: 'button', 'data-site-discover': '' });
    const next = make('button', '加载下一页', { type: 'button', 'data-site-next': '' }); next.hidden = true;
    const retry = make('button', '重读本页失败项', { type: 'button', 'data-site-retry': '' }); retry.hidden = true;
    const selectAll = make('button', '全选已加载图片', { type: 'button' });
    const list = make('div', '', { class: 'site-asset-list' });
    const status = make('p', '仅识别公开作品；选中后才导入。重复保护限当前任务，不代表资料库内容去重。', { role: 'status', class: 'feature-status' });
    const submit = make('button', '导入所选图片', { type: 'button', 'data-site-import': '' });
    const close = make('button', '关闭 / 停止后续', { type: 'button', 'data-site-close': '' });
    const footer = make('div', '', { class: 'feature-footer' }); footer.append(selectAll, retry, next, submit, close);
    dialog.append(make('h2', 'ArtStation 站点导入'), make('p', '输入作者主页，分批加载作品并挑选图片。目标在识别时固定。'), url, destination, discover, list, status, footer);
    document.body.append(dialog); dialog.showModal(); url.focus();
    let requestId = null, busy = false, closed = false;
    const assets = new Map(), checkboxes = new Map();
    const sameLibrary = () => context().libraryPath === initial.libraryPath;
    const cancel = () => {
      if (closed) return;
      closed = true;
      if (requestId) api.cancelSiteImport({ requestId }).catch(() => {});
      dialog.close(); dialog.remove(); active = null; previous?.focus?.();
    };
    close.onclick = cancel;
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    const show = result => {
      for (const asset of result.assets || []) {
        if (assets.has(asset.id)) continue;
        assets.set(asset.id, asset);
        const label = make('label', '', { class: 'site-asset' });
        const checkbox = make('input', '', { type: 'checkbox', 'data-site-asset': asset.id });
        const image = make('img', '', { loading: 'lazy', alt: '', referrerpolicy: 'no-referrer' });
        if (asset.url) image.src = asset.url;
        label.append(checkbox, image, make('span', asset.name || asset.id));
        checkboxes.set(asset.id, checkbox); list.append(label);
      }
      next.hidden = !result.nextPage;
      retry.hidden = !api.retrySiteImport || !result.failures?.some(x => x.code !== 'SITE_ASSET_UNSUPPORTED');
      status.textContent = '已识别 ' + assets.size + ' 张图片，尚未导入。' +
        (result.failures?.length ? result.failures.length + ' 项读取失败；已识别部分仍可选择。' : '') +
        (result.truncated ? '达到读取上限，本次未遍历全部作品。' : '') +
        (!result.nextPage && result.complete ? '已读取至末页。' : '');
    };
    const load = async more => {
      if (busy || closed) return;
      if (!sameLibrary()) { status.textContent = '资料库已切换，请关闭后重新识别。'; return; }
      busy = true; discover.disabled = true; next.disabled = true; submit.disabled = true;
      try {
        if (!more) {
          requestId = globalThis.crypto?.randomUUID?.() || `site-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          url.disabled = true; destination.disabled = true;
        }
        const result = more === 'retry' ? await api.retrySiteImport({ requestId }) : more ? await api.nextSiteImport({ requestId })
          : await api.startSiteImport({ requestId, url: url.value, libraryPath: initial.libraryPath, folderId: destination.value || null });
        if (!closed) show(result);
      } catch (error) {
        if (!closed) {
          status.textContent = error.message;
          // A new recognition is a new task; no import has occurred here.
          if (!assets.size) { url.disabled = false; destination.disabled = false; discover.disabled = false; }
          else retry.hidden = !api.retrySiteImport;
        }
      } finally { busy = false; if (!closed) { next.disabled = false; submit.disabled = false; } }
    };
    discover.onclick = () => load(false); next.onclick = () => load(true);
    retry.onclick = () => load('retry');
    selectAll.onclick = () => { for (const checkbox of checkboxes.values()) if (!checkbox.disabled) checkbox.checked = true; };
    submit.onclick = async () => {
      if (busy || closed || !requestId) return;
      if (!sameLibrary()) { status.textContent = '资料库已切换，请关闭后重新选择目标。'; return; }
      const ids = [...checkboxes].filter(([,node]) => node.checked && !node.disabled).map(([id]) => id);
      if (!ids.length) { status.textContent = '请先勾选要导入的图片。'; return; }
      busy = true; submit.disabled = true; next.disabled = true;
      // Disable selected entries before dispatch. Unknown transport outcomes
      // are not made retryable by merely reopening this modal.
      for (const id of ids) checkboxes.get(id).disabled = true;
      status.textContent = '正在逐项导入；停止只影响尚未提交的图片。';
      try {
        const result = await api.importSiteSelection({ requestId, ids });
        for (const outcome of result.outcomes || []) {
          const box = checkboxes.get(outcome.assetId);
          if (!box) continue;
          if (outcome.status === 'notSubmitted') box.disabled = false;
          else box.checked = false;
        }
        for (const id of result.notSubmitted || []) {
          const box = checkboxes.get(id);
          if (box) box.disabled = false;
        }
        const committed = (result.outcomes || []).filter(x => x.status === 'committed').length;
        const unknown = (result.outcomes || []).filter(x => x.status === 'unknown').length;
        const summary = '已导入 ' + committed + ' 张；结果未确认 ' + unknown + ' 张；未提交 ' + (result.notSubmitted?.length || 0) + ' 张。' + (result.error ? ' ' + (result.error.message || String(result.error)) : '');
        if (!closed) status.textContent = summary;
        notify(summary, 6000);
        if (sameLibrary() && committed) await refresh();
      } catch (error) {
        if (!closed) status.textContent = '提交结果未确认，请先在 Eagle 核对，不要重建任务重复导入。' + error.message;
      } finally { busy = false; if (!closed) { submit.disabled = false; next.disabled = false; } }
    };
  }
  return { open };
};
