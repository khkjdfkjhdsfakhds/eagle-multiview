'use strict';

window.createThumbnailUI = function ({ api, context, refresh, notify, canStart }) {
  let active = null;
  function element(tag, text, attrs = {}) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }
  function run(operation, ids) {
    if (operation === 'clear') {
      notify('取消自定义缩略图尚缺受支持接口；刷新仅重新生成，不等同于取消自定义。', 6000);
      return Promise.resolve({ unsupported: true });
    }
    if (!['refresh', 'file', 'clipboard'].includes(operation) || typeof api.thumbnailOperation !== 'function') {
      notify('当前设备尚未提供这项缩略图操作。', 4000);
      return Promise.resolve({ unsupported: true });
    }
    if (active || !canStart()) return Promise.resolve({ canceled: true });
    const current = context();
    const selected = [...new Set(ids || current.ids || [])];
    if (!selected.length || !current.libraryPath) {
      notify('请先连接资料库并选择素材。', 4000);
      return Promise.resolve({ canceled: true });
    }
    const requestId = globalThis.crypto?.randomUUID?.() || `thumb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const frozen = { libraryPath: current.libraryPath, paneId: current.paneId, ids: selected };
    const previousFocus = document.activeElement;
    const dialog = element('dialog', '', { class: 'feature-dialog', 'aria-label': '缩略图操作' });
    const cancel = element('button', '取消', { type: 'button', 'data-thumbnail-cancel': '' });
    const submit = element('button', '继续', { type: 'button', 'data-thumbnail-submit': '' });
    const status = element('p', '', { class: 'feature-status', role: 'status' });
    const footer = element('div', '', { class: 'feature-footer' });
    footer.append(cancel, submit);
    const title = { refresh: '刷新缩略图', file: '从文件设置缩略图', clipboard: '从剪贴板设置缩略图' }[operation];
    dialog.append(element('h2', `${title} · ${selected.length} 项`),
      element('p', '仅更新所选素材的缩略图，不替换原文件。'), status, footer);
    document.body.append(dialog); active = dialog;
    return new Promise(resolve => {
      let busy = false;
      const close = (result = { canceled: true }) => {
        dialog.close(); dialog.remove(); active = null;
        previousFocus?.focus?.(); resolve(result);
      };
      const stop = async () => {
        if (!busy) { close(); return; }
        if (!api.cancelThumbnailOperation || cancel.disabled) return;
        cancel.disabled = true;
        status.textContent = '正在停止后续图片；已经发出的请求仍会核对结果。';
        try { await api.cancelThumbnailOperation({ requestId }); }
        catch (error) { status.textContent = `停止请求未确认：${error.message}`; cancel.disabled = false; }
      };
      cancel.onclick = stop;
      dialog.addEventListener('cancel', event => { event.preventDefault(); stop(); });
      dialog.addEventListener('keydown', event => event.stopPropagation());
      submit.onclick = async () => {
        if (busy || submit.disabled) return;
        if (context().libraryPath !== frozen.libraryPath) {
          status.textContent = '资料库已切换，请关闭后重新选择。'; submit.disabled = true; return;
        }
        busy = true; submit.disabled = true; cancel.disabled = !api.cancelThumbnailOperation; cancel.textContent = '停止后续';
        status.textContent = `正在处理 ${selected.length} 项缩略图… 请求发出后将核对真实结果，不重复提交。`;
        try {
          const result = await api.thumbnailOperation({ operation, ids: [...selected], libraryPath: frozen.libraryPath, requestId });
          if (result?.canceled && !result.outcomes?.length) { busy = false; close(result); return; }
          if (!result?.counts || !Array.isArray(result.outcomes)) throw new Error('缩略图操作返回结果不完整');
          const counts = result?.counts || {};
          let summary = [`已完成 ${counts.completed || 0}`, `已提交生成 ${counts.accepted || 0}（尚未确认完成）`,
            `结果未确认 ${counts.unknown || 0}`, `失败 ${counts.failed || 0}`, `未执行 ${counts.canceled || 0}`].join('；');
          let refreshFailed = false;
          if (context().libraryPath !== frozen.libraryPath) summary += '。结果对应先前资料库，当前视图未刷新。';
          else if (counts.completed > 0) {
            try { await refresh({ ...frozen, ids: [...selected], preserveSelection: true }); }
            catch (error) { refreshFailed = true; summary += `。视图刷新失败：${error.message}；已完成的写入保留，请勿重复提交。`; }
          }
          notify(summary, 6000);
          busy = false;
          if (counts.failed || counts.unknown || refreshFailed) {
            status.textContent = summary; cancel.disabled = false; cancel.textContent = '关闭'; resolve(result);
          } else close(result);
        } catch (error) {
          busy = false; cancel.disabled = false; cancel.textContent = '关闭';
          status.textContent = `结果未确认：${error.message}。请先核对 Eagle，不自动重试。`;
          notify(status.textContent, 6000);
          resolve({ error: error.message, unknown: true });
        }
      };
      dialog.showModal();
    });
  }
  return { run };
};
