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
  // Idle, not total: a large video on slow Wi-Fi keeps going as long as
  // bytes move, and only a stalled upload is abandoned.
  const uploadIdleTimeoutMs = 120000;

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
        // Each socket gets a new id; the renderer keys "my own change" on it,
        // so hand over the new one (H-09). identity() alone settles only once.
        if (clientId) emit('web:client-id', { clientId });
        if (sessionEverConnected) {
          // Reconnected after a drop: re-sync connection state and make every
          // pane refetch, mirroring what a desktop window sees after a hiccup.
          invoke('hub:connect')
            .then(result => {
              emit('hub:status', { connected: true });
              // Events broadcast while the socket was down are lost: replay
              // the host's current snapshot (another library, a changed
              // folder tree, or a restarted host) before refetching panes.
              if (result?.library) {
                emit('hub:library-changed', {
                  library: result.library,
                  source: 'multiview',
                  origin: null,
                  revision: result.revision,
                  hubInstance: result.hubInstance,
                  reason: 'web-reconnected'
                });
              }
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
  // Phones stop the page while another app (the system file picker, say) is
  // in front; on return, reconnect at once instead of waiting out a backoff
  // that grew while hidden.
  window.addEventListener('visibilitychange', () => {
    if (disposed || document.visibilityState === 'hidden') return;
    if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) return;
    retryDelay = 1000;
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
  // A page restored from the back/forward cache keeps this script's state,
  // including the disposal above: start the connection again (H-12).
  window.addEventListener('pageshow', event => {
    if (!event.persisted || !disposed) return;
    disposed = false;
    retryDelay = 1000;
    connectEvents();
  });
  connectEvents();

  // --- host-only degradations ----------------------------------------------
  const unsupported = message => ({ ok: false, message });
  let dragToken = 0;

  function manualCopy(text) {
    return new Promise((resolve, reject) => {
      const previousFocus = document.activeElement;
      const dialog = document.createElement('dialog');
      dialog.className = 'web-copy-dialog';
      dialog.setAttribute('aria-label', '手动复制文本');
      const explanation = document.createElement('p');
      explanation.textContent = '浏览器未允许自动复制。请长按或使用系统复制命令复制下方已选中的文本。';
      const field = document.createElement('textarea');
      field.value = text;
      field.readOnly = true;
      field.rows = 8;
      field.setAttribute('aria-label', '待复制文本');
      const done = document.createElement('button');
      done.textContent = '已手动复制';
      const cancel = document.createElement('button');
      cancel.textContent = '取消';
      let settled = false;
      const finish = copied => {
        if (settled) return;
        settled = true;
        dialog.remove();
        previousFocus?.focus?.({ preventScroll: true });
        if (copied) resolve(true);
        else reject(Object.assign(new Error('已取消复制'), { code: 'COPY_CANCELED' }));
      };
      done.addEventListener('click', () => finish(true));
      cancel.addEventListener('click', () => finish(false));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      dialog.addEventListener('keydown', event => {
        // Keep native text selection/copy and button activation, but never let
        // the obscured renderer handle navigation, rating, or deletion keys.
        // Escape must stay contained even after finish removes the dialog.
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        if (event.key === 'Tab') {
          const elements = [field, done, cancel];
          const index = elements.indexOf(document.activeElement);
          event.preventDefault();
          elements[(index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length].focus();
        }
      });
      dialog.append(explanation, field, done, cancel);
      document.body.appendChild(dialog);
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else { dialog.setAttribute('open', ''); dialog.setAttribute('aria-modal', 'true'); }
      field.focus();
      field.select();
    });
  }

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

  const thumbnailJobs = new Map();
  async function thumbnailOperation(data) {
    const job = { canceled: false, submitted: false };
    thumbnailJobs.set(data.requestId, job);
    try {
    const payload = { operation: data.operation, ids: [...data.ids], libraryPath: data.libraryPath, requestId: data.requestId };
    if (data.operation === 'refresh') { job.submitted = true; return await invoke('item:thumbnail-operation', [payload]); }
    let blob;
    if (data.operation === 'clipboard') {
      if (!navigator.clipboard?.read) throw new Error('当前浏览器未开放图片剪贴板，请使用“从文件设置”');
      const entries = await navigator.clipboard.read();
      for (const entry of entries) {
        const type = entry.types.find(value => ['image/png', 'image/jpeg', 'image/webp'].includes(value));
        if (type) { blob = await entry.getType(type); break; }
      }
      if (!blob) throw new Error('当前设备剪贴板中没有支持的图片');
    } else if (data.operation === 'file') {
      [blob] = await pickBrowserFiles({ multiple: false });
      if (!blob) return { canceled: true };
    } else throw new Error('尚无受支持的取消自定义缩略图接口');
    if (job.canceled) return { canceled: true };
    if (blob.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw new Error('请选择 5 MB 以内的 PNG、JPEG 或 WebP 图片');
    payload.imageData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('读取所选图片失败'));
      reader.readAsDataURL(blob);
    });
    if (job.canceled) return { canceled: true };
    job.submitted = true;
    return await invoke('item:thumbnail-operation', [payload]);
    } finally { thumbnailJobs.delete(data.requestId); }
  }

  // XHR rather than fetch: only XHR reports upload progress, which drives the
  // idle timeout and the progress shown while importing.
  function postUpload(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let idleTimer = null;
      let settled = false;
      let reason = 'network';
      const handle = { abort: () => { reason = 'disposed'; xhr.abort(); } };
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        activeUploadControllers.delete(handle);
        callback(value);
      };
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { reason = 'timeout'; xhr.abort(); }, uploadIdleTimeoutMs);
      };
      const fail = () => settle(reject, Object.assign(new Error(reason), { reason }));
      activeUploadControllers.add(handle);
      xhr.open('POST', url);
      xhr.setRequestHeader('x-eaglemv-client', String(clientId));
      if (xhr.upload) {
        xhr.upload.onprogress = event => {
          armIdle();
          onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
        };
      }
      xhr.onload = () => {
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch {}
        settle(resolve, { status: xhr.status, body });
      };
      xhr.onerror = fail;
      xhr.onabort = fail;
      xhr.ontimeout = fail;
      armIdle();
      xhr.send(file);
    });
  }

  const stagedUploadBatches = new Map();
  let stagedUploadSequence = 0;

  async function uploadBrowserFiles(files, { folderId, libraryPath } = {}) {
    const outcome = { canceled: false, count: 0, ready: 0, ids: [], rejected: [], unknown: [], notSubmitted: [] };
    const batch = ++stagedUploadSequence;
    const staged = [];
    const duplicates = [];
    const fileName = file => file?.name || '未命名文件';
    // Files after a stop are listed, never silently dropped.
    const stopAt = index => { outcome.notSubmitted.push(...files.slice(index).map(fileName)); };
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (disposed) { stopAt(index); break; }
      const query = new URLSearchParams({ name: fileName(file) });
      if (folderId) query.set('folderId', folderId);
      if (libraryPath) query.set('libraryPath', libraryPath);
      emit('upload:progress', { index, total: files.length, name: fileName(file), loaded: 0, size: file.size || 0 });
      try {
        const { status, body } = await postUpload(`/upload?${query}`, file, (loaded, size) => {
          emit('upload:progress', { index, total: files.length, name: fileName(file), loaded, size });
        });
        if (status === 401) {
          location.replace('/login');
          outcome.rejected.push({ path: fileName(file), message: '登录已过期' });
          stopAt(index + 1);
          break;
        }
        if (body?.ok && body.result?.needsDuplicateDecision) {
          // Matches an existing item: the host keeps the file until the
          // duplicate choice for the whole batch is made (H-08).
          staged.push({ uploadToken: body.result.uploadToken, batch });
          duplicates.push(...(body.result.duplicates || []));
        } else if (body?.ok) {
          outcome.count += body.result.count || 0;
          outcome.ready += body.result.ready || 0;
          outcome.ids.push(...(body.result.ids || []));
          outcome.rejected.push(...(body.result.rejected || []));
        } else {
          outcome.rejected.push({ path: fileName(file), message: body?.message || '上传失败' });
        }
      } catch (error) {
        // The host may already have the file: report it as unverified and
        // never replay it or the rest of the batch automatically.
        const message = error?.reason === 'timeout'
          ? '上传超时，结果可能不确定'
          : (disposed || error?.reason === 'disposed' ? '页面已关闭，结果可能不确定' : '连接中断，结果可能不确定');
        outcome.unknown.push(fileName(file));
        outcome.error = { message };
        stopAt(index + 1);
        break;
      }
    }
    emit('upload:progress', null);
    if (!staged.length) return outcome;
    stagedUploadBatches.set(batch, outcome);
    return { ...outcome, needsDuplicateDecision: true, stagedUploads: true, total: files.length, duplicates, paths: staged };
  }

  // Sends the duplicate choice for staged uploads and folds in what the
  // batch already imported, so the result covers every file. Rejections from
  // the first pass were already returned with the decision request.
  async function resolveStagedUploads(staged, duplicateChoice) {
    const batch = staged[0]?.batch;
    const prior = stagedUploadBatches.get(batch) || { count: 0, ready: 0, ids: [], unknown: [], notSubmitted: [] };
    stagedUploadBatches.delete(batch);
    let resolved;
    try {
      const response = await fetch('/upload/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-eaglemv-client': String(clientId) },
        body: JSON.stringify({ tokens: staged.map(entry => entry.uploadToken), choice: duplicateChoice })
      });
      if (response.status === 401) location.replace('/login');
      const body = await response.json().catch(() => null);
      resolved = body?.ok ? body.result : { count: 0, ready: 0, ids: [], rejected: staged.map(() => ({ path: '', message: body?.message || '重复处理失败' })) };
    } catch {
      resolved = { count: 0, ready: 0, ids: [], rejected: [], unknown: staged.map(() => '重复文件'), error: { message: '连接中断，重复文件的处理结果可能不确定' } };
    }
    const count = (prior.count || 0) + (resolved.count || 0);
    return {
      ...resolved,
      canceled: !count && duplicateChoice === 'cancel',
      count,
      ready: (prior.ready || 0) + (resolved.ready || 0),
      ids: [...(prior.ids || []), ...(resolved.ids || [])],
      unknown: [...(prior.unknown || []), ...(resolved.unknown || [])],
      notSubmitted: prior.notSubmitted || [],
      error: prior.error || resolved.error
    };
  }

  // The Android shell tags its WebView user agent. It has one window and no
  // popups, so window.open there would replace the page instead of opening one.
  const androidShell = /\bEagleMultiViewAndroid\//.test(globalThis.navigator?.userAgent || '');
  // The shell's JavaScript bridge (update checks, back to its host screen).
  // Phones have no menu bar, so these live in the page's own menus.
  const androidBridge = androidShell ? globalThis.EagleMVAndroid : null;
  const androidShellApp = androidBridge && typeof androidBridge.request === 'function' ? {
    version: (() => { try { return String(androidBridge.appVersion() || ''); } catch { return ''; } })(),
    checkForUpdates: () => androidBridge.request('check-for-updates'),
    changeHost: () => androidBridge.request('change-host')
  } : null;

  window.eagleMV = {
    platform: 'web',
    capabilities: {
      multiWindow: !androidShell,
      nativeDrag: false,
      hostDialogs: false,
      clipboardFiles: false,
      finder: false,
      openDefault: false,
      openOther: false,
      share: false,
      export: true,
      importLocal: true,
      customThumbnail: true,
      copyPath: false,
      webAccess: false
    },
    shellApp: androidShellApp,
    mediaURL: (kind, id) => `/media/${encodeURIComponent(String(kind))}/${encodeURIComponent(String(id))}`,
    connect: () => invoke('hub:connect'),
    getLibraryHistory: () => invoke('library:history'),
    switchLibrary: data => invoke('library:switch', [data]),
    identity: () => helloPromise,
    query: query => invoke('hub:query', [query]),
    viewStats: query => invoke('hub:view-stats', [query]),
    viewFacets: query => invoke('hub:view-facets', [query]),
    viewIds: query => invoke('hub:view-ids', [query]),
    selectionSummary: data => invoke('hub:selection-summary', [data]),
    locateItem: data => invoke('hub:locate-item', [data]),
    getRecentFolders: () => invoke('hub:recent-folders'),
    getTrashItems: data => invoke('hub:trash-items', [data]),
    getItem: id => invoke('hub:get-item', [id]),
    getComments: data => invoke('item:comments', [data]),
    addComment: data => invoke('item:add-comment', [data]),
    updateComment: data => invoke('item:update-comment', [data]),
    removeComment: data => invoke('item:remove-comment', [data]),
    setCustomThumbnail: data => thumbnailOperation({ ...data, ids: data.ids || [data.id], operation: 'file' }),
    thumbnailOperation: data => thumbnailOperation(data),
    cancelThumbnailOperation: data => {
      const job = thumbnailJobs.get(data.requestId);
      if (job) job.canceled = true;
      return job && !job.submitted ? Promise.resolve({ canceled: true }) : invoke('item:thumbnail-cancel', [data]);
    },
    getTags: () => invoke('hub:tags'),
    getTagGroups: () => invoke('hub:tag-groups'),
    getStarredTags: () => invoke('hub:starred-tags'),
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
    deferClose: () => {},
    createFolder: data => invoke('folder:create', [data]),
    createDocument: data => invoke('document:create', [data]),
    mutateFolder: data => invoke('folder:mutate', [data]),
    updateFolderProperties: data => invoke('folder:update-properties', [data]),
    startSiteImport: data => invoke('site:start', [data]),
    nextSiteImport: data => invoke('site:next', [data]),
    retrySiteImport: data => invoke('site:retry', [data]),
    cancelSiteImport: data => invoke('site:cancel', [data]),
    importSiteSelection: data => invoke('site:import', [data]),
    moveFolder: data => invoke('folder:move', [data]),
    removeFolder: data => invoke('folder:remove', [data]),
    copyFolder: data => invoke('folder:copy', [data]),
    copyFolderPlan: data => invoke('folder:copy-plan', [data]),
    markFolderUsed: data => send('folder:used', [data]),
    importItems: async (data = {}) => {
      // Dropped/pasted browser File objects arrive via `paths`; without them
      // a picker opens, then everything streams through POST /upload into the
      // host's shared import pipeline.
      if (data.duplicateChoice && Array.isArray(data.paths) && data.paths[0]?.uploadToken) return resolveStagedUploads(data.paths, data.duplicateChoice);
      let files = Array.isArray(data.paths) && data.paths.length && typeof data.paths[0] !== 'string'
        ? data.paths
        : null;
      if (!files) files = await pickBrowserFiles({ multiple: data.multiple !== false });
      if (!files.length) return { canceled: true };
      return uploadBrowserFiles(files, data);
    },
    onUploadProgress: callback => on('upload:progress', callback),
    // 导入本地文件夹 reads folders on the host's disk; a browser has none
    // to give, so the menu row and the sidebar drop stay desktop-only.
    planFolderImport: null,
    runFolderImport: null,
    importClipboard: async () => ({ count: 0, ready: 0, rejected: [], source: 'unsupported' }),
    importURL: async () => ({ count: 0, ready: 0, rejected: [], source: 'unsupported' }),
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      let plan;
      try {
        const response = await fetch('/export/prepare', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, libraryPath: data?.libraryPath }), signal: controller.signal
        });
        if (response.status === 401) {
          location.replace('/login');
          throw new Error('登录已过期');
        }
        plan = await response.json().catch(() => null);
        if (!plan?.ok || !/^\/export\?token=/.test(plan.url) || plan.count !== ids.length) {
          throw new Error(plan?.message || '下载准备失败，请重试');
        }
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('下载准备超时，本次未开始下载，请重试');
        throw error;
      } finally {
        clearTimeout(timer);
      }
      const anchor = document.createElement('a');
      anchor.href = plan.url;
      anchor.download = '';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return { canceled: false, count: plan.count, missing: 0, downloaded: true };
    },
    openOther: async () => ({ canceled: true, ...unsupported('网页版无法在主机上打开文件') }),
    shareFiles: async () => unsupported('网页版不支持系统分享'),
    duplicateFiles: data => invoke('items:duplicate', [data]),
    copyFiles: async () => ({ count: 0, missing: 0, message: '网页版不支持复制文件到剪贴板' }),
    copyText: async text => {
      const value = String(text ?? '');
      if (typeof navigator.clipboard?.writeText === 'function') {
        try { await navigator.clipboard.writeText(value); return true; } catch {}
      }
      return manualCopy(value);
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
        sourceFolderIds: Array.isArray(payload.sourceFolderIds) ? payload.sourceFolderIds : null,
        sourcePaneId: payload.sourcePaneId || null,
        sourceWindowId: payload.sourceWindowId || null,
        libraryPath: payload.libraryPath || null
      });
    },
    cancelDrag: token => {
      emit('item:drag-state', { active: false, token });
    },
    getPins: data => invoke('pins:get', [data]),
    getFolderCovers: data => invoke('folder-covers:get', [data]),
    setFolderCover: data => invoke('folder-covers:set', [data]),
    onFolderCoversChanged: callback => on('folder-covers:changed', callback),
    getManualOrders: data => invoke('manual-order:get', [data]),
    moveManualOrder: data => invoke('manual-order:move', [data]),
    moveEagleOrder: data => invoke('eagle-order:move', [data]),
    setPins: data => invoke('pins:set', [data]),
    readText: data => invoke('text:read', [data]),
    saveText: data => invoke('text:save', [data]),
    putTextDraft: data => invoke('text-draft:put', [data]),
    getTextDraft: data => invoke('text-draft:get', [data]),
    listTextDrafts: data => invoke('text-draft:list', [data]),
    removeTextDraft: data => invoke('text-draft:remove', [data]),
    onStatus: callback => on('hub:status', callback),
    onIdentityChanged: callback => on('web:client-id', payload => callback(payload.clientId)),
    onLibraryChanged: callback => on('hub:library-changed', callback),
    onItemsChanged: callback => on('hub:items-changed', callback),
    onQueryInvalidated: callback => on('hub:query-invalidated', callback),
    onTrashSelection: callback => on('command:trash-selection', callback),
    // The desktop binds ⌘/Ctrl+Z through its 编辑 → 撤销 menu; a browser has no
    // application menu, so the same accelerator is bound here. Text fields keep
    // their native text undo, and the primary key follows the platform (⌘ on
    // Apple, Ctrl elsewhere — the Android shell first of all).
    onUndoDelete: callback => {
      const handler = event => {
        if (event.defaultPrevented || event.isComposing || event.repeat) return;
        if (event.code !== 'KeyZ' && String(event.key).toLowerCase() !== 'z') return;
        const keyboard = window.EagleMVKeyboardPlatform?.createKeyboardPlatform(navigator);
        if (!keyboard?.primaryKey(event) || keyboard.otherKey(event) || event.shiftKey || event.altKey) return;
        if (event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
        event.preventDefault();
        callback();
      };
      document.addEventListener('keydown', handler);
      return () => document.removeEventListener('keydown', handler);
    },
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
    onSiteImportRequest: callback => on('command:site-import', callback),
    onCreateFolderRequest: callback => on('command:create-folder', callback),
    onCreateDocumentRequest: callback => on('command:create-document', callback),
    onCreateSmartFolderRequest: callback => on('command:create-smart-folder', callback),
    onNewWindowRequest: callback => on('command:new-window', callback),
    onOpenView: () => () => {},
    onMenuCommand: () => () => {},
    reportMenuState: () => {},
    onPinsChanged: callback => on('pins:changed', callback),
    onManualOrdersChanged: callback => on('manual-order:changed', callback),
    onTagDataChanged: callback => on('tag-data:changed', callback),
    onFolderUsed: callback => on('folder:used', callback),
    onTextChanged: callback => on('text:changed', callback),
    onItemDragState: callback => on('item:drag-state', callback),
    onDragFinished: callback => on('item:drag-finished', callback),
    onRequestClose: callback => on('command:request-close', callback),
    onChromeState: callback => on('window:chrome-state', callback)
  };
})();
