'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu, clipboard, nativeImage, ShareMenu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { EagleClient } = require('./lib/eagle-client');
const { DataHub } = require('./lib/data-hub');
const { PinStore } = require('./lib/pin-store');
const { SupplementalItemStore } = require('./lib/supplemental-item-store');
const { readText, saveText } = require('./lib/text-file-service');
const { createImportService } = require('./lib/import-service');
const { clipboardFilePaths, finalizeMacImageClipboard, writeClipboardFilePaths } = require('./lib/clipboard-files');
const { readMetadata } = require('./lib/metadata-reader');
const { mimeForPath } = require('./lib/media-mime');
const { findPreviewImagePath } = require('./lib/preview-image');
const { DuplicateIndex, findDuplicateImports, pairImportedIdsWithFolders } = require('./lib/duplicate-service');
const { createErrorLog } = require('./lib/error-log');
const { createWebServer, generateAccessKey } = require('./lib/web-server');
const { createTrashScanService } = require('./lib/trash-scan-service');
const { exportFiles } = require('./lib/export-service');
const {
  normalizeNewFileType,
  validateNewItemName,
  nextAvailableName,
  createTemporaryNewFile
} = require('./lib/new-file-service');

protocol.registerSchemesAsPrivileged([
  { scheme: 'eaglemv', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

const client = new EagleClient();
const hub = new DataHub(client);
const windows = new Set();
const thumbnailCache = new Map();
const metadataCache = new Map();
const duplicateIndex = new DuplicateIndex();
let dragSequence = 0;
const dragCleanupTimers = new Map();
const trashScans = createTrashScanService({ fs: fsp });
let quitting = false;
let pinStore;
let supplementalItemStore;
let tagColorState;
let errorLog;

function errorLogDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function getErrorLog() {
  errorLog ||= createErrorLog({ file: path.join(errorLogDir(), 'error.log') });
  return errorLog;
}

function logFault(source, message, detail) {
  console.error(`[${source}] ${message}`, detail ?? '');
  getErrorLog().write({ level: 'error', source, message, detail });
}

// Field-support mode: the user reports issues after the fact, so uncaught
// main-process failures must survive in userData/logs instead of a dialog
// nobody screenshots. Handlers log and keep the app alive.
process.on('uncaughtException', error => {
  logFault('main', `uncaughtException: ${error?.message || error}`, error);
});
process.on('unhandledRejection', reason => {
  logFault('main', `unhandledRejection: ${reason?.message || reason}`, reason);
});
app.on('render-process-gone', (_event, contents, details) => {
  logFault('main', `渲染进程异常退出（${details.reason}，exitCode ${details.exitCode}）：${contents.getURL()}`);
});
app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit') return;
  logFault('main', `子进程异常退出（${details.type}/${details.reason}，exitCode ${details.exitCode ?? '未知'}）`);
});

async function loadTagColors() {
  if (tagColorState) return tagColorState;
  tagColorState = { version: 1, libraries: {} };
  try {
    const file = path.join(app.getPath('userData'), 'state', 'tag-colors.json');
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (parsed?.version === 1 && parsed.libraries && typeof parsed.libraries === 'object') tagColorState = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Unable to read tag colors:', error);
  }
  return tagColorState;
}

async function getTagColors(libraryPath) {
  const state = await loadTagColors();
  return structuredClone(state.libraries[path.resolve(libraryPath)] || {});
}

async function setTagColor(libraryPath, tag, color) {
  const state = await loadTagColors();
  const key = path.resolve(libraryPath);
  state.libraries[key] ||= {};
  if (color) state.libraries[key][tag] = color;
  else delete state.libraries[key][tag];
  const file = path.join(app.getPath('userData'), 'state', 'tag-colors.json');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, file);
  return structuredClone(state.libraries[key]);
}

const importPaths = createImportService({
  client,
  ensureLibraryPath: libraryPath => hub.ensureLibraryPath(libraryPath),
  onInvalidate: reason => broadcast('hub:query-invalidated', { reason }),
  itemCache: hub.itemCache
});
const creationQueues = new Map();

function enqueueCreation(key, operation) {
  const previous = creationQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  creationQueues.set(key, current);
  return current.finally(() => {
    if (creationQueues.get(key) === current) creationQueues.delete(key);
  });
}

async function listDestinationItems(folderId) {
  const items = [];
  let offset = 0;
  while (true) {
    const page = await hub.query({
      ...(folderId ? { folderId } : { unfiled: true }),
      offset,
      limit: 500
    });
    const batch = Array.isArray(page?.data) ? page.data : [];
    items.push(...batch);
    const nextOffset = Number(page?.nextOffset ?? offset + batch.length);
    if (!page?.hasMore || nextOffset <= offset || !batch.length) break;
    offset = nextOffset;
  }
  return items;
}

