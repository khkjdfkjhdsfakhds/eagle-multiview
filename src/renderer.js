'use strict';

const {
  findFolder,
  findFolderPath,
  normalizeView: normalizeFolderView,
  parentView: resolveParentView,
  recordViewNavigation,
  folderMoveDelta,
  searchFolders
} = window.EagleMVFolderNavigation;
const {
  hasType: dragHasType,
  readItemIds,
  isInternalItemDrag,
  shouldShowImportOverlay
} = window.EagleMVDragDrop;
const {
  createQuery,
  cloneQuery,
  filtersActive: queryFiltersActive,
  filterCount: queryFilterCount,
  selectRange,
  effectiveSortDir,
  compareBySort: compareItemsBySort,
  sharedTags: computeSharedTags
} = window.EagleMVPanestate;
const { buildSmartFolderConditions } = window.EagleMVSmartFolder;
const { createOperationTracker } = window.EagleMVOperationState;
const newFileTypes = Object.freeze({
  txt: { label: 'TXT', defaultName: '未命名文本' },
  md: { label: 'Markdown', defaultName: '未命名文档' },
  json: { label: 'JSON', defaultName: '未命名数据' },
  html: { label: 'HTML', defaultName: '未命名网页' },
  svg: { label: 'SVG', defaultName: '未命名图形' }
});

const paneScopedSelectors = new Set([
  '#backButton', '#forwardButton', '#upButton', '#breadcrumb', '#viewTitle', '#resultCount', '#sortSelect', '#sortDirButton',
  '#gridScroller', '#emptyState', '#emptyRetryButton', '#itemGrid', '#loadIndicator', '#scrollTopButton', '#dropOverlay'
]);
const $ = selector => {
  if (typeof state !== 'undefined' && state.panes?.length && paneScopedSelectors.has(selector)) {
    const active = CSS.escape(state.activePaneId || state.panes[0].id);
    return document.querySelector(`.content-pane[data-pane-id="${active}"] ${selector}`) || document.querySelector(selector);
  }
  return document.querySelector(selector);
};
const state = {
  connected: false,
  library: null,
  items: [],
  total: 0,
  estimatedTotal: false,
  offset: 0,
  nextOffset: 0,
  hasMore: false,
  pageSize: 160,
  loading: false,
  refreshToken: 0,
  selected: new Set(),
  selectedBase: null,
  inspectorDirty: false,
  inspectorSaving: false,
  inspectorAutoSaveTimer: null,
  query: createQuery(),
  sort: 'default',
  sortDir: 'auto',
  viewTitle: '资料库',
  refreshTimer: null,
  toastTimer: null,
  operationTracker: createOperationTracker(),
  windowId: null,
  expandedFolders: new Set(),
  currentView: { kind: 'root' },
  history: [],
  historyIndex: -1,
  selectedFolderCard: null,
  sidebarVisible: true,
  inspectorVisible: true,
  previewId: null,
  previewZoom: { scale: 1, x: 0, y: 0, mode: 'fit', dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 },
  textSession: null,
  textSaving: false,
  previewToken: 0,
  metadataToken: 0,
  commentsToken: 0,
  comments: [],
  availableTags: [],
  tagColors: {},
  recentFolders: [],
  tagGroups: [],
  draftTags: [],
  batchTags: [],
  copiedTags: [],
  contextMenu: null,
  folderDialogResolve: null,
  trashDialogResolve: null,
  duplicateDialogResolve: null,
  localPins: {},
  importing: false,
  suppressPasteUntil: 0,
  dragDepth: 0,
  draggingItemIds: null,
  dragSourcePaneId: null,
  internalDrag: null
};

const paneStateKeys = [
  'items', 'total', 'estimatedTotal', 'offset', 'nextOffset', 'hasMore', 'loading', 'refreshToken', 'errorMessage', 'selected', 'selectedBase',
  'sort', 'sortDir', 'viewTitle', 'currentView', 'history', 'historyIndex', 'selectedFolderCard', 'dragDepth', 'scrollTop', 'query'
];
function createPaneState(id, source = state) {
  return {
    id,
    items: source.items ? [...source.items] : [],
    total: Number(source.total) || 0,
    estimatedTotal: Boolean(source.estimatedTotal),
    offset: Number(source.offset) || 0,
    nextOffset: Number(source.nextOffset) || 0,
    hasMore: Boolean(source.hasMore),
    loading: false,
    refreshToken: 0,
    errorMessage: '',
    selected: new Set(source.selected || []),
    selectedBase: source.selectedBase || null,
    sort: source.sort || 'default',
    sortDir: source.sortDir || 'auto',
    sortCapNotified: false,
    viewTitle: source.viewTitle || '资料库',
    currentView: { ...(source.currentView || { kind: 'root' }) },
    history: [...(source.history || [])],
    historyIndex: Number.isInteger(source.historyIndex) ? source.historyIndex : -1,
    selectedFolderCard: source.selectedFolderCard || null,
    dragDepth: 0,
    draggingItemIds: null,
    scrollTop: 0,
    query: cloneQuery(source.query)
  };
}
state.panes = [createPaneState('pane-1')];
state.activePaneId = 'pane-1';
for (const key of paneStateKeys) {
  const initial = state[key];
  Object.defineProperty(state, key, {
    configurable: true,
    enumerable: true,
    get() { return activePane()?.[key] ?? initial; },
    set(value) { const pane = activePane(); if (pane) pane[key] = value; }
  });
}

const paneLayouts = {
  single: 1,
  vertical2: 2,
  horizontal2: 2,
  grid4: 4,
  leftStack: 3,
  rightStack: 3,
  topStack: 3,
  bottomStack: 3,
  horizontal3: 3,
  vertical3: 3,
  horizontal4: 4,
  vertical4: 4
};
const UI_ZOOM_MIN = 0.8;
const UI_ZOOM_MAX = 1.6;
const UI_ZOOM_STEP = 0.1;
// Non-default sorts pull the full folder so the order is exact; very large
// folders stop auto-fetching here and fall back to scroll-driven loading.
const SORT_FETCH_CAP = 3000;
const LIBRARY_SYNC_DEBOUNCE_MS = 320;
let librarySyncTimer = null;
let librarySyncRunning = false;
let pendingLibraryChange = null;
let visibleItemWatchQueued = false;

function setUIZoom(factor, { persist = true, announce = false } = {}) {
  const next = Math.max(UI_ZOOM_MIN, Math.min(UI_ZOOM_MAX, Math.round(Number(factor) * 10) / 10));
  window.eagleMV.setZoomFactor(next);
  if (persist) {
    try { localStorage.setItem('eaglemv.uiZoom', String(next)); } catch {}
  }
  if (announce) toast(`界面缩放 ${Math.round(next * 100)}%`, 1400);
  return next;
}

function changeUIZoom(delta) {
  let current = 1;
  try { current = Number(localStorage.getItem('eaglemv.uiZoom')) || 1; } catch {}
  setUIZoom(current + delta * UI_ZOOM_STEP, { announce: true });
}

function restoreUIZoom() {
  let saved = 1;
  try { saved = Number(localStorage.getItem('eaglemv.uiZoom')) || 1; } catch {}
  setUIZoom(saved, { persist: false });
}

function applyWindowChromeState(payload = {}) {
  const noTrafficLights = window.eagleMV.platform !== 'darwin' || Boolean(payload.fullScreen);
  document.body.classList.toggle('no-traffic-lights', noTrafficLights);
}

async function restoreWindowChromeState() {
  const fullScreen = await window.eagleMV.isFullScreen().catch(() => false);
  applyWindowChromeState({ fullScreen });
  window.eagleMV.onChromeState(applyWindowChromeState);
}

function activePane() {
  return state.panes?.find(pane => pane.id === state.activePaneId) || state.panes?.[0] || null;
}
function paneById(id) {
  return state.panes.find(pane => pane.id === id) || null;
}
function withActivePane(id, callback) {
  const previous = state.activePaneId;
  state.activePaneId = id;
  try { return callback(); } finally { state.activePaneId = previous; }
}
function paneRoot(id = state.activePaneId) {
  return document.querySelector(`.content-pane[data-pane-id="${CSS.escape(id)}"]`);
}
function paneQuery(id, selector) {
  return paneRoot(id)?.querySelector(selector) || null;
}
function activatePane(id) {
  if (!paneById(id)) return false;
  if (state.activePaneId === id) return true;
  // The inspector is shared visually, so switching panes must resolve edits
  // before the active-pane proxy points at another selection. Switching first
  // lets renderInspector clear inspectorDirty and silently loses the draft.
  if (!confirmDiscardChanges({ includeText: false })) return false;
  state.activePaneId = id;
  for (const pane of document.querySelectorAll('.content-pane')) pane.classList.toggle('active', pane.dataset.paneId === id);
  renderQueryControls();
  renderFolderTree();
  renderInspector();
  return true;
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function uiIcon(name, className = 'tree-icon-svg') {
  const paths = {
    folder: '<path d="M2.5 6.7h5l1.45 1.7h8.55v6.7a1.9 1.9 0 0 1-1.9 1.9H4.4a1.9 1.9 0 0 1-1.9-1.9V6.7Z"></path><path d="M2.5 7.5V5.9A1.9 1.9 0 0 1 4.4 4h3.1l1.5 1.7h6.6a1.9 1.9 0 0 1 1.9 1.9v.8"></path>',
    library: '<rect x="3" y="4" width="14" height="12.5" rx="2.2"></rect><path d="M6.5 4v12.5M3 7.5h3.5"></path>',
    all: '<rect x="3" y="3" width="5.5" height="5.5" rx="1.4"></rect><rect x="11.5" y="3" width="5.5" height="5.5" rx="1.4"></rect><rect x="3" y="11.5" width="5.5" height="5.5" rx="1.4"></rect><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.4"></rect>',
    unfiled: '<path d="M3 6.5h14v8.2a2.3 2.3 0 0 1-2.3 2.3H5.3A2.3 2.3 0 0 1 3 14.7V6.5Z"></path><path d="M2.5 6.5 5 3h10l2.5 3.5M7.2 10h5.6"></path>',
    recent: '<circle cx="10" cy="10" r="7"></circle><path d="M10 6v4l2.8 1.8"></path>',
    random: '<path d="M4 5h2.2c2.9 0 3.4 5 6.2 5h3.6"></path><path d="m13.5 7.3 2.5 2.7-2.5 2.7"></path><path d="M4 15h2.2c1.2 0 2-1 2.7-2.1M13.5 12.7 16 15.4 13.5 18"></path>',
    trash: '<path d="M4.5 6.5h11l-.6 10.5H5.1L4.5 6.5Z"></path><path d="M3.5 6.5h13M7.3 6.5V4h5.4v2.5M8 9.2v5.2M12 9.2v5.2"></path>',
    smart: '<path d="m10 2 1.35 4.15L15.5 7.5l-4.15 1.35L10 13l-1.35-4.15L4.5 7.5l4.15-1.35L10 2Z"></path><path d="m15.7 12 .65 2 2 .65-2 .65-.65 2-.65-2-2-.65 2-.65.65-2Z"></path>',
    chevronDown: '<path d="m5.5 7.5 4.5 5 4.5-5"></path>',
    chevronRight: '<path d="m7.5 5.5 5 4.5-5 4.5"></path>',
    pin: '<path d="m7 3 6 6-1.9 1.9 3.3 3.3-1.2 1.2-3.3-3.3L8 14 6 12l1.9-1.9-3.3-3.3L7 3Z"></path><path d="m6.8 13.2-3.3 3.3"></path>',
    open: '<path d="M4 4.5h5l1.5 2H16a1.8 1.8 0 0 1 1.8 1.8v6.2a1.8 1.8 0 0 1-1.8 1.8H4A1.8 1.8 0 0 1 2.2 14.5V6.3A1.8 1.8 0 0 1 4 4.5Z"></path><path d="m9.5 12 5-5M11 7h3.5v3.5"></path>',
    finder: '<path d="M3 3.5h14v13H3z"></path><path d="M6 7h8M6 10h5M6 13h3"></path>',
    copy: '<rect x="6" y="6" width="10" height="11" rx="1.7"></rect><path d="M4 13H3.8A1.8 1.8 0 0 1 2 11.2V4.8A1.8 1.8 0 0 1 3.8 3h6.4A1.8 1.8 0 0 1 12 4.8V5"></path>',
    path: '<path d="M4 3.5h8l4 4v9H4z"></path><path d="M12 3.5v4h4M6.5 11h7M6.5 14h5"></path>',
    tag: '<path d="M3.5 5.5V3.8h7.3l5.7 5.7-6 6-7-7V5.5Z"></path><circle cx="7.2" cy="6.4" r="1"></circle>',
    rename: '<path d="m4 14.8-.7 2.7 2.7-.7L16.7 6l-2-2L4 14.8Z"></path><path d="m12.8 5.9 2 2"></path>',
    share: '<circle cx="5" cy="10" r="2"></circle><circle cx="15" cy="5" r="2"></circle><circle cx="15" cy="15" r="2"></circle><path d="m6.8 9 6.4-3M6.8 11l6.4 3"></path>',
    remove: '<path d="M4 5h12M6 5v11h8V5M8 8v5M12 8v5M8 3h4"></path>',
    trashMenu: '<path d="M4.5 6.5h11l-.6 10.5H5.1L4.5 6.5Z"></path><path d="M3.5 6.5h13M7.3 6.5V4h5.4v2.5"></path>',
    more: '<circle cx="5" cy="10" r="1"></circle><circle cx="10" cy="10" r="1"></circle><circle cx="15" cy="10" r="1"></circle>',
    window: '<rect x="3" y="4" width="14" height="12" rx="1.8"></rect><path d="M3 7h14M6 5.5h.1M8.5 5.5h.1"></path>',
    export: '<path d="M10 3v9M6.5 6.5 10 3l3.5 3.5M4 12.5V17h12v-4.5"></path>',
    import: '<path d="M10 3v9M6.5 8.5 10 12l3.5-3.5M4 13v3.2h12V13"></path>',
    refresh: '<path d="M16.2 8.2A6.5 6.5 0 1 0 16.5 12M16.2 4.7v3.8h-3.8"></path>',
    lock: '<rect x="5" y="9" width="10" height="7.5" rx="1.6"></rect><path d="M7 9V6.8a3 3 0 0 1 6 0V9"></path>'
  };
  return `<svg class="${className}" viewBox="0 0 20 20" aria-hidden="true">${paths[name] || ''}</svg>`;
}

function eagleIcon(file, className = 'tree-image-icon') {
  return `<img class="${className}" src="eagle-assets/${file}" alt="">`;
}

function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function debounceByKey(fn, wait = 250) {
  const timers = new Map();
  return (key, ...args) => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      fn(key, ...args);
    }, wait));
  };
}

let pendingInspectorExternalChange = false;
const schedulePaneGridRender = debounceByKey(paneId => {
  if (paneById(paneId)) withActivePane(paneId, () => renderGrid({ preserveScroll: true }));
}, 24);
const scheduleChangedInspectorRender = debounce(() => {
  const external = pendingInspectorExternalChange;
  pendingInspectorExternalChange = false;
  if (state.inspectorDirty && external) $('#staleBanner').classList.remove('hidden');
  else renderInspector();
}, 24);

function queueChangedInspectorRender(external) {
  pendingInspectorExternalChange ||= Boolean(external);
  scheduleChangedInspectorRender();
}

function paneMarkup(id, index) {
  return `<section class="content-pane${id === state.activePaneId ? ' active' : ''}" data-pane-id="${escapeHTML(id)}" tabindex="0">
    <div class="pane-badge">栏 ${index + 1}</div>
    <div class="content-heading">
      <div class="navigation-controls">
        <button id="backButton" class="nav-button" title="返回（⌥←）" disabled aria-label="返回"><img class="nav-image-icon" src="eagle-assets/ic-modal-back.svg" alt=""></button>
        <button id="forwardButton" class="nav-button" title="前进（⌥→）" disabled aria-label="前进"><img class="nav-image-icon mirror-x" src="eagle-assets/ic-modal-back.svg" alt=""></button>
        <button id="upButton" class="nav-button up" title="上一级（⌥↑）" disabled aria-label="上一级"><img class="nav-image-icon" src="eagle-assets/ic-arrow-up.svg" alt=""></button>
      </div>
      <div class="location-block">
        <div id="breadcrumb" class="breadcrumb" aria-label="当前路径"></div>
        <h1 id="viewTitle">资料库</h1>
        <span id="resultCount" class="muted">正在连接…</span>
      </div>
      <div class="sort-controls">
        <select id="sortSelect" class="sort-select" aria-label="当前栏排序">
          <option value="default">Eagle 顺序</option>
          <option value="name">名称</option>
          <option value="newest">最近修改</option>
          <option value="size">文件大小</option>
          <option value="resolution">分辨率</option>
          <option value="rating">评分</option>
          <option value="type">文件类型</option>
        </select>
        <button id="sortDirButton" class="sort-dir-button" title="切换排序方向" aria-label="切换排序方向">↓</button>
      </div>
    </div>
    <div id="gridScroller" class="grid-scroller">
      <div id="emptyState" class="empty-state hidden">
        <div class="empty-icon"><img src="brand-icon.png" alt=""></div>
        <h2>这里还没有素材</h2>
        <p>可以调整筛选条件，或将文件导入当前文件夹。</p>
        <button id="emptyRetryButton" class="secondary-button empty-retry-button hidden">重新读取</button>
      </div>
      <div id="itemGrid" class="item-grid"></div>
      <div id="loadIndicator" class="load-indicator hidden">正在载入更多…</div>
      <button id="scrollTopButton" class="scroll-top-button hidden" title="回到顶部（Home）">↑</button>
    </div>
    <div id="dropOverlay" class="drop-overlay hidden"><div><strong>导入到当前文件夹</strong><span>松开即可导入文件</span></div></div>
  </section>`;
}

function savePaneScrollPositions() {
  for (const pane of state.panes) {
    const scroller = paneQuery(pane.id, '#gridScroller');
    if (scroller) pane.scrollTop = scroller.scrollTop;
  }
}

function renderPaneLayout(layout = 'single', { refresh = true } = {}) {
  if (!paneLayouts[layout]) layout = 'single';
  const layoutRoot = $('#paneLayout');
  if (layoutRoot.dataset.layout === layout && layoutRoot.querySelector('.content-pane')) return true;
  if (state.inspectorSaving) {
    toast('正在保存素材信息，请稍候再切换布局', 2800);
    return false;
  }
  if (state.operationTracker.size) {
    toast(`${foregroundOperationSummary()}，完成后才能切换布局`, 3200);
    return false;
  }
  if (!confirmDiscardChanges({ includeText: false })) return false;
  savePaneScrollPositions();
  const oldPanes = state.panes;
  const count = paneLayouts[layout];
  state.panes = Array.from({ length: count }, (_, index) => oldPanes[index] || createPaneState(`pane-${index + 1}`, { currentView: { kind: 'root' }, sort: 'default', sortDir: 'auto', viewTitle: '资料库' }));
  state.panes.forEach((pane, index) => { pane.id = `pane-${index + 1}`; });
  if (!paneById(state.activePaneId)) state.activePaneId = state.panes[0].id;
  layoutRoot.dataset.layout = layout;
  layoutRoot.innerHTML = state.panes.map((pane, index) => paneMarkup(pane.id, index)).join('');
  try { localStorage.setItem('eaglemv.paneLayout', layout); } catch {}
  for (const pane of state.panes) bindPaneEvents(pane.id);
  for (const pane of state.panes) {
    withActivePane(pane.id, () => {
      renderSortControls();
      renderLocation();
      renderGrid({ preserveScroll: true });
    });
    const scroller = paneQuery(pane.id, '#gridScroller');
    if (scroller) scroller.scrollTop = pane.scrollTop || 0;
  }
  for (const pane of document.querySelectorAll('.content-pane')) pane.classList.toggle('active', pane.dataset.paneId === state.activePaneId);
  renderQueryControls();
  renderFolderTree();
  if (refresh && state.connected) refreshAllPanes({ reset: true, preserveScroll: true });
  return true;
}

async function refreshAllPanes(options = {}) {
  // A slow Eagle query in one pane must not hold every other pane behind it.
  // Each pane owns its refresh token and handles its own error state, so the
  // requests can safely run together after a drag or a cross-window update.
  await Promise.all([...state.panes].map(pane => refresh({ ...options, paneId: pane.id })));
}

function toast(message, duration = 2400) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.add('hidden'), duration);
}

function scheduleVisibleItemWatch() {
  if (visibleItemWatchQueued) return;
  visibleItemWatchQueued = true;
  queueMicrotask(() => {
    visibleItemWatchQueued = false;
    const perPane = Math.max(1, Math.floor(300 / Math.max(1, state.panes.length)));
    const ids = [...new Set(state.panes.flatMap(pane => pane.items.slice(0, perPane).map(item => item.id)))];
    window.eagleMV.watchItems(ids).catch(() => {});
  });
}

function renderSyncStatus() {
  $('#syncText').textContent = state.operationTracker.currentText();
}

function setSyncStatus(text) {
  state.operationTracker.setStatus(text);
  renderSyncStatus();
}

function beginForegroundOperation(label, { key = null, blocksClose = true } = {}) {
  const result = state.operationTracker.begin(label, { key, blocksClose });
  if (!result.token) {
    toast(`${result.duplicate.label}，请勿重复操作`, 3000);
    return null;
  }
  renderSyncStatus();
  return result.token;
}

function endForegroundOperation(token) {
  if (!token) return;
  state.operationTracker.end(token);
  renderSyncStatus();
}

async function runForegroundOperation(label, options, operation) {
  const token = beginForegroundOperation(label, options);
  if (!token) return undefined;
  try {
    return await operation();
  } finally {
    endForegroundOperation(token);
  }
}

function blockingForegroundOperations() {
  return state.operationTracker.blocking();
}

function foregroundOperationSummary(operations = state.operationTracker.active()) {
  return state.operationTracker.summary(operations);
}

function setConnection(connected, message) {
  state.connected = connected;
  document.body.classList.toggle('offline', !connected);
  $('#connectionDot').className = `connection-dot ${connected ? 'online' : 'offline'}`;
  $('#connectionText').textContent = connected ? (state.library?.name || '已连接 Eagle') : (message || 'Eagle 未连接');
  for (const selector of ['#trashButton', '#batchTrashButton', '#batchTagButton', '#addCommentButton', '#customThumbnailButton']) {
    $(selector).disabled = !connected;
  }
  $('#pinButton').disabled = !connected || state.currentView.kind !== 'folder' || state.selected.size !== 1;
}

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes))) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes), index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif', 'bmp', 'heic', 'tif', 'tiff']);
function isImageItem(item) { return imageExtensions.has(String(item?.ext || '').toLowerCase()); }
function itemFormat(item) { return String(item?.ext || '').trim().toUpperCase(); }

function sortedItems() {
  const items = [...state.items];
  items.sort((a, b) => {
    if (state.currentView.kind === 'folder') {
      const left = pinTimestamp(a);
      const right = pinTimestamp(b);
      if (left && !right) return -1;
      if (!left && right) return 1;
      if (left !== right) return right - left;
    }
    return compareItemsBySort(state.sort, state.sortDir, a, b);
  });
  return items;
}

function renderSortControls() {
  const select = $('#sortSelect');
  if (select) select.value = state.sort || 'default';
  const dirButton = $('#sortDirButton');
  if (!dirButton) return;
  const sortable = Boolean(state.sort) && state.sort !== 'default';
  const dir = effectiveSortDir(state.sort, state.sortDir);
  dirButton.disabled = !sortable;
  dirButton.textContent = dir === 'asc' ? '↑' : '↓';
  dirButton.title = sortable
    ? `切换排序方向（当前${dir === 'asc' ? '升序' : '降序'}）`
    : 'Eagle 顺序不支持切换方向';
}

function pinTimestamp(item) {
  if (state.currentView.kind !== 'folder') return 0;
  const folderId = state.currentView.id;
  const local = state.localPins?.[folderId];
  if (local && Object.prototype.hasOwnProperty.call(local, item.id)) return Math.max(0, Number(local[item.id]) || 0);
  return Number(item.pinned?.[folderId] || 0);
}

function itemIsPinned(item) {
  return pinTimestamp(item) > 0;
}

function revealFolderPath(id) {
  const path = findFolderPath(state.library?.folders, id);
  for (const ancestor of path.slice(0, -1)) {
    if (ancestor.children?.length) state.expandedFolders.add(ancestor.id);
  }
}

function quickAccessEntries() {
  return (state.library?.quickAccess || []).map(entry => {
    if (entry?.type === 'folder') {
      const folder = findFolder(state.library?.folders, entry.id);
      return folder ? { ...folder, quickType: 'folder' } : null;
    }
    if (entry?.type === 'smartFolder' || entry?.type === 'smart') {
      const folder = (state.library?.smartFolders || []).find(candidate => candidate.id === entry.id);
      return folder ? { ...folder, quickType: 'smart' } : null;
    }
    return null;
  }).filter(Boolean);
}

function currentFolder() {
  return state.currentView.kind === 'folder' ? findFolder(state.library?.folders, state.currentView.id) : null;
}

function visibleChildFolders() {
  if (!state.library) return [];
  if (state.currentView.kind === 'recent') return state.recentFolders || [];
  const folders = state.currentView.kind === 'root'
    ? (state.library.folders || [])
    : (currentFolder()?.children || []);
  const keyword = state.query.search.trim().toLocaleLowerCase('zh-CN');
  return keyword ? folders.filter(folder => folder.name.toLocaleLowerCase('zh-CN').includes(keyword)) : folders;
}

function rememberRecentFolderUsage(folderId) {
  if (!folderId) return false;
  const folder = findFolder(state.library?.folders, folderId);
  if (!folder) return false;
  state.recentFolders = [folder, ...(state.recentFolders || []).filter(candidate => candidate?.id !== folderId)].slice(0, 50);
  return true;
}

function markFolderUsed(folderId, libraryPath = state.library?.path) {
  if (!rememberRecentFolderUsage(folderId)) return;
  window.eagleMV.markFolderUsed?.({ folderId, libraryPath });
}

function confirmDiscardChanges({ includeText = true } = {}) {
  if (state.textSaving) {
    toast('正在保存 TXT，请稍候', 2400);
    return false;
  }
  const textDirty = includeText && state.textSession?.dirty;
  // Inspector metadata follows Eagle's edit-and-leave flow. The save routine
  // captures the selected pane and patch before its first await, so a
  // navigation can safely continue while that write finishes in background.
  if (state.inspectorDirty && !state.connected) {
    if (!confirm('Eagle 当前未连接，素材信息无法自动保存。\n\n按“确定”放弃素材信息修改并继续；按“取消”留在当前内容。')) return false;
    state.inspectorDirty = false;
    clearInspectorAutoSave();
  } else if (state.inspectorDirty && !state.inspectorSaving) saveInspector();
  if (!textDirty) return true;
  if (state.inspectorSaving) {
    toast('正在保存素材信息，请稍候再离开 TXT 编辑', 2400);
    return false;
  }
  const discard = confirm('TXT 内容有尚未保存的修改。\n\n按“确定”放弃修改并继续；按“取消”留在当前内容。');
  if (discard && state.textSession) state.textSession.dirty = false;
  return discard;
}

