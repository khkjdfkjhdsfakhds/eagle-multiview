'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { EagleClient } = require('./lib/eagle-client');
const { DataHub } = require('./lib/data-hub');
const { PinStore } = require('./lib/pin-store');
const { readText, saveText } = require('./lib/text-file-service');
const { createImportService } = require('./lib/import-service');
const { clipboardFilePaths } = require('./lib/clipboard-files');

protocol.registerSchemesAsPrivileged([
  { scheme: 'eaglemv', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

const client = new EagleClient();
const hub = new DataHub(client);
const windows = new Set();
const thumbnailCache = new Map();
let quitting = false;
let pinStore;

const importPaths = createImportService({
  client,
  ensureLibraryPath: libraryPath => hub.ensureLibraryPath(libraryPath),
  onInvalidate: reason => broadcast('hub:query-invalidated', { reason }),
  itemCache: hub.itemCache
});

function getPinStore() {
  pinStore ||= new PinStore(path.join(app.getPath('userData'), 'state', 'pins.json'));
  return pinStore;
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
}

hub.on('status', payload => broadcast('hub:status', payload));
hub.on('library-changed', payload => {
  if (payload.libraryChanged) thumbnailCache.clear();
  broadcast('hub:library-changed', payload);
});
hub.on('items-changed', payload => broadcast('hub:items-changed', payload));
hub.on('query-invalidated', payload => broadcast('hub:query-invalidated', payload));

function createWindow() {
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
      sandbox: true
    }
  });
  windows.add(window);
  const webContentsId = window.webContents.id;
  window.__allowClose = false;
  window.__closePromptPending = false;
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
        { label: '新建资料库窗口', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
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
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '显示',
      submenu: [
        { role: 'reload', label: '重新载入窗口' },
        { role: 'togglefullscreen', label: '全屏' }
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

async function showItemContextMenu(event, data) {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const selectedIds = [...new Set(data?.ids || [])];
  if (!selectedIds.length) return false;
  const first = await itemFilePath(selectedIds[0]);
  const one = selectedIds.length === 1;
  const folderId = data?.folderId || null;
  const allPinned = Boolean(data?.allPinned);
  const menu = Menu.buildFromTemplate([
    {
      label: one ? '使用默认应用打开' : `使用默认应用打开（已选择 ${selectedIds.length} 项）`,
      enabled: one && Boolean(first.filePath),
      click: () => first.filePath && shell.openPath(first.filePath)
    },
    {
      label: '在 Finder 中显示',
      enabled: Boolean(first.filePath),
      click: () => first.filePath && shell.showItemInFolder(first.filePath)
    },
    { type: 'separator' },
    {
      label: '复制文件路径',
      enabled: one && Boolean(first.filePath),
      click: () => first.filePath && clipboard.writeText(first.filePath)
    },
    {
      label: one ? '复制素材名称' : `复制 ${selectedIds.length} 个素材名称`,
      click: async () => {
        const names = [];
        for (const id of selectedIds) names.push((hub.itemCache.get(id) || await client.getItem(id)).name);
        clipboard.writeText(names.join('\n'));
      }
    },
    { type: 'separator' },
    ...(folderId ? [{
      label: allPinned ? '取消置顶' : '置顶',
      click: () => event.sender.send('command:pin-selection', { pinned: !allPinned })
    }, { type: 'separator' }] : []),
    { label: '移入废纸篓…', click: () => event.sender.send('command:trash-selection') }
  ]);
  menu.popup({ window: parent });
  return true;
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
      return net.fetch(fileURL);
    } catch (error) {
      return new Response(error.message || 'Media error', { status: 500 });
    }
  });
}

function setupIPC() {
  ipcMain.handle('hub:connect', () => hub.connect());
  ipcMain.handle('hub:identity', event => event.sender.id);
  ipcMain.handle('hub:query', (_event, query) => hub.query(query));
  ipcMain.handle('hub:get-item', (_event, id) => client.getItem(id));
  ipcMain.handle('hub:tags', () => client.listTags());
  ipcMain.handle('hub:mutate', (event, mutation) => hub.mutate({ ...mutation, origin: event.sender.id }));
  ipcMain.handle('hub:mutate-set', (event, mutation) => hub.mutateSet({ ...mutation, origin: event.sender.id }));
  ipcMain.handle('hub:watch-items', (event, ids) => {
    hub.setWatchedIds(event.sender.id, ids);
    return true;
  });
  ipcMain.handle('window:new', () => {
    createWindow();
    return true;
  });
  ipcMain.on('window:confirm-close', event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    window.__closePromptPending = false;
    window.__allowClose = true;
    window.close();
    if (quitting) setImmediate(() => app.quit());
  });
  ipcMain.on('window:cancel-close', event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) window.__closePromptPending = false;
    quitting = false;
  });
  ipcMain.handle('folder:create', async (_event, { name, parent, libraryPath }) => {
    await hub.ensureLibraryPath(libraryPath);
    const result = await client.createFolder(name, parent);
    broadcast('hub:query-invalidated', { reason: 'folder-create' });
    return result;
  });
  ipcMain.handle('items:import', async (event, { folderId, libraryPath, paths }) => {
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
    return { canceled: false, ...(await importPaths({ paths: filePaths, folderId, libraryPath })) };
  });
  ipcMain.handle('items:import-clipboard', (_event, data) => importClipboard(data));
  ipcMain.handle('item:show-in-finder', async (_event, id) => {
    const { filePath } = await itemFilePath(id);
    if (!filePath) return false;
    shell.showItemInFolder(filePath);
    return true;
  });
  ipcMain.handle('item:open-default', async (_event, id) => {
    const { filePath } = await itemFilePath(id);
    if (!filePath) return { ok: false, message: '找不到素材原文件' };
    const message = await shell.openPath(filePath);
    return message ? { ok: false, message } : { ok: true };
  });
  ipcMain.handle('item:context-menu', (event, data) => showItemContextMenu(event, data));
  ipcMain.handle('pins:get', async (_event, { libraryPath }) => {
    await hub.ensureLibraryPath(libraryPath);
    return getPinStore().get(libraryPath);
  });
  ipcMain.handle('pins:set', async (_event, { libraryPath, folderId, ids, pinned }) => {
    await hub.ensureLibraryPath(libraryPath);
    const pins = await getPinStore().set(libraryPath, folderId, ids, pinned);
    broadcast('pins:changed', { libraryPath, pins });
    return pins;
  });
  ipcMain.handle('text:read', async (_event, { id, libraryPath }) => {
    await hub.ensureLibraryPath(libraryPath);
    const { item, filePath } = await itemFilePath(id);
    return readText({ item, filePath, libraryPath });
  });
  ipcMain.handle('text:save', async (_event, { id, libraryPath, content, base, force }) => {
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
  app.on('before-quit', () => { quitting = true; });
  app.on('second-instance', () => createWindow());
  app.whenReady().then(async () => {
    setupMenu();
    setupIPC();
    await installProtocol();
    createWindow();
    hub.startPolling();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('window-all-closed', () => {
    hub.stopPolling();
    if (process.platform !== 'darwin') app.quit();
  });
}
