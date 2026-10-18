'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const api = window.updater;

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} B`;
  }

  function plainInline(text) {
    return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  }

  // Release notes are Markdown; render a safe subset with textContent only.
  function renderNotes(markdown) {
    const root = $('notes');
    root.replaceChildren();
    let list = null;
    for (const raw of String(markdown || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) { list = null; continue; }
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      const bullet = line.match(/^[-*+]\s+(.*)$/);
      if (heading) {
        list = null;
        const node = document.createElement('h3');
        node.textContent = plainInline(heading[1]);
        root.append(node);
      } else if (bullet) {
        if (!list) { list = document.createElement('ul'); root.append(list); }
        const node = document.createElement('li');
        node.textContent = plainInline(bullet[1]);
        list.append(node);
      } else {
        list = null;
        const node = document.createElement('p');
        node.textContent = plainInline(line);
        root.append(node);
      }
    }
    return root.childElementCount > 0;
  }

  function button(label, action, { primary = false, value } = {}) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    if (primary) node.className = 'primary';
    // One click per state: buttons stay disabled until the next state
    // replaces them, so 下载并安装 cannot be sent twice (F-10).
    node.addEventListener('click', () => {
      for (const other of $('buttons').querySelectorAll('button')) other.disabled = true;
      api.act(action, value);
    });
    return node;
  }

  let phase = null;
  function render(state) {
    phase = state.phase;
    const title = $('title');
    const subtitle = $('subtitle');
    const buttons = [];
    let notes = false;
    let progress = null;
    subtitle.classList.remove('error');
    subtitle.textContent = '';
    $('autoCheck').checked = state.autoCheck !== false;

    switch (state.phase) {
      case 'checking':
        title.textContent = '正在检查更新…';
        progress = { text: '' };
        buttons.push(button('取消', 'cancel-check'));
        break;
      case 'latest':
        title.textContent = '已是最新版本';
        subtitle.textContent = `Eagle MultiView ${state.currentVersion} 是目前的最新版本。`;
        buttons.push(button('好', 'close', { primary: true }));
        break;
      case 'available':
        title.textContent = `发现新版本 Eagle MultiView ${state.version}`;
        subtitle.textContent = [`当前版本 ${state.currentVersion}`, state.size ? `安装包 ${formatBytes(state.size)}` : '', state.manualOnly ? state.manualReason : '']
          .filter(Boolean).join(' · ');
        notes = renderNotes(state.notes);
        buttons.push(button('跳过此版本', 'skip'), button('稍后提醒', 'close'));
        buttons.push(state.manualOnly
          ? button('前往下载页面', 'open-page', { primary: true })
          : button('下载并安装', 'download', { primary: true }));
        break;
      case 'downloading': {
        title.textContent = `正在下载 Eagle MultiView ${state.version}`;
        const total = Number(state.total) || 0;
        const received = Number(state.received) || 0;
        progress = {
          ratio: total ? Math.min(1, received / total) : null,
          text: total ? `${formatBytes(received)} / ${formatBytes(total)}（${Math.floor(received / total * 100)}%）` : formatBytes(received)
        };
        notes = renderNotes(state.notes);
        buttons.push(button('取消', 'cancel'));
        break;
      }
      case 'preparing':
        title.textContent = '正在校验并准备安装…';
        subtitle.textContent = '正在检查安装包的完整性和签名。';
        notes = renderNotes(state.notes);
        progress = { text: '' };
        break;
      case 'ready':
        title.textContent = `Eagle MultiView ${state.version} 已准备就绪`;
        subtitle.textContent = '重新启动后即可完成更新。选择“稍后”会在你退出 Eagle MultiView 时自动安装。';
        notes = renderNotes(state.notes);
        buttons.push(button('稍后', 'later'), button('立即重启并更新', 'install', { primary: true }));
        break;
      case 'installing':
        title.textContent = '正在退出并安装更新…';
        subtitle.textContent = '如果有未保存的内容，请先在窗口中处理。';
        progress = { text: '' };
        break;
      case 'error':
        title.textContent = state.retry === 'check' ? '无法检查更新' : '更新失败';
        subtitle.textContent = state.message || '发生未知错误。';
        subtitle.classList.add('error');
        if (state.releaseURL) buttons.push(button('前往下载页面', 'open-page'));
        buttons.push(button('关闭', 'close'));
        if (state.retry) buttons.push(button('重试', state.retry === 'check' ? 'check' : 'download', { primary: true }));
        break;
      default:
        title.textContent = '软件更新';
        buttons.push(button('检查更新', 'check', { primary: true }));
    }

    $('notes').hidden = !notes;
    $('spacer').hidden = notes;
    $('progress').hidden = !progress;
    if (progress) {
      const known = typeof progress.ratio === 'number';
      $('bar').classList.toggle('indeterminate', !known);
      $('fill').style.width = known ? `${(progress.ratio * 100).toFixed(1)}%` : '';
      if (known) $('bar').setAttribute('aria-valuenow', String(Math.round(progress.ratio * 100)));
      else $('bar').removeAttribute('aria-valuenow');
      $('progressText').textContent = progress.text;
      $('progressText').hidden = !progress.text;
    }
    $('buttons').replaceChildren(...buttons);
    const primary = $('buttons').querySelector('button.primary');
    if (primary && !document.activeElement?.closest?.('footer')) primary.focus();
  }

  $('autoCheck').addEventListener('change', event => api.act('auto-check', event.target.checked));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') api.act(phase === 'checking' ? 'cancel-check' : 'close');
  });
  api.onState(render);
  api.getState().then(render);
})();