function filtersActive() {
  return queryFiltersActive(state.query);
}

function renderFilterState() {
  const active = filtersActive();
  $('#clearFiltersButton').classList.toggle('hidden', !active);
  $('#filterButton').classList.toggle('active', active || !$('#filterPopover').classList.contains('hidden'));
  const count = queryFilterCount(state.query);
  $('#filterCount').textContent = count;
  $('#filterCount').classList.toggle('hidden', !count);
}

function renderQueryControls() {
  const query = state.query;
  $('#searchInput').value = query.search;
  $('#extFilter').value = query.ext;
  $('#annotationFilter').value = query.annotation;
  $('#urlFilter').value = query.url;
  $('#shapeFilter').value = query.shape;
  $('#ratingFilter').value = Number.isInteger(query.rating) ? String(query.rating) : '';
  renderTagEditor('filter');
  renderFilterState();
}

const tagEditors = {
  item: { input: '#itemTagInput', chips: '#itemTagChips' },
  batch: { input: '#batchTagInput', chips: '#batchTagChips' },
  filter: { input: '#filterTagInput', chips: '#filterTagChips' }
};

function tagValues(kind) {
  if (kind === 'item') return state.draftTags;
  if (kind === 'batch') return state.batchTags;
  return state.query.tags;
}

function normalizeTags(tags) {
  return [...new Set((tags || []).map(tag => String(tag).trim()).filter(Boolean))];
}

function renderTagEditor(kind) {
  const config = tagEditors[kind];
  const chips = $(config.chips);
  if (!chips) return;
  chips.innerHTML = tagValues(kind).map(tag => {
    const color = state.tagColors[tag];
    const disabled = kind === 'item' && state.inspectorSaving ? ' disabled' : '';
    return `<span class="tag-chip"${color ? ` style="--tag-color:${escapeHTML(color)}"` : ''}><span title="${escapeHTML(tag)}">${escapeHTML(tag)}</span><button type="button" data-remove-tag="${escapeHTML(tag)}" aria-label="移除 ${escapeHTML(tag)}"${disabled}>×</button></span>`;
  }).join('');
  const input = $(config.input);
  if (input?.matches(':focus')) renderTagSuggestionPopover(kind, { open: true });
}

function setTagValues(kind, tags, changed = true) {
  const values = normalizeTags(tags);
  if (kind === 'item') state.draftTags = values;
  else if (kind === 'batch') state.batchTags = values;
  else state.query.tags = values;
  renderTagEditor(kind);
  if (!changed) return;
  if (kind === 'item') markDirty();
  if (kind === 'filter') {
    renderFilterState();
    schedulePaneFilterRefresh(state.activePaneId);
  }
}

function commitTagInput(kind) {
  const input = $(tagEditors[kind].input);
  const pending = normalizeTags(input.value.split(/[,，\n]+/));
  if (!pending.length) return false;
  setTagValues(kind, [...tagValues(kind), ...pending]);
  input.value = '';
  renderTagSuggestionPopover(kind, { open: true });
  return true;
}

function removeTag(kind, tag) {
  setTagValues(kind, tagValues(kind).filter(value => value !== tag));
}

const schedulePaneFilterRefresh = debounceByKey(paneId => {
  if (paneById(paneId)) refresh({ reset: true, preserveScroll: false, paneId });
}, 240);

function tagSuggestionRecords(kind) {
  const input = $(tagEditors[kind].input);
  const needle = input?.value.trim().toLocaleLowerCase() || '';
  const selected = new Set(tagValues(kind));
  return state.availableTags
    .map(tag => {
      const name = tagName(tag);
      return { name, count: Number(tag?.imageCount || 0), color: state.tagColors[name] || '' };
    })
    .filter(tag => tag.name && !selected.has(tag.name) && (!needle || tag.name.toLocaleLowerCase().includes(needle)))
    .slice(0, 120);
}

function ensureTagSuggestionPopover(kind) {
  const input = $(tagEditors[kind].input);
  const editor = input?.closest('.tag-editor');
  if (!editor) return null;
  let popover = editor.querySelector('.tag-suggestion-popover');
  if (!popover) {
    popover = document.createElement('div');
    popover.className = 'tag-suggestion-popover hidden';
    popover.setAttribute('role', 'listbox');
    editor.appendChild(popover);
  }
  return popover;
}

function closeTagSuggestions(kind) {
  const input = $(tagEditors[kind].input);
  const popover = ensureTagSuggestionPopover(kind);
  if (!popover) return;
  popover.classList.add('hidden');
  popover.dataset.activeIndex = '-1';
  input?.setAttribute('aria-expanded', 'false');
}

function renderTagSuggestionPopover(kind, { open = false } = {}) {
  const input = $(tagEditors[kind].input);
  const popover = ensureTagSuggestionPopover(kind);
  if (!input || !popover) return;
  const records = tagSuggestionRecords(kind);
  const shouldOpen = open && document.activeElement === input && records.length > 0;
  const previousIndex = Number(popover.dataset.activeIndex || -1);
  const activeIndex = shouldOpen && previousIndex >= 0 && previousIndex < records.length ? previousIndex : -1;
  popover.dataset.activeIndex = String(activeIndex);
  popover.innerHTML = records.map((record, index) => `<button type="button" class="tag-suggestion" role="option" aria-selected="${index === activeIndex}" data-tag-suggestion="${escapeHTML(record.name)}">
    <span class="tag-suggestion-leading"${record.color ? ` style="--tag-color:${escapeHTML(record.color)}"` : ''}></span>
    <span class="tag-suggestion-name" title="${escapeHTML(record.name)}">${escapeHTML(record.name)}</span>
    <span class="tag-suggestion-count">${record.count.toLocaleString()}</span>
  </button>`).join('');
  popover.classList.toggle('hidden', !shouldOpen);
  input.setAttribute('aria-expanded', String(shouldOpen));
}

function openTagSuggestions(kind) {
  const input = $(tagEditors[kind].input);
  if (!input) return;
  renderTagSuggestionPopover(kind, { open: true });
}

function chooseTagSuggestion(kind, name) {
  const input = $(tagEditors[kind].input);
  if (!name || !input) return;
  setTagValues(kind, [...tagValues(kind), name]);
  input.value = '';
  renderTagSuggestionPopover(kind, { open: true });
  input.focus();
}

function renderTagSuggestions() {
  $('#tagSuggestions').innerHTML = state.availableTags.slice(0, 1000).map(tag => `<option value="${escapeHTML(tag.name || tag)}"></option>`).join('');
  for (const kind of Object.keys(tagEditors)) {
    const input = $(tagEditors[kind].input);
    if (input?.matches(':focus')) renderTagSuggestionPopover(kind, { open: true });
  }
}

function renderTagColors() {
  const manager = $('#tagColorManager');
  if (!manager) return;
  manager.innerHTML = state.availableTags.slice(0, 200).map(tag => {
    const name = tag.name || tag;
    const color = state.tagColors[name] || '#0072ef';
    return `<label class="tag-color-row"><span class="tag-color-swatch" style="--tag-color:${escapeHTML(color)}"></span><span title="${escapeHTML(name)}">${escapeHTML(name)}</span><input type="color" value="${escapeHTML(color)}" data-tag-color="${escapeHTML(name)}" aria-label="${escapeHTML(name)}颜色"></label>`;
  }).join('') || '<small class="muted">当前资料库还没有标签</small>';
}

async function saveCurrentViewAsSmartFolder() {
  const libraryPath = state.library?.path;
  const currentSmartFolder = state.currentView.kind === 'smart'
    ? findFolder(state.library?.smartFolders, state.currentView.id)
    : null;
  const converted = buildSmartFolderConditions(state.currentView, state.query, currentSmartFolder?.conditions || []);
  if (converted.unsupported) {
    toast(converted.unsupported, 4200);
    return;
  }
  const suggestedName = `${state.viewTitle || '素材'}筛选`;
  const name = await requestNameDialog({ title: '保存为智能文件夹', initialValue: suggestedName, submitLabel: '保存' });
  if (!name?.trim()) return;
  await runForegroundOperation('正在保存智能文件夹…', { key: `smart-create:${libraryPath}` }, async () => {
    await window.eagleMV.createSmartFolder({
      libraryPath,
      name: name.trim(),
      conditions: converted.conditions
    });
    $('#filterPopover').classList.add('hidden');
    toast('智能文件夹已保存到 Eagle');
  });
}

function createSmartFolderFromNewMenu() {
  const currentSmartFolder = state.currentView.kind === 'smart'
    ? findFolder(state.library?.smartFolders, state.currentView.id)
    : null;
  const converted = buildSmartFolderConditions(state.currentView, state.query, currentSmartFolder?.conditions || []);
  if (!converted.unsupported) return saveCurrentViewAsSmartFolder();
  if (converted.unsupported === '当前视图没有可保存的筛选条件') {
    $('#filterPopover').classList.remove('hidden');
    $('#filterButton').setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => $('#searchInput').focus());
    toast('请先设置筛选条件，再点击“另存为智能文件夹”', 4200);
    return Promise.resolve(false);
  }
  toast(converted.unsupported, 4200);
  return Promise.resolve(false);
}

async function renameSmartFolder(id) {
  const libraryPath = state.library?.path;
  const folder = findFolder(state.library?.smartFolders, id);
  if (!folder) return;
  const name = await requestNameDialog({ title: '重命名智能文件夹', initialValue: folder.name || '', submitLabel: '重命名' });
  if (!name?.trim() || name.trim() === folder.name) return;
  await runForegroundOperation('正在重命名智能文件夹…', { key: `smart-update:${libraryPath}:${id}` }, async () => {
    await window.eagleMV.updateSmartFolder({ libraryPath, id, patch: { name: name.trim() } });
    toast('智能文件夹已重命名');
  });
}

async function removeSmartFolder(id) {
  const libraryPath = state.library?.path;
  const folder = findFolder(state.library?.smartFolders, id);
  if (!folder) return;
  const childCount = (folder.children || []).length;
  if (!confirm(`移除智能文件夹“${folder.name}”？${childCount ? `\n\n它的 ${childCount} 个子智能文件夹也会一并移除。` : ''}\n\n素材和普通文件夹不会被删除。`)) return;
  await runForegroundOperation('正在移除智能文件夹…', { key: `smart-remove:${libraryPath}:${id}` }, async () => {
    await window.eagleMV.removeSmartFolder({ libraryPath, id });
    toast('智能文件夹已移除');
  });
}

