'use strict';
// Isolated synthetic library. No real Eagle calls, files, or credentials.
// Model the default LAN HTTP capability boundary even in file-based probes.
const realHttpCapabilities = process.argv.includes('--eaglemv-http-capabilities');
if (!realHttpCapabilities) Object.defineProperty(window.crypto, 'randomUUID', { value: undefined, configurable: true });
const clone = value => JSON.parse(JSON.stringify(value));
const listeners = {};
const folderA = { id: 'folder-a', name: 'Alpha', children: [], imageCount: 202 };
const folderB = { id: 'folder-b', name: 'Beta', children: [], imageCount: 160 };
const items = [
  { id: 'text-1', name: 'Audit text', ext: 'txt', size: 8, tags: [], folders: ['folder-a'], annotation: '', star: 0 },
  ...Array.from({ length: 360 }, (_, index) => ({ id: `item-${index + 1}`, name: `Item ${String(index + 1).padStart(3, '0')}`, ext: 'png', width: 1000, height: 800, size: 1000, tags: [], folders: [index < 200 ? 'folder-a' : 'folder-b'], annotation: '', star: 0, btime: 1700000000000 + index }))
];
let readResolve = null;
let mutationResolve = null;
let textSaveResolve = null;
let textContent = 'original';
let textRevision = 1;
window.__audit = {
  readDelay: false, mutationDelay: false, textSaveDelay: false, textSaveMode: 'normal', textSavesInFlight: 0, maxTextSavesInFlight: 0, failIds: [], calls: [], confirmations: [],
  emit(name, payload) { return listeners[name]?.(payload); },
  resolveRead() { readResolve?.(); readResolve = null; },
  resolveMutation() { mutationResolve?.(); mutationResolve = null; },
  resolveTextSave() { textSaveResolve?.(); textSaveResolve = null; },
  snapshotText() { return textContent; },
  externalItemChange(id, patch) { Object.assign(items.find(item => item.id === id), clone(patch)); },
  snapshotItem(id) { return clone(items.find(item => item.id === id)); }
};
window.confirm = message => { window.__audit.confirmations.push(message); return false; };
let mutationHub = null;
const realMutationEvents = process.argv.includes('--eaglemv-real-mutation-events');
if (process.argv.includes('--eaglemv-real-mutation-hub') || realMutationEvents) {
  const { DataHub } = require('../lib/data-hub');
  mutationHub = new DataHub({
    libraryInfo: async () => ({ path: '/mock/interaction-audit.library' }),
    getItem: async id => clone(items.find(item => item.id === id)),
    updateItem: async (id, patch) => {
      const item = items.find(candidate => candidate.id === id);
      Object.assign(item, clone(patch));
      if (window.__audit.ackReadbackTime) item.lastModified = window.__audit.ackReadbackTime.ack;
      const response = clone(item);
      if (window.__audit.ackReadbackTime) item.lastModified = window.__audit.ackReadbackTime.readback;
      return response;
    },
    request: async (_url, options) => ({ data: clone(items.filter(item => options.body.ids.includes(item.id))) })
  });
  mutationHub.library = { path: '/mock/interaction-audit.library' };
  if (realMutationEvents) {
    window.__audit.pollSelectedItem = async () => {
      mutationHub.setWatchedIds('fixture', ['item-1']);
      await mutationHub.refreshWatchedItems();
    };
    mutationHub.on('items-changed', payload => listeners.onItemsChanged?.(clone(payload)));
    mutationHub.on('query-invalidated', payload => listeners.onQueryInvalidated?.(clone(payload)));
  }
}
const bridge = {
  platform: realHttpCapabilities ? 'web' : 'darwin',
  capabilities: { nativeDrag: false, hostDialogs: false, clipboardFiles: false, finder: false, openDefault: false, openOther: false, share: false, export: false, importLocal: false, customThumbnail: false, copyPath: false, webAccess: false },
  mediaURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  identity: async () => 'isolated-interaction-audit',
  connect: async () => ({ app: { version: 'mock' }, library: { path: '/mock/interaction-audit.library', name: 'Audit fixture', folders: [folderA, folderB], smartFolders: [] } }),
  initialWindowState: async () => ({ view: { kind: 'all' } }),
  currentEagleWindowState: async () => ({ view: { kind: 'all' } }),
  query: async (query = {}) => {
    if (realMutationEvents) window.__audit.calls.push({ kind: 'query' });
    let data = items.filter(item => !item.isDeleted);
    if (query.folderId) data = data.filter(item => item.folders.includes(query.folderId));
    if (query.unfiled) data = data.filter(item => !item.folders.length);
    if (query.search) data = data.filter(item => item.name.toLowerCase().includes(query.search.toLowerCase()));
    if (query.rating !== null && query.rating !== undefined) data = data.filter(item => item.star === query.rating);
    const offset = query.offset || 0, limit = query.limit || 160;
    return { data: clone(data.slice(offset, offset + limit)), total: data.length, nextOffset: offset + limit, hasMore: offset + limit < data.length };
  },
  getItem: async id => clone(items.find(item => item.id === id) || null),
  mutate: async payload => {
    window.__audit.calls.push({ kind: 'mutate', ...clone(payload) });
    if (window.__audit.failIds.includes(payload.id)) throw new Error('fixture partial failure');
    if (window.__audit.mutationDelay) await new Promise(resolve => { mutationResolve = resolve; });
    if (mutationHub) return mutationHub.mutate(realMutationEvents ? { ...payload, origin: 'isolated-interaction-audit' } : payload);
    const item = items.find(candidate => candidate.id === payload.id);
    Object.assign(item, payload.patch);
    return { ok: true, item: clone(item) };
  },
  mutateSet: async payload => {
    window.__audit.calls.push({ kind: 'mutate-set', ...clone(payload) });
    if (window.__audit.failIds.includes(payload.id)) throw new Error('fixture partial failure');
    const item = items.find(candidate => candidate.id === payload.id);
    const values = new Set(item[payload.field] || []);
    (payload.add || []).forEach(value => values.add(value));
    (payload.remove || []).forEach(value => values.delete(value));
    item[payload.field] = [...values];
    return { ok: true, item: clone(item) };
  },
  duplicateFiles: async ({ ids, folderId, preserveFolders }) => {
    const copied = ids.map((id, index) => ({ ...clone(items.find(item => item.id === id)), id: `copy-${index + 1}`, folders: preserveFolders ? clone(items.find(item => item.id === id).folders) : [folderId] }));
    items.push(...copied);
    return { count: copied.length, ids: copied.map(item => item.id) };
  },
  readText: async () => {
    if (window.__audit.readDelay) await new Promise(resolve => { readResolve = resolve; });
    return { content: textContent, fingerprint: { size: textContent.length, mtimeMs: textRevision } };
  },
  saveText: async payload => {
    window.__audit.calls.push({ kind: 'save-text', ...clone(payload) });
    window.__audit.textSavesInFlight += 1;
    window.__audit.maxTextSavesInFlight = Math.max(window.__audit.maxTextSavesInFlight, window.__audit.textSavesInFlight);
    try {
    if (window.__audit.textSaveDelay) await new Promise(resolve => { textSaveResolve = resolve; });
    if (window.__audit.textSaveMode === 'fail') throw new Error('fixture plugin disconnected');
    if (window.__audit.textSaveMode === 'conflict') return { conflict: true, current: { content:'external text', fingerprint:{ size:13, mtimeMs:99 } } };
    textContent = payload.content;
    textRevision += 1;
    return { fingerprint: { size: textContent.length, mtimeMs: textRevision }, status: window.__audit.textSaveMode === 'pending' ? 'written_pending_refresh' : 'saved' };
    } finally { window.__audit.textSavesInFlight -= 1; }
  },
  getComments: async () => [], readMetadata: async () => ({ metadata: null }),
  importItems: async () => clone(window.__audit.importResult),
  addComment: async payload => { window.__audit.calls.push({kind:'add-comment',...clone(payload)}); return {id:'comment-1'}; },
  getPins: async () => ({}), getTags: async () => [], getTagGroups: async () => [], getRecentFolders: async () => [], getTagColors: async () => ({}),
  getTrashItems: async () => ({ data: [], total: 0, nextOffset: 0, hasMore: false }),
  isFullScreen: async () => false,
  confirmClose: () => window.__audit.calls.push({ kind: 'confirm-close' }),
  cancelClose: () => window.__audit.calls.push({ kind: 'cancel-close' })
};
if (process.argv.includes('--eaglemv-real-drafts')) {
  const { ipcRenderer } = require('electron');
  for (const [method, operation] of Object.entries({ putTextDraft: 'put', getTextDraft: 'get', removeTextDraft: 'remove', listTextDrafts: 'list' })) {
    bridge[method] = payload => {
      window.__audit.calls.push({ kind: 'draft-' + operation, ...clone(payload) });
      return ipcRenderer.invoke('audit:text-draft', operation, payload);
    };
  }
}
window.eagleMV = new Proxy(bridge, {
  get(target, name) {
    if (name in target) return target[name];
    if (String(name).startsWith('on')) return callback => { listeners[name] = callback; return () => {}; };
    return async () => null;
  }
});
