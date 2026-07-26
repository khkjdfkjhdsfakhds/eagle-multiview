'use strict';

// Browser-side stand-in for preload.js. The web server injects this script
// before every renderer script, so window.eagleMV exists with the exact same
// method surface: data methods go over POST /rpc, hub events arrive over the
// /events WebSocket, and host-bound methods either run locally (clipboard,
// open-in-tab, HTML5 drag bookkeeping) or degrade to the same "unsupported"
// result shapes the renderer already handles. The capabilities table tells the
// renderer which native entry points to hide.
(() => {
  if (window.eagleMV) return;

  // --- event fan-out --------------------------------------------------------
  const listeners = new Map();
  function emit(channel, payload) {
    for (const callback of [...(listeners.get(channel) || [])]) {
      try {
        callback(payload);
      } catch (error) {
        console.error(`eagleMV 事件回调失败（${channel}）`, error);
      }
    }
  }
  function on(channel, callback) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(callback);
    return () => listeners.get(channel)?.delete(callback);
  }

  // --- transport ------------------------------------------------------------
  let clientId = 0;
  let resolveHello;
  const helloPromise = new Promise(resolve => {
    resolveHello = resolve;
    // The server assigns ids over the WebSocket; if it never comes up the
    // renderer still needs identity() to settle so its retry loop can run.
    setTimeout(() => resolve(0), 10000);
  });

  async function invoke(method, args = []) {
    let response;
    try {
      response = await fetch('/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-eaglemv-client': String(clientId) },
        body: JSON.stringify({ method, args })
      });
    } catch {
      throw new Error('无法连接 MultiView 主机');
    }
    if (response.status === 401) {
      location.replace('/login');
      throw new Error('登录已过期');
    }
    const body = await response.json().catch(() => null);
    if (!body || body.ok !== true) throw new Error(body?.message || `RPC 调用失败（${method}）`);
    return body.result;
  }

  function send(method, args = []) {
    invoke(method, args).catch(() => {});
  }

  let socket = null;
  let retryDelay = 1000;
  let sessionEverConnected = false;
  function connectEvents() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    try {
      socket = new WebSocket(`${scheme}://${location.host}/events`);
    } catch {
      scheduleReconnect();
      return;
    }
    socket.onmessage = event => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message?.channel === 'web:hello') {
        clientId = message.payload?.clientId || 0;
        resolveHello(clientId);
        retryDelay = 1000;
        if (sessionEverConnected) {
          // Reconnected after a drop: re-sync connection state and make every
          // pane refetch, mirroring what a desktop window sees after a hiccup.
          invoke('hub:connect')
            .then(() => {
              emit('hub:status', { connected: true });
              emit('hub:query-invalidated', { reason: 'web-reconnected' });
            })
            .catch(() => {});
        }
        sessionEverConnected = true;
        return;
      }
      if (message?.channel) emit(message.channel, message.payload);
    };
    socket.onclose = () => scheduleReconnect();
    socket.onerror = () => {
      try {
        socket.close();
      } catch {}
    };
  }
  function scheduleReconnect() {
    if (sessionEverConnected) {
      emit('hub:status', { connected: false, message: '与 MultiView 主机连接中断，正在重连…' });
    }
    // A dead session cookie keeps the upgrade at 401 forever — probe once per
    // attempt and bounce to the login page instead of silently spinning.
    fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(response => {
        if (response.status === 401) location.replace('/login');
      })
      .catch(() => {});
    setTimeout(connectEvents, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  }
  connectEvents();

  // --- host-only degradations ----------------------------------------------
  const unsupported = message => ({ ok: false, message });
  let dragToken = 0;

  window.eagleMV = {
    platform: 'web',
    capabilities: {
      nativeDrag: false,
      hostDialogs: false,
      clipboardFiles: false,
      finder: false,
      openDefault: false,
      openOther: false,
      share: false,
      export: false,
      importLocal: false,
      customThumbnail: false,
      copyPath: false,
      uiZoom: false,
      webAccess: false
    },
    mediaURL: (kind, id) => `/media/${encodeURIComponent(String(kind))}/${encodeURIComponent(String(id))}`,
    connect: () => invoke('hub:connect'),
    getLibraryHistory: () => invoke('library:history'),
    switchLibrary: data => invoke('library:switch', [data]),
    identity: () => helloPromise,
    query: query => invoke('hub:query', [query]),
    getRecentFolders: () => invoke('hub:recent-folders'),
    getTrashItems: data => invoke('hub:trash-items', [data]),
    getItem: id => invoke('hub:get-item', [id]),
    getComments: data => invoke('item:comments', [data]),
    addComment: data => invoke('item:add-comment', [data]),
    updateComment: data => invoke('item:update-comment', [data]),
    removeComment: data => invoke('item:remove-comment', [data]),
    setCustomThumbnail: async () => ({ canceled: true, ...unsupported('网页版不支持设置自定义缩略图') }),
    getTags: () => invoke('hub:tags'),
    getTagGroups: () => invoke('hub:tag-groups'),
    createSmartFolder: data => invoke('smart-folder:create', [data]),
    updateSmartFolder: data => invoke('smart-folder:update', [data]),
    removeSmartFolder: data => invoke('smart-folder:remove', [data]),
    mutate: mutation => invoke('hub:mutate', [mutation]),
    mutateSet: mutation => invoke('hub:mutate-set', [mutation]),
    watchItems: ids => invoke('hub:watch-items', [ids]),
    newWindow: async data => {
      const url = new URL(location.pathname, location.origin);
      if (data) url.hash = `state=${encodeURIComponent(JSON.stringify(data))}`;
      window.open(url.toString(), '_blank');
      return true;
    },
    initialWindowState: async () => {
      const match = /(?:^#|&)state=([^&]+)/.exec(location.hash || '');
      if (!match) return null;
      history.replaceState(null, '', location.pathname);
      try {
        return JSON.parse(decodeURIComponent(match[1]));
      } catch {
        return null;
      }
    },
    focusWindow: async () => {
      window.focus();
      return true;
    },
    isFullScreen: async () => Boolean(document.fullscreenElement),
    setZoomFactor: () => {},
    confirmClose: () => {},
    cancelClose: () => {},
    createFolder: data => invoke('folder:create', [data]),
    createDocument: data => invoke('document:create', [data]),
    mutateFolder: data => invoke('folder:mutate', [data]),
    markFolderUsed: data => send('folder:used', [data]),
    importItems: async () => ({ canceled: true, ...unsupported('网页版暂不支持导入，请在桌面版导入') }),
    importClipboard: async () => ({ count: 0, ready: 0, rejected: [], source: 'unsupported' }),
    pathForFile: () => null,
    showInFinder: async () => false,
    filePath: id => invoke('item:file-path', [id]),
    fileURL: async id => `/media/original/${encodeURIComponent(String(id))}`,
    readMetadata: id => invoke('item:metadata', [id]),
    openDefault: async () => unsupported('网页版无法在主机上打开文件'),
    exportFiles: async () => ({ canceled: true, ...unsupported('网页版暂不支持导出') }),
    openOther: async () => ({ canceled: true, ...unsupported('网页版无法在主机上打开文件') }),
    shareFiles: async () => unsupported('网页版不支持系统分享'),
    duplicateFiles: data => invoke('items:duplicate', [data]),
    copyFiles: async () => ({ count: 0, missing: 0, message: '网页版不支持复制文件到剪贴板' }),
    copyText: async text => {
      await navigator.clipboard.writeText(String(text || ''));
      return true;
    },
    logError: entry => send('log:renderer-error', [entry]),
    openExternal: async url => {
      const target = String(url || '').trim();
      if (!/^https?:\/\//i.test(target)) throw new Error('只支持打开 http/https 网址');
      window.open(target, '_blank', 'noopener');
      return true;
    },
    // No native drag session in a browser: the renderer keeps the default
    // HTML5 drag alive and we only mirror main's drag-state bookkeeping so
    // in-page drops (folder cards, panes, the tree) behave identically.
    startDrag: data => {
      const payload = Array.isArray(data) ? { ids: data } : data || {};
      const token = ++dragToken;
      emit('item:drag-state', {
        active: true,
        token,
        ids: [...new Set(payload.ids || [])],
        sourceFolderId: payload.sourceFolderId || null,
        sourcePaneId: payload.sourcePaneId || null,
        sourceWindowId: payload.sourceWindowId || null,
        libraryPath: payload.libraryPath || null
      });
    },
    cancelDrag: token => {
      emit('item:drag-state', { active: false, token });
    },
    getPins: data => invoke('pins:get', [data]),
    setPins: data => invoke('pins:set', [data]),
    readText: data => invoke('text:read', [data]),
    saveText: data => invoke('text:save', [data]),
    onStatus: callback => on('hub:status', callback),
    onLibraryChanged: callback => on('hub:library-changed', callback),
    onItemsChanged: callback => on('hub:items-changed', callback),
    onQueryInvalidated: callback => on('hub:query-invalidated', callback),
    onTrashSelection: callback => on('command:trash-selection', callback),
    onPinSelection: callback => on('command:pin-selection', callback),
    onAddToFolder: callback => on('command:add-to-folder', callback),
    onMoveToFolder: callback => on('command:move-to-folder', callback),
    onRemoveFromFolder: callback => on('command:remove-from-folder', callback),
    onAddTag: callback => on('command:add-tag', callback),
    onSetRating: callback => on('command:set-rating', callback),
    onSetTagColor: callback => on('command:set-tag-color', callback),
    onRenameRequest: callback => on('command:rename', callback),
    getTagColors: data => invoke('tag-colors:get', [data]),
    setTagColor: data => invoke('tag-colors:set', [data]),
    renameTag: data => invoke('tag:rename', [data]),
    mergeTag: data => invoke('tag:merge', [data]),
    createTagGroup: data => invoke('tag-group:create', [data]),
    updateTagGroup: data => invoke('tag-group:update', [data]),
    removeTagGroup: data => invoke('tag-group:remove', [data]),
    addTagsToGroup: data => invoke('tag-group:add-tags', [data]),
    removeTagsFromGroup: data => invoke('tag-group:remove-tags', [data]),
    getWebAccess: async () => null,
    setWebAccess: async () => unsupported('Web 访问设置只能在桌面版修改'),
    resetWebAccessKey: async () => unsupported('Web 访问设置只能在桌面版修改'),
    onWebAccessRequest: callback => on('command:web-access', callback),
    onImportRequest: callback => on('command:import', callback),
    onCreateFolderRequest: callback => on('command:create-folder', callback),
    onCreateDocumentRequest: callback => on('command:create-document', callback),
    onCreateSmartFolderRequest: callback => on('command:create-smart-folder', callback),
    onPinsChanged: callback => on('pins:changed', callback),
    onTagDataChanged: callback => on('tag-data:changed', callback),
    onFolderUsed: callback => on('folder:used', callback),
    onTextChanged: callback => on('text:changed', callback),
    onItemDragState: callback => on('item:drag-state', callback),
    onDragFinished: callback => on('item:drag-finished', callback),
    onRequestClose: callback => on('command:request-close', callback),
    onChromeState: callback => on('window:chrome-state', callback)
  };
})();