async function updateTagColor(tag, color) {
  if (!tag || !/^#[0-9a-f]{6}$/i.test(color || '')) return;
  const libraryPath = state.library?.path;
  try {
    await runForegroundOperation('正在保存标签颜色…', { key: `tag-color:${libraryPath}:${tag}` }, async () => {
      state.tagColors = await window.eagleMV.setTagColor({ libraryPath, tag, color });
      renderTagColors();
      renderTagEditor('item');
      renderTagEditor('batch');
      renderTagEditor('filter');
    });
  } catch (error) {
    toast(`标签颜色保存失败：${error.message}`, 4000);
  }
}

function clearFilters() {
  state.query.search = '';
  state.query.tags = [];
  state.query.ext = '';
  state.query.rating = null;
  state.query.annotation = '';
  state.query.url = '';
  state.query.shape = '';
  renderQueryControls();
  refresh({ reset: true, preserveScroll: false, paneId: state.activePaneId });
}

function normalizeExtension(value) {
  return String(value || '').trim().toLowerCase().replace(/^\.+/, '');
}

function renderPanels() {
  document.body.classList.toggle('sidebar-hidden', !state.sidebarVisible);
  document.body.classList.toggle('inspector-hidden', !state.inspectorVisible);
  $('#toggleSidebarButton').classList.toggle('active', state.sidebarVisible);
  $('#toggleInspectorButton').classList.toggle('active', state.inspectorVisible);
}

function togglePanel(panel) {
  if (panel === 'sidebar') state.sidebarVisible = !state.sidebarVisible;
  if (panel === 'inspector') state.inspectorVisible = !state.inspectorVisible;
  renderPanels();
}

function updateCardSelectionStyles() {
  const root = paneRoot();
  if (!root) return;
  for (const card of root.querySelectorAll('#itemGrid .folder-card')) {
    card.classList.toggle('selected', card.dataset.openFolder === state.selectedFolderCard);
  }
  for (const card of root.querySelectorAll('#itemGrid .item-card')) {
    card.classList.toggle('selected', state.selected.has(card.dataset.id));
  }
}

function selectFolderCard(id) {
  if (!confirmDiscardChanges()) return false;
  state.selectedFolderCard = id;
  state.selected.clear();
  updateCardSelectionStyles();
  renderInspector();
  requestAnimationFrame(() => paneRoot()?.querySelector(`.folder-card[data-open-folder="${CSS.escape(id)}"]`)?.focus());
  return true;
}

function focusSelectedCard() {
  const root = paneRoot();
  const selectedFolder = state.selectedFolderCard && root?.querySelector(`.folder-card[data-open-folder="${CSS.escape(state.selectedFolderCard)}"]`);
  const selectedItemId = state.selected.size === 1 ? [...state.selected][0] : null;
  const selectedItem = selectedItemId && root?.querySelector(`.item-card[data-id="${CSS.escape(selectedItemId)}"]`);
  return selectedFolder || selectedItem || root?.querySelector('#itemGrid .folder-card, #itemGrid .item-card');
}

function moveCardFocus(key) {
  const cards = [...(paneRoot()?.querySelectorAll('#itemGrid .folder-card, #itemGrid .item-card') || [])];
  if (!cards.length) return;
  const current = focusSelectedCard();
  let next = current || cards[0];
  if (current) {
    const origin = current.getBoundingClientRect();
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
    const candidates = cards.filter(card => card !== current).map(card => {
      const box = card.getBoundingClientRect();
      const primary = horizontal ? box.left - origin.left : box.top - origin.top;
      const secondary = horizontal ? Math.abs(box.top - origin.top) : Math.abs(box.left - origin.left);
      return { card, primary, secondary };
    }).filter(candidate => Math.sign(candidate.primary) === direction)
      .sort((a, b) => (Math.abs(a.primary) + a.secondary * 2) - (Math.abs(b.primary) + b.secondary * 2));
    next = candidates[0]?.card || current;
  }
  if (next.classList.contains('folder-card')) selectFolderCard(next.dataset.openFolder);
  else selectItem(next.dataset.id);
  requestAnimationFrame(() => {
    const target = focusSelectedCard();
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function folderCardMarkup(folder) {
  const childCount = (folder.children || []).length;
  const directCount = Number(folder.imageCount) || 0;
  return `<article class="folder-card ${state.selectedFolderCard === folder.id ? 'selected' : ''}" data-open-folder="${escapeHTML(folder.id)}" tabindex="0">
    <div class="folder-thumbnail">
      <span class="folder-sheet folder-sheet-back" aria-hidden="true"></span>
      <span class="folder-sheet folder-sheet-middle" aria-hidden="true"></span>
      <div class="folder-cover">
        ${folder.covers?.length ? `<img loading="lazy" src="eaglemv://folder/${encodeURIComponent(folder.id)}" alt="">` : ''}
      </div>
    </div>
    <div class="folder-name" title="${escapeHTML(folder.name)}">${escapeHTML(folder.name)}</div>
    <div class="folder-meta">${directCount.toLocaleString()} 个文件${childCount ? ` · ${childCount.toLocaleString()} 个子文件夹` : ''}</div>
  </article>`;
}

function itemThumbnailAspect(item) {
  const width = Number(item?.width);
  const height = Number(item?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  return Math.max(0.2, Math.min(5, width / height));
}

function tagName(value) {
  return typeof value === 'string' ? value : String(value?.name || '');
}

function tagRecord(name) {
  return state.availableTags.find(tag => tagName(tag) === name) || { name };
}

function tagManagerTagMarkup(name, groupId = null) {
  const record = tagRecord(name);
  const groups = state.tagGroups || [];
  return `<div class="tag-manager-row">
    <span class="tag-manager-name" title="${escapeHTML(name)}">${escapeHTML(name)}</span>
    <span class="tag-manager-count">${Number(record.imageCount || 0).toLocaleString()}</span>
    <button type="button" class="tag-manager-action" data-tag-action="filter-tag" data-tag-name="${escapeHTML(name)}">筛选</button>
    <button type="button" class="tag-manager-action" data-tag-action="rename-tag" data-tag-name="${escapeHTML(name)}">重命名</button>
    <button type="button" class="tag-manager-action" data-tag-action="merge-tag" data-tag-name="${escapeHTML(name)}">合并</button>
    <select class="tag-manager-group-select" data-tag-add-group data-tag-name="${escapeHTML(name)}" aria-label="将 ${escapeHTML(name)} 加入分组">
      <option value="">加入分组…</option>
      ${groups.filter(group => group.id !== groupId).map(group => `<option value="${escapeHTML(group.id)}">${escapeHTML(group.name)}</option>`).join('')}
    </select>
    ${groupId ? `<button type="button" class="tag-manager-remove" data-tag-action="remove-from-group" data-tag-group-id="${escapeHTML(groupId)}" data-tag-name="${escapeHTML(name)}" aria-label="从分组移除">×</button>` : ''}
  </div>`;
}

function tagManagerMarkup() {
  const grouped = new Set((state.tagGroups || []).flatMap(group => group.tags || []));
  const groups = (state.tagGroups || []).map(group => `<section class="tag-manager-group">
    <header class="tag-manager-group-heading">
      <div><h2>${escapeHTML(group.name || '未命名分组')}</h2><span>${(group.tags || []).length.toLocaleString()} 个标签</span></div>
      <div class="tag-manager-group-actions">
        <button type="button" class="tag-manager-action" data-tag-action="rename-group" data-tag-group-id="${escapeHTML(group.id)}">重命名</button>
        <button type="button" class="tag-manager-action danger" data-tag-action="remove-group" data-tag-group-id="${escapeHTML(group.id)}">移除分组</button>
      </div>
    </header>
    <div class="tag-manager-list">${(group.tags || []).map(name => tagManagerTagMarkup(name, group.id)).join('') || '<span class="muted">分组中还没有标签</span>'}</div>
  </section>`).join('');
  const ungrouped = state.availableTags.filter(tag => !grouped.has(tagName(tag)));
  const ungroupedHTML = ungrouped.length ? `<section class="tag-manager-group">
    <header class="tag-manager-group-heading"><div><h2>未分组</h2><span>${ungrouped.length.toLocaleString()} 个标签</span></div></header>
    <div class="tag-manager-list">${ungrouped.map(tag => tagManagerTagMarkup(tagName(tag))).join('')}</div>
  </section>` : '';
  return `<div class="tag-manager">
    <header class="tag-manager-toolbar"><div><h1>标签管理</h1><p>通过 Eagle 管理标签与分组；标签颜色仍保存在 MultiView 本地状态。</p></div><button type="button" class="primary-button" data-tag-action="create-group">新建分组</button></header>
    ${groups || ungroupedHTML ? `${groups}${ungroupedHTML}` : '<div class="tag-manager-empty">当前资料库还没有标签</div>'}
  </div>`;
}

async function executeTagManagerAction(action, payload = {}) {
  const libraryPath = state.library?.path;
  if (!libraryPath) return;
  if (action === 'filter-tag') {
    state.query.tags = [payload.tagName];
    navigate({ kind: 'all' });
    renderQueryControls();
    return;
  }
  if (action === 'create-group') {
    const name = await requestNameDialog({ title: '新建标签分组', submitLabel: '创建' });
    if (!name?.trim()) return;
    await runForegroundOperation('正在创建标签分组…', { key: `tag-group-create:${libraryPath}` }, async () => {
      await window.eagleMV.createTagGroup({ libraryPath, name: name.trim() });
      toast('标签分组已创建');
    });
    return;
  }
  if (action === 'rename-group') {
    const group = state.tagGroups.find(candidate => candidate.id === payload.groupId);
    if (!group) return;
    const name = await requestNameDialog({ title: '重命名标签分组', initialValue: group.name || '', submitLabel: '重命名' });
    if (!name?.trim() || name.trim() === group.name) return;
    await runForegroundOperation('正在重命名标签分组…', { key: `tag-group-update:${libraryPath}:${group.id}` }, async () => {
      await window.eagleMV.updateTagGroup({ libraryPath, id: group.id, patch: { name: name.trim() } });
      toast('标签分组已重命名');
    });
    return;
  }
  if (action === 'remove-group') {
    const group = state.tagGroups.find(candidate => candidate.id === payload.groupId);
    if (!group || !confirm(`移除分组“${group.name}”？\n\n分组会被删除，标签本身和素材不会删除。`)) return;
    await runForegroundOperation('正在移除标签分组…', { key: `tag-group-remove:${libraryPath}:${group.id}` }, async () => {
      await window.eagleMV.removeTagGroup({ libraryPath, id: group.id });
      toast('标签分组已移除');
    });
    return;
  }
  if (action === 'rename-tag' || action === 'merge-tag') {
    const name = String(payload.tagName || '');
    if (!name) return;
    const next = await requestNameDialog({ title: action === 'rename-tag' ? '重命名标签' : '合并标签到', initialValue: action === 'rename-tag' ? name : '', submitLabel: action === 'rename-tag' ? '重命名' : '合并' });
    if (!next?.trim() || next.trim() === name) return;
    if (action === 'merge-tag' && !confirm(`将标签“${name}”合并到“${next.trim()}”？\n\n原标签会从素材中移除，此操作通过 Eagle 执行。`)) return;
    await runForegroundOperation(action === 'rename-tag' ? '正在重命名标签…' : '正在合并标签…', { key: `tag-${action}:${libraryPath}:${name}` }, async () => {
      if (action === 'rename-tag') await window.eagleMV.renameTag({ libraryPath, originalName: name, name: next.trim() });
      else await window.eagleMV.mergeTag({ libraryPath, source: name, target: next.trim() });
      toast(action === 'rename-tag' ? '标签已重命名' : '标签已合并');
    });
    return;
  }
  if (action === 'remove-from-group') {
    await runForegroundOperation('正在从分组移除标签…', { key: `tag-group-remove-tag:${libraryPath}:${payload.groupId}:${payload.tagName}` }, async () => {
      await window.eagleMV.removeTagsFromGroup({ libraryPath, groupId: payload.groupId, tags: [payload.tagName] });
      toast('标签已从分组移除');
    });
  }
}

function bindGifHover(card) {
  const image = card.querySelector('img[data-gif-static]');
  if (!image) return;
  const staticSrc = image.dataset.gifStatic;
  const animatedSrc = image.dataset.gifAnimated;
  card.addEventListener('mouseenter', () => {
    image.src = animatedSrc;
  });
  card.addEventListener('mouseleave', () => {
    image.src = staticSrc;
  });
  image.addEventListener('error', () => {
    if (image.src !== staticSrc) image.src = staticSrc;
  });
}

function renderGrid({ preserveScroll = true } = {}) {
  const scroller = $('#gridScroller');
  const scrollTop = scroller.scrollTop;
  // withActivePane changes the data proxy temporarily, but it does not move
  // the visible active highlight. Only the visibly active pane owns the
  // shared footer; background pane renders must not replace its statistics.
  const updateSharedFooter = paneRoot()?.classList.contains('active') ?? true;
  if (state.currentView.kind === 'tags') {
    // The tag manager is a content view, not an empty-materials result. Keep
    // the generic overlay physically out of the layout as well as hidden by
    // class: this prevents any later result refresh from painting the
    // material-empty state over the tag rows.
    const emptyState = $('#emptyState');
    emptyState.classList.add('hidden');
    emptyState.style.display = 'none';
    $('#itemGrid').innerHTML = tagManagerMarkup();
    scroller.scrollTop = preserveScroll ? scrollTop : 0;
    if (updateSharedFooter) updateScrollUI();
    return;
  }
  const items = sortedItems();
  const folders = visibleChildFolders();
  const emptyState = $('#emptyState');
  emptyState.style.display = '';
  emptyState.querySelector('h2').textContent = state.errorMessage ? '当前栏读取失败' : '这里还没有素材';
  emptyState.querySelector('p').textContent = state.errorMessage || '可以调整筛选条件，或将文件导入当前文件夹。';
  $('#emptyRetryButton').classList.toggle('hidden', !state.errorMessage);
  $('#emptyState').classList.toggle('hidden', items.length > 0 || folders.length > 0 || state.loading);
  const folderSection = folders.length
    ? `<div class="grid-section-heading"><span>子文件夹</span><span>${folders.length.toLocaleString()}</span></div><div class="folder-grid">${folders.map(folderCardMarkup).join('')}</div>`
    : '';
  const itemCards = items.map(item => {
    const ext = String(item.ext || '').trim().toLowerCase().replace(/^\./, '');
    const isGif = ext === 'gif';
    const thumbURL = `eaglemv://thumb/${encodeURIComponent(item.id)}`;
    const originalURL = `eaglemv://original/${encodeURIComponent(item.id)}`;
    const aspect = itemThumbnailAspect(item);
    return `
    <article class="item-card ${state.selected.has(item.id) ? 'selected' : ''} ${itemIsPinned(item) ? 'pinned' : ''}" data-id="${escapeHTML(item.id)}" draggable="true" tabindex="0" style="--item-aspect: ${aspect.toFixed(4)}">
      <div class="thumb-wrap">
        <img loading="lazy" src="${thumbURL}" alt="${escapeHTML(item.name)}"${isGif ? ` data-gif-static="${thumbURL}" data-gif-animated="${originalURL}"` : ''}>
        ${itemIsPinned(item) ? `<span class="pin-badge" title="已在当前文件夹置顶">${eagleIcon('ic-toolbar-pin.svg', 'pin-icon')}</span>` : ''}
        ${(isGif || (!isImageItem(item) && item.ext)) ? `<span class="format-badge${isGif ? ' gif-badge' : ''}">${escapeHTML(itemFormat(item))}</span>` : ''}
        ${Number(item.star) > 0 ? `<span class="card-stars" title="${Number(item.star)} 星">${'★'.repeat(Number(item.star))}</span>` : ''}
      </div>
      <div class="card-name" title="${escapeHTML(item.name)}">${escapeHTML(item.name)}</div>
      <div class="card-meta">${item.width || 0}×${item.height || 0} · ${formatBytes(item.size)}</div>
    </article>`;
  }).join('');
  const itemSection = items.length
    ? `${folders.length ? `<div class="grid-section-heading"><span>文件</span><span>${state.estimatedTotal ? '≥ ' : ''}${state.total.toLocaleString()}</span></div>` : ''}<div class="asset-grid">${itemCards}</div>`
    : '';
  $('#itemGrid').innerHTML = `${folderSection}${itemSection}`;
  const root = paneRoot();
  for (const card of root?.querySelectorAll('#itemGrid .item-card') || []) bindGifHover(card);
  for (const image of root?.querySelectorAll('.thumb-wrap img, .folder-cover img') || []) {
    if (image.complete) image.classList.add('loaded');
    image.addEventListener('load', () => image.classList.add('loaded'), { once: true });
  }
  state.scrollTop = preserveScroll ? scrollTop : 0;
  scroller.scrollTop = state.scrollTop;
  if (updateSharedFooter) updateScrollUI();
  scheduleVisibleItemWatch();
}

function updateScrollUI() {
  const scroller = $('#gridScroller');
  const loaded = state.items.length;
  const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const percent = maximum ? Math.max(0, Math.min(100, Math.round(scroller.scrollTop / maximum * 100))) : 0;
  $('#scrollStatus').textContent = `已载入 ${loaded.toLocaleString()} / ${state.estimatedTotal ? '至少 ' : ''}${state.total.toLocaleString()}${maximum ? ` · ${percent}%` : ''}`;
  $('#scrollTopButton').classList.toggle('hidden', scroller.scrollTop < Math.max(240, scroller.clientHeight * 0.6));
}

function renderResultCount() {
  const childCount = visibleChildFolders().length;
  $('#resultCount').textContent = state.currentView.kind === 'tags'
    ? `${state.availableTags.length.toLocaleString()} 个标签 · ${(state.tagGroups || []).length.toLocaleString()} 个分组`
    : childCount
    ? `${childCount.toLocaleString()} 个文件夹 · ${state.estimatedTotal ? '至少 ' : ''}${state.total.toLocaleString()} 个文件`
    : `${state.estimatedTotal ? '至少 ' : ''}${state.total.toLocaleString()} 个文件`;
}

function reconcileLocalFolderCount(folderId, total) {
  if (!folderId || !state.library?.folders?.length) return false;
  const path = findFolderPath(state.library.folders, folderId);
  const target = path.at(-1);
  if (!target) return false;
  const current = Number(target.imageCount) || 0;
  const next = Math.max(current, Number(total) || 0);
  const delta = next - current;
  if (!delta) return false;
  target.imageCount = next;
  for (const folder of path) {
    if (Number.isFinite(folder.descendantImageCount)) {
      folder.descendantImageCount = Math.max(folder.descendantImageCount + delta, folder === target ? next : 0);
    }
  }
  renderFolderTree();
  return true;
}

// Eagle stores folder colors either as a hex string or one of its named
// presets; unset folders have no color field at all.
const eagleNamedFolderColors = Object.freeze({
  red: '#e5484d', orange: '#f76b15', yellow: '#ffc53d', green: '#46a758',
  aqua: '#00a2c7', blue: '#0090ff', purple: '#8e4ec6', pink: '#d6409f', gray: '#8d8d8d'
});

function folderColorValue(folder) {
  const raw = String(folder?.color || '').trim();
  if (!raw) return '';
  if (/^#[0-9a-f]{3,8}$/i.test(raw)) return raw;
  return eagleNamedFolderColors[raw.toLowerCase()] || '';
}

function folderColorDot(folder) {
  const color = folderColorValue(folder);
  return color ? `<span class="folder-color-dot" style="background:${escapeHTML(color)}" aria-hidden="true"></span>` : '';
}

function folderLockBadge(folder) {
  return folder?.password ? `<span class="folder-lock" title="加密文件夹">${uiIcon('lock', 'folder-lock-svg')}</span>` : '';
}

function renderFolderTree() {
  if (!state.library) return;
  const tree = $('#folderTree');
  const folderHTML = folders => (folders || []).map(folder => {
    const children = folder.children || [];
    const expanded = state.expandedFolders.has(folder.id);
    const count = Number.isFinite(folder.descendantImageCount) ? folder.descendantImageCount : folder.imageCount;
    return `<div class="folder-node">
      <button class="folder-row ${state.currentView.kind === 'folder' && state.currentView.id === folder.id ? 'active' : ''}" data-folder-id="${escapeHTML(folder.id)}" data-folder-name="${escapeHTML(folder.name)}" aria-expanded="${children.length ? String(expanded) : 'false'}">
        ${children.length ? `<span class="folder-toggle" data-toggle-folder="${escapeHTML(folder.id)}">${eagleIcon('ic-arrow-right.svg', `disclosure-icon${expanded ? ' expanded' : ''}`)}</span>` : '<span class="folder-toggle spacer"></span>'}
        <span class="folder-icon">${eagleIcon('ic-filter-item-folder.svg')}${folderColorDot(folder)}</span><span class="folder-name">${escapeHTML(folder.name)}</span>${folderLockBadge(folder)}
        ${Number.isFinite(count) ? `<span class="folder-count">${count}</span>` : ''}
      </button>
      ${children.length && expanded ? `<div class="folder-children">${folderHTML(children)}</div>` : ''}
    </div>`;
  }).join('');
  const smartFolderHTML = folders => (folders || []).map(folder => {
    const children = folder.children || [];
    const expanded = state.expandedFolders.has(folder.id);
    return `<div class="folder-node">
      <button class="folder-row ${state.currentView.kind === 'smart' && state.currentView.id === folder.id ? 'active' : ''}" data-smart-folder-id="${escapeHTML(folder.id)}" data-folder-name="${escapeHTML(folder.name)}" aria-expanded="${children.length ? String(expanded) : 'false'}">
        ${children.length ? `<span class="folder-toggle" data-toggle-folder="${escapeHTML(folder.id)}">${eagleIcon('ic-arrow-right.svg', `disclosure-icon${expanded ? ' expanded' : ''}`)}</span>` : '<span class="folder-toggle spacer"></span>'}
        <span class="folder-icon smart">${uiIcon('smart')}</span><span class="folder-name">${escapeHTML(folder.name)}</span>
        ${Number.isFinite(folder.imageCount) ? `<span class="folder-count">${folder.imageCount}</span>` : ''}
      </button>
      ${children.length && expanded ? `<div class="folder-children">${smartFolderHTML(children)}</div>` : ''}
    </div>`;
  }).join('');
  const smartHTML = smartFolderHTML(state.library.smartFolders || []);
  const quickHTML = quickAccessEntries().map(folder => folder.quickType === 'smart'
    ? `<button class="folder-row ${state.currentView.kind === 'smart' && state.currentView.id === folder.id ? 'active' : ''}" data-smart-folder-id="${escapeHTML(folder.id)}" data-folder-name="${escapeHTML(folder.name)}">
      <span class="folder-toggle spacer"></span><span class="folder-icon smart">${uiIcon('smart')}</span><span class="folder-name">${escapeHTML(folder.name)}</span></button>`
    : `<button class="folder-row ${state.currentView.kind === 'folder' && state.currentView.id === folder.id ? 'active' : ''}" data-folder-id="${escapeHTML(folder.id)}" data-folder-name="${escapeHTML(folder.name)}">
      <span class="folder-toggle spacer"></span><span class="folder-icon">${eagleIcon('ic-filter-item-folder.svg')}${folderColorDot(folder)}</span><span class="folder-name">${escapeHTML(folder.name)}</span>${folderLockBadge(folder)}${Number.isFinite(folder.descendantImageCount) ? `<span class="folder-count">${folder.descendantImageCount}</span>` : ''}</button>`).join('');
  tree.innerHTML = `
    <button class="folder-row ${state.currentView.kind === 'root' ? 'active' : ''}" data-special="root"><span class="folder-toggle spacer"></span><span class="folder-icon special">${uiIcon('library')}</span><span class="folder-name">资料库根目录</span></button>
    <button class="folder-row ${state.currentView.kind === 'all' ? 'active' : ''}" data-special="all"><span class="folder-toggle spacer"></span><span class="folder-icon special">${eagleIcon('ic-sidebar-all.svg')}</span><span class="folder-name">全部素材</span></button>
    <button class="folder-row ${state.currentView.kind === 'unfiled' ? 'active' : ''}" data-special="unfiled"><span class="folder-toggle spacer"></span><span class="folder-icon special">${eagleIcon('ic-sidebar-unfiled.svg')}</span><span class="folder-name">未分类</span></button>
    <button class="folder-row ${state.currentView.kind === 'untagged' ? 'active' : ''}" data-special="untagged"><span class="folder-toggle spacer"></span><span class="folder-icon special">${uiIcon('tag')}</span><span class="folder-name">未加标签</span></button>
    <button class="folder-row ${state.currentView.kind === 'tags' ? 'active' : ''}" data-special="tags"><span class="folder-toggle spacer"></span><span class="folder-icon special">${uiIcon('tag')}</span><span class="folder-name">标签管理</span><span class="folder-count">${state.availableTags.length.toLocaleString()}</span></button>
    <button class="folder-row ${state.currentView.kind === 'recent' ? 'active' : ''}" data-special="recent"><span class="folder-toggle spacer"></span><span class="folder-icon special">${uiIcon('recent')}</span><span class="folder-name">最近使用</span></button>
    <button class="folder-row ${state.currentView.kind === 'random' ? 'active' : ''}" data-special="random"><span class="folder-toggle spacer"></span><span class="folder-icon special">${uiIcon('random')}</span><span class="folder-name">随机模式</span></button>
    <button class="folder-row ${state.currentView.kind === 'trash' ? 'active' : ''}" data-special="trash"><span class="folder-toggle spacer"></span><span class="folder-icon special">${uiIcon('trash')}</span><span class="folder-name">回收站</span></button>
    ${quickHTML ? `<div class="folder-section-label">快速访问</div>${quickHTML}` : ''}
    ${smartHTML ? `<div class="folder-section-label">智能文件夹</div>${smartHTML}` : ''}
    <div class="folder-section-label">文件夹</div>${folderHTML(state.library.folders)}
    `;
  attachFolderDragTargets();
}

function toggleFolder(id) {
  state.expandedFolders.has(id) ? state.expandedFolders.delete(id) : state.expandedFolders.add(id);
  renderFolderTree();
}

function attachFolderDragTargets() {
  for (const row of document.querySelectorAll('[data-folder-id]')) {
    row.addEventListener('dragover', event => {
      if (!isInternalItemDrag(event.dataTransfer, activeDraggedItemIds())) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', event => {
      const ids = readItemIds(event.dataTransfer, activeDraggedItemIds());
      const libraryPath = state.internalDrag?.libraryPath || state.library?.path;
      const folderId = row.dataset.folderId;
      const folderName = row.dataset.folderName;
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove('drop-target');
      if (!ids.length) {
        toast('无法识别拖入的素材，请重新拖动', 3500);
        clearDragUI();
        return;
      }
      scheduleDropTask(() => addItemsToFolder(ids, folderId, folderName, libraryPath));
    });
  }
}

async function refresh({ reset = true, preserveScroll = true, paneId = state.activePaneId } = {}) {
  const pane = paneById(paneId);
  if (!pane || (pane.loading && !reset)) return;
  const refreshToken = ++pane.refreshToken;
  pane.loading = true;
  withActivePane(paneId, () => $('#loadIndicator').classList.remove('hidden'));
  setSyncStatus('正在同步…');
  const currentView = { ...pane.currentView };
  const selectedId = pane.selected.size === 1 ? [...pane.selected][0] : null;
  const selectedBefore = selectedId ? pane.items.find(item => item.id === selectedId) : null;
  const offset = reset ? 0 : pane.nextOffset;
  const query = {
    ...cloneQuery(pane.query),
    folderId: currentView.kind === 'folder' ? currentView.id : null,
    smartFolderId: currentView.kind === 'smart' ? currentView.id : null,
    unfiled: currentView.kind === 'root' || currentView.kind === 'unfiled',
    isUntagged: currentView.kind === 'untagged',
    random: currentView.kind === 'random'
  };
  try {
    const page = currentView.kind === 'tags'
      ? { data: [], total: 0, nextOffset: 0, hasMore: false }
      : currentView.kind === 'recent'
      ? { data: [], total: 0, nextOffset: 0, hasMore: false }
      : currentView.kind === 'trash'
        ? await window.eagleMV.getTrashItems({ ...query, libraryPath: state.library?.path, offset, limit: state.pageSize })
        : await window.eagleMV.query({ ...query, offset, limit: state.pageSize });
    if (page.error) {
      const error = new Error(page.error.message || '读取失败');
      error.code = page.error.code;
      throw error;
    }
    if (refreshToken !== pane.refreshToken) return;
    const paneIsActive = state.activePaneId === paneId;
    withActivePane(paneId, () => {
      state.errorMessage = '';
      state.total = page.total || 0;
      state.estimatedTotal = Boolean(page.estimated);
      state.nextOffset = page.nextOffset ?? (offset + (page.data || []).length);
      state.hasMore = Boolean(page.hasMore ?? (state.nextOffset < state.total));
      state.items = reset ? (page.data || []) : [...state.items, ...(page.data || []).filter(next => !state.items.some(item => item.id === next.id))];
      if (currentView.kind === 'folder') reconcileLocalFolderCount(currentView.id, state.total);
      renderResultCount();
      $('#viewTitle').textContent = state.viewTitle;
      renderLocation();
      renderGrid({ preserveScroll: preserveScroll && reset });
      if (reset && selectedId) {
        const selectedAfter = itemById(selectedId);
        if (!selectedAfter) {
          state.selected.clear();
          if (paneIsActive) renderInspector();
        } else if (!state.inspectorDirty && paneIsActive) {
          renderInspector();
        } else if (JSON.stringify(selectedBefore) !== JSON.stringify(selectedAfter) && paneIsActive) {
          $('#staleBanner').classList.remove('hidden');
        }
      }
    });
    setSyncStatus(`已同步 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
    setConnection(true);
  } catch (error) {
    if (refreshToken !== pane.refreshToken) return;
    if (currentView.kind === 'trash' && error?.code === 'TRASH_SCAN_INVALIDATED') {
      pane.hasMore = false;
      pane.nextOffset = 0;
      setConnection(true);
      setSyncStatus('回收站数据已变化，正在刷新…');
      scheduleRefresh();
    } else if (currentView.kind === 'trash' && error?.code === 'TRASH_SCAN_TIMEOUT') {
      withActivePane(paneId, () => {
        state.items = [];
        state.total = 0;
        state.estimatedTotal = false;
        state.nextOffset = 0;
        state.hasMore = false;
        $('#resultCount').textContent = '读取失败，请重试';
        $('#viewTitle').textContent = state.viewTitle;
        renderLocation();
        renderGrid({ preserveScroll: false });
      });
      setConnection(true);
      setSyncStatus('回收站读取超时');
      toast(error.message, 5000);
    } else {
      withActivePane(paneId, () => {
        state.errorMessage = error.message || 'Eagle 暂时无法读取当前内容';
        state.hasMore = false;
        $('#resultCount').textContent = '读取失败 · 可重新读取';
        renderGrid({ preserveScroll: true });
      });
      // The DataHub poll is the authority for the global Eagle connection.
      // A malformed smart folder, one slow query, or another pane-specific
      // failure must not disable every otherwise healthy pane.
      setSyncStatus(`栏 ${state.panes.findIndex(candidate => candidate.id === paneId) + 1} 读取失败`);
      toast(`当前栏读取失败：${error.message}`, 4000);
    }
  } finally {
    if (refreshToken === pane.refreshToken) {
      pane.loading = false;
      const paneIsActive = state.activePaneId === paneId;
      withActivePane(paneId, () => {
        $('#loadIndicator').classList.add('hidden');
        if (state.currentView.kind !== 'tags') {
          $('#emptyState').classList.toggle('hidden', state.items.length > 0 || visibleChildFolders().length > 0);
        } else {
          const emptyState = $('#emptyState');
          emptyState.classList.add('hidden');
          emptyState.style.display = 'none';
        }
        if (paneIsActive) updateScrollUI();
        const scroller = $('#gridScroller');
        const needsViewportFill = state.hasMore && scroller.scrollHeight <= scroller.clientHeight + 80;
        const sortBackfillActive = state.sort !== 'default' && state.hasMore;
        if (needsViewportFill || (sortBackfillActive && state.items.length < SORT_FETCH_CAP)) {
          setTimeout(() => refresh({ reset: false, preserveScroll: true, paneId }), 0);
        } else if (sortBackfillActive && state.items.length >= SORT_FETCH_CAP && !pane.sortCapNotified) {
          pane.sortCapNotified = true;
          toast(`素材较多，当前排序先基于前 ${state.items.length} 个素材，继续滚动会继续载入`, 4200);
        }
      });
    }
  }
}

const scheduleRefresh = debounce(() => refreshAllPanes({ reset: true, preserveScroll: true }), 320);

function itemById(id) { return state.items.find(item => item.id === id); }

function selectItem(id, additive = false, range = false) {
  const staysOnSameItem = !additive && !range && state.selected.size === 1 && state.selected.has(id);
  if (staysOnSameItem) return true;
  if (!staysOnSameItem && !confirmDiscardChanges()) return false;
  state.selectedFolderCard = null;
  if (range && state.selected.size) {
    state.selected = selectRange(sortedItems(), state.selected, id, additive);
  } else if (additive) {
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  } else {
    state.selected.clear();
    state.selected.add(id);
  }
  updateCardSelectionStyles();
  renderInspector();
  return true;
}

function renderItemPalette(item) {
  const box = $('#itemPalette');
  if (!box) return;
  const palettes = Array.isArray(item?.palettes) ? item.palettes.slice(0, 8) : [];
  box.innerHTML = palettes.map(entry => {
    const rgb = Array.isArray(entry?.color) ? entry.color.map(v => Math.max(0, Math.min(255, Math.round(Number(v) || 0)))) : null;
    if (!rgb || rgb.length < 3) return '';
    const hex = '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
    const ratio = Number(entry.ratio) || 0;
    const pct = ratio > 1 ? Math.round(ratio) : Math.round(ratio * 100);
    return `<button type="button" class="palette-swatch" style="background:rgb(${rgb.join(',')})" data-color="${hex}" title="${hex} · ${pct}%" aria-label="主色 ${hex}"></button>`;
  }).join('');
  box.classList.toggle('hidden', !box.innerHTML);
}

function renderSharedTags() {
  const section = $('#sharedTagsSection');
  const chips = $('#sharedTagChips');
  if (!section || !chips) return;
  const selectedItems = [...state.selected].map(id => itemById(id)).filter(Boolean);
  const tags = computeSharedTags(selectedItems);
  section.classList.toggle('hidden', !tags.length);
  chips.innerHTML = tags.map(tag => {
    const color = state.tagColors[tag];
    return `<span class="tag-chip"${color ? ` style="--tag-color:${escapeHTML(color)}"` : ''}><span title="${escapeHTML(tag)}">${escapeHTML(tag)}</span><button type="button" data-remove-shared-tag="${escapeHTML(tag)}" aria-label="从所选素材移除 ${escapeHTML(tag)}">×</button></span>`;
  }).join('');
}

function updateURLActions() {
  const url = String($('#itemURL')?.value || '').trim();
  const openButton = $('#openURLButton');
  const copyButton = $('#copyURLButton');
  if (openButton) openButton.disabled = !/^https?:\/\//i.test(url);
  if (copyButton) copyButton.disabled = !url;
}

function renderInspector() {
  const count = state.selected.size;
  $('#noSelection').classList.toggle('hidden', count !== 0);
  $('#inspectorContent').classList.toggle('hidden', count !== 1);
  $('#multiSelection').classList.toggle('hidden', count < 2);
  if (count >= 2) {
    $('#multiCount').textContent = count;
    const allDeleted = [...state.selected].every(id => itemById(id)?.isDeleted);
    $('#batchTrashButton').textContent = allDeleted ? '恢复素材' : '移入废纸篓…';
    renderSharedTags();
    $('#batchRating').value = '';
    state.selectedBase = null;
    state.inspectorDirty = false;
    clearInspectorAutoSave();
    state.commentsToken += 1;
    state.comments = [];
    $('#itemComments').innerHTML = '<span class="muted">选择单个素材查看评论</span>';
    return;
  }
  if (count !== 1) {
    state.metadataToken += 1;
    state.commentsToken += 1;
    state.comments = [];
    $('#itemComments').innerHTML = '<span class="muted">选择单个素材查看评论</span>';
    $('#generationMetadataSection').classList.add('hidden');
    const folder = state.selectedFolderCard ? findFolder(state.library?.folders, state.selectedFolderCard) : null;
    if (folder) {
      const direct = Number(folder.imageCount) || 0;
      const descendants = Number(folder.descendantImageCount) || direct;
      $('#noSelection').innerHTML = `<div class="inspector-folder-icon">${eagleIcon('ic-filter-item-folder.svg', 'inspector-folder-svg')}</div>
        <h2 title="${escapeHTML(folder.name)}">${escapeHTML(folder.name)}</h2>
        <p>${direct.toLocaleString()} 个直属文件 · ${(folder.children || []).length.toLocaleString()} 个子文件夹</p>
        ${descendants !== direct ? `<small>共含 ${descendants.toLocaleString()} 个后代文件<br>双击或按 Return 进入</small>` : '<small>双击或按 Return 进入</small>'}`;
    } else {
      $('#noSelection').innerHTML = '<div class="inspector-placeholder"><img src="brand-icon.png" alt=""></div><p>选择一个素材查看详情</p><small>多个窗口可以停留在不同文件夹和搜索结果中</small>';
    }
    state.selectedBase = null;
    state.inspectorDirty = false;
    clearInspectorAutoSave();
    return;
  }
  const id = [...state.selected][0];
  const item = itemById(id);
  if (!item) return;
  if (state.selectedBase?.id !== id) clearInspectorAutoSave();
  state.selectedBase = structuredClone(item);
  state.inspectorDirty = false;
  $('#staleBanner').classList.add('hidden');
  $('#itemName').value = item.name || '';
  setTagValues('item', item.tags || [], false);
  $('#itemRating').value = String(item.star || 0);
  syncRatingPlaceholder();
  $('#itemAnnotation').value = item.annotation || '';
  $('#itemURL').value = item.url || '';
  updateURLActions();
  resizeAnnotation();
  $('#previewBox').innerHTML = `<img src="eaglemv://thumb/${encodeURIComponent(item.id)}" alt="${escapeHTML(item.name)}">${item.ext ? `<span class="preview-format-badge">${escapeHTML(itemFormat(item))}</span>` : ''}`;
  renderItemPalette(item);
  $('#itemMeta').innerHTML = `<span><em>格式</em>${escapeHTML(String(item.ext || '').toUpperCase())}</span><span><em>大小</em>${formatBytes(item.size)}</span><span><em>尺寸</em>${item.width || 0} × ${item.height || 0}</span><span><em>修改日期</em>${new Date(item.modificationTime || 0).toLocaleDateString('zh-CN')}</span>`;
  loadGenerationMetadata(item);
  $('#customThumbnailButton').disabled = !state.connected;
  loadComments(item);
  $('#trashButton').textContent = item.isDeleted ? '恢复素材' : '移入废纸篓…';
  const canPin = state.currentView.kind === 'folder';
  $('#pinButton').disabled = !canPin || !state.connected;
  $('#pinButton').textContent = canPin && itemIsPinned(item) ? '取消置顶' : '置顶';
  $('#pinButton').title = canPin ? '在当前文件夹内置顶；会同步到所有 MultiView 窗口' : '与 Eagle 原版一致，置顶只在普通文件夹中可用';
}

function commentGeometryLabel(comment) {
  const coordinates = [comment.x, comment.y, comment.width, comment.height].map(Number);
  if (coordinates.every(Number.isFinite)) return `框选 ${coordinates.join(' × ')}`;
  if (Number.isFinite(Number(comment.duration))) return `视频 ${Number(comment.duration).toFixed(2)} 秒`;
  return '普通评论';
}

function renderComments(comments = []) {
  state.comments = Array.isArray(comments) ? comments : [];
  const container = $('#itemComments');
  if (!container) return;
  if (!state.comments.length) {
    container.innerHTML = '<span class="muted">还没有评论或标注</span>';
    return;
  }
  container.innerHTML = state.comments.map((comment, index) => `<article class="comment-row" data-comment-id="${escapeHTML(comment.id || '')}">
    <div class="comment-copy"><p class="comment-text">${escapeHTML(comment.annotation || '未填写文字')}</p><div class="comment-meta">${index + 1} · ${escapeHTML(commentGeometryLabel(comment))}</div></div>
    <div class="comment-actions"><button type="button" class="comment-action" data-comment-action="edit" title="编辑评论">编辑</button><button type="button" class="comment-action danger" data-comment-action="remove" title="删除评论">×</button></div>
  </article>`).join('');
}

function commentContextMatches({ paneId, id, libraryPath }) {
  const pane = paneById(paneId);
  return Boolean(
    pane
    && state.activePaneId === paneId
    && state.library?.path === libraryPath
    && pane.selected.size === 1
    && pane.selected.has(id)
  );
}

async function loadComments(item, context = {}) {
  const paneId = context.paneId || state.activePaneId;
  const libraryPath = context.libraryPath || state.library?.path;
  const target = { paneId, id: item?.id, libraryPath };
  if (!item?.id || !commentContextMatches(target)) return false;
  const token = ++state.commentsToken;
  $('#itemComments').innerHTML = '<span class="muted">正在读取…</span>';
  try {
    const comments = await window.eagleMV.getComments({ id: item.id, libraryPath });
    if (token !== state.commentsToken || !commentContextMatches(target)) return false;
    renderComments(comments);
    return true;
  } catch (error) {
    if (token !== state.commentsToken || !commentContextMatches(target)) return false;
    state.comments = [];
    $('#itemComments').innerHTML = `<span class="muted">Eagle 暂不支持评论接口${error?.message ? `：${escapeHTML(error.message)}` : ''}</span>`;
    return false;
  }
}

async function addCommentToSelected() {
  const paneId = state.activePaneId;
  const pane = paneById(paneId);
  const id = [...(pane?.selected || [])][0];
  if (!id || !state.connected) return;
  const libraryPath = state.library?.path;
  const annotation = prompt('评论内容', '');
  if (annotation === null || !annotation.trim()) return;
  const item = pane.items.find(candidate => candidate.id === id);
  const payload = { id, libraryPath, annotation: annotation.trim() };
  const ext = String(item?.ext || '').toLowerCase();
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv'].includes(ext)) {
    const duration = prompt('可选视频时间点（秒），留空为普通评论', '');
    if (duration?.trim()) {
      const value = Number(duration);
      if (!Number.isFinite(value) || value < 0) { toast('时间点必须是大于等于 0 的数字', 3000); return; }
      payload.duration = value;
    }
  } else if (isImageItem(item)) {
    const rect = prompt('可选图片框选坐标：x,y,width,height；留空为普通评论', '');
    if (rect?.trim()) {
      const values = rect.split(/[,，\s]+/).map(Number);
      if (values.length !== 4 || values.some(value => !Number.isFinite(value)) || values[2] <= 0 || values[3] <= 0) {
        toast('框选坐标格式应为 x,y,width,height，且宽高大于 0', 3600);
        return;
      }
      [payload.x, payload.y, payload.width, payload.height] = values;
    }
  }
  const operationToken = beginForegroundOperation('正在添加评论…', { key: `comment:${libraryPath}:${id}` });
  if (!operationToken) return;
  try {
    await window.eagleMV.addComment(payload);
    if (commentContextMatches({ paneId, id, libraryPath })) await loadComments(item, { paneId, libraryPath });
    toast('评论已添加');
  } catch (error) {
    toast(`添加评论失败：${error.message}`, 4000);
  } finally {
    endForegroundOperation(operationToken);
  }
}

async function editComment(commentId) {
  const paneId = state.activePaneId;
  const pane = paneById(paneId);
  const id = [...(pane?.selected || [])][0];
  const comment = state.comments.find(entry => entry.id === commentId);
  if (!id || !comment) return;
  const libraryPath = state.library?.path;
  const item = pane.items.find(candidate => candidate.id === id);
  const annotation = prompt('编辑评论', comment.annotation || '');
  if (annotation === null || annotation.trim() === comment.annotation) return;
  const operationToken = beginForegroundOperation('正在更新评论…', { key: `comment:${libraryPath}:${id}` });
  if (!operationToken) return;
  try {
    await window.eagleMV.updateComment({ id, libraryPath, commentId, patch: { annotation: annotation.trim() } });
    if (commentContextMatches({ paneId, id, libraryPath })) await loadComments(item, { paneId, libraryPath });
    toast('评论已更新');
  } catch (error) {
    toast(`更新评论失败：${error.message}`, 4000);
  } finally {
    endForegroundOperation(operationToken);
  }
}

async function removeComment(commentId) {
  const paneId = state.activePaneId;
  const pane = paneById(paneId);
  const id = [...(pane?.selected || [])][0];
  const comment = state.comments.find(entry => entry.id === commentId);
  if (!id || !comment || !confirm('删除这条评论或标注？')) return;
  const libraryPath = state.library?.path;
  const item = pane.items.find(candidate => candidate.id === id);
  const operationToken = beginForegroundOperation('正在删除评论…', { key: `comment:${libraryPath}:${id}` });
  if (!operationToken) return;
  try {
    await window.eagleMV.removeComment({ id, libraryPath, commentId });
    if (commentContextMatches({ paneId, id, libraryPath })) await loadComments(item, { paneId, libraryPath });
    toast('评论已删除');
  } catch (error) {
    toast(`删除评论失败：${error.message}`, 4000);
  } finally {
    endForegroundOperation(operationToken);
  }
}

async function setCustomThumbnail() {
  const id = [...state.selected][0];
  if (!id || !state.connected) return;
  const libraryPath = state.library?.path;
  const operationToken = beginForegroundOperation('正在设置自定义缩略图…', { key: `thumbnail:${libraryPath}:${id}` });
  if (!operationToken) return;
  try {
    const result = await window.eagleMV.setCustomThumbnail({ id, libraryPath });
    if (!result?.canceled) {
      toast('自定义缩略图已通过 Eagle 更新');
      await refreshAllPanes({ reset: true, preserveScroll: true });
    }
  } catch (error) {
    toast(`设置自定义缩略图失败：${error.message}`, 4200);
  } finally {
    endForegroundOperation(operationToken);
  }
}

function metadataPromptBlock(label, text, kind) {
  if (!text) return '';
  return `<div class="metadata-block">
    <div class="metadata-block-heading"><span class="metadata-label">${label}</span><button type="button" class="metadata-copy" data-metadata-copy="${kind}">复制</button></div>
    <pre class="metadata-text metadata-prompt-text">${escapeHTML(text)}</pre>
  </div>`;
}

function resizeAnnotation() {
  const annotation = $('#itemAnnotation');
  if (!annotation) return;
  annotation.style.height = 'auto';
  annotation.style.height = `${Math.max(annotation.scrollHeight, 38)}px`;
}

function syncRatingPlaceholder() {
  $('#itemRating')?.classList.toggle('has-value', Number($('#itemRating').value) > 0);
}

function renderGenerationMetadata(metadata) {
  const section = $('#generationMetadataSection');
  if (!metadata) {
    section.classList.add('hidden');
    section.dataset.positive = '';
    section.dataset.negative = '';
    return;
  }
  section.dataset.positive = metadata.positive || '';
  section.dataset.negative = metadata.negative || '';
  $('#generationMetadataFormat').textContent = metadata.format || '';
  const params = Object.entries(metadata.params || {});
  const parameterHTML = params.length ? `<div class="metadata-block">
    <span class="metadata-label">参数</span>
    <dl class="metadata-params">${params.map(([key, value]) => `<dt title="${escapeHTML(key)}">${escapeHTML(key)}</dt><dd>${escapeHTML(value)}</dd>`).join('')}</dl>
  </div>` : '';
  const loraHTML = metadata.loras?.length ? `<div class="metadata-block"><span class="metadata-label">LoRA</span><div class="metadata-loras">${metadata.loras.map(lora => `<span class="metadata-lora">${escapeHTML(lora.name)} · ${escapeHTML(lora.weight)}</span>`).join('')}</div></div>` : '';
  const workflowHTML = metadata.workflow ? `<details class="metadata-workflow-details"><summary>工作流 JSON</summary><pre class="metadata-text metadata-workflow-json">${escapeHTML(JSON.stringify(metadata.workflow, null, 2))}</pre></details>` : '';
  $('#generationMetadata').innerHTML = `${metadataPromptBlock('正向提示词', metadata.positive, 'positive')}${metadataPromptBlock('负向提示词', metadata.negative, 'negative')}${parameterHTML}${loraHTML}${workflowHTML}`;
  section.classList.remove('hidden');
}

async function loadGenerationMetadata(item) {
  const token = ++state.metadataToken;
  $('#generationMetadataSection').classList.add('hidden');
  if (!isImageItem(item)) return;
  try {
    const result = await window.eagleMV.readMetadata(item.id);
    if (token !== state.metadataToken || state.selected.size !== 1 || !state.selected.has(item.id)) return;
    renderGenerationMetadata(result?.metadata || null);
  } catch {
    if (token === state.metadataToken) renderGenerationMetadata(null);
  }
}

function markDirty() {
  if (state.inspectorSaving) return;
  state.inspectorDirty = Object.keys(collectPatch()).length > 0;
  if (state.inspectorDirty) queueInspectorAutoSave();
  else clearInspectorAutoSave();
  if (!state.inspectorDirty && !$('#staleBanner').classList.contains('hidden')) renderInspector();
}

function clearInspectorAutoSave() {
  if (state.inspectorAutoSaveTimer) clearTimeout(state.inspectorAutoSaveTimer);
  state.inspectorAutoSaveTimer = null;
}

function queueInspectorAutoSave({ immediate = false } = {}) {
  clearInspectorAutoSave();
  if (!state.inspectorDirty || !state.connected || state.inspectorSaving) return;
  if (immediate) {
    saveInspector();
    return;
  }
  state.inspectorAutoSaveTimer = setTimeout(() => {
    state.inspectorAutoSaveTimer = null;
    if (state.inspectorDirty && !state.inspectorSaving) saveInspector();
  }, 420);
}

function collectPatch() {
  const base = state.selectedBase;
  if (!base) return {};
  const values = {
    name: $('#itemName').value.trim(),
    tags: [...state.draftTags],
    star: Number($('#itemRating').value),
    annotation: $('#itemAnnotation').value,
    url: $('#itemURL').value.trim()
  };
  const patch = {};
  for (const [key, value] of Object.entries(values)) {
    const equal = Array.isArray(value)
      ? JSON.stringify([...value].sort()) === JSON.stringify([...(base[key] || [])].sort())
      : value === (base[key] ?? (typeof value === 'number' ? 0 : ''));
    if (!equal) patch[key] = value;
  }
  return patch;
}

function setInspectorSaving(saving) {
  state.inspectorSaving = Boolean(saving);
  for (const selector of ['#itemName', '#itemTagInput', '#itemRating', '#itemAnnotation', '#itemURL']) {
    const control = $(selector);
    if (control) control.disabled = state.inspectorSaving;
  }
  for (const button of document.querySelectorAll('#itemTagChips [data-remove-tag]')) button.disabled = state.inspectorSaving;
  $('#paneLayoutButton').disabled = state.inspectorSaving;
  for (const option of $('#paneLayoutPopover').querySelectorAll('[data-layout]')) option.disabled = state.inspectorSaving;
  $('#inspectorContent').classList.toggle('saving', state.inspectorSaving);
}

async function saveInspector(force = false) {
  if (state.inspectorSaving) return false;
  const paneId = state.activePaneId;
  const pane = paneById(paneId);
  const id = [...(pane?.selected || [])][0];
  const patch = collectPatch();
  if (!id || !Object.keys(patch).length) {
    state.inspectorDirty = false;
    clearInspectorAutoSave();
    return true;
  }
  clearInspectorAutoSave();
  const base = structuredClone(pane.selectedBase || {});
  const libraryPath = state.library?.path;
  let overwrite = Boolean(force);
  const operationToken = beginForegroundOperation('正在安全保存素材信息…', { key: 'inspector-save' });
  if (!operationToken) return false;
  setInspectorSaving(true);
  setSyncStatus('正在安全保存…');
  try {
    while (true) {
      const result = await window.eagleMV.mutate({ id, patch, base, force: overwrite, libraryPath });
      if (state.library?.path !== libraryPath) throw new Error('Eagle 已切换资料库，旧资料库的保存结果已忽略');
      if (result.conflict) {
        const fields = result.conflicts.map(conflict => conflict.field).join('、');
        overwrite = confirm(`另一个窗口或 Eagle 已修改：${fields}\n\n按“确定”以当前窗口的内容覆盖这些字段；按“取消”载入最新内容。`);
        if (overwrite) continue;
        const index = pane.items.findIndex(item => item.id === id);
        if (index >= 0) pane.items[index] = result.current;
        state.inspectorDirty = false;
        if (state.activePaneId === paneId) {
          renderGrid();
          renderInspector();
        } else {
          schedulePaneGridRender(paneId);
        }
        toast('已载入另一窗口的最新内容');
        return true;
      }
      const index = pane.items.findIndex(item => item.id === id);
      if (index >= 0) pane.items[index] = result.item;
      state.inspectorDirty = false;
      if (state.activePaneId === paneId) {
        renderGrid();
        renderInspector();
      } else {
        schedulePaneGridRender(paneId);
      }
      toast('修改已同步到所有窗口');
      return true;
    }
  } catch (error) {
    toast(`保存失败：${error.message}`, 4000);
    return false;
  } finally {
    setInspectorSaving(false);
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

async function setPinned(ids, pinned, paneId = state.activePaneId) {
  const pane = paneById(paneId);
  if (pane?.currentView.kind !== 'folder' || !ids?.length) {
    toast('置顶只在普通文件夹中可用', 3200);
    return;
  }
  const libraryPath = state.library?.path;
  const folderId = pane.currentView.id;
  const operationToken = beginForegroundOperation(pinned ? '正在置顶素材…' : '正在取消置顶…', { key: `pins:${paneId}` });
  if (!operationToken) return;
  try {
    state.localPins = await window.eagleMV.setPins({
      libraryPath,
      folderId,
      ids,
      pinned
    });
    if (state.library?.path !== libraryPath) return;
    if (paneById(paneId)) schedulePaneGridRender(paneId);
    if (state.activePaneId === paneId) renderInspector();
    toast(pinned ? `已在当前文件夹置顶 ${ids.length} 个素材` : `已取消 ${ids.length} 个素材的置顶`);
  } catch (error) {
    toast(`置顶操作失败：${error.message}`, 4000);
  } finally {
    endForegroundOperation(operationToken);
  }
}

function closeTrashDialog(choice = null) {
  $('#trashDialog').classList.add('hidden');
  const resolve = state.trashDialogResolve;
  state.trashDialogResolve = null;
  resolve?.(choice);
}

function closeDuplicateDialog(choice = null) {
  $('#duplicateDialog').classList.add('hidden');
  const resolve = state.duplicateDialogResolve;
  state.duplicateDialogResolve = null;
  resolve?.(choice);
}

function blockingSurfaceOpen() {
  return ['#folderDialog', '#trashDialog', '#duplicateDialog', '#contextMenu']
    .some(selector => !$(selector).classList.contains('hidden'));
}

function chooseDuplicateAction(duplicates, total) {
  const duplicateCount = duplicates.length;
  $('#duplicateDialogMessage').textContent = `${total} 个待导入文件中有 ${duplicateCount} 个与资料库已有素材内容相同。请选择使用现有素材，或仍然保留两份。`;
  $('#duplicateDialog').classList.remove('hidden');
  $('#duplicateUseExistingButton').focus();
  return new Promise(resolve => { state.duplicateDialogResolve = resolve; });
}

async function canRemoveFromCurrentFolder(ids, paneId = state.activePaneId) {
  const pane = paneById(paneId);
  const currentFolder = pane?.currentView.kind === 'folder' ? pane.currentView.id : null;
  if (!currentFolder) return false;
  const results = await settleWithConcurrency([...new Set(ids)], id => withTimeout(
    Promise.resolve(pane.items.find(item => item.id === id) || window.eagleMV.getItem(id)),
    15000,
    'Eagle 素材信息读取超时'
  ));
  const items = results.filter(result => result.ok).map(result => result.value);
  return items.some(item => {
    const folders = Array.isArray(item?.folders) ? item.folders : [];
    return folders.includes(currentFolder) && folders.some(folderId => folderId !== currentFolder);
  });
}

function chooseTrashAction(ids) {
  $('#trashDialogMessage').textContent = `已选择 ${ids.length} 个素材。请选择只从当前文件夹移除，还是删除素材并移入回收站。`;
  $('#trashRemoveButton').classList.remove('hidden');
  $('#trashDialog').classList.remove('hidden');
  $('#trashDeleteButton').focus();
  return new Promise(resolve => { state.trashDialogResolve = resolve; });
}

async function applyTrash(ids, deleted, paneId = state.activePaneId) {
  if (!ids.length) return;
  const pane = paneById(paneId);
  if (!pane) return;
  const libraryPath = state.library?.path;
  const action = deleted ? '移入废纸篓' : '恢复';
  const operationToken = beginForegroundOperation(`正在${action}…`, { key: `trash:${paneId}` });
  if (!operationToken) return;
  setSyncStatus(`正在${action}…`);
  try {
    const outcome = await runItemBatch(ids, async id => {
      const item = pane.items.find(candidate => candidate.id === id) || await window.eagleMV.getItem(id);
      const result = await window.eagleMV.mutate({
        id,
        patch: { isDeleted: deleted },
        base: item,
        libraryPath
      });
      if (result.conflict) throw new Error('素材已在其他窗口发生变化，请刷新后重试');
      return result;
    }, `Eagle ${action}请求超时`);
    if (!outcome.succeeded.length) throw outcome.firstError || new Error(`没有素材完成${action}`);
    pane.selected = new Set(outcome.failed);
    if (state.activePaneId === paneId) renderInspector();
    await refresh({ reset: true, preserveScroll: true, paneId });
    toast(outcome.failed.length
      ? `已${action} ${outcome.succeeded.length} 个素材 · ${outcome.failed.length} 个失败并保持选中`
      : `已${action} ${outcome.succeeded.length} 个素材`, outcome.failed.length ? 4400 : 2400);
  } catch (error) {
    toast(`${action}失败：${error.message}`, 4000);
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

async function setTrash(ids, deleted) {
  if (!ids.length) return;
  const paneId = state.activePaneId;
  const sourceFolderId = paneById(paneId)?.currentView.kind === 'folder' ? paneById(paneId).currentView.id : null;
  if (!deleted) return applyTrash(ids, false, paneId);
  if (!(await canRemoveFromCurrentFolder(ids, paneId))) return applyTrash(ids, true, paneId);
  const choice = await chooseTrashAction(ids);
  if (choice === 'remove') return removeSelectionFromFolder({ ids, folderId: sourceFolderId, paneId });
  if (choice === 'delete') return applyTrash(ids, true, paneId);
}

async function mutateSelectionSet(ids, field, delta, message, paneId = state.activePaneId) {
  if (!ids?.length || !state.connected) return false;
  const pane = paneById(paneId);
  if (!pane) return false;
  const libraryPath = state.library?.path;
  const operationToken = beginForegroundOperation(message, { key: `set:${paneId}:${field}` });
  if (!operationToken) return false;
  setSyncStatus(message);
  try {
    const outcome = await runItemBatch(ids, id => window.eagleMV.mutateSet({
      id, field, ...delta, libraryPath
    }), 'Eagle 批量修改请求超时');
    if (!outcome.succeeded.length) throw outcome.firstError || new Error('没有素材完成修改');
    pane.selected = new Set(outcome.failed);
    if (state.activePaneId === paneId) renderInspector();
    await refresh({ reset: true, preserveScroll: true, paneId });
    toast(outcome.failed.length
      ? `已完成 ${outcome.succeeded.length} 个素材 · ${outcome.failed.length} 个失败并保持选中`
      : '操作已同步到所有窗口', outcome.failed.length ? 4200 : 2400);
    return true;
  } catch (error) {
    toast(`操作失败：${error.message}`, 4000);
    return false;
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

async function addSelectionToFolder(payload) {
  const folderId = payload?.folderId;
  if (!folderId) return false;
  const libraryPath = state.library?.path;
  const completed = await mutateSelectionSet(payload.ids, 'folders', { add: [folderId] }, '正在加入文件夹…', payload?.paneId || state.activePaneId);
  if (completed && state.library?.path === libraryPath) markFolderUsed(folderId, libraryPath);
  return completed;
}

async function moveSelectionToFolder(payload) {
  const folderId = payload?.folderId;
  if (!folderId) return;
  const paneId = payload?.paneId || state.activePaneId;
  const pane = paneById(paneId);
  const ids = payload?.ids || [...(pane?.selected || [])];
  if (!ids.length || !state.connected) return;
  if (!pane) return;
  const libraryPath = state.library?.path;
  const sourceFolderId = payload?.sourceFolderId || (pane.currentView.kind === 'folder' ? pane.currentView.id : null);
  if (!sourceFolderId) {
    toast('请在具体文件夹中使用“移动到文件夹”', 3500);
    return;
  }
  if (sourceFolderId === folderId) {
    toast('素材已经在这个文件夹中', 3000);
    return;
  }
  const delta = folderMoveDelta(sourceFolderId, folderId);
  const operationToken = beginForegroundOperation('正在移动到文件夹…', { key: `move:${paneId}` });
  if (!operationToken) return;
  setSyncStatus('正在移动到文件夹…');
  try {
    const outcome = await runItemBatch(ids, id => window.eagleMV.mutateSet({
      id, field: 'folders', ...delta, libraryPath
    }), 'Eagle 移动请求超时');
    if (!outcome.succeeded.length) throw outcome.firstError || new Error('没有素材完成移动');
    pane.selected = new Set(outcome.failed);
    if (state.activePaneId === paneId) renderInspector();
    await refresh({ reset: true, preserveScroll: true, paneId });
    toast(outcome.failed.length
      ? `已移动 ${outcome.succeeded.length} 个素材 · ${outcome.failed.length} 个失败并保持选中`
      : '已移动到目标文件夹', outcome.failed.length ? 4200 : 2400);
    if (state.library?.path === libraryPath) markFolderUsed(folderId, libraryPath);
    return true;
  } catch (error) {
    toast(`移动失败：${error.message}`, 4000);
    return false;
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

function removeSelectionFromFolder(payload) {
  const paneId = payload?.paneId || state.activePaneId;
  const pane = paneById(paneId);
  const folderId = payload?.folderId || (pane?.currentView.kind === 'folder' ? pane.currentView.id : null);
  if (!folderId) return false;
  return mutateSelectionSet(payload.ids, 'folders', { remove: [folderId] }, '正在从文件夹移除…', paneId);
}

function addTagToSelection(payload) {
  const tags = normalizeTags(Array.isArray(payload?.tag) ? payload.tag : [payload?.tag]);
  if (!tags.length) return false;
  return mutateSelectionSet(payload.ids, 'tags', { add: tags }, '正在添加标签…', payload?.paneId || state.activePaneId);
}

async function setSelectionRating(payload) {
  const rating = Math.max(0, Math.min(5, Number(payload?.rating) || 0));
  const paneId = payload?.paneId || state.activePaneId;
  const pane = paneById(paneId);
  const ids = payload?.ids || [...(pane?.selected || [])];
  if (!ids.length || !state.connected) return;
  if (!pane) return;
  const libraryPath = state.library?.path;
  const operationToken = beginForegroundOperation('正在设置评分…', { key: `rating:${paneId}` });
  if (!operationToken) return;
  setSyncStatus('正在设置评分…');
  try {
    const outcome = await runItemBatch(ids, async id => {
      const item = pane.items.find(candidate => candidate.id === id) || await window.eagleMV.getItem(id);
      const result = await window.eagleMV.mutate({ id, patch: { star: rating }, base: item, libraryPath });
      if (result?.conflict) throw new Error('素材已在其他窗口发生变化');
      return result;
    }, 'Eagle 评分请求超时');
    if (!outcome.succeeded.length) throw outcome.firstError || new Error('没有素材完成评分');
    pane.selected = new Set(outcome.failed);
    if (state.activePaneId === paneId) renderInspector();
    await refresh({ reset: true, preserveScroll: true, paneId });
    toast(outcome.failed.length
      ? `已为 ${outcome.succeeded.length} 个素材设置评分 · ${outcome.failed.length} 个失败并保持选中`
      : `已设置为 ${rating ? `${rating} 星` : '未评分'}`, outcome.failed.length ? 4200 : 2400);
  } catch (error) {
    toast(`评分失败：${error.message}`, 4000);
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

async function removeTagFromSelection(tag) {
  const paneId = state.activePaneId;
  const pane = paneById(paneId);
  const ids = [...(pane?.selected || [])];
  if (!ids.length || !tag || !state.connected) return;
  const libraryPath = state.library?.path;
  const operationToken = beginForegroundOperation('正在移除标签…', { key: `shared-tag-remove:${paneId}` });
  if (!operationToken) return;
  setSyncStatus('正在移除标签…');
  try {
    const outcome = await runItemBatch(ids, id => window.eagleMV.mutateSet({
      id, field: 'tags', remove: [tag], libraryPath
    }), 'Eagle 批量标签请求超时');
    if (!outcome.succeeded.length) throw outcome.firstError || new Error('没有素材完成标签修改');
    pane.selected = new Set(outcome.failed.length ? outcome.failed : ids);
    if (state.activePaneId === paneId) renderInspector();
    await refresh({ reset: true, preserveScroll: true, paneId });
    toast(outcome.failed.length
      ? `已从 ${outcome.succeeded.length} 个素材移除「${tag}」 · ${outcome.failed.length} 个失败并保持选中`
      : `已从 ${outcome.succeeded.length} 个素材移除「${tag}」`, outcome.failed.length ? 4200 : 2400);
  } catch (error) {
    toast(`移除标签失败：${error.message}`, 4000);
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

function mediaMarkup(item) {
  const url = `eaglemv://original/${encodeURIComponent(item.id)}`;
  const ext = String(item.ext || '').toLowerCase();
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv'].includes(ext)) return `<video src="${url}" controls autoplay></video>`;
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)) return `<audio src="${url}" controls autoplay></audio>`;
  if (ext === 'pdf') return `<embed src="${url}" type="application/pdf" width="100%" height="100%">`;
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif', 'bmp'].includes(ext)) return `<img src="${url}" alt="${escapeHTML(item.name)}">`;
  return `<div class="unsupported-preview"><img src="eaglemv://thumb/${encodeURIComponent(item.id)}" alt="${escapeHTML(item.name)}"><p>${escapeHTML(String(item.ext || '文件').toUpperCase())} 无法直接预览<br><span>按 ⇧Enter 使用默认应用打开</span></p></div>`;
}

function previewImage() { return $('#modalMedia img.preview-image'); }

function renderPreviewZoom() {
  const image = previewImage();
  const zoom = state.previewZoom;
  $('#previewZoomLabel').textContent = `${Math.round(zoom.scale * 100)}%`;
  if (!image) return;
  const fit = zoom.mode === 'fit';
  image.classList.toggle('preview-actual', !fit);
  image.style.maxWidth = fit ? '100%' : 'none';
  image.style.maxHeight = fit ? '100%' : 'none';
  image.style.width = 'auto';
  image.style.height = 'auto';
  image.style.transform = fit ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  image.style.cursor = !fit ? (zoom.dragging ? 'grabbing' : 'grab') : 'zoom-in';
}

function setPreviewZoom(mode, scale = null) {
  const nextScale = scale === null ? (mode === 'fit' ? 1 : mode === 'actual' ? 1 : state.previewZoom.scale) : scale;
  state.previewZoom = { ...state.previewZoom, mode, scale: Math.max(.25, Math.min(6, nextScale)), x: 0, y: 0, dragging: false };
  renderPreviewZoom();
}

function changePreviewZoom(delta) {
  const next = Math.max(.25, Math.min(6, state.previewZoom.scale + delta));
  setPreviewZoom('zoom', next);
}

function setupPreviewMedia() {
  const image = $('#modalMedia img');
  if (image) {
    image.classList.add('preview-image');
    image.addEventListener('load', () => renderPreviewZoom(), { once: true });
  }
  renderPreviewZoom();
}

function updatePreviewChrome(item) {
  const items = sortedItems();
  const index = items.findIndex(candidate => candidate.id === item.id);
  const position = index >= 0 ? `${index + 1} / ${state.total || items.length}` : '';
  $('#modalCaption').textContent = `${position}${position ? ' · ' : ''}${item.name}.${item.ext}`;
  $('#prevPreview').disabled = index <= 0;
  $('#nextPreview').disabled = index < 0 || (index >= items.length - 1 && !state.hasMore);
}

function renderTextPreview(session) {
  $('#modalMedia').innerHTML = `<div class="text-preview">
    <div class="text-toolbar">
      <span id="textStatus" class="text-status">UTF-8 · ${formatBytes(session.fingerprint.size)}</span>
      <button id="reloadTextButton" type="button">重新载入</button>
      <button id="saveTextButton" class="primary" type="button" disabled>保存 ⌘S</button>
    </div>
    <textarea id="textEditor" class="text-editor" spellcheck="false" aria-label="TXT 内容"></textarea>
  </div>`;
  const editor = $('#textEditor');
  editor.value = session.content;
  editor.disabled = state.textSaving;
  editor.addEventListener('input', () => {
    session.content = editor.value;
    session.dirty = session.content !== session.original;
    $('#saveTextButton').disabled = state.textSaving || !session.dirty || !state.connected;
    $('#textStatus').textContent = session.dirty ? '有未保存修改' : `UTF-8 · ${formatBytes(session.fingerprint.size)}`;
  });
  editor.addEventListener('keydown', event => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = editor.selectionStart;
      editor.setRangeText('  ', start, editor.selectionEnd, 'end');
      editor.dispatchEvent(new Event('input'));
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveTextPreview();
    }
  });
  $('#saveTextButton').addEventListener('click', () => saveTextPreview());
  $('#reloadTextButton').addEventListener('click', async () => {
    if (session.dirty && !confirm('重新载入会放弃当前 TXT 修改，是否继续？')) return;
    session.dirty = false;
    await openPreview(session.id, { forceReload: true });
  });
  $('#reloadTextButton').disabled = state.textSaving;
}

async function openPreview(id, { forceReload = false } = {}) {
  const item = itemById(id);
  if (!item) return false;
  if (!forceReload && state.previewId && state.previewId !== id && !confirmDiscardChanges()) return false;
  if (forceReload && state.textSession) state.textSession.dirty = false;
  const token = ++state.previewToken;
  state.previewId = id;
  $('#previewModal').classList.remove('hidden');
  updatePreviewChrome(item);
  if (String(item.ext || '').toLowerCase() !== 'txt') {
    state.textSession = null;
    $('#modalMedia').innerHTML = mediaMarkup(item);
    setPreviewZoom('fit');
    setupPreviewMedia();
    return true;
  }
  setPreviewZoom('fit');
  $('#modalMedia').innerHTML = '<div class="unsupported-preview"><p>正在读取 TXT…</p></div>';
  try {
    const result = await window.eagleMV.readText({ id, libraryPath: state.library?.path });
    if (token !== state.previewToken || state.previewId !== id) return false;
    state.textSession = { id, content: result.content, original: result.content, fingerprint: result.fingerprint, dirty: false };
    renderTextPreview(state.textSession);
    return true;
  } catch (error) {
    if (token !== state.previewToken) return false;
    state.textSession = null;
    $('#modalMedia').innerHTML = `<div class="unsupported-preview"><img src="eaglemv://thumb/${encodeURIComponent(item.id)}" alt=""><p>无法读取 TXT<br><span>${escapeHTML(error.message)} · 可按 ⇧Enter 用默认应用打开</span></p></div>`;
    return false;
  }
}

function setTextSaving(saving, session = state.textSession) {
  state.textSaving = Boolean(saving);
  if (state.textSession !== session) return;
  const editor = $('#textEditor');
  const reload = $('#reloadTextButton');
  const save = $('#saveTextButton');
  if (editor) editor.disabled = state.textSaving;
  if (reload) reload.disabled = state.textSaving;
  if (save) save.disabled = state.textSaving || !session?.dirty || !state.connected;
}

async function saveTextPreview(force = false) {
  if (state.textSaving) return false;
  const session = state.textSession;
  if (!session?.dirty) return true;
  const id = session.id;
  const content = session.content;
  const base = structuredClone(session.fingerprint);
  const libraryPath = state.library?.path;
  let overwrite = Boolean(force);
  const operationToken = beginForegroundOperation('正在安全保存 TXT…', { key: 'text-save' });
  if (!operationToken) return false;
  setTextSaving(true, session);
  $('#textStatus').textContent = '正在安全保存…';
  try {
    while (true) {
      const result = await window.eagleMV.saveText({ id, libraryPath, content, base, force: overwrite });
      if (state.library?.path !== libraryPath) throw new Error('Eagle 已切换资料库，旧资料库的 TXT 保存结果已忽略');
      if (result.conflict) {
        overwrite = confirm('这个 TXT 已在另一个窗口或其他应用中修改。\n\n按“确定”用当前编辑内容覆盖；按“取消”载入磁盘上的最新内容。');
        if (overwrite) continue;
        session.content = result.current.content;
        session.original = result.current.content;
        session.fingerprint = result.current.fingerprint;
        session.dirty = false;
        if (state.textSession === session) renderTextPreview(session);
        toast('已载入磁盘上的最新 TXT 内容');
        return true;
      }
      session.fingerprint = result.fingerprint;
      session.original = content;
      session.content = content;
      session.dirty = false;
      if (state.textSession === session) {
        $('#saveTextButton').disabled = true;
        $('#textStatus').textContent = `已保存 · ${formatBytes(result.fingerprint.size)}`;
      }
      toast('TXT 已安全保存；原版本已备份');
      return true;
    }
  } catch (error) {
    if (state.textSession === session) {
      const save = $('#saveTextButton');
      const status = $('#textStatus');
      if (save) save.disabled = false;
      if (status) status.textContent = '保存失败';
    }
    toast(`TXT 保存失败：${error.message}`, 4400);
    return false;
  } finally {
    setTextSaving(false, session);
    endForegroundOperation(operationToken);
  }
}

function closePreview({ commitSelection = true, skipDiscard = false } = {}) {
  if (!skipDiscard && state.textSession?.dirty && !confirmDiscardChanges()) return false;
  const finalId = state.previewId;
  ++state.previewToken;
  state.previewId = null;
  state.textSession = null;
  $('#previewModal').classList.add('hidden');
  $('#modalMedia').innerHTML = '';
  if (commitSelection && finalId && itemById(finalId)) {
    state.selectedFolderCard = null;
    state.selected = new Set([finalId]);
    updateCardSelectionStyles();
    renderInspector();
    requestAnimationFrame(() => {
      const card = paneRoot()?.querySelector(`.item-card[data-id="${CSS.escape(finalId)}"]`);
      card?.focus({ preventScroll: true });
      card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      updateScrollUI();
    });
  }
  return true;
}

async function openWithDefault(id) {
  try {
    const result = await window.eagleMV.openDefault(id);
    if (!result?.ok) toast(`无法打开：${result?.message || '找不到素材原文件'}`, 4000);
  } catch (error) {
    toast(`无法打开：${error.message}`, 4000);
  }
}

async function movePreview(delta) {
  let items = sortedItems();
  let index = items.findIndex(item => item.id === state.previewId);
  let next = items[index + delta];
  if (!next && delta > 0 && state.hasMore) {
    await refresh({ reset: false, preserveScroll: true });
    items = sortedItems();
    index = items.findIndex(item => item.id === state.previewId);
    next = items[index + delta];
  }
  if (next) await openPreview(next.id);
}

function descriptorFromTarget(target) {
  if (target.dataset.folderId) return { kind: 'folder', id: target.dataset.folderId };
  if (target.dataset.smartFolderId) return { kind: 'smart', id: target.dataset.smartFolderId, name: target.dataset.folderName };
  return { kind: target.dataset.special || 'root' };
}

function descriptorKey(view) {
  return `${view.kind}:${view.id || ''}`;
}

function normalizeView(view) {
  return normalizeFolderView(state.library?.folders, view);
}

function applyView(view) {
  view = normalizeView(view);
  state.currentView = view;
  if (view.kind === 'folder') {
    const folder = findFolder(state.library?.folders, view.id);
    state.viewTitle = folder?.name || '文件夹';
  } else if (view.kind === 'smart') {
    state.viewTitle = view.name || '智能文件夹';
  } else {
    state.viewTitle = ({ root: state.library?.name || '资料库', all: '全部素材', unfiled: '未分类', untagged: '未加标签', recent: '最近使用', random: '随机模式', trash: '回收站', tags: '标签管理' })[view.kind] || '资料库';
  }
}

function navigate(view, { record = true, refreshView = true, skipDiscard = false } = {}) {
  if (!state.library) return;
  view = normalizeView(view);
  if (view.kind === 'folder') {
    const target = findFolder(state.library?.folders, view.id);
    if (target?.password) {
      toast('该文件夹已加密，MultiView 无法解锁（Eagle API 限制）', 3600);
      return false;
    }
  }
  const changed = descriptorKey(view) !== descriptorKey(state.currentView);
  if (!skipDiscard && !confirmDiscardChanges()) return false;
  if (record && changed) {
    const recorded = recordViewNavigation(state.history, state.historyIndex, state.currentView, view);
    state.history = recorded.history;
    state.historyIndex = recorded.historyIndex;
  } else if (record && state.historyIndex < 0) {
    state.history = [{ ...view }];
    state.historyIndex = 0;
  }
  applyView(view);
  if (view.kind === 'folder') revealFolderPath(view.id);
  $('#viewTitle').textContent = state.viewTitle;
  closePreview({ commitSelection: false, skipDiscard: true });
  state.selected.clear();
  state.selectedFolderCard = null;
  if (changed) {
    state.items = [];
    state.total = 0;
    state.estimatedTotal = false;
    state.nextOffset = 0;
    state.hasMore = false;
    $('#resultCount').textContent = '正在读取…';
    renderGrid({ preserveScroll: false });
  }
  renderInspector();
  renderFolderTree();
  renderLocation();
  if (refreshView) refresh({ reset: true, preserveScroll: false });
  return true;
}

function navigateHistory(delta) {
  const next = state.historyIndex + delta;
  if (next < 0 || next >= state.history.length) return;
  if (!confirmDiscardChanges()) return;
  state.historyIndex = next;
  navigate(state.history[next], { record: false, skipDiscard: true });
}

function parentView() {
  return resolveParentView(state.library?.folders, state.currentView);
}

function navigateUp() {
  const parent = parentView();
  if (parent) navigate(parent);
}

function renderLocation() {
  if (!state.library) return;
  let crumbs = [{ label: state.library.name || '资料库', view: { kind: 'root' } }];
  if (state.currentView.kind === 'folder') {
    crumbs = crumbs.concat(findFolderPath(state.library.folders, state.currentView.id).map(folder => ({ label: folder.name, view: { kind: 'folder', id: folder.id } })));
  } else if (state.currentView.kind !== 'root') {
    crumbs.push({ label: state.viewTitle, view: state.currentView });
  }
  $('#breadcrumb').innerHTML = crumbs.map((crumb, index) => `<button data-crumb-index="${index}" ${index === crumbs.length - 1 ? 'disabled' : ''}>${escapeHTML(crumb.label)}</button>${index < crumbs.length - 1 ? '<span>›</span>' : ''}`).join('');
  $('#breadcrumb')._crumbs = crumbs;
  $('#backButton').disabled = state.historyIndex <= 0;
  $('#forwardButton').disabled = state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
  $('#upButton').disabled = !parentView();
}

function locateCurrentFolder() {
  const folders = state.library?.folders || [];
  if (!folders.length) return;
  const path = state.currentView.kind === 'folder' ? findFolderPath(folders, state.currentView.id) : [];
  const reference = path.length > 1 ? path.at(-2) : folders[0];
  const expand = !state.expandedFolders.has(reference.id);
  state.expandedFolders.clear();
  if (expand) {
    const addAll = nodes => (nodes || []).forEach(folder => {
      if (folder.children?.length) state.expandedFolders.add(folder.id);
      addAll(folder.children);
    });
    addAll(folders);
  }
  renderFolderTree();
  if (expand) {
    requestAnimationFrame(() => {
      const active = $('#folderTree .folder-row.active');
      active?.scrollIntoView({ block: 'center' });
      active?.classList.add('located');
      setTimeout(() => active?.classList.remove('located'), 900);
    });
    toast('已展开全部文件夹并定位当前文件夹');
  } else {
    $('#folderTree').scrollTop = 0;
    toast('已收起全部文件夹');
  }
}

function importTargetFolderId() {
  return state.currentView.kind === 'folder' ? state.currentView.id : null;
}

async function importFiles(paths = null, source = 'picker') {
  if (!state.connected || state.importing) return;
  const sourcePaneId = state.activePaneId;
  const operationToken = beginForegroundOperation('正在导入到 Eagle…', { key: 'import' });
  if (!operationToken) return;
  state.importing = true;
  setSyncStatus('正在导入到 Eagle…');
  try {
    const payload = { folderId: importTargetFolderId(), libraryPath: state.library?.path };
    let result = source === 'clipboard'
      ? await window.eagleMV.importClipboard(payload)
      : await window.eagleMV.importItems({ ...payload, ...(paths?.length ? { paths } : {}) });
    if (result.canceled) return;
    if (result.needsDuplicateDecision) {
      const choice = await chooseDuplicateAction(result.duplicates || [], result.paths?.length || paths?.length || 0);
      if (!choice || choice === 'cancel') return;
      result = await window.eagleMV.importItems({ ...payload, paths: result.paths, duplicateChoice: choice });
      if (result.canceled) return;
    }
    if (!result.count) {
      toast(source === 'clipboard' ? '剪贴板里没有可导入的文件或图片' : (result.rejected?.[0]?.message || '没有可导入的文件'), 3800);
      return;
    }
    await window.eagleMV.focusWindow().catch(() => {});
    await refreshAllPanes({ reset: true, preserveScroll: true });
    const pending = Math.max(0, result.count - result.ready);
    const rejected = (result.rejected?.length || 0) + (result.duplicateFailed || 0);
    toast(`已接收 ${result.count} 个素材${pending ? ` · ${pending} 个仍由 Eagle 后台处理` : ''}${rejected ? ` · ${rejected} 个未完成` : ''}`, 4200);
    if (pending) {
      setTimeout(() => refresh({ reset: true, preserveScroll: true, paneId: sourcePaneId }), 1600);
      setTimeout(() => refresh({ reset: true, preserveScroll: true, paneId: sourcePaneId }), 4200);
    }
  } catch (error) {
    toast(`导入失败：${error.message}`, 4600);
  } finally {
    state.importing = false;
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

function bindTagEditor(kind) {
  const config = tagEditors[kind];
  const input = $(config.input);
  const chips = $(config.chips);
  const editor = input.closest('.tag-editor');
  const popover = ensureTagSuggestionPopover(kind);
  input.setAttribute('aria-haspopup', 'listbox');
  input.setAttribute('aria-expanded', 'false');
  input.addEventListener('keydown', event => {
    const suggestions = tagSuggestionRecords(kind);
    const activeIndex = Number(popover?.dataset.activeIndex || -1);
    if (event.key === 'ArrowDown' && suggestions.length) {
      event.preventDefault();
      openTagSuggestions(kind);
      const next = activeIndex < suggestions.length - 1 ? activeIndex + 1 : 0;
      if (popover) {
        popover.dataset.activeIndex = String(next);
        renderTagSuggestionPopover(kind, { open: true });
        popover.querySelector(`[data-tag-suggestion="${CSS.escape(suggestions[next].name)}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    } else if (event.key === 'ArrowUp' && suggestions.length) {
      event.preventDefault();
      openTagSuggestions(kind);
      const next = activeIndex > 0 ? activeIndex - 1 : suggestions.length - 1;
      if (popover) {
        popover.dataset.activeIndex = String(next);
        renderTagSuggestionPopover(kind, { open: true });
        popover.querySelector(`[data-tag-suggestion="${CSS.escape(suggestions[next].name)}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    } else if (event.key === 'Escape') {
      closeTagSuggestions(kind);
    } else if (event.key === 'Enter' && activeIndex >= 0 && suggestions[activeIndex]) {
      event.preventDefault();
      chooseTagSuggestion(kind, suggestions[activeIndex].name);
    } else if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
      event.preventDefault();
      commitTagInput(kind);
    } else if (event.key === 'Backspace' && !input.value && tagValues(kind).length) {
      removeTag(kind, tagValues(kind).at(-1));
    }
  });
  input.addEventListener('focus', () => openTagSuggestions(kind));
  input.addEventListener('input', () => renderTagSuggestionPopover(kind, { open: true }));
  input.addEventListener('blur', () => {
    commitTagInput(kind);
    if (kind === 'item') queueInspectorAutoSave({ immediate: true });
    setTimeout(() => {
      if (document.activeElement !== input && !popover?.contains(document.activeElement)) closeTagSuggestions(kind);
    }, 0);
  });
  input.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text') || '';
    if (!/[,，\n]/.test(text)) return;
    event.preventDefault();
    setTagValues(kind, [...tagValues(kind), ...text.split(/[,，\n]+/)]);
  });
  chips.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-tag]');
    if (button) removeTag(kind, button.dataset.removeTag);
  });
  popover?.addEventListener('pointerdown', event => {
    const suggestion = event.target.closest('[data-tag-suggestion]');
    if (!suggestion) return;
    event.preventDefault();
    chooseTagSuggestion(kind, suggestion.dataset.tagSuggestion);
  });
  editor.addEventListener('click', event => {
    if (event.target === event.currentTarget) input.focus();
  });
}

function contextMenuRow({ icon = 'more', label, shortcut = '', action = '', payload = {}, submenu = null, disabled = false, danger = false }) {
  const attributes = action ? ` data-context-action="${escapeHTML(action)}" data-context-payload="${escapeHTML(JSON.stringify(payload))}"` : '';
  const className = `context-menu-row${submenu ? ' has-submenu' : ''}${disabled ? ' disabled' : ''}${danger ? ' danger' : ''}`;
  const child = submenu ? `<span class="context-menu-arrow">›</span><div class="context-submenu">${submenu}</div>` : '';
  return `<div class="${className}" role="menuitem"${attributes} aria-disabled="${disabled ? 'true' : 'false'}">
    <span class="context-menu-leading">${uiIcon(icon, 'context-menu-icon')}</span><span class="context-menu-label">${escapeHTML(label)}</span>${shortcut ? `<span class="context-menu-shortcut">${escapeHTML(shortcut)}</span>` : ''}${child}
  </div>`;
}

function newFileSubmenuMarkup(folderId = null, paneId = state.activePaneId) {
  return ['md', 'json', 'html', 'svg'].map(type => contextMenuRow({
    icon: 'path',
    label: newFileTypes[type].label,
    action: 'create-document',
    payload: { type, folderId, paneId }
  })).join('');
}

function newCreationMenuMarkup({ folderId = null, paneId = state.activePaneId } = {}) {
  return [
    contextMenuRow({ icon: 'folder', label: folderId ? '新建子文件夹' : '新建文件夹', shortcut: '⌥ N', action: 'create-current-folder', payload: { parentId: folderId, paneId } }),
    contextMenuRow({ icon: 'path', label: '新建 TXT', shortcut: '⌥ ⇧ N', action: 'create-document', payload: { type: 'txt', folderId, paneId } }),
    contextMenuRow({ icon: 'path', label: '新建文件…', submenu: newFileSubmenuMarkup(folderId, paneId) }),
    contextMenuRow({ icon: 'smart', label: '新建智能文件夹…', action: 'create-smart-folder', payload: { paneId } }),
    '<div class="context-menu-separator"></div>',
    contextMenuRow({ icon: 'window', label: '新建窗口', shortcut: '⌘ ⌥ N', action: 'new-window' })
  ].join('');
}

function contextFolderEntries(action, query = '') {
  const search = searchFolders(state.library?.folders, query, { excludeId: state.contextMenu?.folderId, limit: 100 });
  const searching = Boolean(String(query || '').trim());
  const entries = search.results.map(folder => contextMenuRow({
    icon: 'folder',
    label: searching ? folder.path : `${'  '.repeat(Math.min(folder.depth, 3))}${folder.name}`,
    action,
    payload: { folderId: folder.id }
  }));
  if (!entries.length) entries.push(contextMenuRow({ label: searching ? '没有匹配的文件夹' : '没有可用文件夹', disabled: true }));
  if (search.truncated) entries.push(contextMenuRow({ label: `继续输入以缩小范围 · 共 ${search.matched.toLocaleString()} 个`, disabled: true }));
  return entries.join('');
}

function contextFolderPicker(action) {
  return `<div class="context-folder-picker" data-folder-picker-action="${escapeHTML(action)}">
    <input class="context-picker-search context-folder-search" type="search" placeholder="搜索全部文件夹…" aria-label="搜索目标文件夹" autocomplete="off">
    <div class="context-folder-results">${contextFolderEntries(action)}</div>
  </div>`;
}

function contextTagEntries(action = 'add-tag', query = '') {
  const keyword = String(query || '').trim();
  const normalizedKeyword = keyword.toLocaleLowerCase('zh-CN');
  const all = normalizeTags((state.availableTags || []).map(tag => typeof tag === 'string' ? tag : tag?.name));
  const matches = normalizedKeyword
    ? all.filter(tag => tag.toLocaleLowerCase('zh-CN').includes(normalizedKeyword))
    : all;
  const entries = [];
  const exact = keyword && all.some(tag => tag.toLocaleLowerCase('zh-CN') === normalizedKeyword);
  if (action === 'add-tag' && keyword && !exact) {
    entries.push(contextMenuRow({ icon: 'tag', label: `添加“${keyword}”`, action, payload: { tag: keyword } }));
  }
  entries.push(...matches.slice(0, 100).map(tag => contextMenuRow({ icon: 'tag', label: tag, action, payload: { tag } })));
  if (!entries.length) entries.push(contextMenuRow({ label: keyword ? '没有匹配的标签' : '暂无已有标签', disabled: true }));
  if (matches.length > 100) entries.push(contextMenuRow({ label: `继续输入以缩小范围 · 共 ${matches.length.toLocaleString()} 个`, disabled: true }));
  return entries.join('');
}

function contextTagPicker(action, placeholder = '搜索标签…') {
  return `<div class="context-tag-picker" data-tag-picker-action="${escapeHTML(action)}">
    <input class="context-picker-search context-tag-search" type="search" placeholder="${escapeHTML(placeholder)}" aria-label="${escapeHTML(placeholder)}" autocomplete="off">
    <div class="context-tag-results">${contextTagEntries(action)}</div>
  </div>`;
}

function contextMenuMarkup(data) {
  if (data.kind === 'new-menu') return newCreationMenuMarkup(data);
  if (data.kind === 'shortcut-folder-picker') {
    return `<div class="context-shortcut-picker">${contextFolderPicker('add-folder')}</div>`;
  }
  if (data.kind === 'smart-folder') {
    return [
      contextMenuRow({ icon: 'rename', label: '重命名智能文件夹', action: 'rename-smart-folder', payload: { id: data.smartFolderId } }),
      contextMenuRow({ icon: 'smart', label: '将当前筛选另存为智能文件夹', action: 'save-smart-folder' }),
      '<div class="context-menu-separator"></div>',
      contextMenuRow({ icon: 'trashMenu', label: '移除智能文件夹…', action: 'remove-smart-folder', payload: { id: data.smartFolderId }, danger: true })
    ].join('');
  }
  if (data.kind === 'sidebar') {
    return [
      ...(data.targetFolderId ? [contextMenuRow({ icon: 'rename', label: '重命名', shortcut: '⌘ R', action: 'rename-folder', payload: { folderId: data.targetFolderId } }), '<div class="context-menu-separator"></div>'] : []),
      contextMenuRow({ icon: 'folder', label: '新建同级文件夹', action: 'create-folder', payload: { parentId: data.siblingParentId || null, subfolder: false, paneId: data.paneId } }),
      ...(data.targetFolderId ? [contextMenuRow({ icon: 'folder', label: '新建子文件夹', shortcut: '⌥ N', action: 'create-folder', payload: { parentId: data.targetFolderId, subfolder: true } })] : [])
    ].join('');
  }
  if (data.kind === 'folder') {
    return [
      contextMenuRow({ icon: 'rename', label: '重命名', shortcut: '⌘ R', action: 'rename-folder', payload: { folderId: data.folderId } }),
      '<div class="context-menu-separator"></div>',
      contextMenuRow({ icon: 'folder', label: '新建子文件夹', action: 'create-folder', payload: { parentId: data.folderId, subfolder: true, paneId: data.paneId } })
    ].join('');
  }
  if (data.kind === 'workspace') {
    return [
      newCreationMenuMarkup({ folderId: data.folderId, paneId: data.paneId }),
      '<div class="context-menu-separator"></div>',
      contextMenuRow({ icon: 'import', label: state.importing ? '正在导入…' : '导入文件…', action: 'import', disabled: !state.connected || state.importing }),
      contextMenuRow({ icon: 'refresh', label: '刷新所有分栏', action: 'refresh-all', disabled: !state.connected })
    ].join('');
  }
  const one = data.ids.length === 1;
  const currentFolder = state.currentView.kind === 'folder' ? state.currentView.id : null;
  const finderLabel = window.eagleMV.platform === 'darwin' ? '在访达中打开' : '在文件资源管理器中显示';
  const folderEntries = contextFolderPicker('add-folder');
  const moveEntries = currentFolder ? contextFolderPicker('move-folder') : '';
  const ratingEntries = [0, 1, 2, 3, 4, 5].map(rating => contextMenuRow({ icon: 'more', label: rating ? `${'★'.repeat(rating)}（${rating} 星）` : '未评分', action: 'rating', payload: { rating } })).join('');
  const moreEntries = [
    contextMenuRow({ icon: 'rename', label: '重命名', shortcut: '⌘ R', action: 'rename', disabled: !one }),
    contextMenuRow({ icon: 'copy', label: one ? '复制素材名称' : `复制 ${data.ids.length} 个素材名称`, action: 'copy-name' }),
    contextMenuRow({ icon: 'tag', label: '添加标签', submenu: contextTagPicker('add-tag', '搜索或输入标签…') }),
    contextMenuRow({ icon: 'copy', label: '复制标签', shortcut: '⌘ ⇧ C', action: 'copy-tags' }),
    contextMenuRow({ icon: 'tag', label: '粘贴标签', shortcut: '⌘ ⇧ V', action: 'paste-tags', disabled: !state.copiedTags.length }),
    contextMenuRow({ icon: 'more', label: '设置评分', submenu: ratingEntries }),
    contextMenuRow({ icon: 'tag', label: '标签颜色', submenu: contextTagPicker('tag-color') })
  ].join('');
  return [
    contextMenuRow({ icon: 'window', label: '在新窗口打开', shortcut: '⌘ O', action: 'open-window' }),
    contextMenuRow({ icon: 'open', label: '在默认应用打开', shortcut: '⇧ Enter', action: 'open-default', disabled: !one }),
    contextMenuRow({ icon: 'open', label: '在其它应用打开…', action: 'open-other', disabled: !one }),
    contextMenuRow({ icon: 'finder', label: finderLabel, shortcut: '⌘ Enter', action: 'finder' }),
    contextMenuRow({ icon: 'path', label: '打开文件所在的位置', submenu: contextMenuRow({ label: finderLabel, action: 'finder' }) }),
    '<div class="context-menu-separator"></div>',
    contextMenuRow({ icon: 'folder', label: '添加至上次使用的文件夹…', shortcut: '⇧ D', action: 'last-folder', disabled: !state.recentFolders?.length }),
    contextMenuRow({ icon: 'folder', label: '添加至文件夹…', shortcut: '⌘ ⇧ J', submenu: folderEntries }),
    ...(currentFolder ? [contextMenuRow({ icon: 'folder', label: '移动到文件夹…', submenu: moveEntries })] : []),
    contextMenuRow({ icon: 'export', label: '导出', action: 'export' }),
    contextMenuRow({ icon: 'share', label: '分享', action: 'share' }),
    '<div class="context-menu-separator"></div>',
    contextMenuRow({ icon: 'pin', label: data.allPinned ? '取消置顶' : '置顶', action: 'pin', disabled: !currentFolder }),
    contextMenuRow({ icon: 'copy', label: one ? '复制文件' : `复制 ${data.ids.length} 个文件`, shortcut: '⌘ C', action: 'copy-files' }),
    contextMenuRow({ icon: 'path', label: '复制文件路径', shortcut: '⌘ ⌥ C', action: 'copy-path', disabled: !one }),
    contextMenuRow({ icon: 'copy', label: '创建副本', shortcut: '⌘ D', action: 'duplicate' }),
    contextMenuRow({ icon: 'more', label: '更多', submenu: moreEntries }),
    '<div class="context-menu-separator"></div>',
    ...(currentFolder ? [contextMenuRow({ icon: 'remove', label: '从文件夹中移除', shortcut: '⌘ ⇧ ⌫', action: 'remove-folder' })] : []),
    contextMenuRow({ icon: 'trashMenu', label: data.allDeleted ? '恢复素材' : '丢到回收站', shortcut: '⌘ ⌫', action: 'trash', danger: !data.allDeleted })
  ].join('');
}

function hideContextMenu() {
  state.contextMenu = null;
  $('#contextMenu').classList.add('hidden');
  $('#contextMenu').innerHTML = '';
  $('#newButton')?.setAttribute('aria-expanded', 'false');
}

function openSelectionInNewWindow(ids = []) {
  const uniqueIds = [...new Set(ids || [])].filter(Boolean);
  return window.eagleMV.newWindow({
    view: { ...state.currentView },
    query: cloneQuery(state.query),
    selectedIds: uniqueIds,
    previewId: uniqueIds.length === 1 ? uniqueIds[0] : null
  });
}

function showContextMenuAt(x, y, data) {
  state.contextMenu = { ...data, x, y };
  const menu = $('#contextMenu');
  menu.innerHTML = contextMenuMarkup(state.contextMenu);
  menu.classList.remove('hidden');
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  });
}

function showContextMenu(event, data) {
  showContextMenuAt(event.clientX, event.clientY, data);
}

async function executeContextAction(action, payload) {
  const data = state.contextMenu;
  if (!data) return;
  if (action === 'save-smart-folder') return saveCurrentViewAsSmartFolder();
  if (action === 'rename-smart-folder') return renameSmartFolder(payload.id);
  if (action === 'remove-smart-folder') return removeSmartFolder(payload.id);
  if (action === 'create-smart-folder') return createSmartFolderFromNewMenu();
  if (action === 'create-folder' || action === 'create-current-folder') return createFolder(payload.parentId || null, Boolean(payload.subfolder || payload.parentId), payload.paneId || data.paneId);
  if (action === 'create-document') return createNewDocument(payload.type, { folderId: payload.folderId || null, paneId: payload.paneId || data.paneId });
  if (action === 'new-window') return window.eagleMV.newWindow();
  if (action === 'rename-folder') return renameFolderById(payload.folderId || data.folderId);
  if (action === 'import') return importFiles();
  if (action === 'refresh-all') return refreshAllPanes({ reset: true, preserveScroll: true });
  const ids = data.ids || [];
  const firstId = ids[0];
  if (action === 'open-window') return openSelectionInNewWindow(ids);
  if (action === 'open-default') return openWithDefault(firstId);
  if (action === 'open-other') {
    return window.eagleMV.openOther({ ids: [firstId] }).then(result => {
      if (result?.message) toast(result.message, 4000);
      else if (result?.missing) toast(`已打开 ${result.count} 个文件 · ${result.missing} 个原文件缺失`, 3500);
    });
  }
  if (action === 'finder') return showItemInFileManager(firstId);
  if (action === 'copy-files') return copySelectedFiles(ids);
  if (action === 'export') {
    return window.eagleMV.exportFiles({ ids, libraryPath: state.library?.path }).then(result => {
      if (result?.canceled) return;
      toast(`已导出 ${result?.count || 0} 个文件${result?.missing ? ` · ${result.missing} 个原文件缺失` : ''}`, 4000);
    });
  }
  if (action === 'share') {
    return window.eagleMV.shareFiles({ ids }).then(result => {
      if (!result?.ok) toast(result?.message || '无法打开分享菜单', 4000);
    });
  }
  if (action === 'duplicate') return duplicateSelection(ids);
  if (action === 'copy-name') return window.eagleMV.copyText(ids.map(id => itemById(id)?.name || '').filter(Boolean).join('\n'));
  if (action === 'copy-path') return copyItemPath(firstId);
  if (action === 'copy-tags') return copyTagsFromItems(ids);
  if (action === 'paste-tags') return pasteTagsToItems(ids);
  if (action === 'add-folder') return addSelectionToFolder({ ids, folderId: payload.folderId });
  if (action === 'move-folder') return moveSelectionToFolder({ ids, folderId: payload.folderId });
  if (action === 'remove-folder') return removeSelectionFromFolder({ ids, folderId: state.currentView.id });
  if (action === 'last-folder') return addSelectionToFolder({ ids, folderId: state.recentFolders[0]?.id });
  if (action === 'add-tag') return addTagToSelection({ ids, tag: payload.tag });
  if (action === 'tag-color') {
    const tag = String(payload.tag || '').trim();
    if (!tag) return;
    const color = prompt(`设置标签“${tag}”颜色（六位十六进制）`, state.tagColors[tag] || '#0072ef');
    if (color !== null) return updateTagColor(tag, color.trim());
    return;
  }
  if (action === 'rating') return setSelectionRating({ ids, rating: payload.rating });
  if (action === 'pin') return setPinned(ids, !data.allPinned);
  if (action === 'rename') {
    return renameItem(itemById(firstId));
  }
  if (action === 'trash') return setTrash(ids, !data.allDeleted);
}

function closeFolderDialog(name = null) {
  $('#folderDialog').classList.add('hidden');
  const resolve = state.folderDialogResolve;
  state.folderDialogResolve = null;
  if (resolve) resolve(name);
}

function requestNameDialog({ title, initialValue = '', submitLabel = '确认', fieldLabel = '名称', placeholder = '' }) {
  if (state.folderDialogResolve) closeFolderDialog();
  $('#folderDialogTitle').textContent = title;
  $('#folderDialogFieldLabel').textContent = fieldLabel;
  $('#folderDialogCreateButton').textContent = submitLabel;
  $('#folderNameInput').value = initialValue;
  $('#folderNameInput').placeholder = placeholder;
  $('#folderDialog').classList.remove('hidden');
  requestAnimationFrame(() => {
    $('#folderNameInput').focus();
    $('#folderNameInput').select();
  });
  return new Promise(resolve => { state.folderDialogResolve = resolve; });
}

function folderCreationParentForPane(paneId = state.activePaneId) {
  const pane = paneById(paneId);
  return pane?.currentView.kind === 'folder' ? pane.currentView.id : null;
}

async function revealCreatedFolder({ paneId, viewKey, libraryPath, parentId, id }) {
  if (!id) return false;
  const deadline = Date.now() + 1800;
  while (state.library?.path === libraryPath && !findFolder(state.library?.folders, id) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  const folder = findFolder(state.library?.folders, id);
  if (!folder || state.library?.path !== libraryPath) return false;
  revealFolderPath(id);
  if (parentId) state.expandedFolders.add(parentId);
  renderFolderTree();

  const pane = paneById(paneId);
  if (!pane || state.activePaneId !== paneId || descriptorKey(pane.currentView) !== viewKey) return false;
  const destinationIsVisible = parentId
    ? pane.currentView.kind === 'folder' && pane.currentView.id === parentId
    : pane.currentView.kind === 'root';
  if (!destinationIsVisible) return false;
  pane.selected.clear();
  pane.selectedFolderCard = id;
  withActivePane(paneId, () => {
    renderGrid({ preserveScroll: true });
    renderInspector();
  });
  requestAnimationFrame(() => {
    const card = paneQuery(paneId, `.folder-card[data-open-folder="${CSS.escape(id)}"]`);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  return true;
}

async function createFolder(parentId = null, subfolder = false, paneId = state.activePaneId) {
  if (!state.connected) {
    toast('Eagle 未连接，暂时无法新建文件夹', 3500);
    return;
  }
  if (state.folderDialogResolve) {
    toast('请先完成当前的新建名称输入', 2800);
    return false;
  }
  if (state.operationTracker.size) {
    toast(`${foregroundOperationSummary()}，完成后再新建文件夹`, 3200);
    return false;
  }
  const sourcePane = paneById(paneId);
  if (!sourcePane) return false;
  const libraryPath = state.library?.path;
  const viewKey = descriptorKey(sourcePane.currentView);
  const operationToken = beginForegroundOperation(subfolder ? '正在创建子文件夹…' : '正在创建文件夹…', { key: `create-folder:${libraryPath}:${parentId || 'root'}` });
  if (!operationToken) return false;
  try {
    const result = await window.eagleMV.createFolder({ name: '未命名文件夹', parent: parentId, libraryPath });
    if (!result?.id) throw new Error('Eagle 没有返回新文件夹');
    const revealed = await revealCreatedFolder({ paneId, viewKey, libraryPath, parentId, id: result.id });
    if (!revealed && state.library?.path === libraryPath) {
      setTimeout(() => revealCreatedFolder({ paneId, viewKey, libraryPath, parentId, id: result.id }).catch(() => {}), 900);
    }
    toast(result.renamed
      ? `已创建 ${result.name}（同名文件夹已自动编号）`
      : `已创建 ${result.name}`, result.renamed ? 3800 : 2400);
    return true;
  } finally {
    endForegroundOperation(operationToken);
  }
}

async function revealCreatedDocument({ paneId, viewKey, libraryPath, id, type }) {
  const pane = paneById(paneId);
  if (!pane || state.library?.path !== libraryPath) return false;
  await refresh({ reset: true, preserveScroll: true, paneId });
  if (state.activePaneId !== paneId || descriptorKey(pane.currentView) !== viewKey) return false;
  const item = pane.items.find(candidate => candidate.id === id);
  if (!item) return false;
  pane.selectedFolderCard = null;
  pane.selected = new Set([id]);
  updateCardSelectionStyles();
  renderInspector();
  if (type === 'txt') {
    await openPreview(id);
    requestAnimationFrame(() => $('#textEditor')?.focus());
  } else {
    requestAnimationFrame(() => focusSelectedCard()?.focus({ preventScroll: true }));
  }
  return true;
}

async function createNewDocument(type, { folderId = null, paneId = state.activePaneId } = {}) {
  const config = newFileTypes[String(type || '').toLowerCase()];
  if (!config) throw new Error('不支持的新建文件类型');
  if (!state.connected) {
    toast('Eagle 未连接，暂时无法新建文件', 3500);
    return false;
  }
  if (state.folderDialogResolve) {
    toast('请先完成当前的新建名称输入', 2800);
    return false;
  }
  if (state.importing) {
    toast('正在完成上一个导入或新建操作，请稍候', 3200);
    return false;
  }
  if (state.operationTracker.size) {
    toast(`${foregroundOperationSummary()}，完成后再新建文件`, 3200);
    return false;
  }
  const sourcePane = paneById(paneId);
  if (!sourcePane) return false;
  const libraryPath = state.library?.path;
  const viewKey = descriptorKey(sourcePane.currentView);
  const targetFolderId = folderId || null;
  const operationToken = beginForegroundOperation(`正在创建 ${config.label}…`, { key: `create-document:${libraryPath}:${targetFolderId || 'unfiled'}` });
  if (!operationToken) return false;
  state.importing = true;
  setSyncStatus(`正在创建 ${config.label}…`);
  try {
    const result = await window.eagleMV.createDocument({
      type,
      name: config.defaultName,
      folderId: targetFolderId,
      libraryPath
    });
    if (!result?.id) throw new Error('Eagle 没有返回新文件');
    const revealed = await revealCreatedDocument({ paneId, viewKey, libraryPath, id: result.id, type });
    if (!revealed && state.library?.path === libraryPath) {
      setTimeout(() => revealCreatedDocument({ paneId, viewKey, libraryPath, id: result.id, type }).catch(() => {}), 1400);
      setTimeout(() => refresh({ reset: true, preserveScroll: true, paneId }).catch(() => {}), 4200);
    }
    toast(result.renamed
      ? `已创建 ${result.name}.${type}（同名文件已自动改名）`
      : `已创建 ${result.name}.${type}`, result.renamed ? 4200 : 2800);
    return true;
  } finally {
    state.importing = false;
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

async function renameItem(item) {
  if (!item || !state.connected) return;
  if (!confirmDiscardChanges()) return;
  const nextName = await requestNameDialog({ title: '重命名素材', initialValue: item.name || '', submitLabel: '重命名' });
  if (nextName === null || nextName === item.name) return;
  const libraryPath = state.library?.path;
  const operationToken = beginForegroundOperation('正在重命名素材…', { key: `rename-item:${libraryPath}:${item.id}` });
  if (!operationToken) return;
  setSyncStatus('正在重命名…');
  try {
    let result = await window.eagleMV.mutate({
      id: item.id,
      patch: { name: nextName },
      base: { name: item.name },
      libraryPath
    });
    if (result?.conflict) {
      const overwrite = confirm(`这个素材已在 Eagle 或另一个窗口中重命名为“${result.current?.name || '未命名'}”。\n\n按“确定”覆盖为当前名称；按“取消”载入最新名称。`);
      if (!overwrite) {
        scheduleRefresh();
        return;
      }
      result = await window.eagleMV.mutate({
        id: item.id,
        patch: { name: nextName },
        base: { name: result.current?.name || item.name },
        force: true,
        libraryPath
      });
    }
    if (!result?.ok) throw new Error('重命名未完成');
    toast('素材已重命名');
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

async function renameFolderById(folderId) {
  const folder = findFolder(state.library?.folders, folderId);
  if (!folder || !state.connected) return;
  if (!confirmDiscardChanges()) return;
  const nextName = await requestNameDialog({ title: '重命名文件夹', initialValue: folder.name || '', submitLabel: '重命名' });
  if (nextName === null || nextName === folder.name) return;
  const libraryPath = state.library?.path;
  const operationToken = beginForegroundOperation('正在重命名文件夹…', { key: `rename-folder:${libraryPath}:${folder.id}` });
  if (!operationToken) return;
  setSyncStatus('正在重命名…');
  try {
    let result = await window.eagleMV.mutateFolder({
      id: folder.id,
      name: nextName,
      baseName: folder.name,
      libraryPath
    });
    if (result?.conflict) {
      const overwrite = confirm(`这个文件夹已在 Eagle 或另一个窗口中重命名为“${result.current?.name || '未命名'}”。\n\n按“确定”覆盖为当前名称；按“取消”载入最新名称。`);
      if (!overwrite) {
        scheduleRefresh();
        return;
      }
      result = await window.eagleMV.mutateFolder({
        id: folder.id,
        name: nextName,
        baseName: result.current?.name || folder.name,
        force: true,
        libraryPath
      });
    }
    if (!result?.ok) throw new Error('重命名未完成');
    toast('文件夹已重命名');
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

async function renameSelection() {
  if (state.selected.size === 1) return renameItem(itemById([...state.selected][0]));
  if (state.selected.size > 1) return false;
  if (state.selectedFolderCard) return renameFolderById(state.selectedFolderCard);
  const activeFolderRow = document.activeElement?.closest?.('[data-folder-id]');
  if (activeFolderRow?.dataset.folderId) return renameFolderById(activeFolderRow.dataset.folderId);
  if (state.currentView.kind === 'folder') return renameFolderById(state.currentView.id);
  return false;
}

function requestRenameSelection() {
  const editable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  const previewOpen = !$('#previewModal').classList.contains('hidden');
  if (editable || previewOpen) return Promise.resolve(false);
  return renameSelection();
}

function siblingParentId(folderId) {
  if (!folderId) return null;
  const path = findFolderPath(state.library?.folders || [], folderId);
  return path.length > 1 ? path.at(-2).id : null;
}

function currentFolderSiblingParentId() {
  return state.currentView.kind === 'folder' ? siblingParentId(state.currentView.id) : null;
}

async function copySelectedFiles(ids = [...state.selected]) {
  if (!ids.length) return;
  const result = await window.eagleMV.copyFiles(ids);
  if (!result.count) {
    toast(result.message ? `复制失败：${result.message}` : '找不到可复制的素材原文件', 4000);
    return;
  }
  toast(`已复制 ${result.count} 个文件${result.missing ? ` · ${result.missing} 个原文件缺失` : ''}`);
}

function selectedActionIds({ includePreview = false } = {}) {
  if (includePreview && state.previewId) return [state.previewId];
  return [...state.selected];
}

async function showItemInFileManager(id) {
  if (!id) return false;
  try {
    const shown = await window.eagleMV.showInFinder(id);
    if (!shown) toast('找不到素材原文件', 3500);
    return shown;
  } catch (error) {
    toast(`无法在 Finder 中显示：${error.message}`, 4000);
    return false;
  }
}

async function copyItemPath(id) {
  if (!id) return false;
  const filePath = await window.eagleMV.filePath(id);
  if (!filePath) {
    toast('找不到素材原文件', 3500);
    return false;
  }
  await window.eagleMV.copyText(filePath);
  toast('文件路径已复制');
  return true;
}

function copyTagsFromItems(ids = selectedActionIds()) {
  state.copiedTags = normalizeTags((ids || []).flatMap(id => itemById(id)?.tags || []));
  toast(state.copiedTags.length ? `已复制 ${state.copiedTags.length} 个标签` : '所选素材没有标签');
  return state.copiedTags.length > 0;
}

function pasteTagsToItems(ids = selectedActionIds()) {
  if (!state.copiedTags.length) {
    toast('请先复制标签', 3000);
    return false;
  }
  return addTagToSelection({ ids, tag: state.copiedTags });
}

async function duplicateSelection(ids = selectedActionIds(), paneId = state.activePaneId) {
  const uniqueIds = [...new Set(ids || [])].filter(Boolean);
  if (!uniqueIds.length) return false;
  const pane = paneById(paneId);
  if (!pane) return false;
  const folderId = pane.currentView.kind === 'folder' ? pane.currentView.id : null;
  const preserveFolders = pane.currentView.kind !== 'folder';
  const libraryPath = state.library?.path;
  return runForegroundOperation('正在创建副本…', { key: `duplicate:${paneId}` }, async () => {
    const result = await window.eagleMV.duplicateFiles({ ids: uniqueIds, folderId, preserveFolders, libraryPath });
    if (!result?.count) {
      toast(result?.message || '没有可创建副本的原文件', 4000);
      return false;
    }
    const createdItems = (await Promise.all((result.ids || []).map(id => window.eagleMV.getItem(id).catch(() => null)))).filter(Boolean);
    const mergeCreatedItems = () => {
      const sourcePane = paneById(paneId);
      if (!sourcePane || state.library?.path !== libraryPath || !createdItems.length) return;
      const known = new Set(sourcePane.items.map(item => item.id));
      const additions = createdItems.filter(item => !known.has(item.id));
      if (!additions.length) return;
      sourcePane.items = [...additions, ...sourcePane.items];
      sourcePane.total = Math.max(sourcePane.items.length, sourcePane.total + additions.length);
      reconcileLocalFolderCount(folderId, sourcePane.total);
      withActivePane(paneId, () => {
        renderGrid({ preserveScroll: true });
        renderResultCount();
      });
    };
    await refresh({ reset: true, preserveScroll: true, paneId });
    mergeCreatedItems();
    for (const delay of [1600, 4200]) setTimeout(async () => {
      await refresh({ reset: true, preserveScroll: true, paneId }).catch(() => {});
      mergeCreatedItems();
    }, delay);
    toast(`已创建 ${result.count} 个副本${result.missing ? ` · ${result.missing} 个原文件缺失` : ''}${result.folderAssignmentFailed ? ` · ${result.folderAssignmentFailed} 个未能保留原文件夹` : ''}`, 4200);
    return true;
  });
}

function showFolderAssignmentPicker(ids = selectedActionIds()) {
  const uniqueIds = [...new Set(ids || [])].filter(Boolean);
  if (!uniqueIds.length) return false;
  const card = paneRoot()?.querySelector(`.item-card[data-id="${CSS.escape(uniqueIds[0])}"]`);
  const rect = card?.getBoundingClientRect();
  const x = rect ? rect.left + Math.min(rect.width, 34) : Math.round(window.innerWidth / 2 - 147);
  const y = rect ? Math.min(rect.bottom + 6, window.innerHeight - 180) : Math.round(window.innerHeight / 2 - 180);
  showContextMenuAt(x, y, {
    kind: 'shortcut-folder-picker',
    ids: uniqueIds,
    folderId: state.currentView.kind === 'folder' ? state.currentView.id : null
  });
  requestAnimationFrame(() => $('#contextMenu').querySelector('.context-folder-search')?.focus());
  return true;
}

function activeDraggedItemIds() {
  const sharedIds = state.internalDrag?.active ? state.internalDrag.ids : [];
  return sharedIds?.length ? sharedIds : (state.draggingItemIds || []);
}

function clearDragUI() {
  const token = state.internalDrag?.token || null;
  state.dragDepth = 0;
  state.draggingItemIds = null;
  state.dragSourcePaneId = null;
  state.internalDrag = null;
  if (token) window.eagleMV.cancelDrag?.(token);
  for (const pane of state.panes || []) {
    pane.dragDepth = 0;
    pane.draggingItemIds = null;
  }
  for (const target of document.querySelectorAll('.drop-target')) target.classList.remove('drop-target');
  for (const overlay of document.querySelectorAll('.drop-overlay')) overlay.classList.add('hidden');
}

function scheduleDropTask(task) {
  // Electron native file drags run through a macOS dragging session. Starting
  // Eagle API IPC while the browser is still unwinding the drop event can
  // leave the native drag session and renderer waiting on each other. Always
  // release every local/native drag state first, return from the DOM event,
  // and only start the mutation on the next task.
  clearDragUI();
  setTimeout(() => {
    Promise.resolve()
      .then(task)
      .catch(error => {
        console.error('Deferred drop task failed:', error);
        toast(`拖放失败：${error.message || '未知错误'}`, 4600);
      });
  }, 0);
}

function withTimeout(promise, milliseconds, message = '操作超时，请重试') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = 'OPERATION_TIMEOUT';
      reject(error);
    }, milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function settleWithConcurrency(values, worker, concurrency = 4) {
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
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return results;
}

async function runItemBatch(ids, worker, timeoutMessage) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  const results = await settleWithConcurrency(uniqueIds, id => withTimeout(
    worker(id),
    15000,
    timeoutMessage
  ));
  const succeeded = [];
  const failed = [];
  let firstError = null;
  results.forEach((result, index) => {
    if (result?.ok) succeeded.push(uniqueIds[index]);
    else {
      failed.push(uniqueIds[index]);
      firstError ||= result?.error || new Error('操作失败');
    }
  });
  return { succeeded, failed, firstError };
}

async function addItemsToFolder(ids, folderId, folderName = '目标文件夹', libraryPath = state.library?.path) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  if (!uniqueIds.length || !folderId) return false;
  if (!state.connected) {
    toast('Eagle 未连接，暂时无法修改归类', 3500);
    return true;
  }
  const operationToken = beginForegroundOperation(`正在归类 ${uniqueIds.length} 个素材…`, { key: `folder-add:${libraryPath}:${folderId}` });
  if (!operationToken) return true;
  setSyncStatus(`正在归类 ${uniqueIds.length} 个素材…`);
  try {
    const results = await settleWithConcurrency(uniqueIds, id => withTimeout(
      window.eagleMV.mutateSet({
        id,
        field: 'folders',
        add: [folderId],
        libraryPath
      }),
      15000,
      'Eagle 归类请求超时'
    ));
    const failed = results.filter(result => !result.ok);
    const succeeded = results.length - failed.length;
    if (!succeeded) throw failed[0]?.error || new Error('没有素材完成归类');
    toast(`已加入“${folderName || '目标文件夹'}”${failed.length ? ` · ${failed.length} 个失败` : ''}`);
    if (failed.length) console.warn('Some dragged items could not be assigned:', failed.map(result => result.error?.message));
    if (state.library?.path === libraryPath) markFolderUsed(folderId, libraryPath);
    return true;
  } catch (error) {
    toast(`归类失败：${error.message}`, 4600);
    return true;
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

function paneItemDropContext(targetPaneId, event) {
  const targetPane = paneById(targetPaneId);
  const internalDrag = state.internalDrag;
  const ids = readItemIds(event.dataTransfer, activeDraggedItemIds());
  if (!targetPane || !ids.length) return null;
  let sourcePaneId = state.dragSourcePaneId || internalDrag?.sourcePaneId || null;
  try { sourcePaneId = event.dataTransfer.getData('application/x-eagle-multiview-source-pane') || sourcePaneId; } catch {}
  const sourceIsThisWindow = !internalDrag?.sourceWindowId || internalDrag.sourceWindowId === state.windowId;
  const sourcePane = sourceIsThisWindow && sourcePaneId ? paneById(sourcePaneId) : null;
  return {
    targetPaneId,
    ids,
    libraryPath: internalDrag?.libraryPath || state.library?.path,
    targetFolderId: targetPane.currentView.kind === 'folder' ? targetPane.currentView.id : null,
    sourceFolderId: sourcePane?.currentView.kind === 'folder'
      ? sourcePane.currentView.id
      : (internalDrag?.sourceFolderId || null),
    move: Boolean(event.altKey)
  };
}

async function handlePaneItemDrop(context) {
  if (!context) return false;
  const { targetPaneId, ids, libraryPath, targetFolderId, sourceFolderId, move } = context;
  if (!state.connected) { toast('Eagle 未连接，暂时无法修改归类', 3500); return true; }
  if (!targetFolderId) { toast('请将素材拖入一个具体文件夹栏', 3500); return true; }
  if (sourceFolderId && sourceFolderId === targetFolderId) { toast('素材已经在这个文件夹中'); return true; }
  const operationToken = beginForegroundOperation(`${move ? '正在移动' : '正在复制'} ${ids.length} 个素材…`, { key: `pane-drop:${targetPaneId}` });
  if (!operationToken) return true;
  setSyncStatus(`${move ? '正在移动' : '正在复制'} ${ids.length} 个素材…`);
  try {
    const results = await settleWithConcurrency(ids, id => withTimeout(
      window.eagleMV.mutateSet({
        id,
        field: 'folders',
        add: [targetFolderId],
        remove: move && sourceFolderId ? [sourceFolderId] : [],
        libraryPath
      }),
      15000,
      'Eagle 归类请求超时'
    ));
    const failed = results.filter(result => !result.ok);
    const succeeded = results.length - failed.length;
    if (!succeeded) throw failed[0]?.error || new Error('没有素材完成归类');
    if (failed.length) console.warn('Some dropped items could not be assigned:', failed.map(result => result.error?.message));
    toast(`${move ? '已移动' : '已复制'} ${succeeded} 个素材到当前栏${failed.length ? ` · ${failed.length} 个失败` : ''}`);
    if (state.library?.path === libraryPath) markFolderUsed(targetFolderId, libraryPath);
    // Refresh the drop target now, but do not hold the native drop completion
    // open while every other pane performs a network query.
    await withTimeout(refresh({ reset: true, preserveScroll: true, paneId: targetPaneId }), 12000, '刷新目标栏超时');
    setTimeout(() => refreshAllPanes({ reset: true, preserveScroll: true }).catch(() => {}), 0);
  } catch (error) {
    toast(`${move ? '移动' : '复制'}失败：${error.message}`, 4200);
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
  return true;
}

function bindWorkspaceResizers() {
  const root = document.documentElement;
  const workspace = $('.workspace');
  for (const handle of document.querySelectorAll('[data-resizer]')) {
    handle.addEventListener('pointerdown', event => {
      const kind = handle.dataset.resizer;
      const property = kind === 'sidebar' ? '--sidebar-width' : '--inspector-width';
      const startX = event.clientX;
      const startValue = parseFloat(getComputedStyle(root).getPropertyValue(property)) || (kind === 'sidebar' ? 234 : 304);
      const rect = workspace.getBoundingClientRect();
      handle.classList.add('dragging');
      handle.setPointerCapture(event.pointerId);
      const move = moveEvent => {
        const delta = kind === 'sidebar' ? moveEvent.clientX - startX : startX - moveEvent.clientX;
        const other = kind === 'sidebar'
          ? parseFloat(getComputedStyle(root).getPropertyValue('--inspector-width')) || 304
          : parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-width')) || 234;
        const max = Math.max(kind === 'sidebar' ? 170 : 240, rect.width - other - 340);
        const next = Math.max(kind === 'sidebar' ? 150 : 220, Math.min(max, startValue + delta));
        root.style.setProperty(property, `${Math.round(next)}px`);
      };
      const end = () => {
        handle.classList.remove('dragging');
        handle.releasePointerCapture?.(event.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        try { localStorage.setItem(`eaglemv.${kind}Width`, root.style.getPropertyValue(property)); } catch {}
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  }
}

function restorePanelSizes() {
  for (const kind of ['sidebar', 'inspector']) {
    try {
      const value = Number.parseFloat(localStorage.getItem(`eaglemv.${kind}Width`));
      if (Number.isFinite(value)) document.documentElement.style.setProperty(`--${kind}-width`, `${Math.round(value)}px`);
    } catch {}
  }
}

function bindPaneEvents(paneId) {
  const root = paneRoot(paneId);
  if (!root || root.dataset.bound === 'true') return;
  root.dataset.bound = 'true';
  const query = selector => root.querySelector(selector);
  let blockNextClick = false;
  const stopRejectedActivation = event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  root.addEventListener('pointerdown', event => {
    if (activatePane(paneId)) {
      blockNextClick = false;
      return;
    }
    blockNextClick = true;
    stopRejectedActivation(event);
  }, true);
  root.addEventListener('click', event => {
    if (blockNextClick) {
      blockNextClick = false;
      stopRejectedActivation(event);
      return;
    }
    if (!activatePane(paneId)) stopRejectedActivation(event);
  }, true);
  query('#backButton').addEventListener('click', () => { activatePane(paneId); navigateHistory(-1); });
  query('#forwardButton').addEventListener('click', () => { activatePane(paneId); navigateHistory(1); });
  query('#upButton').addEventListener('click', () => { activatePane(paneId); navigateUp(); });
  query('#breadcrumb').addEventListener('click', event => {
    activatePane(paneId);
    const button = event.target.closest('[data-crumb-index]');
    if (button) navigate($('#breadcrumb')._crumbs[Number(button.dataset.crumbIndex)].view);
  });
  query('#sortSelect').addEventListener('change', event => {
    activatePane(paneId);
    state.sort = event.target.value;
    state.sortDir = 'auto';
    const pane = paneById(paneId);
    if (pane) pane.sortCapNotified = false;
    renderSortControls();
    renderGrid({ preserveScroll: true });
    if (state.sort !== 'default' && state.hasMore) refresh({ reset: false, preserveScroll: true, paneId });
  });
  query('#sortDirButton').addEventListener('click', () => {
    activatePane(paneId);
    if (!state.sort || state.sort === 'default') return;
    state.sortDir = effectiveSortDir(state.sort, state.sortDir) === 'asc' ? 'desc' : 'asc';
    renderSortControls();
    renderGrid({ preserveScroll: true });
  });
  query('#itemGrid').addEventListener('click', event => {
    activatePane(paneId);
    const tagAction = event.target.closest('[data-tag-action]');
    if (tagAction) {
      executeTagManagerAction(tagAction.dataset.tagAction, {
        tagName: tagAction.dataset.tagName,
        groupId: tagAction.dataset.tagGroupId
      }).catch(error => toast(`标签操作失败：${error.message}`, 4200));
      return;
    }
    const folder = event.target.closest('.folder-card');
    if (folder) { selectFolderCard(folder.dataset.openFolder); return; }
    const card = event.target.closest('.item-card');
    if (card) selectItem(card.dataset.id, event.metaKey || event.ctrlKey, event.shiftKey);
  });
  query('#itemGrid').addEventListener('change', async event => {
    if (!activatePane(paneId)) return;
    const select = event.target.closest('[data-tag-add-group]');
    if (!select?.value) return;
    const libraryPath = state.library?.path;
    const groupId = select.value;
    const tag = select.dataset.tagName;
    select.disabled = true;
    try {
      await runForegroundOperation('正在将标签加入分组…', { key: `tag-group-add:${libraryPath}:${groupId}:${tag}` }, async () => {
        await window.eagleMV.addTagsToGroup({ libraryPath, groupId, tags: [tag] });
        toast('标签已加入分组');
      });
    } catch (error) {
      toast(`加入分组失败：${error.message}`, 4200);
    } finally {
      select.value = '';
      select.disabled = false;
    }
  });
  query('#itemGrid').addEventListener('dblclick', event => {
    activatePane(paneId);
    const folder = event.target.closest('.folder-card');
    if (folder) { navigate({ kind: 'folder', id: folder.dataset.openFolder }); return; }
    const card = event.target.closest('.item-card');
    if (card) openPreview(card.dataset.id);
  });
  query('#itemGrid').addEventListener('contextmenu', event => {
    if (!activatePane(paneId)) {
      event.preventDefault();
      return;
    }
    const folderCard = event.target.closest('.folder-card');
    if (folderCard) {
      event.preventDefault();
      if (state.selectedFolderCard !== folderCard.dataset.openFolder && !selectFolderCard(folderCard.dataset.openFolder)) return;
      showContextMenu(event, { kind: 'folder', ids: [], folderId: folderCard.dataset.openFolder, paneId });
      return;
    }
    const card = event.target.closest('.item-card');
    if (!card) return;
    event.preventDefault();
    if (!state.selected.has(card.dataset.id) && !selectItem(card.dataset.id)) return;
    const selectedItems = [...state.selected].map(itemById).filter(Boolean);
    showContextMenu(event, {
      ids: [...state.selected],
      folderId: state.currentView.kind === 'folder' ? state.currentView.id : null,
      allPinned: selectedItems.length > 0 && selectedItems.every(itemIsPinned),
      allDeleted: selectedItems.length > 0 && selectedItems.every(item => item.isDeleted),
      tags: state.availableTags
    });
  });
  const itemGrid = query('#itemGrid');
  itemGrid.addEventListener('dragstart', event => {
    if (!activatePane(paneId)) {
      event.preventDefault();
      clearDragUI();
      return;
    }
    const card = event.target.closest('.item-card');
    if (!card) return;
    if (!state.selected.has(card.dataset.id) && !selectItem(card.dataset.id)) {
      event.preventDefault();
      clearDragUI();
      return;
    }
    // Electron's native file drag must replace Chromium's default HTML5
    // drag session. Leaving the default session alive can make macOS wait
    // indefinitely after dropping into another pane or the folder tree.
    event.preventDefault();
    const ids = [...state.selected];
    const libraryPath = state.library?.path;
    const sourceFolderId = state.currentView.kind === 'folder' ? state.currentView.id : null;
    state.draggingItemIds = ids;
    state.dragSourcePaneId = paneId;
    state.internalDrag = {
      active: true,
      token: null,
      ids,
      sourceFolderId,
      sourcePaneId: paneId,
      sourceWindowId: state.windowId,
      libraryPath
    };
    window.eagleMV.startDrag({
      ids,
      sourceFolderId,
      sourcePaneId: paneId,
      sourceWindowId: state.windowId,
      libraryPath
    });
  });
  itemGrid.addEventListener('dragend', clearDragUI);
  itemGrid.addEventListener('dragover', event => {
    const folder = event.target.closest('.folder-card');
    if (!folder || !isInternalItemDrag(event.dataTransfer, activeDraggedItemIds())) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    folder.classList.add('drop-target');
  });
  itemGrid.addEventListener('dragleave', event => {
    const folder = event.target.closest('.folder-card');
    if (folder && !folder.contains(event.relatedTarget)) folder.classList.remove('drop-target');
  });
  itemGrid.addEventListener('drop', event => {
    if (!activatePane(paneId)) {
      event.preventDefault();
      clearDragUI();
      return;
    }
    const folder = event.target.closest('.folder-card');
    const ids = readItemIds(event.dataTransfer, activeDraggedItemIds());
    if (!folder) return;
    event.preventDefault();
    event.stopPropagation();
    folder.classList.remove('drop-target');
    if (!ids.length) {
      toast('无法识别拖入的素材，请重新拖动', 3500);
      clearDragUI();
      return;
    }
    const target = findFolder(state.library?.folders, folder.dataset.openFolder);
    const libraryPath = state.internalDrag?.libraryPath || state.library?.path;
    scheduleDropTask(() => addItemsToFolder(ids, folder.dataset.openFolder, target?.name, libraryPath));
  });
  const scroller = query('#gridScroller');
  scroller.addEventListener('contextmenu', event => {
    if (event.target.closest('.item-card, .folder-card')) return;
    event.preventDefault();
    if (!activatePane(paneId)) return;
    const pane = paneById(paneId);
    showContextMenu(event, {
      kind: 'workspace',
      ids: [],
      paneId,
      folderId: pane?.currentView.kind === 'folder' ? pane.currentView.id : null
    });
  });
  scroller.addEventListener('scroll', event => {
    const element = event.currentTarget;
    const pane = paneById(paneId);
    if (!pane) return;
    pane.scrollTop = element.scrollTop;
    if (state.activePaneId === paneId) updateScrollUI();
    if (!pane.loading && pane.hasMore && element.scrollTop + element.clientHeight > element.scrollHeight - 500) refresh({ reset: false, preserveScroll: true, paneId });
  });
  query('#scrollTopButton').addEventListener('click', () => {
    activatePane(paneId);
    scroller.scrollTo({ top: 0, behavior: 'smooth' });
  });
  query('#emptyRetryButton').addEventListener('click', () => {
    activatePane(paneId);
    refresh({ reset: true, preserveScroll: true, paneId });
  });
  scroller.addEventListener('dragenter', event => {
    const fallbackIds = activeDraggedItemIds();
    if (!dragHasType(event.dataTransfer, 'Files') && !isInternalItemDrag(event.dataTransfer, fallbackIds)) return;
    event.preventDefault();
    if (!activatePane(paneId)) {
      clearDragUI();
      return;
    }
    if (!shouldShowImportOverlay(event.dataTransfer, fallbackIds)) return;
    state.dragDepth += 1;
    $('#dropOverlay').classList.remove('hidden');
  });
  scroller.addEventListener('dragover', event => {
    const fallbackIds = activeDraggedItemIds();
    if (!dragHasType(event.dataTransfer, 'Files') && !isInternalItemDrag(event.dataTransfer, fallbackIds)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = isInternalItemDrag(event.dataTransfer, fallbackIds) ? (event.altKey ? 'move' : 'copy') : 'copy';
  });
  scroller.addEventListener('dragleave', () => {
    if ($('#dropOverlay').classList.contains('hidden')) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth) $('#dropOverlay').classList.add('hidden');
  });
  scroller.addEventListener('drop', event => {
    event.preventDefault();
    if (!activatePane(paneId)) {
      clearDragUI();
      return;
    }
    const fallbackIds = activeDraggedItemIds();
    if (isInternalItemDrag(event.dataTransfer, fallbackIds)) {
      const context = paneItemDropContext(paneId, event);
      if (!context) {
        toast('无法识别拖入的素材，请重新拖动', 3500);
        clearDragUI();
        return;
      }
      scheduleDropTask(() => handlePaneItemDrop(context));
      return;
    }
    if (!event.dataTransfer?.files?.length) {
      clearDragUI();
      return;
    }
    const paths = [...event.dataTransfer.files].map(file => window.eagleMV.pathForFile(file)).filter(Boolean);
    if (!paths.length) {
      clearDragUI();
      return;
    }
    scheduleDropTask(() => importFiles(paths, 'drop'));
  });
}

function bindEvents() {
  bindWorkspaceResizers();
  document.addEventListener('dragend', clearDragUI, true);
  document.addEventListener('drop', () => setTimeout(clearDragUI, 0), true);
  $('#newButton').addEventListener('click', event => {
    event.stopPropagation();
    if (!$('#contextMenu').classList.contains('hidden') && state.contextMenu?.kind === 'new-menu') {
      hideContextMenu();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const paneId = state.activePaneId;
    event.currentTarget.setAttribute('aria-expanded', 'true');
    showContextMenuAt(rect.left, rect.bottom + 6, {
      kind: 'new-menu',
      paneId,
      folderId: folderCreationParentForPane(paneId)
    });
  });
  $('#newWindowButton').addEventListener('click', () => window.eagleMV.newWindow().catch(error => toast(`无法新建窗口：${error.message}`, 4000)));
  $('#toggleSidebarButton').addEventListener('click', () => togglePanel('sidebar'));
  $('#toggleInspectorButton').addEventListener('click', () => togglePanel('inspector'));
  $('#generationMetadata').addEventListener('click', async event => {
    const button = event.target.closest('[data-metadata-copy]');
    if (!button) return;
    const value = $('#generationMetadataSection').dataset[button.dataset.metadataCopy] || '';
    if (!value) return;
    await window.eagleMV.copyText(value);
    toast('提示词已复制');
  });
  $('#addCommentButton').addEventListener('click', () => addCommentToSelected());
  $('#itemComments').addEventListener('click', event => {
    const button = event.target.closest('[data-comment-action]');
    const row = button?.closest('[data-comment-id]');
    if (!button || !row?.dataset.commentId) return;
    if (button.dataset.commentAction === 'edit') editComment(row.dataset.commentId);
    if (button.dataset.commentAction === 'remove') removeComment(row.dataset.commentId);
  });
  $('#clearFiltersButton').addEventListener('click', clearFilters);
  $('#filterButton').addEventListener('click', () => {
    $('#filterPopover').classList.toggle('hidden');
    renderFilterState();
  });
  $('#saveSmartFolderButton').addEventListener('click', () => saveCurrentViewAsSmartFolder().catch(error => toast(`智能文件夹保存失败：${error.message}`, 4200)));
  $('#closeFilterButton').addEventListener('click', () => {
    $('#filterPopover').classList.add('hidden');
    renderFilterState();
  });
  $('#toggleTagColorsButton').addEventListener('click', () => {
    $('#tagColorManager').classList.toggle('hidden');
    renderTagColors();
  });
  $('#tagColorManager').addEventListener('change', event => {
    const input = event.target.closest('[data-tag-color]');
    if (input) updateTagColor(input.dataset.tagColor, input.value);
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('#filterButton, #filterPopover')) {
      $('#filterPopover').classList.add('hidden');
      renderFilterState();
    }
    if (!event.target.closest('#paneLayoutButton, #paneLayoutPopover')) {
      $('#paneLayoutPopover').classList.add('hidden');
      $('#paneLayoutButton').setAttribute('aria-expanded', 'false');
    }
  });
  $('#paneLayoutButton').addEventListener('click', event => {
    event.stopPropagation();
    const popover = $('#paneLayoutPopover');
    popover.classList.toggle('hidden');
    $('#paneLayoutButton').setAttribute('aria-expanded', String(!popover.classList.contains('hidden')));
    for (const option of popover.querySelectorAll('[data-layout]')) option.classList.toggle('active', option.dataset.layout === $('#paneLayout').dataset.layout);
  });
  $('#paneLayoutPopover').addEventListener('click', event => {
    const option = event.target.closest('[data-layout]');
    if (!option) return;
    if (renderPaneLayout(option.dataset.layout, { refresh: true })) {
      $('#paneLayoutPopover').classList.add('hidden');
      $('#paneLayoutButton').setAttribute('aria-expanded', 'false');
    }
  });
  $('#trashRemoveButton').addEventListener('click', () => closeTrashDialog('remove'));
  $('#trashDeleteButton').addEventListener('click', () => closeTrashDialog('delete'));
  $('#trashCancelButton').addEventListener('click', () => closeTrashDialog());
  $('#trashDialog').addEventListener('click', event => {
    if (event.target === event.currentTarget) closeTrashDialog();
  });
  $('#duplicateUseExistingButton').addEventListener('click', () => closeDuplicateDialog('use-existing'));
  $('#duplicateKeepBothButton').addEventListener('click', () => closeDuplicateDialog('keep-both'));
  $('#duplicateCancelButton').addEventListener('click', () => closeDuplicateDialog('cancel'));
  $('#duplicateDialog').addEventListener('click', event => {
    if (event.target === event.currentTarget) closeDuplicateDialog('cancel');
  });
  $('#folderDialogForm').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('#folderNameInput').value.trim();
    if (!name) { $('#folderNameInput').focus(); return; }
    closeFolderDialog(name);
  });
  $('#folderDialogCancelButton').addEventListener('click', () => closeFolderDialog());
  $('#folderDialog').addEventListener('click', event => {
    if (event.target === event.currentTarget) closeFolderDialog();
  });
  $('#searchInput').addEventListener('input', event => {
    const paneId = state.activePaneId;
    const pane = paneById(paneId);
    if (!pane) return;
    pane.query.search = event.target.value;
    renderFilterState();
    schedulePaneFilterRefresh(paneId);
  });
  for (const kind of Object.keys(tagEditors)) bindTagEditor(kind);
  $('#extFilter').addEventListener('input', event => {
    const paneId = state.activePaneId;
    const pane = paneById(paneId);
    if (!pane) return;
    pane.query.ext = normalizeExtension(event.target.value);
    renderFilterState();
    schedulePaneFilterRefresh(paneId);
  });
  $('#ratingFilter').addEventListener('change', event => {
    const paneId = state.activePaneId;
    const pane = paneById(paneId);
    if (!pane) return;
    pane.query.rating = event.target.value === '' ? null : Number(event.target.value);
    renderFilterState();
    schedulePaneFilterRefresh(paneId);
  });
  $('#shapeFilter').addEventListener('change', event => {
    const paneId = state.activePaneId;
    const pane = paneById(paneId);
    if (!pane) return;
    pane.query.shape = event.target.value;
    renderFilterState();
    schedulePaneFilterRefresh(paneId);
  });
  $('#annotationFilter').addEventListener('input', event => {
    const paneId = state.activePaneId;
    const pane = paneById(paneId);
    if (!pane) return;
    pane.query.annotation = event.target.value;
    renderFilterState();
    schedulePaneFilterRefresh(paneId);
  });
  $('#urlFilter').addEventListener('input', event => {
    const paneId = state.activePaneId;
    const pane = paneById(paneId);
    if (!pane) return;
    pane.query.url = event.target.value;
    renderFilterState();
    schedulePaneFilterRefresh(paneId);
  });
  $('#sizeSlider').addEventListener('input', event => {
    document.documentElement.style.setProperty('--thumb', `${event.target.value}px`);
    try { localStorage.setItem('eaglemv.thumbnailSize', event.target.value); } catch {}
  });
  $('#folderTree').addEventListener('click', event => {
    const toggle = event.target.closest('[data-toggle-folder]');
    if (toggle) { event.stopPropagation(); toggleFolder(toggle.dataset.toggleFolder); return; }
    const row = event.target.closest('.folder-row');
    if (row) navigate(descriptorFromTarget(row));
  });
  $('.sidebar').addEventListener('contextmenu', event => {
    const folderRow = event.target.closest('[data-folder-id]');
    const smartRow = event.target.closest('[data-smart-folder-id]');
    event.preventDefault();
    if (smartRow) {
      showContextMenu(event, { kind: 'smart-folder', smartFolderId: smartRow.dataset.smartFolderId });
      return;
    }
    const targetFolderId = folderRow?.dataset.folderId || null;
    showContextMenu(event, {
      kind: 'sidebar',
      ids: [],
      paneId: state.activePaneId,
      targetFolderId,
      siblingParentId: siblingParentId(targetFolderId)
    });
  });
  $('#contextMenu').addEventListener('click', event => {
    const row = event.target.closest('[data-context-action]');
    if (!row) {
      const submenu = event.target.closest('.has-submenu');
      if (submenu) {
        submenu.classList.add('submenu-open');
        submenu.querySelector('.context-picker-search')?.focus();
      }
      return;
    }
    if (row.classList.contains('disabled')) return;
    let payload = {};
    try { payload = JSON.parse(row.dataset.contextPayload || '{}'); } catch {}
    const execution = executeContextAction(row.dataset.contextAction, payload);
    hideContextMenu();
    execution.catch(error => toast(`操作失败：${error.message}`, 4000));
  });
  $('#contextMenu').addEventListener('input', event => {
    const input = event.target.closest('.context-picker-search');
    if (!input) return;
    const folderPicker = input.closest('[data-folder-picker-action]');
    const tagPicker = input.closest('[data-tag-picker-action]');
    if (folderPicker) {
      folderPicker.querySelector('.context-folder-results').innerHTML = contextFolderEntries(folderPicker.dataset.folderPickerAction, input.value);
    } else if (tagPicker) {
      tagPicker.querySelector('.context-tag-results').innerHTML = contextTagEntries(tagPicker.dataset.tagPickerAction, input.value);
    }
  });
  $('#contextMenu').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    const folderInput = event.target.closest('.context-folder-search');
    if (folderInput) {
      const firstResult = folderInput.closest('[data-folder-picker-action]')?.querySelector('[data-context-action]:not(.disabled)');
      if (!firstResult) return;
      event.preventDefault();
      event.stopPropagation();
      firstResult.click();
      return;
    }
    const tagInput = event.target.closest('.context-tag-search');
    const picker = tagInput?.closest('[data-tag-picker-action="add-tag"]');
    const tag = tagInput?.value.trim();
    if (!picker || !tag) return;
    event.preventDefault();
    event.stopPropagation();
    const execution = executeContextAction('add-tag', { tag });
    hideContextMenu();
    execution.catch(error => toast(`添加标签失败：${error.message}`, 4000));
  });
  $('#contextMenu').addEventListener('mouseenter', event => {
    const row = event.target.closest('.has-submenu');
    if (row) row.classList.add('submenu-open');
  }, true);
  $('#contextMenu').addEventListener('mouseleave', event => {
    const row = event.target.closest('.has-submenu');
    if (row && !row.contains(event.relatedTarget)) row.classList.remove('submenu-open');
  }, true);
  document.addEventListener('click', event => {
    if (!event.target.closest('#contextMenu') && !event.target.closest('.item-card') && !event.target.closest('#newButton')) hideContextMenu();
  });
  for (const selector of ['#itemName', '#itemURL']) {
    $(selector).addEventListener('input', markDirty);
    $(selector).addEventListener('blur', () => queueInspectorAutoSave({ immediate: true }));
  }
  $('#itemURL').addEventListener('input', updateURLActions);
  $('#openURLButton').addEventListener('click', async () => {
    const url = $('#itemURL').value.trim();
    if (!/^https?:\/\//i.test(url)) { toast('只支持打开 http/https 网址', 3200); return; }
    try {
      await window.eagleMV.openExternal(url);
    } catch (error) {
      toast(`打开来源失败：${error.message}`, 4000);
    }
  });
  $('#copyURLButton').addEventListener('click', async () => {
    const url = $('#itemURL').value.trim();
    if (!url) return;
    await window.eagleMV.copyText(url);
    toast('已复制来源网址', 2000);
  });
  $('#itemRating').addEventListener('change', () => {
    syncRatingPlaceholder();
    markDirty();
    queueInspectorAutoSave({ immediate: true });
  });
  $('#itemAnnotation').addEventListener('input', () => { resizeAnnotation(); markDirty(); });
  $('#itemAnnotation').addEventListener('blur', () => queueInspectorAutoSave({ immediate: true }));
  $('#itemPalette').addEventListener('click', event => {
    const swatch = event.target.closest('.palette-swatch');
    if (!swatch) return;
    window.eagleMV.copyText(swatch.dataset.color);
    toast(`已复制颜色 ${swatch.dataset.color}`, 1600);
  });
  $('#pinButton').addEventListener('click', () => {
    const item = itemById([...state.selected][0]);
    if (item) setPinned([item.id], !itemIsPinned(item));
  });
  $('#openDefaultButton').addEventListener('click', () => { const id = [...state.selected][0]; if (id) openWithDefault(id); });
  $('#customThumbnailButton').addEventListener('click', () => setCustomThumbnail());
  $('#finderButton').addEventListener('click', () => showItemInFileManager([...state.selected][0]));
  $('#trashButton').addEventListener('click', () => { const item = itemById([...state.selected][0]); if (item) setTrash([item.id], !item.isDeleted); });
  $('#batchTrashButton').addEventListener('click', () => {
    const ids = [...state.selected];
    const restore = ids.length > 0 && ids.every(id => itemById(id)?.isDeleted);
    setTrash(ids, !restore);
  });
  $('#batchTagButton').addEventListener('click', async () => {
    commitTagInput('batch');
    const tags = [...state.batchTags];
    if (!tags.length) return;
    const paneId = state.activePaneId;
    const pane = paneById(paneId);
    const ids = [...(pane?.selected || [])];
    const libraryPath = state.library?.path;
    const operationToken = beginForegroundOperation('正在合并标签…', { key: `batch-tags:${paneId}` });
    if (!operationToken) return;
    setSyncStatus('正在合并标签…');
    try {
      const outcome = await runItemBatch(ids, id => window.eagleMV.mutateSet({
        id, field: 'tags', add: tags, libraryPath
      }), 'Eagle 批量标签请求超时');
      if (!outcome.succeeded.length) throw outcome.firstError || new Error('没有素材完成标签修改');
      pane.selected = new Set(outcome.failed);
      $('#batchTagInput').value = '';
      setTagValues('batch', [], false);
      if (state.activePaneId === paneId) renderInspector();
      await refresh({ reset: true, preserveScroll: true, paneId });
      toast(outcome.failed.length
        ? `已为 ${outcome.succeeded.length} 个素材添加标签 · ${outcome.failed.length} 个失败并保持选中`
        : `已为 ${outcome.succeeded.length} 个素材添加标签`, outcome.failed.length ? 4200 : 2400);
    } catch (error) {
      toast(`添加标签失败：${error.message}`, 4000);
    } finally {
      setSyncStatus('所有窗口已同步');
      endForegroundOperation(operationToken);
    }
  });
  $('#sharedTagChips').addEventListener('click', event => {
    const button = event.target.closest('[data-remove-shared-tag]');
    if (button) removeTagFromSelection(button.dataset.removeSharedTag);
  });
  $('#batchRating').addEventListener('change', event => {
    const value = event.target.value;
    event.target.value = '';
    if (value === '') return;
    setSelectionRating({ ids: [...state.selected], rating: Number(value) });
  });
  $('#previewBox').addEventListener('click', () => { const id = [...state.selected][0]; if (id) openPreview(id); });
  $('#closePreview').addEventListener('click', closePreview);
  $('#previewModal').addEventListener('click', event => { if (event.target === event.currentTarget) closePreview(); });
  $('#prevPreview').addEventListener('click', () => movePreview(-1));
  $('#nextPreview').addEventListener('click', () => movePreview(1));
  $('#previewFit').addEventListener('click', () => setPreviewZoom('fit'));
  $('#previewActual').addEventListener('click', () => setPreviewZoom('actual'));
  $('#previewZoomOut').addEventListener('click', () => changePreviewZoom(-.25));
  $('#previewZoomIn').addEventListener('click', () => changePreviewZoom(.25));
  $('#modalMedia').addEventListener('wheel', event => {
    if (!previewImage()) return;
    event.preventDefault();
    changePreviewZoom(event.deltaY < 0 ? .15 : -.15);
  }, { passive: false });
  $('#modalMedia').addEventListener('pointerdown', event => {
    const image = previewImage();
    if (!image || state.previewZoom.mode === 'fit' || event.button !== 0) return;
    state.previewZoom.dragging = true;
    state.previewZoom.startX = event.clientX;
    state.previewZoom.startY = event.clientY;
    state.previewZoom.originX = state.previewZoom.x;
    state.previewZoom.originY = state.previewZoom.y;
    event.currentTarget.setPointerCapture(event.pointerId);
    renderPreviewZoom();
  });
  $('#modalMedia').addEventListener('pointermove', event => {
    if (!state.previewZoom.dragging) return;
    state.previewZoom.x = state.previewZoom.originX + event.clientX - state.previewZoom.startX;
    state.previewZoom.y = state.previewZoom.originY + event.clientY - state.previewZoom.startY;
    renderPreviewZoom();
  });
  $('#modalMedia').addEventListener('pointerup', event => {
    if (!state.previewZoom.dragging) return;
    state.previewZoom.dragging = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    renderPreviewZoom();
  });

  document.addEventListener('paste', event => {
    if (Date.now() < state.suppressPasteUntil) {
      event.preventDefault();
      return;
    }
    const editable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (editable || blockingSurfaceOpen() || !$('#previewModal').classList.contains('hidden')) return;
    const paths = [...(event.clipboardData?.files || [])].map(file => window.eagleMV.pathForFile(file)).filter(Boolean);
    event.preventDefault();
    importFiles(paths.length ? paths : null, paths.length ? 'paste-files' : 'clipboard');
  });

  document.addEventListener('keydown', event => {
    const editable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    const previewOpen = !$('#previewModal').classList.contains('hidden');
    if (event.key === 'Escape') {
      if (!$('#folderDialog').classList.contains('hidden')) { event.preventDefault(); closeFolderDialog(); return; }
      if (!$('#trashDialog').classList.contains('hidden')) { event.preventDefault(); closeTrashDialog(); return; }
      if (!$('#duplicateDialog').classList.contains('hidden')) { event.preventDefault(); closeDuplicateDialog('cancel'); return; }
      if (!$('#contextMenu').classList.contains('hidden')) { event.preventDefault(); hideContextMenu(); return; }
      if (previewOpen) { event.preventDefault(); closePreview(); return; }
      if (!editable && (state.selected.size || state.selectedFolderCard) && confirmDiscardChanges()) {
        state.selected.clear();
        state.selectedFolderCard = null;
        updateCardSelectionStyles();
        renderInspector();
      }
      return;
    }
    // Do not let global shortcuts act on the obscured workspace. In
    // particular, a second Delete while the trash prompt is open can replace
    // its resolver and leave the first operation waiting forever.
    if (blockingSurfaceOpen()) return;
    const primaryKey = event.metaKey || event.ctrlKey;
    const selectedIds = selectedActionIds();
    const activeItemId = previewOpen && state.previewId ? state.previewId : selectedIds[0];
    const deleteKey = event.key === 'Backspace' || event.key === 'Delete';
    if (!editable && primaryKey && !event.shiftKey && !event.altKey && event.key === 'Enter' && activeItemId) {
      event.preventDefault();
      showItemInFileManager(activeItemId);
      return;
    }
    if (!editable && primaryKey && !event.shiftKey && event.altKey && event.key.toLowerCase() === 'c' && activeItemId) {
      event.preventDefault();
      copyItemPath(activeItemId).catch(error => toast(`复制路径失败：${error.message}`, 4000));
      return;
    }
    if (!editable && !previewOpen && primaryKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c' && selectedIds.length) {
      event.preventDefault();
      copyTagsFromItems(selectedIds);
      return;
    }
    if (!editable && !previewOpen && primaryKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'v' && selectedIds.length) {
      event.preventDefault();
      state.suppressPasteUntil = Date.now() + 750;
      pasteTagsToItems(selectedIds);
      return;
    }
    if (!editable && !previewOpen && primaryKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'j' && selectedIds.length) {
      event.preventDefault();
      showFolderAssignmentPicker(selectedIds);
      return;
    }
    if (!editable && !previewOpen && !primaryKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd' && selectedIds.length) {
      event.preventDefault();
      const folderId = state.recentFolders[0]?.id;
      if (folderId) addSelectionToFolder({ ids: selectedIds, folderId });
      else toast('还没有上次使用的文件夹', 3000);
      return;
    }
    if (!editable && !previewOpen && primaryKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd' && selectedIds.length) {
      event.preventDefault();
      duplicateSelection(selectedIds).catch(error => toast(`创建副本失败：${error.message}`, 4000));
      return;
    }
    if (!editable && !previewOpen && primaryKey && event.shiftKey && !event.altKey && deleteKey && selectedIds.length) {
      event.preventDefault();
      if (state.currentView.kind !== 'folder') toast('请在具体文件夹中使用“从文件夹中移除”', 3500);
      else removeSelectionFromFolder({ ids: selectedIds, folderId: state.currentView.id });
      return;
    }
    if (!editable && !previewOpen && primaryKey && !event.shiftKey && !event.altKey && deleteKey && selectedIds.length) {
      event.preventDefault();
      setTrash(selectedIds, true);
      return;
    }
    if (!editable && (event.metaKey || event.ctrlKey) && !event.altKey) {
      if (event.code === 'Equal' || event.code === 'NumpadAdd') { event.preventDefault(); changeUIZoom(1); return; }
      if (event.code === 'Minus' || event.code === 'NumpadSubtract') { event.preventDefault(); changeUIZoom(-1); return; }
      if (event.code === 'Digit0' || event.code === 'Numpad0') { event.preventDefault(); setUIZoom(1, { announce: true }); return; }
    }
    if (!editable && !previewOpen && primaryKey && !event.shiftKey && event.altKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      window.eagleMV.newWindow().catch(error => toast(`无法新建窗口：${error.message}`, 4000));
      return;
    }
    if (!editable && !previewOpen && !primaryKey && event.shiftKey && event.altKey && (event.code === 'KeyN' || event.key.toLowerCase() === 'n')) {
      event.preventDefault();
      createNewDocument('txt', { folderId: folderCreationParentForPane(), paneId: state.activePaneId }).catch(error => toast(`创建 TXT 失败：${error.message}`, 4000));
      return;
    }
    if (!editable && !previewOpen && !primaryKey && !event.shiftKey && event.altKey && (event.code === 'KeyN' || event.key.toLowerCase() === 'n')) {
      event.preventDefault();
      const parentId = folderCreationParentForPane();
      createFolder(parentId, Boolean(parentId), state.activePaneId).catch(error => toast(`创建失败：${error.message}`, 4000));
      return;
    }
    if (!editable && !previewOpen && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      requestRenameSelection().catch(error => toast(`重命名失败：${error.message}`, 4000));
      return;
    }
    if (!editable && !previewOpen && !primaryKey && !event.shiftKey && !event.altKey && event.key === 'F2' && state.selected.size === 1) {
      event.preventDefault();
      requestRenameSelection().catch(error => toast(`重命名失败：${error.message}`, 4000));
      return;
    }
    if (primaryKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); $('#searchInput').focus(); }
    if (!editable && event.metaKey && event.shiftKey && event.key.toLowerCase() === 'l') { event.preventDefault(); togglePanel('sidebar'); }
    if (!editable && event.metaKey && event.shiftKey && event.key.toLowerCase() === 'i') { event.preventDefault(); togglePanel('inspector'); }
    if (!editable && event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); locateCurrentFolder(); }
    if (!editable && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'Enter' && (state.previewId || state.selected.size === 1)) {
      event.preventDefault();
      openWithDefault(state.previewId || [...state.selected][0]);
      return;
    }
    if (!editable && !previewOpen && !primaryKey && !event.shiftKey && !event.altKey && event.key === 'Enter' && state.selectedFolderCard) { event.preventDefault(); navigate({ kind: 'folder', id: state.selectedFolderCard }); }
    else if (!editable && !previewOpen && !primaryKey && !event.shiftKey && !event.altKey && event.key === 'Enter' && state.selected.size === 1) { event.preventDefault(); openPreview([...state.selected][0]); }
    if (!editable && event.code === 'Space' && previewOpen) {
      event.preventDefault();
      // Eagle: space toggles playback while a video/audio preview is open;
      // for stills it keeps closing the preview.
      const media = $('#modalMedia video, #modalMedia audio');
      if (media) media.paused ? media.play().catch(() => {}) : media.pause();
      else closePreview();
    } else if (!editable && event.code === 'Space' && state.selected.size) {
      event.preventDefault();
      const first = sortedItems().find(item => state.selected.has(item.id));
      if (first) openPreview(first.id);
    }
    if (!editable && primaryKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o' && (state.previewId || state.selected.size === 1)) {
      event.preventDefault();
      openSelectionInNewWindow([state.previewId || [...state.selected][0]]);
      return;
    }
    if (!editable && primaryKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      if (!confirmDiscardChanges()) return;
      state.selectedFolderCard = null;
      state.selected = new Set(state.items.map(item => item.id));
      updateCardSelectionStyles();
      renderInspector();
    }
    if (!editable && !event.shiftKey && !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && state.selected.size) {
      event.preventDefault();
      copySelectedFiles([...state.selected]).catch(error => toast(`复制失败：${error.message}`, 4000));
    }
    if (!editable && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && !previewOpen && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      moveCardFocus(event.key);
    }
    if (!editable && event.altKey && event.key === 'ArrowUp') { event.preventDefault(); navigateUp(); }
    if (!editable && event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); navigateHistory(-1); }
    if (!editable && event.altKey && event.key === 'ArrowRight') { event.preventDefault(); navigateHistory(1); }
    if (!editable && event.metaKey && event.key === '[') { event.preventDefault(); navigateHistory(-1); }
    if (!editable && event.metaKey && event.key === ']') { event.preventDefault(); navigateHistory(1); }
    if (!editable && !previewOpen && ['PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const grid = $('#gridScroller');
      const top = event.key === 'Home' ? 0 : event.key === 'End' ? grid.scrollHeight : grid.scrollTop + (event.key === 'PageDown' ? 1 : -1) * grid.clientHeight * .86;
      grid.scrollTo({ top, behavior: event.key.startsWith('Page') ? 'smooth' : 'auto' });
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !state.textSession && state.inspectorDirty) {
      event.preventDefault();
      saveInspector();
    }
    if (previewOpen && !editable && event.key === 'ArrowLeft') { event.preventDefault(); movePreview(-1); }
    if (previewOpen && !editable && event.key === 'ArrowRight') { event.preventDefault(); movePreview(1); }
    if (!editable && !previewOpen && !primaryKey && !event.altKey && !event.shiftKey && /^[0-5]$/.test(event.key) && state.selected.size) {
      event.preventDefault();
      setSelectionRating({ ids: [...state.selected], rating: Number(event.key) });
      return;
    }
    if (deleteKey && !editable && !previewOpen && !primaryKey && !event.shiftKey && !event.altKey && state.selected.size) setTrash([...state.selected], true);
  });
}

function bindHubEvents() {
  window.eagleMV.onItemDragState(payload => {
    if (payload?.active) {
      state.internalDrag = payload;
      return;
    }
    if (!state.internalDrag || payload?.token !== state.internalDrag.token) return;
    state.internalDrag = null;
    for (const pane of state.panes) {
      pane.draggingItemIds = null;
      pane.dragDepth = 0;
    }
    state.dragSourcePaneId = null;
    for (const target of document.querySelectorAll('.drop-target')) target.classList.remove('drop-target');
    for (const overlay of document.querySelectorAll('.drop-overlay')) overlay.classList.add('hidden');
  });
  window.eagleMV.onDragFinished(result => {
    if (!result?.ok) toast(`拖动失败：${result?.message || '无法导出素材文件'}`, 4000);
    else if (result.missing) toast(`已拖动 ${result.count} 个文件 · ${result.missing} 个原文件缺失`, 3500);
  });
  window.eagleMV.onRequestClose(async () => {
    const pendingOperations = blockingForegroundOperations();
    if (state.inspectorSaving || state.textSaving || pendingOperations.length) {
      window.eagleMV.cancelClose();
      const message = state.textSaving
        ? 'TXT 仍在保存'
        : state.inspectorSaving
          ? '素材信息仍在保存'
          : foregroundOperationSummary(pendingOperations);
      toast(`${message}，完成后才能关闭窗口`, 3600);
      return;
    }
    // Metadata is auto-saved on input/blur. A close request is the final
    // flush for a very recent edit instead of a discard prompt.
    if (state.inspectorDirty) {
      window.eagleMV.cancelClose();
      if (!await saveInspector()) return;
    }
    const hasUnsavedText = Boolean(state.textSession?.dirty);
    if (hasUnsavedText && !confirm('TXT 内容有尚未保存的修改。\n\n按“确定”放弃修改并关闭窗口；按“取消”继续编辑。')) {
      window.eagleMV.cancelClose();
      return;
    }
    state.inspectorDirty = false;
    if (state.textSession) state.textSession.dirty = false;
    window.eagleMV.confirmClose();
  });
  window.eagleMV.onTrashSelection(payload => setTrash(payload?.ids || [...state.selected], payload?.deleted ?? true));
  window.eagleMV.onPinSelection(payload => setPinned(payload?.ids || [...state.selected], payload.pinned, payload?.paneId || state.activePaneId));
  window.eagleMV.onAddToFolder(payload => addSelectionToFolder(payload));
  window.eagleMV.onMoveToFolder(payload => moveSelectionToFolder(payload));
  window.eagleMV.onRemoveFromFolder(payload => removeSelectionFromFolder(payload));
  window.eagleMV.onAddTag(payload => addTagToSelection(payload));
  window.eagleMV.onSetRating(payload => setSelectionRating(payload));
  window.eagleMV.onSetTagColor(async payload => {
    const tag = String(payload?.tag || '').trim();
    if (!tag) return;
    const current = state.tagColors[tag] || '#0072ef';
    const color = prompt(`设置标签“${tag}”颜色（六位十六进制）`, current);
    if (color !== null) updateTagColor(tag, color.trim());
  });
  window.eagleMV.onRenameRequest(() => requestRenameSelection().catch(error => toast(`重命名失败：${error.message}`, 4000)));
  window.eagleMV.onImportRequest(() => importFiles());
  window.eagleMV.onCreateFolderRequest(() => {
    const paneId = state.activePaneId;
    const parentId = folderCreationParentForPane(paneId);
    createFolder(parentId, Boolean(parentId), paneId).catch(error => toast(`创建失败：${error.message}`, 4000));
  });
  window.eagleMV.onCreateDocumentRequest(payload => {
    const paneId = state.activePaneId;
    createNewDocument(payload?.type, { folderId: folderCreationParentForPane(paneId), paneId })
      .catch(error => toast(`新建文件失败：${error.message}`, 4000));
  });
  window.eagleMV.onCreateSmartFolderRequest(() => {
    createSmartFolderFromNewMenu().catch(error => toast(`智能文件夹创建失败：${error.message}`, 4200));
  });
  window.eagleMV.onFolderUsed(payload => {
    if (!payload?.folderId || payload.libraryPath !== state.library?.path) return;
    rememberRecentFolderUsage(payload.folderId);
  });
  window.eagleMV.onPinsChanged(payload => {
    if (payload.libraryPath !== state.library?.path) return;
    state.localPins = payload.pins || {};
    for (const pane of state.panes) withActivePane(pane.id, () => renderGrid({ preserveScroll: true }));
    renderInspector();
  });
  window.eagleMV.onTagDataChanged(async payload => {
    if (payload?.libraryPath !== state.library?.path) return;
    await loadLibraryExtras();
    renderFolderTree();
    for (const pane of state.panes) {
      if (pane.currentView.kind === 'tags') withActivePane(pane.id, () => renderGrid({ preserveScroll: true }));
    }
  });
  window.eagleMV.onTextChanged(payload => {
    if (payload.origin === state.windowId || payload.id !== state.textSession?.id) return;
    if (state.textSession.dirty) {
      $('#textStatus').textContent = '另一个窗口已修改此 TXT；保存时会检查冲突';
      return;
    }
    openPreview(payload.id, { forceReload: true });
  });
  window.eagleMV.onStatus(payload => setConnection(payload.connected, payload.message));
  window.eagleMV.onItemsChanged(payload => {
    let touchedSelection = false;
    for (const pane of state.panes) {
      for (const changed of payload.items || []) {
        const index = pane.items.findIndex(item => item.id === changed.id);
        if (index >= 0) {
          pane.items[index] = changed;
          schedulePaneGridRender(pane.id);
        }
        if (pane.id === state.activePaneId && pane.selected.has(changed.id)) touchedSelection = true;
      }
    }
    if (touchedSelection) queueChangedInspectorRender(payload.origin !== state.windowId);
    setSyncStatus(payload.source === 'multiview' ? '所有窗口已同步' : '已接收 Eagle 的外部修改');
  });
  window.eagleMV.onLibraryChanged(payload => scheduleLibraryChange(payload));
  window.eagleMV.onQueryInvalidated(() => scheduleRefresh());
}

function scheduleLibraryChange(payload) {
  pendingLibraryChange = payload;
  if (librarySyncRunning) return;
  clearTimeout(librarySyncTimer);
  librarySyncTimer = setTimeout(() => {
    librarySyncTimer = null;
    drainLibraryChanges().catch(error => {
      setSyncStatus('同步失败，请重试');
      toast(`无法同步 Eagle：${error.message}`, 4000);
    });
  }, LIBRARY_SYNC_DEBOUNCE_MS);
}

async function drainLibraryChanges() {
  if (librarySyncRunning) return;
  librarySyncRunning = true;
  try {
    while (pendingLibraryChange) {
      const payload = pendingLibraryChange;
      pendingLibraryChange = null;
      await applyLibraryChange(payload);
    }
  } finally {
    librarySyncRunning = false;
    if (pendingLibraryChange) scheduleLibraryChange(pendingLibraryChange);
  }
}

async function applyLibraryChange(payload) {
    const pathChanged = state.library?.path && state.library.path !== payload.library.path;
    const hadUnsaved = state.inspectorDirty || state.textSession?.dirty;
    state.library = payload.library;
    $('#windowTitle').textContent = 'Eagle MultiView';
    $('.sidebar-library-label').textContent = payload.library.name || '资源库';
    setConnection(true);
    if (pathChanged) {
      state.expandedFolders.clear();
      for (const pane of state.panes) {
        pane.query = createQuery();
        withActivePane(pane.id, () => {
        state.history = [];
        state.historyIndex = -1;
        state.selected.clear();
        state.selectedFolderCard = null;
        state.items = [];
        state.total = 0;
        state.estimatedTotal = false;
        state.nextOffset = 0;
        state.hasMore = false;
        navigate({ kind: 'root' }, { record: false, refreshView: false, skipDiscard: true });
        });
      }
      renderQueryControls();
      state.inspectorDirty = false;
      if (state.textSession) state.textSession.dirty = false;
      closePreview({ commitSelection: false, skipDiscard: true });
      await loadLibraryExtras();
      renderQueryControls();
      renderFolderTree();
      await refreshAllPanes({ reset: true, preserveScroll: false });
      toast(hadUnsaved ? 'Eagle 已切换资料库；旧资料库的未保存修改已取消' : 'Eagle 已切换资料库，所有窗口已跟随', 4200);
    } else {
      await loadLibraryExtras();
      let missingFolder = false;
      let missingSmartFolder = false;
      for (const pane of state.panes) {
        if (pane.currentView.kind === 'folder' && !findFolder(state.library.folders, pane.currentView.id)) {
          missingFolder = true;
          withActivePane(pane.id, () => navigate({ kind: 'root' }, { record: false, refreshView: false, skipDiscard: true }));
        }
        if (pane.currentView.kind === 'smart') {
          const smartFolder = findFolder(state.library.smartFolders, pane.currentView.id);
          if (!smartFolder) {
            missingSmartFolder = true;
            withActivePane(pane.id, () => navigate({ kind: 'root' }, { record: false, refreshView: false, skipDiscard: true }));
          } else {
            pane.currentView = { ...pane.currentView, name: smartFolder.name };
            pane.viewTitle = smartFolder.name;
          }
        }
      }
      renderFolderTree();
      for (const pane of state.panes) withActivePane(pane.id, () => { renderGrid({ preserveScroll: true }); renderLocation(); });
      await refreshAllPanes({ reset: true, preserveScroll: true });
      if (missingFolder) toast('当前文件夹已在 Eagle 中删除，已返回资料库根目录', 4000);
      if (missingSmartFolder) toast('当前智能文件夹已在 Eagle 中移除，已返回资料库根目录', 4000);
    }
}

async function loadLibraryExtras() {
  const libraryPath = state.library?.path;
  if (!libraryPath) return;
  const [pins, tags, tagGroups, recentFolders, tagColors] = await Promise.all([
    window.eagleMV.getPins({ libraryPath }).catch(() => ({})),
    window.eagleMV.getTags().catch(() => []),
    window.eagleMV.getTagGroups().catch(() => []),
    window.eagleMV.getRecentFolders().catch(() => []),
    window.eagleMV.getTagColors({ libraryPath }).catch(() => ({}))
  ]);
  if (state.library?.path !== libraryPath) return;
  state.localPins = pins || {};
  state.availableTags = tags || [];
  state.tagGroups = tagGroups || [];
  state.recentFolders = recentFolders || [];
  state.tagColors = tagColors || {};
  renderTagSuggestions();
  renderTagColors();
}

async function restoreInitialWindowState() {
  const initial = await window.eagleMV.initialWindowState().catch(() => null);
  if (!initial) return null;
  const pane = activePane();
  if (initial.query) pane.query = cloneQuery(initial.query);
  if (initial.view) navigate(initial.view, { record: false, refreshView: false, skipDiscard: true });
  return initial;
}

async function start() {
  bindEvents();
  bindHubEvents();
  await restoreWindowChromeState();
  restoreUIZoom();
  restorePanelSizes();
  let savedPaneLayout = 'single';
  try {
    if (paneLayouts[localStorage.getItem('eaglemv.paneLayout')]) savedPaneLayout = localStorage.getItem('eaglemv.paneLayout');
  } catch {}
  renderPaneLayout(savedPaneLayout, { refresh: false });
  try {
    const thumbnailSize = Number(localStorage.getItem('eaglemv.thumbnailSize'));
    if (thumbnailSize >= 110 && thumbnailSize <= 260) {
      $('#sizeSlider').value = String(thumbnailSize);
      document.documentElement.style.setProperty('--thumb', `${thumbnailSize}px`);
    }
  } catch {}
  renderPanels();
  renderQueryControls();
  try {
    state.windowId = await window.eagleMV.identity();
    const { app, library } = await window.eagleMV.connect();
    state.library = library;
    await loadLibraryExtras();
    $('#windowTitle').textContent = 'Eagle MultiView';
    $('.sidebar-library-label').textContent = library.name || '资源库';
    setConnection(true);
    const initial = await restoreInitialWindowState();
    if (!initial) navigate({ kind: 'root' }, { refreshView: false });
    await refreshAllPanes({ reset: true, preserveScroll: false });
    if (initial?.selectedIds?.length) {
      const missing = initial.selectedIds.filter(id => !itemById(id));
      if (missing.length) {
        const fetched = await Promise.all(missing.map(id => window.eagleMV.getItem(id).catch(() => null)));
        const pane = activePane();
        pane.items = [...pane.items, ...fetched.filter(Boolean)];
      }
      activePane().selected = new Set(initial.selectedIds.filter(id => itemById(id)));
      renderGrid({ preserveScroll: true });
      renderInspector();
    }
    if (initial?.previewId && itemById(initial.previewId)) await openPreview(initial.previewId);
    toast(`已连接 Eagle ${app.version}`);
  } catch (error) {
    setConnection(false, '请先启动 Eagle 4');
    $('#resultCount').textContent = '等待 Eagle 启动';
    toast('未连接 Eagle。启动 Eagle 后本窗口会自动重试。', 5000);
    const retry = setInterval(async () => {
      try {
        const result = await window.eagleMV.connect();
        clearInterval(retry);
        state.library = result.library;
        await loadLibraryExtras();
        setConnection(true);
        navigate({ kind: 'root' }, { refreshView: false });
        await refreshAllPanes({ reset: true, preserveScroll: false });
      } catch {}
    }, 2500);
  }
}

start();