async function waitForImportedFile(id, libraryPath, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let item = null;
  while (Date.now() < deadline) {
    try {
      item = await client.getItem(id);
      const fileURL = await client.fileURLForItem(item, libraryPath);
      if (fileURL) return { item, fileURL };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return { item, fileURL: null };
}

function siblingFolders(folders, parentId) {
  if (!parentId) return folders || [];
  return findFolder(folders, parentId)?.children || [];
}

function getPinStore() {
  pinStore ||= new PinStore(path.join(app.getPath('userData'), 'state', 'pins.json'));
  return pinStore;
}

function getSupplementalItemStore() {
  supplementalItemStore ||= new SupplementalItemStore(path.join(app.getPath('userData'), 'state', 'supplemental-items.json'));
  return supplementalItemStore;
}

async function hydrateSupplementalItems(libraryPath, { notify = false } = {}) {
  if (!libraryPath) {
    hub.setSupplementalItems(null, []);
    return [];
  }
  const ids = await getSupplementalItemStore().get(libraryPath);
  const loaded = await Promise.all(ids.map(id => client.getItem(id).catch(() => null)));
  const items = loaded.filter(item => item?.id && !item.isDeleted);
  hub.setSupplementalItems(libraryPath, items);
  const validIds = items.map(item => item.id);
  if (validIds.length !== ids.length) await getSupplementalItemStore().set(libraryPath, validIds);
  if (notify) hub.emit('query-invalidated', { reason: 'supplemental-items-hydrated', ids: validIds });
  return items;
}

function findFolder(nodes, id) {
  for (const folder of nodes || []) {
    if (folder.id === id) return folder;
    const child = findFolder(folder.children, id);
    if (child) return child;
  }
  return null;
}

function broadcast(channel, payload) {
  for (const window of windows) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
  // Web clients are additional "windows": every hub broadcast fans out to the
  // /events WebSocket so browsers stay in the same live-sync loop.
  webServer?.broadcast(channel, payload);
}

// --- optional web access ----------------------------------------------------
let webServer = null;
let webAccessState = null;
let lastWebServerError = null;

function webAccessFile() {
  return path.join(app.getPath('userData'), 'state', 'web-access.json');
}

async function loadWebAccessState() {
  if (webAccessState) return webAccessState;
  webAccessState = { version: 1, enabled: false, port: 41600, key: null, requireKey: true };
  try {
    const parsed = JSON.parse(await fsp.readFile(webAccessFile(), 'utf8'));
    if (parsed?.version === 1) {
      webAccessState.enabled = Boolean(parsed.enabled);
      const port = Number(parsed.port);
      if (Number.isInteger(port) && port >= 1024 && port <= 65535) webAccessState.port = port;
      if (typeof parsed.key === 'string' && parsed.key) webAccessState.key = parsed.key;
      if (parsed.requireKey === false) webAccessState.requireKey = false;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') logFault('web', `无法读取 Web 访问设置：${error.message}`, error);
  }
  return webAccessState;
}

async function saveWebAccessState(state) {
  webAccessState = state;
  const file = webAccessFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, file);
}

async function resolveMediaPathForWeb(kind, id) {
  const fileURL = await resolveMediaURL(kind, id);
  if (!fileURL || !String(fileURL).startsWith('file:')) return null;
  try {
    return fileURLToPath(fileURL);
  } catch {
    return null;
  }
}

function listWebAddresses(port) {
  const results = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const info of entries || []) {
      if (info.family !== 'IPv4' || info.internal || info.address.startsWith('169.254.')) continue;
      // Tailscale hands out CGNAT range addresses (100.64.0.0/10).
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(info.address);
      results.push({ interface: name, address: info.address, url: `http://${info.address}:${port}`, tailscale });
    }
  }
  return results.sort((a, b) => Number(a.tailscale) - Number(b.tailscale));
}

async function webAccessStatus() {
  const state = await loadWebAccessState();
  return {
    enabled: state.enabled,
    port: state.port,
    key: state.key,
    requireKey: state.requireKey !== false,
    running: Boolean(webServer?.listening),
    clientCount: webServer?.clientCount || 0,
    addresses: listWebAddresses(state.port),
    error: lastWebServerError
  };
}

async function applyWebAccess() {
  lastWebServerError = null;
  if (webServer) {
    const stopping = webServer;
    webServer = null;
    await stopping.stop().catch(() => {});
  }
  const state = await loadWebAccessState();
  if (!state.enabled || !state.key) return;
  const server = createWebServer({
    srcDir: path.join(__dirname, 'src'),
    invoke: invokeWebRPC,
    resolveMediaPath: resolveMediaPathForWeb,
    accessKey: state.key,
    requireKey: state.requireKey !== false,
    uploadImport: importPaths,
    uploadDir: path.join(app.getPath('userData'), 'temp', 'web-uploads'),
    onClientGone: id => hub.removeWatcher(id),
    logError: (message, detail) => logFault('web', message, detail)
  });
  try {
    await server.start(state.port);
    webServer = server;
    hub.startPolling();
    getErrorLog().write({ level: 'info', source: 'web', message: `Web 访问已启动：0.0.0.0:${state.port}` });
  } catch (error) {
    lastWebServerError = error?.message || 'Web 服务启动失败';
    await server.stop().catch(() => {});
    logFault('web', `Web 服务启动失败（端口 ${state.port}）：${lastWebServerError}`);
  }
}

function finishDrag(token) {
  if (!token) return;
  const timer = dragCleanupTimers.get(token);
  if (timer) clearTimeout(timer);
  dragCleanupTimers.delete(token);
  broadcast('item:drag-state', { active: false, token });
}

function focusBrowserWindow(window) {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  app.focus({ steal: true });
  window.focus();
  window.moveTop();
  return true;
}

hub.on('status', payload => broadcast('hub:status', payload));
hub.on('library-changed', payload => {
  duplicateIndex.invalidate();
  duplicateIndex.warm(payload.library?.path).catch(() => {});
  trashScans.invalidateAll({ abort: payload.libraryChanged });
  if (payload.libraryChanged) {
    thumbnailCache.clear();
    metadataCache.clear();
    hydrateSupplementalItems(payload.library?.path, { notify: true }).catch(error => console.error('Unable to hydrate supplemental items:', error));
  }
  broadcast('hub:library-changed', payload);
});
hub.on('items-changed', payload => {
  trashScans.invalidateAll({ abort: true });
  broadcast('hub:items-changed', payload);
});
hub.on('query-invalidated', payload => {
  trashScans.invalidateAll({ abort: true });
  broadcast('hub:query-invalidated', payload);
});
hub.on('supplemental-indexed', payload => {
  getSupplementalItemStore().remove(payload.libraryPath, payload.ids).catch(error => console.error('Unable to prune supplemental items:', error));
});

function createWindow(initialState = null) {
  hub.startPolling();
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: 'Eagle MultiView',
    backgroundColor: '#111317',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 17, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true
    }
  });
  windows.add(window);
  const webContentsId = window.webContents.id;
  window.__allowClose = false;
  window.__closePromptPending = false;
  window.__initialState = initialState;
  window.on('close', event => {
    if (window.__allowClose || window.webContents.isDestroyed()) return;
    event.preventDefault();
    if (window.__closePromptPending) return;
    window.__closePromptPending = true;
    window.webContents.send('command:request-close');
  });
  window.on('closed', () => {
    windows.delete(window);
    hub.removeWatcher(webContentsId);
  });
  window.on('enter-full-screen', () => window.webContents.send('window:chrome-state', { fullScreen: true }));
  window.on('leave-full-screen', () => window.webContents.send('window:chrome-state', { fullScreen: false }));
  window.on('unresponsive', () => logFault(`renderer#${webContentsId}`, '窗口长时间无响应'));
  window.webContents.on('preload-error', (_event, preloadPath, error) =>
    logFault(`renderer#${webContentsId}`, `preload 加载失败：${preloadPath}`, error));
  window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 (ERR_ABORTED) fires on ordinary in-app navigation cancellations.
    if (isMainFrame && code !== -3) logFault(`renderer#${webContentsId}`, `窗口页面加载失败（${code} ${description}）：${url}`);
  });
  window.loadFile(path.join(__dirname, 'src', 'index.html'));
  return window;
}

