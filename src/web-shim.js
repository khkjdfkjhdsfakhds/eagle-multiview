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
  let reconnectTimer = null;
  let healthProbe = null;
  let healthProbeEpoch = 0;
  let retryDelay = 1000;
  let sessionEverConnected = false;
  let transportGeneration = 0;
  let disposed = false;
  const activeUploadControllers = new Set();
  const uploadTimeoutMs = 120000;

  function isCurrentTransport(generation) {
    return !disposed && generation === transportGeneration;
  }

  function connectEvents() {
    if (disposed || socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const generation = transportGeneration;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    let candidate;
    try {
      candidate = new WebSocket(`${scheme}://${location.host}/events`);
      socket = candidate;
    } catch {
      scheduleReconnect(generation);
      return;
    }
    candidate.onmessage = event => {
      if (!isCurrentTransport(generation) || socket !== candidate) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message?.channel === 'web:hello') {
        healthProbeEpoch += 1;
        healthProbe = null;
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
    candidate.onclose = () => {
      if (!isCurrentTransport(generation) || socket !== candidate) return;
      socket = null;
      scheduleReconnect(generation);
    };
    candidate.onerror = () => {
      if (!isCurrentTransport(generation) || socket !== candidate) return;
      try {
        candidate.close();
      } catch {}
    };
  }

  function probeSessionHealth(generation) {
    if (!isCurrentTransport(generation) || healthProbe) return;
    const probe = { generation, epoch: ++healthProbeEpoch };
    healthProbe = probe;
    const request = fetch('/health/session', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin'
      })
      .then(response => {
        if (!isCurrentTransport(generation) ||
            healthProbe !== probe || healthProbeEpoch !== probe.epoch) return;
        if (response.status === 401) location.replace('/login');
      })
      .catch(() => {})
      .finally(() => {
        if (healthProbe === probe) healthProbe = null;
      });
    // Keep the token in healthProbe; a later hello invalidates this request.
    void request;
  }

  function scheduleReconnect(generation = transportGeneration) {
    if (!isCurrentTransport(generation) || reconnectTimer) return;
    if (sessionEverConnected) {
      emit('hub:status', { connected: false, message: '与 MultiView 主机连接中断，正在重连…' });
    }
    // WebSocket upgrade failures do not expose HTTP status to browser code.
    // Probe a read-only endpoint once per retry window so an expired session
    // returns to the existing login flow without replaying any prior RPC.
    probeSessionHealth(generation);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (isCurrentTransport(generation)) connectEvents();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  }

  window.addEventListener('online', () => {
    if (disposed) return;
    retryDelay = 1000;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connectEvents();
  });
  window.addEventListener('pagehide', () => {
    disposed = true;
    transportGeneration += 1;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    healthProbe = null;
    healthProbeEpoch += 1;
    for (const controller of activeUploadControllers) controller.abort();
    activeUploadControllers.clear();
    const current = socket;
    socket = null;
    if (current) {
      current.onclose = null;
      current.onerror = null;
      current.onmessage = null;
      try {
        current.close();
      } catch {}
    }
  });
  connectEvents();

  // --- host-only degradations ----------------------------------------------
  const unsupported = message => ({ ok: false, message });
  let dragToken = 0;

  // --- uploads --------------------------------------------------------------
  function pickBrowserFiles({ multiple = true } = {}) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = multiple;
      input.style.display = 'none';
      document.body.appendChild(input);
      const finish = files => {
        input.remove();
        resolve(files);
      };
      input.addEventListener('change', () => finish([...input.files]));
      input.addEventListener('cancel', () => finish([]));
      input.click();
    });
  }

  async function uploadBrowserFiles(files, { folderId, libraryPath } = {}) {
    const outcome = { canceled: false, count: 0, ready: 0, ids: [], rejected: [] };
    for (const file of files) {
      if (disposed) break;
      const controller = new AbortController();
      let timeoutTimer = null;
      let timedOut = false;
      activeUploadControllers.add(controller);
      try {
        const query = new URLSearchParams({ name: file.name || '未命名文件' });
        if (folderId) query.set('folderId', folderId);
        if (libraryPath) query.set('libraryPath', libraryPath);
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, uploadTimeoutMs);
        const response = await fetch(`/upload?${query}`, {
          method: 'POST',
          headers: { 'x-eaglemv-client': String(clientId) },
          body: file,
          signal: controller.signal
        });
        if (response.status === 401) {
          location.replace('/login');
          outcome.rejected.push({ path: file.name, message: '登录已过期' });
          break;
        }
        const body = await response.json();
        if (body?.ok) {
          outcome.count += body.result.count || 0;
          outcome.ready += body.result.ready || 0;
          outcome.ids.push(...(body.result.ids || []));
          outcome.rejected.push(...(body.result.rejected || []));
        } else {
          outcome.rejected.push({ path: file.name, message: body?.message || '上传失败' });
        }
      } catch (error) {
        const transportError = error?.name === 'TypeError';
        const message = timedOut
          ? '上传超时，结果可能不确定'
          : (disposed ? '页面已关闭，结果可能不确定' : '连接中断，结果可能不确定');
        outcome.rejected.push({ path: file.name, message: error?.name === 'AbortError' || transportError || timedOut || disposed
          ? message
          : (error?.message || message) });
        if (timedOut || disposed || error?.name === 'AbortError' || transportError) break;
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        activeUploadControllers.delete(controller);
      }
    }
    return outcome;
  }

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
      export: true,
      importLocal: true,
      customThumbnail: false,
      copyPath: false,
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
    currentEagleWindowState: () => invoke('window:eagle-state'),
    prepareNewWindow: () => window.open('about:blank', '_blank'),
    newWindow: async (data, preparedWindow) => {
      const url = new URL(location.pathname, location.origin);
      if (data) url.hash = `state=${encodeURIComponent(JSON.stringify(data))}`;
      if (preparedWindow && !preparedWindow.closed) {
        preparedWindow.location.href = url.toString();
        return true;
      }
      return Boolean(window.open(url.toString(), '_blank'));
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
    confirmClose: () => {},
    cancelClose: () => {},
    createFolder: data => invoke('folder:create', [data]),
    createDocument: data => invoke('document:create', [data]),
    mutateFolder: data => invoke('folder:mutate', [data]),
    markFolderUsed: data => send('folder:used', [data]),
    importItems: async (data = {}) => {
      // Dropped/pasted browser File objects arrive via `paths`; without them
      // a picker opens, then everything streams through POST /upload into the
      // host's shared import pipeline.
      let files = Array.isArray(data.paths) && data.paths.length && typeof data.paths[0] !== 'string'
        ? data.paths
        : null;
      if (!files) files = await pickBrowserFiles({ multiple: data.multiple !== false });
      if (!files.length) return { canceled: true };
      return uploadBrowserFiles(files, data);
    },
    importClipboard: async () => ({ count: 0, ready: 0, rejected: [], source: 'unsupported' }),
    pathForFile: () => null,
    showInFinder: async () => false,
    filePath: id => invoke('item:file-path', [id]),
    fileURL: async id => `/media/original/${encodeURIComponent(String(id))}`,
    readMetadata: id => invoke('item:metadata', [id]),
    openDefault: async () => unsupported('网页版无法在主机上打开文件'),
    exportFiles: async data => {
      // Export means "download to this device": one file arrives as-is,
      // multiple as a store-zip streamed by the host.
      const ids = [...new Set(data?.ids || [])].filter(Boolean);
      if (!ids.length) return { canceled: true };
      const anchor = document.createElement('a');
      anchor.href = `/export?ids=${ids.map(encodeURIComponent).join(',')}`;
      anchor.download = '';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return { canceled: false, count: ids.length, missing: 0, downloaded: true };
    },
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
    onNewWindowRequest: callback => on('command:new-window', callback),
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