function setupMenu() {
  const template = [
    {
      label: 'Eagle MultiView',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '文件',
      submenu: [
        { label: '新建文件夹', accelerator: 'Alt+N', click: (_item, window) => window?.webContents.send('command:create-folder') },
        { label: '新建 TXT', accelerator: 'Alt+Shift+N', click: (_item, window) => window?.webContents.send('command:create-document', { type: 'txt' }) },
        {
          label: '新建文件',
          submenu: [
            { label: 'Markdown', click: (_item, window) => window?.webContents.send('command:create-document', { type: 'md' }) },
            { label: 'JSON', click: (_item, window) => window?.webContents.send('command:create-document', { type: 'json' }) },
            { label: 'HTML', click: (_item, window) => window?.webContents.send('command:create-document', { type: 'html' }) },
            { label: 'SVG', click: (_item, window) => window?.webContents.send('command:create-document', { type: 'svg' }) }
          ]
        },
        { label: '新建智能文件夹…', click: (_item, window) => window?.webContents.send('command:create-smart-folder') },
        { type: 'separator' },
        { label: '新建资料库窗口', accelerator: 'CmdOrCtrl+Alt+N', click: () => createWindow() },
        { label: '导入文件…', accelerator: 'CmdOrCtrl+Shift+O', click: (_item, window) => window?.webContents.send('command:import') },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { label: '重命名', accelerator: 'CmdOrCtrl+R', click: (_item, window) => window?.webContents.send('command:rename') },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '显示',
      submenu: [
        { role: 'reload', label: '重新载入窗口', accelerator: 'CmdOrCtrl+Shift+R' },
        { role: 'togglefullscreen', label: '全屏' },
        { type: 'separator' },
        {
          label: 'Web 访问…',
          click: (_item, window) => window?.webContents.send('command:web-access')
        },
        { type: 'separator' },
        {
          label: '打开错误日志文件夹',
          click: async () => {
            await fsp.mkdir(errorLogDir(), { recursive: true }).catch(() => {});
            shell.openPath(errorLogDir());
          }
        }
      ]
    },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function resolveMediaURL(kind, id) {
  if (!id) return null;
  if (kind === 'folder') {
    const folder = findFolder(hub.library?.folders, id);
    const cover = folder?.covers?.[0];
    const source = typeof cover === 'string' ? cover.match(/src=["']([^"']+)["']/)?.[1] : null;
    if (!source) return null;
    try {
      const filePath = fileURLToPath(source.replaceAll('&amp;', '&'));
      return fs.existsSync(filePath) ? pathToFileURL(filePath).toString() : null;
    } catch {
      return null;
    }
  }
  if (kind === 'thumb') {
    let filePath = thumbnailCache.get(id);
    if (!filePath) {
      filePath = await client.thumbnailPath(id);
      if (filePath) thumbnailCache.set(id, filePath);
    }
    return filePath && fs.existsSync(filePath) ? pathToFileURL(filePath).toString() : null;
  }
  if (kind === 'preview') {
    // High-res stand-in for originals Chromium cannot decode (PSD/TIFF/HEIC):
    // Eagle keeps a generated preview image next to the original in .info.
    try {
      const { filePath } = await itemFilePath(id);
      if (filePath) {
        const previewPath = await findPreviewImagePath(path.dirname(filePath), path.basename(filePath));
        if (previewPath) return pathToFileURL(previewPath).toString();
      }
    } catch {}
    return resolveMediaURL('thumb', id);
  }
  const item = hub.itemCache.get(id) || await client.getItem(id);
  const library = hub.library || await client.libraryInfo();
  return (await client.fileURLForItem(item, library.path)) || resolveMediaURL('thumb', id);
}

async function itemFilePath(id) {
  const item = hub.itemCache.get(id) || await client.getItem(id);
  const library = hub.library || await client.libraryInfo();
  const fileURL = await client.fileURLForItem(item, library.path);
  return { item, filePath: fileURL ? fileURLToPath(fileURL) : null };
}

async function settleWithConcurrency(values, worker, concurrency = 8) {
  const results = [];
  let cursor = 0;
  const run = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      try {
        results[index] = { ok: true, value: await worker(values[index]) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, run));
  return results;
}

async function resolveItemFiles(ids) {
  const uniqueIds = [...new Set(ids || [])].filter(Boolean);
  const results = await settleWithConcurrency(uniqueIds, itemFilePath, 8);
  return results.map((result, index) => result.ok
    ? { id: uniqueIds[index], ...result.value, error: null }
    : { id: uniqueIds[index], item: null, filePath: null, error: result.error });
}

function cachedItemFilePath(id) {
  const item = hub.itemCache.get(id);
  const libraryPath = hub.library?.path;
  if (!item || !libraryPath) return null;
  const itemFolder = path.join(libraryPath, 'images', `${item.id}.info`);
  const expected = path.join(itemFolder, `${item.name}.${item.ext}`);
  if (fs.existsSync(expected)) return expected;
  try {
    const extension = `.${String(item.ext || '').toLowerCase()}`;
    const match = fs.readdirSync(itemFolder).find(name => name.toLowerCase().endsWith(extension) && !name.includes('_thumbnail'));
    return match ? path.join(itemFolder, match) : null;
  } catch {
    return null;
  }
}

async function copyItemFiles(ids) {
  const resolved = await resolveItemFiles(ids);
  const paths = resolved.map(entry => entry.filePath).filter(Boolean);
  const copied = writeClipboardFilePaths(clipboard, paths);
  if (copied.length === 1) {
    const scriptPath = app.isPackaged
      ? path.join(process.resourcesPath, 'copy-image.applescript')
      : path.join(__dirname, 'resources', 'copy-image.applescript');
    const finalized = finalizeMacImageClipboard(copied[0], scriptPath);
    if (!finalized.ok) {
      return { count: 0, missing: resolved.length - copied.length, message: finalized.message };
    }
  }
  return { count: copied.length, missing: resolved.length - copied.length };
}

function dragIcon(id, filePath) {
  for (const candidate of [thumbnailCache.get(id), filePath, path.join(process.resourcesPath, 'icon.icns')]) {
    if (!candidate) continue;
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return image.resize({ width: 96, height: 96, quality: 'good' });
  }
  return nativeImage.createEmpty();
}

async function readTrashItems(libraryPath) {
  await hub.ensureLibraryPath(libraryPath);
  return trashScans.read(libraryPath);
}

function filterTrashItems(items, query = {}) {
  let filtered = items;
  const keyword = query.search?.trim().toLocaleLowerCase('zh-CN');
  if (keyword) {
    const words = keyword.split(/\s+/).filter(Boolean);
    filtered = filtered.filter(item => words.every(word => `${item.name || ''} ${(item.tags || []).join(' ')} ${item.annotation || ''}`.toLocaleLowerCase('zh-CN').includes(word)));
  }
  if (query.tags?.length) filtered = filtered.filter(item => query.tags.every(tag => (item.tags || []).includes(tag)));
  if (query.ext) filtered = filtered.filter(item => String(item.ext || '').toLowerCase() === String(query.ext).toLowerCase());
  if (Number.isInteger(query.rating)) filtered = filtered.filter(item => Number(item.star || 0) === query.rating);
  return filtered;
}

async function importClipboard({ folderId, libraryPath }) {
  const filePaths = clipboardFilePaths(clipboard);
  if (filePaths.length) return { ...(await importPaths({ paths: filePaths, folderId, libraryPath })), source: 'files' };

  const image = clipboard.readImage();
  if (image.isEmpty()) return { count: 0, ready: 0, rejected: [], source: 'empty' };
  const temporaryDir = path.join(app.getPath('temp'), 'Eagle MultiView Paste');
  await fsp.mkdir(temporaryDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const temporaryPath = path.join(temporaryDir, `粘贴的图像-${stamp}.png`);
  await fsp.writeFile(temporaryPath, image.toPNG());
  try {
    const result = await importPaths({ paths: [temporaryPath], folderId, libraryPath });
    setTimeout(() => fsp.unlink(temporaryPath).catch(() => {}), result.ready ? 15000 : 5 * 60 * 1000);
    return { ...result, source: 'image' };
  } catch (error) {
    setTimeout(() => fsp.unlink(temporaryPath).catch(() => {}), 5 * 60 * 1000);
    throw error;
  }
}

async function installProtocol() {
  protocol.handle('eaglemv', async request => {
    try {
      const url = new URL(request.url);
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const fileURL = await resolveMediaURL(url.hostname, id);
      if (!fileURL) {
        return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" rx="24" fill="#0b0d11"/><path d="M112 76h58l38 38v110H112z" fill="#242832"/><path d="M170 76v40h38" fill="none" stroke="#59606d" stroke-width="8"/><text x="160" y="178" text-anchor="middle" fill="#7e8590" font-family="sans-serif" font-size="22">FILE</text></svg>', { headers: { 'Content-Type': 'image/svg+xml' } });
      }
      const range = request.headers.get('Range');
      const response = await net.fetch(fileURL, range ? { headers: { Range: range } } : undefined);
      // file:// responses carry no Content-Type and no CORS headers. Images
      // and media survive on sniffing, but Chromium's PDF viewer and fetch()
      // callers are blocked by ORB/CORS without them.
      const headers = new Headers(response.headers);
      const mime = mimeForPath(fileURL.pathname || fileURL);
      if (mime) headers.set('Content-Type', mime);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Accept-Ranges', 'bytes');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      return new Response(error.message || 'Media error', { status: 500 });
    }
  });
}

// Every renderer-facing operation registers here once and is served over both
// transports: ipcMain for Electron windows and POST /rpc for web clients.
// Channels in HOST_ONLY_CHANNELS depend on host dialogs, the host clipboard,
// the shell, or window chrome; the web shim implements them locally or hides
// the entry points via its capabilities table, and the web RPC rejects them.
const HOST_ONLY_CHANNELS = new Set([
  'item:set-custom-thumbnail', 'items:import', 'items:import-clipboard',
  'item:show-in-finder', 'item:open-default', 'items:export', 'items:open-other',
  'items:share', 'clipboard:write-files', 'clipboard:write-text', 'shell:open-external',
  'item:start-drag', 'item:cancel-drag', 'window:new', 'window:initial-state',
  'window:focus', 'window:is-fullscreen', 'window:confirm-close', 'window:cancel-close',
  'item:file-url', 'web-access:get', 'web-access:set', 'web-access:reset-key'
]);
const rpcRegistry = new Map();

function handleRPC(channel, handler) {
  rpcRegistry.set(channel, handler);
  ipcMain.handle(channel, handler);
}

function onRPC(channel, handler) {
  rpcRegistry.set(channel, handler);
  ipcMain.on(channel, handler);
}

async function invokeWebRPC(method, args, sender) {
  const handler = rpcRegistry.get(method);
  if (!handler || HOST_ONLY_CHANNELS.has(method)) {
    throw new Error(`此操作仅桌面版支持（${method}）`);
  }
  return handler({ sender }, ...(Array.isArray(args) ? args : []));
}

function setupIPC() {
  onRPC('log:renderer-error', (event, entry) => {
    getErrorLog().write({
      level: entry?.level === 'warn' ? 'warn' : 'error',
      source: `renderer#${event.sender.id}`,
      message: entry?.message,
      detail: entry?.detail
    });
  });
  handleRPC('hub:connect', async () => {
    const result = await hub.connect();
    await hydrateSupplementalItems(result.library?.path);
    duplicateIndex.warm(result.library?.path).catch(() => {});
    return result;
  });
  handleRPC('hub:identity', event => event.sender.id);
  handleRPC('library:history', async () => {
    const paths = await client.listLibraryHistory();
    return paths.map(libraryPath => ({
      path: libraryPath,
      name: path.basename(libraryPath).replace(/\.library$/i, ''),
      exists: fs.existsSync(libraryPath)
    }));
  });
  handleRPC('library:switch', async (_event, payload = {}) => {
    const libraryPath = EagleClient.normalizeLibraryPath(payload.libraryPath);
    if (!libraryPath) throw new Error('缺少资料库路径');
    if (EagleClient.normalizeLibraryPath(hub.library?.path) === libraryPath) return { switched: false, library: hub.library };
    await client.switchLibrary(libraryPath);
    if (!await client.waitForLibrary(libraryPath)) {
      throw new Error('Eagle 未能在预期时间内完成切换，请稍后重试');
    }
    // connect() sees the path change and emits library-changed, which the hub
    // listener broadcasts to every window and uses to refresh caches and
    // supplemental items — the same flow as an Eagle-side switch.
    const result = await hub.connect();
    return { switched: true, library: result.library };
  });
  handleRPC('hub:query', (_event, query) => hub.query(query));
  handleRPC('hub:recent-folders', () => client.listRecentFolders());
  handleRPC('hub:trash-items', async (_event, { libraryPath, ...query }) => {
    try {
      const filtered = filterTrashItems(await readTrashItems(libraryPath), query);
      const offset = Math.max(0, Number(query.offset) || 0);
      const limit = Math.min(500, Math.max(1, Number(query.limit) || 160));
      const data = filtered.slice(offset, offset + limit);
      return { data, total: filtered.length, nextOffset: offset + data.length, hasMore: offset + data.length < filtered.length };
    } catch (error) {
      if (!['TRASH_SCAN_TIMEOUT', 'TRASH_SCAN_INVALIDATED'].includes(error.code)) throw error;
      return {
        data: [],
        total: 0,
        nextOffset: 0,
        hasMore: false,
        error: { code: error.code, message: error.message }
      };
    }
  });
  handleRPC('hub:get-item', (_event, id) => client.getItem(id));
  const refreshItemAfterCommentMutation = async (event, payload, operation, reason) => {
    const { id, libraryPath } = payload || {};
    if (!id) throw new Error('缺少素材 ID');
    await hub.ensureLibraryPath(libraryPath);
    const result = await operation(id);
    await hub.ensureLibraryPath(libraryPath);
    const item = await client.getItem(id);
    hub.itemCache.set(id, item);
    broadcast('hub:items-changed', { items: [item], source: 'multiview', origin: event.sender.id });
    broadcast('hub:query-invalidated', { reason, id });
    return result;
  };
  handleRPC('item:comments', async (_event, { id, libraryPath }) => {
    await hub.ensureLibraryPath(libraryPath);
    return client.getComments(id);
  });
  handleRPC('item:add-comment', (event, payload) => {
    const { id, libraryPath, ...comment } = payload || {};
    return refreshItemAfterCommentMutation(event, { id, libraryPath }, itemId => client.addComment(itemId, comment), 'comment-add');
  });
  handleRPC('item:update-comment', (event, payload) =>
    refreshItemAfterCommentMutation(event, payload, (id) => client.updateComment(id, payload.commentId, payload.patch || {}), 'comment-update'));
  handleRPC('item:remove-comment', (event, payload) =>
    refreshItemAfterCommentMutation(event, payload, (id) => client.removeComment(id, payload.commentId), 'comment-remove'));
  handleRPC('item:set-custom-thumbnail', async (event, payload) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const { id, libraryPath } = payload || {};
    if (!id) throw new Error('缺少素材 ID');
    let filePath = payload.filePath;
    if (!filePath) {
      const chooser = await dialog.showOpenDialog(parent, {
        title: '选择自定义缩略图',
        buttonLabel: '使用缩略图',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff'] }]
      });
      if (chooser.canceled || !chooser.filePaths[0]) return { canceled: true };
      filePath = chooser.filePaths[0];
    }
    await hub.ensureLibraryPath(libraryPath);
    const result = await client.setCustomThumbnail(id, filePath, payload.width, payload.height);
    thumbnailCache.delete(id);
    await hub.ensureLibraryPath(libraryPath);
    const item = await client.getItem(id);
    hub.itemCache.set(id, item);
    broadcast('hub:items-changed', { items: [item], source: 'multiview', origin: event.sender.id });
    broadcast('hub:query-invalidated', { reason: 'custom-thumbnail', id });
    return { canceled: false, result, item };
  });
  handleRPC('hub:tags', () => client.listTags());
  handleRPC('hub:tag-groups', () => client.listTagGroups());
  const refreshLibraryAfterMutation = async (event, libraryPath, operation, reason) => {
    await hub.ensureLibraryPath(libraryPath);
    const result = await operation();
    const [library, folders] = await Promise.all([client.libraryInfo(), client.folderTree()]);
    library.folders = folders;
    hub.library = library;
    hub.lastModificationTime = library.modificationTime;
    broadcast('hub:library-changed', { library, libraryChanged: false, source: 'multiview', origin: event.sender.id });
    broadcast('hub:query-invalidated', { reason });
    return result;
  };
  handleRPC('smart-folder:create', (event, { libraryPath, ...payload }) =>
    refreshLibraryAfterMutation(event, libraryPath, () => client.createSmartFolder(payload), 'smart-folder-create'));
  handleRPC('smart-folder:update', (event, { libraryPath, id, patch }) =>
    refreshLibraryAfterMutation(event, libraryPath, () => client.updateSmartFolder(id, patch), 'smart-folder-update'));
  handleRPC('smart-folder:remove', (event, { libraryPath, id }) =>
    refreshLibraryAfterMutation(event, libraryPath, () => client.removeSmartFolder(id), 'smart-folder-remove'));
  handleRPC('tag-colors:get', (_event, { libraryPath }) => getTagColors(libraryPath));
  handleRPC('tag-colors:set', (_event, { libraryPath, tag, color }) => setTagColor(libraryPath, tag, color));
  const mutateTagData = async (event, libraryPath, operation, reason) => {
    await hub.ensureLibraryPath(libraryPath);
    const result = await operation();
    broadcast('tag-data:changed', { libraryPath, origin: event.sender.id, reason });
    broadcast('hub:query-invalidated', { reason });
    return result;
  };
  handleRPC('tag:rename', (event, { libraryPath, originalName, name }) =>
    mutateTagData(event, libraryPath, () => client.renameTag(originalName, name), 'tag-rename'));
  handleRPC('tag:merge', (event, { libraryPath, source, target }) =>
    mutateTagData(event, libraryPath, () => client.mergeTag(source, target), 'tag-merge'));
  handleRPC('tag-group:create', (event, { libraryPath, name }) =>
    mutateTagData(event, libraryPath, () => client.createTagGroup(name), 'tag-group-create'));
  handleRPC('tag-group:update', (event, { libraryPath, id, patch }) =>
    mutateTagData(event, libraryPath, () => client.updateTagGroup(id, patch), 'tag-group-update'));
  handleRPC('tag-group:remove', (event, { libraryPath, id }) =>
    mutateTagData(event, libraryPath, () => client.removeTagGroup(id), 'tag-group-remove'));
  handleRPC('tag-group:add-tags', (event, { libraryPath, groupId, tags }) =>
    mutateTagData(event, libraryPath, () => client.addTagsToGroup(groupId, tags), 'tag-group-add-tags'));
  handleRPC('tag-group:remove-tags', (event, { libraryPath, groupId, tags }) =>
    mutateTagData(event, libraryPath, () => client.removeTagsFromGroup(groupId, tags), 'tag-group-remove-tags'));
  handleRPC('hub:mutate', (event, mutation) => hub.mutate({ ...mutation, origin: event.sender.id }));
  handleRPC('hub:mutate-set', (event, mutation) => hub.mutateSet({ ...mutation, origin: event.sender.id }));
  handleRPC('folder:mutate', (event, mutation) => hub.mutateFolder({ ...mutation, origin: event.sender.id }));
  onRPC('folder:used', (event, payload = {}) => {
    broadcast('folder:used', {
      folderId: payload.folderId || null,
      libraryPath: payload.libraryPath || null,
      origin: event.sender.id
    });
  });
  handleRPC('hub:watch-items', (event, ids) => {
    hub.setWatchedIds(event.sender.id, ids);
    return true;
  });
  handleRPC('window:new', (_event, initialState = null) => {
    createWindow(initialState);
    return true;
  });
  handleRPC('window:initial-state', event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const initialState = window?.__initialState || null;
    if (window) window.__initialState = null;
    return initialState;
  });
  handleRPC('window:focus', event => {
    return focusBrowserWindow(BrowserWindow.fromWebContents(event.sender));
  });
  handleRPC('window:is-fullscreen', event => {
    return Boolean(BrowserWindow.fromWebContents(event.sender)?.isFullScreen());
  });
  onRPC('window:confirm-close', event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    window.__closePromptPending = false;
    window.__allowClose = true;
    window.close();
    if (quitting) setImmediate(() => app.quit());
  });
  onRPC('window:cancel-close', event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) window.__closePromptPending = false;
    quitting = false;
  });
  handleRPC('folder:create', (event, { name = '未命名文件夹', parent, libraryPath }) => {
    const requestedName = validateNewItemName(name);
    const libraryKey = path.resolve(libraryPath);
    return enqueueCreation(`folder:${libraryKey}:${parent || 'root'}`, async () => {
      await hub.ensureLibraryPath(libraryPath);
      const folders = await client.folderTree();
      if (parent && !findFolder(folders, parent)) throw new Error('目标文件夹已不存在，请刷新后重试');
      const availableName = nextAvailableName(requestedName, siblingFolders(folders, parent));
      const apiResult = await refreshLibraryAfterMutation(event, libraryPath, () => client.createFolder(availableName, parent), 'folder-create');
      const createdFolder = siblingFolders(hub.library?.folders, parent).find(folder =>
        String(folder?.name || '').trim().toLocaleLowerCase('zh-CN') === availableName.toLocaleLowerCase('zh-CN'));
      return {
        id: createdFolder?.id || apiResult?.id || null,
        name: availableName,
        renamed: availableName !== requestedName
      };
    });
  });
  handleRPC('document:create', (event, payload = {}) => {
    const type = normalizeNewFileType(payload.type);
    const requestedName = validateNewItemName(payload.name, { extension: type });
    const folderId = payload.folderId || null;
    const libraryPath = payload.libraryPath;
    const libraryKey = path.resolve(libraryPath);
    return enqueueCreation(`document:${libraryKey}:${folderId || 'unfiled'}`, async () => {
      await hub.ensureLibraryPath(libraryPath);
      if (folderId) {
        const folders = await client.folderTree();
        if (!findFolder(folders, folderId)) throw new Error('目标文件夹已不存在，请刷新后重试');
      }
      const existingItems = await listDestinationItems(folderId);
      const availableName = nextAvailableName(requestedName, existingItems, type);
      const temporary = await createTemporaryNewFile({
        root: path.join(app.getPath('userData'), 'temp', 'new-files'),
        name: availableName,
        type
      });
      let importedId = null;
      try {
        const imported = await importPaths({
          paths: [temporary.filePath],
          folderId,
          libraryPath,
          waitTimeoutMs: 4000
        });
        if (!imported.count || !imported.ids?.length) {
          throw new Error(imported.rejected?.[0]?.message || 'Eagle 没有返回新文件的素材 ID');
        }
        duplicateIndex.invalidate(libraryPath);
        const id = imported.ids[0];
        importedId = id;
        const ready = await waitForImportedFile(id, libraryPath);
        if (!ready.fileURL) throw new Error(`Eagle 未能完成 ${type.toUpperCase()} 文件复制`);
        const item = ready.item;
        if (item) hub.itemCache.set(id, item);
        const currentLibrary = await client.libraryInfo().catch(() => null);
        if (currentLibrary?.path === libraryPath) {
          currentLibrary.folders = await client.folderTree();
          hub.library = currentLibrary;
          hub.lastModificationTime = currentLibrary.modificationTime;
          broadcast('hub:library-changed', {
            library: currentLibrary,
            libraryChanged: false,
            source: 'multiview',
            origin: event.sender.id
          });
        }
        broadcast('hub:items-changed', {
          items: item ? [item] : [],
          ids: [id],
          source: 'multiview',
          origin: event.sender.id,
          reason: 'document-create'
        });
        return {
          ...imported,
          id,
          item,
          type,
          name: availableName,
          renamed: availableName !== requestedName
        };
      } catch (error) {
        if (importedId) {
          await client.updateItem(importedId, { isDeleted: true }).catch(() => {});
          broadcast('hub:query-invalidated', { reason: 'document-create-rollback', id: importedId });
        }
        throw error;
      } finally {
        await temporary.cleanup().catch(error => console.error('Unable to clean new-file temporary directory:', error));
      }
    });
  });
  handleRPC('items:import', async (event, { folderId, libraryPath, paths, duplicateChoice = null }) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    let filePaths = paths;
    if (!filePaths?.length) {
      const result = await dialog.showOpenDialog(parent, {
        title: folderId ? '导入到当前 Eagle 文件夹' : '导入到 Eagle 未分类',
        buttonLabel: '导入',
        properties: ['openFile', 'multiSelections']
      });
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      filePaths = result.filePaths;
    }
    try {
      const duplicates = await findDuplicateImports({ paths: filePaths, libraryPath, index: duplicateIndex });
      if (!duplicateChoice && duplicates.length) return { canceled: false, needsDuplicateDecision: true, paths: filePaths, duplicates };
      if (duplicateChoice === 'cancel') return { canceled: true };
      const duplicateByPath = new Map();
      for (const duplicate of duplicates) if (!duplicateByPath.has(duplicate.path)) duplicateByPath.set(duplicate.path, duplicate);
      const useExisting = duplicateChoice === 'use-existing';
      const existing = useExisting ? [...duplicateByPath.values()] : [];
      const importPathsToUse = useExisting ? filePaths.filter(candidate => !duplicateByPath.has(path.resolve(candidate))) : filePaths;
      const imported = importPathsToUse.length
        ? await importPaths({ paths: importPathsToUse, folderId, libraryPath })
        : { count: 0, ready: 0, ids: [], rejected: [] };
      if (imported.count) duplicateIndex.invalidate(libraryPath);
      let existingIds = existing.map(duplicate => duplicate.id);
      let duplicateFailed = 0;
      if (useExisting && existing.length && folderId) {
        const assignments = await settleWithConcurrency(existing, duplicate => hub.mutateSet({
          id: duplicate.id,
          field: 'folders',
          add: [folderId],
          libraryPath,
          origin: event.sender.id
        }), 4);
        existingIds = assignments.flatMap((result, index) => result.ok ? [existing[index].id] : []);
        duplicateFailed = assignments.length - existingIds.length;
      }
      const result = {
        ...imported,
        count: imported.count + existingIds.length,
        ready: imported.ready + existingIds.length,
        ids: [...imported.ids, ...existingIds],
        duplicateCount: existingIds.length,
        duplicateFailed
      };
      return { canceled: false, ...result };
    } finally {
      focusBrowserWindow(parent);
      setTimeout(() => focusBrowserWindow(parent), 350);
    }
  });
  handleRPC('items:import-clipboard', (_event, data) => importClipboard(data));
  handleRPC('item:show-in-finder', async (_event, id) => {
    const { filePath } = await itemFilePath(id);
    if (!filePath) return false;
    shell.showItemInFolder(filePath);
    return true;
  });
  handleRPC('item:file-path', async (_event, id) => {
    const { filePath } = await itemFilePath(id);
    return filePath || null;
  });
  handleRPC('item:file-url', async (_event, id) => {
    const { filePath } = await itemFilePath(id);
    return filePath ? pathToFileURL(filePath).toString() : null;
  });
  handleRPC('item:metadata', async (_event, id) => {
    const { item, filePath } = await itemFilePath(id);
    if (!filePath) return { itemId: id, metadata: null, error: '找不到素材原文件' };
    const cacheKey = `${id}:${item.modificationTime || item.size || 0}`;
    if (metadataCache.has(cacheKey)) return { itemId: id, metadata: metadataCache.get(cacheKey) };
    try {
      const metadata = await readMetadata(filePath, item.ext);
      if (metadataCache.size > 500) metadataCache.delete(metadataCache.keys().next().value);
      metadataCache.set(cacheKey, metadata);
      return { itemId: id, metadata };
    } catch (error) {
      return { itemId: id, metadata: null, error: error.message || '读取元数据失败' };
    }
  });
  handleRPC('item:open-default', async (_event, id) => {
    const { filePath } = await itemFilePath(id);
    if (!filePath) return { ok: false, message: '找不到素材原文件' };
    const message = await shell.openPath(filePath);
    return message ? { ok: false, message } : { ok: true };
  });
  handleRPC('items:export', async (event, { ids, libraryPath }) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const destination = await dialog.showOpenDialog(parent, {
      title: '导出素材到文件夹',
      buttonLabel: '选择导出目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (destination.canceled || !destination.filePaths[0]) return { canceled: true };
    const resolved = await resolveItemFiles(ids);
    const exported = await exportFiles({
      filePaths: resolved.map(entry => entry.filePath).filter(Boolean),
      destinationRoot: destination.filePaths[0],
      libraryPath,
      fs: { ...fsp, existsSync: candidate => fs.existsSync(candidate) }
    });
    return {
      canceled: false,
      ...exported,
      missing: exported.missing + resolved.filter(entry => !entry.filePath).length,
      requested: resolved.length
    };
  });
  handleRPC('items:open-other', async (event, { ids }) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const chooser = await dialog.showOpenDialog(parent, {
      title: '选择打开素材的应用',
      buttonLabel: '选择应用',
      defaultPath: process.platform === 'darwin' ? '/Applications' : undefined,
      properties: ['openFile']
    });
    if (chooser.canceled || !chooser.filePaths[0]) return { canceled: true };
    const resolved = await resolveItemFiles(ids);
    const files = resolved.map(entry => entry.filePath).filter(Boolean);
    if (!files.length) return { canceled: false, count: 0, missing: resolved.length };
    if (process.platform !== 'darwin') return { canceled: false, count: 0, missing: 0, message: '其它应用打开目前仅支持 macOS' };
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/open', ['-a', chooser.filePaths[0], ...files], { detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return { canceled: false, count: files.length, missing: resolved.length - files.length };
  });
  handleRPC('items:share', async (event, { ids }) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const resolved = await resolveItemFiles(ids);
    const files = resolved.map(entry => entry.filePath).filter(Boolean);
    if (!files.length) return { ok: false, message: '找不到可分享的素材原文件' };
    if (typeof ShareMenu !== 'function') return { ok: false, message: '当前系统不支持分享菜单' };
    new ShareMenu({ filePaths: files }).popup({ window: parent });
    return { ok: true, count: files.length, missing: resolved.length - files.length };
  });
  handleRPC('items:duplicate', async (event, { ids, folderId, libraryPath, preserveFolders = false }) => {
    const resolved = await resolveItemFiles(ids);
    const paths = resolved.map(entry => entry.filePath).filter(Boolean);
    if (!paths.length) return { count: 0, missing: resolved.length };
    const imported = await importPaths({ paths, folderId: folderId || null, libraryPath });
    if (preserveFolders && imported.ids?.length) {
      const assignments = pairImportedIdsWithFolders(imported.ids, resolved.filter(entry => entry.filePath));
      const folderAssignments = await settleWithConcurrency(assignments, ({ id, folders }) => hub.mutateSet({
        id,
        field: 'folders',
        add: folders,
        libraryPath,
        origin: event.sender.id
      }), 4);
      imported.folderAssignmentFailed = folderAssignments.filter(result => !result.ok).length;
    }
    const supplementalItems = (await Promise.all((imported.ids || []).map(id => client.getItem(id).catch(() => null)))).filter(Boolean);
    if (supplementalItems.length) {
      await getSupplementalItemStore().add(libraryPath, supplementalItems.map(item => item.id));
      hub.addSupplementalItems(libraryPath, supplementalItems);
      for (const item of supplementalItems) hub.itemCache.set(item.id, item);
      hub.emit('items-changed', { items: supplementalItems, source: 'multiview', origin: event.sender.id });
      hub.emit('query-invalidated', { reason: 'duplicate-supplemental', ids: supplementalItems.map(item => item.id) });
    }
    return { ...imported, missing: resolved.length - paths.length };
  });
  handleRPC('clipboard:write-files', (_event, ids) => copyItemFiles(ids));
  handleRPC('clipboard:write-text', (_event, value) => {
    clipboard.writeText(String(value || ''));
    return true;
  });
  handleRPC('shell:open-external', async (_event, value) => {
    const url = String(value || '').trim();
    // Only real web URLs may leave the app; file:, smb: etc. stay blocked.
    if (!/^https?:\/\//i.test(url)) throw new Error('只支持打开 http/https 网址');
    await shell.openExternal(url);
    return true;
  });
  onRPC('item:start-drag', (event, data) => {
    const payload = Array.isArray(data) ? { ids: data } : (data || {});
    const uniqueIds = [...new Set(payload.ids || [])];
    // Resolve from the in-memory item cache synchronously. Calling startDrag
    // after an async IPC round-trip can outlive the renderer's dragstart event
    // and leave Chromium's native drag session waiting indefinitely on macOS.
    const resolved = uniqueIds.map(id => ({ id, filePath: cachedItemFilePath(id) }));
    const files = resolved.map(entry => entry.filePath).filter(Boolean);
    if (!files.length) {
      broadcast('item:drag-state', { active: false });
      event.returnValue = { ok: false, message: '找不到素材原文件' };
      event.sender.send('item:drag-finished', { ok: false, message: '找不到素材原文件' });
      return;
    }
    const token = ++dragSequence;
    broadcast('item:drag-state', {
      active: true,
      token,
      ids: uniqueIds,
      sourceFolderId: payload.sourceFolderId || null,
      sourcePaneId: payload.sourcePaneId || null,
      sourceWindowId: payload.sourceWindowId || null,
      libraryPath: payload.libraryPath || hub.library?.path || null
    });
    try {
      event.sender.startDrag({ file: files[0], files, icon: dragIcon(uniqueIds[0], files[0]) });
      event.returnValue = { ok: true, count: files.length, missing: uniqueIds.length - files.length };
      event.sender.send('item:drag-finished', { ok: true, count: files.length, missing: uniqueIds.length - files.length });
    } catch (error) {
      finishDrag(token);
      event.returnValue = { ok: false, message: error.message || '无法开始文件拖动' };
      event.sender.send('item:drag-finished', { ok: false, message: error.message || '无法开始文件拖动' });
    }
    // Keep the fallback ids available for the complete native drag session.
    // A short timer made long drags lose their ids before drop and could leave
    // the renderer stuck in a drag state. Renderer drop/dragend clears this;
    // the long timer is only a last-resort recovery for an aborted session.
    clearTimeout(dragCleanupTimers.get(token));
    dragCleanupTimers.set(token, setTimeout(() => {
      finishDrag(token);
    }, 30000));
  });
  onRPC('item:cancel-drag', (_event, token) => finishDrag(token));
  handleRPC('pins:get', async (_event, { libraryPath }) => {
    await hub.ensureLibraryPath(libraryPath);
    return getPinStore().get(libraryPath);
  });
  handleRPC('pins:set', async (_event, { libraryPath, folderId, ids, pinned }) => {
    await hub.ensureLibraryPath(libraryPath);
    const pins = await getPinStore().set(libraryPath, folderId, ids, pinned);
    broadcast('pins:changed', { libraryPath, pins });
    return pins;
  });
  handleRPC('text:read', async (_event, { id, libraryPath }) => {
    await hub.ensureLibraryPath(libraryPath);
    const { item, filePath } = await itemFilePath(id);
    return readText({ item, filePath, libraryPath });
  });
  handleRPC('web-access:get', () => webAccessStatus());
  handleRPC('web-access:set', async (_event, payload = {}) => {
    const state = await loadWebAccessState();
    const port = Number(payload.port ?? state.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口无效，应为 1024–65535');
    const enabled = Boolean(payload.enabled);
    const requireKey = payload.requireKey === undefined ? state.requireKey !== false : Boolean(payload.requireKey);
    if (enabled && !state.key) state.key = generateAccessKey();
    await saveWebAccessState({ ...state, enabled, port, requireKey });
    await applyWebAccess();
    return webAccessStatus();
  });
  handleRPC('web-access:reset-key', async () => {
    const state = await loadWebAccessState();
    state.key = generateAccessKey();
    await saveWebAccessState(state);
    // Live sessions and sockets die with the old key.
    webServer?.setAccessKey(state.key);
    return webAccessStatus();
  });
  handleRPC('text:save', async (_event, { id, libraryPath, content, base, force }) => {
    await hub.ensureLibraryPath(libraryPath);
    const { item, filePath } = await itemFilePath(id);
    const result = await saveText({
      item,
      filePath,
      libraryPath,
      content,
      base,
      force,
      backupRoot: path.join(app.getPath('userData'), 'Text Backups')
    });
    if (!result.conflict) {
      client.refreshThumbnail(id).catch(() => {});
      broadcast('text:changed', { id, origin: _event.sender.id, fingerprint: result.fingerprint });
      broadcast('hub:query-invalidated', { reason: 'text-saved' });
    }
    return result;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('before-quit', () => {
    quitting = true;
    webServer?.stop().catch(() => {});
  });
  app.on('second-instance', () => createWindow());
  app.whenReady().then(async () => {
    getErrorLog().write({
      level: 'info',
      source: 'main',
      message: `Eagle MultiView ${app.getVersion()} 启动（Electron ${process.versions.electron}）`
    });
    setupMenu();
    setupIPC();
    await installProtocol();
    createWindow();
    hub.startPolling();
    applyWebAccess().catch(error => logFault('web', `Web 访问初始化失败：${error.message}`, error));
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('window-all-closed', () => {
    // Web clients keep the hub alive: with the server up they still need
    // polling-driven change events even when every desktop window is gone.
    if (!webServer?.listening) hub.stopPolling();
    if (process.platform !== 'darwin') app.quit();
  });
}
