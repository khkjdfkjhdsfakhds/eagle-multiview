'use strict';

// Installed before anything else so failures in the module destructuring
// below still land in userData/logs/error.log for after-the-fact diagnosis.
(() => {
  const report = (message, detail) => {
    try { window.eagleMV?.logError?.({ level: 'error', message, detail }); } catch {}
  };
  window.addEventListener('error', event => {
    try {
      const location = event.filename ? `（${event.filename}:${event.lineno}:${event.colno}）` : '';
      report(`${event.message || '未知脚本错误'}${location}`, event.error?.stack);
    } catch {}
  });
  window.addEventListener('unhandledrejection', event => {
    try {
      const reason = event.reason;
      report(`未处理的 Promise 拒绝：${reason?.message || String(reason)}`, reason?.stack);
    } catch {}
  });
})();

const {
  findFolder,
  findFolderPath,
  overlayFolder,
  normalizeView: normalizeFolderView,
  parentView: resolveParentView,
  recordViewNavigation,
  folderMoveDelta,
  folderScopeRemovable,
  searchFolders,
  flattenFolders: flattenFolderTree,
  itemFolderLocations
} = window.EagleMVFolderNavigation;
const { NO_FOLDER } = window.EagleMVQuerySpec;
const { formatEaglePath, resolveEaglePath } = window.EagleMVLogicalPath;
const { paneLayoutPopoverPosition } = window.EagleMVLayoutPopover;
const {
  hasType: dragHasType,
  readItemIds,
  isInternalItemDrag,
  droppedURL
} = window.EagleMVDragDrop;
// A drag that starts in this page (an inspector image, a link) carries
// MultiView's own media addresses, never a web image to import. Item drags
// cancel the default session and are recognised as items on their own.
let pageDragActive = false;
window.addEventListener('dragstart', event => { pageDragActive = !event.defaultPrevented; });
const classifyDrop = (dataTransfer, fallbackIds = []) =>
  window.EagleMVDragDrop.classifyDrop(dataTransfer, fallbackIds, { allowURL: !pageDragActive });
const shouldShowImportOverlay = (dataTransfer, fallbackIds = []) =>
  window.EagleMVDragDrop.shouldShowImportOverlay(dataTransfer, fallbackIds, { allowURL: !pageDragActive });
const resolveDrop = (dataTransfer, options = {}) =>
  window.EagleMVDragDrop.resolveDrop(dataTransfer, { ...options, allowURL: !pageDragActive });
const {
  exceedsThreshold: marqueeExceedsThreshold,
  normalizeRect: marqueeNormalizeRect,
  clampRect: marqueeClampRect,
  hitIds: marqueeHitIds,
  combineSelection: marqueeCombineSelection,
  sameSelection: marqueeSameSelection,
  autoScrollSpeed: marqueeAutoScrollSpeed
} = window.EagleMVMarquee;
const {
  createQuery,
  cloneQuery,
  queryWithoutSearch,
  filtersActive: queryFiltersActive,
  filterCount: queryFilterCount,
  extendSelection,
  stepSelection,
  normalizeRange: normalizeQueryRange,
  effectiveSortDir,
  compareBySort: compareItemsBySort,
  itemDates,
  sharedTags: computeSharedTags,
  sharedFolders: computeSharedFolders,
  sharedFieldValue,
  selectionSummary: computeSelectionSummary,
  appendableTailCount,
  paneLayoutSpecs,
  paneRevealTargets,
  coordinatePaneLayout,
  defaultSplitRatios,
  resetSplitRatioAxis,
  findFolderInTree,
  validateSessionView,
  createSessionState,
  calculateSplitRatios
} = window.EagleMVPanestate;
const { buildSmartFolderConditions } = window.EagleMVSmartFolder;
const { windowStateForView } = window.EagleMVWindowTarget;
const { createWindowActions } = window.EagleMVWindowActions;
const {
  BACK_ACTION,
  BACK_STATUS,
  createBackRouter,
  createHistoryEntry,
  readHistoryEntry,
  installBackRouter
} = window.EagleMVWindowRouter;
// ⌘ on Apple keyboards, Ctrl elsewhere (Android shell, non-Mac browsers).
const keyboardPlatform = window.EagleMVKeyboardPlatform.createKeyboardPlatform(navigator);
const sortMemory = window.EagleMVSortMemory.createSortMemory(window.localStorage);
const SORT_CASCADE_KEY = window.EagleMVSortMemory?.SORT_CASCADE_KEY || 'eaglemv.sortCascade';
let sortCascadeEnabled = false;
try {
  sortCascadeEnabled = localStorage.getItem(SORT_CASCADE_KEY) === 'true';
} catch {}

function setSortCascadeEnabled(enabled) {
  sortCascadeEnabled = Boolean(enabled);
  try {
    localStorage.setItem(SORT_CASCADE_KEY, String(sortCascadeEnabled));
  } catch {}
  if (typeof state !== 'undefined' && Array.isArray(state.panes)) {
    for (const pane of state.panes) pane.sortCascade = sortCascadeEnabled;
    state.sortCascade = sortCascadeEnabled;
  }
  syncSortCascadeChecks();
}

// "包含子文件夹" is one preference for every pane and window, so every pane's
// checkbox must show it: a stale unchecked box in a background pane would
// hide that its next sort change rewrites the whole subtree (B1-02).
function syncSortCascadeChecks() {
  for (const check of document.querySelectorAll('.sort-cascade-check')) check.checked = sortCascadeEnabled;
}

// Another MultiView window may update the shared sort preferences.
window.addEventListener('storage', event => {
  if (event.key === window.EagleMVSortMemory.STORAGE_KEY) sortMemory.invalidate();
  if (event.key === SORT_CASCADE_KEY) {
    sortCascadeEnabled = event.newValue === 'true';
    if (typeof state !== 'undefined' && Array.isArray(state.panes)) {
      for (const pane of state.panes) pane.sortCascade = sortCascadeEnabled;
      state.sortCascade = sortCascadeEnabled;
    }
    syncSortCascadeChecks();
  }
});
// Eagle's 子文件夹 section folds open or shut once for every view (its
// isHideSubFolder in localStorage), open by default (P7-15).
const SUBFOLDERS_COLLAPSED_KEY = 'eaglemv.subfoldersCollapsed';
let subfoldersCollapsed = false;
try { subfoldersCollapsed = localStorage.getItem(SUBFOLDERS_COLLAPSED_KEY) === 'true'; } catch {}
window.addEventListener('storage', event => {
  // The list columns are one setting for every pane and window, like Eagle's.
  if (event.key === 'eaglemv.listColumns' && typeof state !== 'undefined') applyListColumnClasses();
  if (event.key !== SUBFOLDERS_COLLAPSED_KEY) return;
  subfoldersCollapsed = event.newValue === 'true';
  if (typeof state !== 'undefined' && Array.isArray(state.panes)) renderSubfolderSections();
});
// Eagle's 布局 panel switches: card lines and 显示子文件夹内容, one global
// setting shared by every pane and window (P1-06, P1-07).
const cardDisplayAPI = window.EagleMVCardDisplay;
let cardDisplay = cardDisplayAPI.parse(null);
// 瀑布流 placement (layoutWaterfall). Declared up here: card display classes
// are applied during start-up and already schedule a relayout.
const waterfall = window.EagleMVWaterfall;
let waterfallFrame = 0;
// Pane and window resizes, the inspector opening, a split appearing.
const waterfallResize = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
  for (const entry of entries) {
    const grid = entry.target.querySelector(':scope > .asset-grid.waterfall');
    if (grid && grid.clientWidth !== grid._waterfall?.width) layoutWaterfall(grid);
  }
}) : null;
try { cardDisplay = cardDisplayAPI.parse(localStorage.getItem(cardDisplayAPI.STORAGE_KEY)); } catch {}
window.addEventListener('storage', event => {
  if (event.key === cardDisplayAPI.STORAGE_KEY) adoptCardDisplay(cardDisplayAPI.parse(event.newValue));
});
const { createOperationTracker } = window.EagleMVOperationState;
// Single choke point for media addresses: the Electron preload mints
// eaglemv:// protocol URLs, the web shim mints same-origin /media/ paths.
// Folder covers follow every thumbnail change; an item thumbnail follows only
// its own, so one custom thumbnail no longer reloads every card (H-10). A
// change that names no items falls back to reloading them all.
let thumbnailRevision = 0;
let allThumbnailsRevision = 0;
const thumbnailRevisions = new Map();
// The single item the inspector last rendered, so a re-render of it can
// update in place (see renderInspector).
let inspectorShown = null;
const mediaURL = (kind, id) => {
  const version = kind === 'thumb' ? Math.max(thumbnailRevisions.get(id) || 0, allThumbnailsRevision) : 0;
  return window.eagleMV.mediaURL(kind, id) + (version ? `?v=${version}` : '');
};
// Host-bound entry points (Finder, native drag, host dialogs…) check this
// table; the web shim serves the same keys with false so they hide cleanly.
const caps = window.eagleMV.capabilities || {};
const hasCapability = key => caps[key] !== false;
// Width alone cannot identify the touch/web layout: Electron's UI zoom makes
// an ordinary desktop window report a phone-sized CSS viewport. Keep drawers
// exclusive to the web client and expose the same distinction to CSS.
const isWebClient = window.eagleMV.platform === 'web';
document.body.classList.toggle('web-client', isWebClient);
const newFileTypes = Object.freeze({
  txt: { label: 'TXT', defaultName: '未命名文本' },
  md: { label: 'Markdown', defaultName: '未命名文档' },
  json: { label: 'JSON', defaultName: '未命名数据' },
  html: { label: 'HTML', defaultName: '未命名网页' },
  svg: { label: 'SVG', defaultName: '未命名图形' }
});

const paneScopedSelectors = new Set([
  '#backButton', '#forwardButton', '#upButton', '#breadcrumb', '#viewTitle', '#resultCount', '#sortSelect',
  '#sortSelectButton', '#sortSelectLabel', '#sortPopover', '#sortCascadeDivider', '#sortCascadeItem', '#sortCascadeCheck',
  '#viewModeGroup', '#gridScroller', '#emptyState', '#emptyRetryButton', '#itemGrid', '#loadIndicator', '#scrollTopButton', '#dropOverlay',
  '#previewModal', '#modalMedia', '#closePreview', '#slideshowControls', '#slideshowToggle', '#slideshowInterval',
  '#previewBackground', '#previewGrayscale', '#modalRating', '#modalCaption', '#textEditor', '#textStatus'
]);
const $ = selector => {
  if (typeof state !== 'undefined' && state.panes?.length) {
    const isScoped = paneScopedSelectors.has(selector) || selector.startsWith('#modalMedia') || selector.startsWith('#previewModal');
    if (isScoped) {
      const active = CSS.escape(state.activePaneId || state.panes[0].id);
      return document.querySelector(`.content-pane[data-pane-id="${active}"] ${selector}`) || document.querySelector(selector);
    }
  }
  return document.querySelector(selector);
};
// The pane the user is really in while withActivePane borrows another one.
let foregroundPaneId = null;
const state = {
  connected: false,
  library: null,
  operationTracker: createOperationTracker(),
  items: [],
  total: 0,
  estimatedTotal: false,
  offset: 0,
  nextOffset: 0,
  hasMore: false,
  pageSize: 160,
  loading: false,
  refreshToken: 0,
  commentsToken: 0,
  metadataToken: 0,
  selected: new Set(),
  selectedBase: null,
  sidebarVisible: true,
  inspectorVisible: true,
  inspectorDirty: false,
  inspectorSaving: false,
  inspectorEditing: false,
  inspectorAutoSaveTimer: null,
  sort: 'default',
  sortDir: 'auto',
  sortCascade: sortCascadeEnabled,
  randomSeed: 'seed',
  viewMode: 'justified',
  sortCapNoticeKey: '',
  viewTitle: '资源库',
  currentView: { kind: 'root' },
  history: [],
  historyIndex: -1,
  selectedFolderCard: null,
  dragDepth: 0,
  draggingItemIds: null,
  scrollTop: 0,
  query: createQuery(),
  localPins: {},
  localOrders: {},
  manualOrdersReady: false,
  localFolderCovers: { revision: 0, covers: {} },
  folderCoversReady: false,
  folderCoversLibrary: null,
  expandedFolders: new Set(),
  availableTags: [],
  tagGroups: [],
  starredTags: [],
  recentFolders: [],
  tagColors: {},
  viewMemory: new Map(),
  restoreScroll: null,
  activePaneId: 'pane-1',
  paneActivationHistory: ['pane-1'],
  splitRatios: null,
  windowId: null,
  previewId: null,
  previewZoom: { scale: 1, x: 0, y: 0, mode: 'fit', dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 },
  previewView: { background: 'none', grayscale: false },
  previewToken: 0,
  slideshow: { timer: null, intervalMs: 4000 },
  textSession: null,
  textSaving: false,
  comments: [],
  availableTags: [],
  tagColors: {},
  recentFolders: [],
  tagGroups: [],
  draftTags: [],
  batchTags: [],
  copiedTags: [],
  contextMenu: null,
  openDrawer: null,
  folderDialogResolve: null,
  folderDialogAllowEmpty: false,
  trashDialogResolve: null,
  // Folder id -> view to open when a folder this window deleted disappears.
  folderRemovalRedirects: new Map(),
  duplicateDialogResolve: null,
  localPins: {},
  importing: false,
  suppressPasteUntil: 0,
  dragDepth: 0,
  draggingItemIds: null,
  dragSourcePaneId: null,
  internalDrag: null,
  viewMemory: new Map(),
  restoreScroll: null
};

// Eagle has no client-side undo history for metadata mutations. Keep a small
// in-memory record of the latest trash operation so Control+Z can safely send
// the inverse API patch while this window remains open.
const trashUndoStack = [];
let trashMutationInFlight = 0;
// Per pane: the rating whose writes are still in flight (setSelectionRating).
const ratingQueues = new Map();
// The library the extras on screen belong to, and the newest load (H-11).
let libraryExtrasLibrary = null;
let libraryExtrasToken = 0;
// A library change, a tag edit and a pin change often ask for the extras at
// once; a load already running for that library absorbs them into one more
// read after it (H-11) instead of starting parallel ones.
let libraryExtrasRun = null;

// 编辑 → 撤销 (⌘Z) is one menu item for two jobs: text undo while a field
// has focus, otherwise undoing the last delete. An open dialog swallows it so
// nothing changes behind the dialog.
function routeUndoCommand() {
  if (isEditableElement()) {
    document.execCommand('undo');
    return;
  }
  const dialogOpen = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
    .some(dialog => !dialog.classList.contains('hidden'));
  if (dialogOpen) return;
  undoLastTrash();
}

async function undoLastTrash() {
  if (trashMutationInFlight) { toast('删除操作尚未完成，请稍后再试', 2600); return; }
  const entry = trashUndoStack.at(-1);
  if (!entry?.ids?.length) { toast('没有可撤销的删除操作', 2200); return; }
  const paneId = paneById(entry.paneId) ? entry.paneId : state.activePaneId;
  const pane = paneById(paneId);
  const libraryPath = state.library?.path;
  if (!pane || !libraryPath || libraryPath !== entry.libraryPath) { toast('撤销失败：资源库已切换', 3500); return; }
  const operationToken = beginForegroundOperation('正在撤销删除…', { key: `trash-undo:${paneId}` });
  if (!operationToken) return;
  const selectionBefore = new Set(pane.selected);
  trashMutationInFlight += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    trashMutationInFlight -= 1;
    endForegroundOperation(operationToken);
  };
  setSyncStatus('正在撤销删除…');
  try {
    const outcome = await runItemBatch(entry.ids, async id => {
      const item = pane.itemMap?.get(id) || await window.eagleMV.getItem(id);
      const result = await window.eagleMV.mutate({ id, patch: { isDeleted: false }, base: item, libraryPath });
      if (result?.conflict) throw new Error('素材已在其他窗口发生变化，请刷新后重试');
      return result;
    }, 'Eagle 撤销请求超时');
    if (!outcome.succeeded.length) throw outcome.firstError || new Error('没有素材完成撤销');
    entry.ids = entry.ids.filter(id => !outcome.succeeded.includes(id));
    if (!entry.ids.length) trashUndoStack.pop();
    settleBatchSelection(pane, selectionBefore, outcome.failed);
    release();
    await refresh({ reset: true, preserveScroll: true, paneId });
    toast(outcome.failed.length ? `已撤销 ${outcome.succeeded.length} 个素材 · ${outcome.failed.length} 个失败` : `已撤销删除 ${outcome.succeeded.length} 个素材`, outcome.failed.length ? 4200 : 2400);
  } catch (error) {
    toast(`撤销删除失败：${error.message}`, 4000);
  } finally {
    setSyncStatus('所有窗口已同步');
    release();
  }
}
window.state = state;

// Each shuffle needs an order that survives re-renders and lazy pages but
// differs from the last one; a counter behind the clock gives both.
let randomSeedCounter = 0;
function nextRandomSeed() {
  randomSeedCounter += 1;
  return `${Date.now().toString(36)}-${randomSeedCounter}`;
}

let paneIdCounter = 1;
function nextPaneId() {
  paneIdCounter += 1;
  return `pane-${paneIdCounter}`;
}

function paneCreationOrder(id) {
  const match = String(id || '').match(/(\d+)$/);
  return match ? Number(match[1]) : paneIdCounter;
}

const paneStateKeys = [
  'items', 'itemMap', 'total', 'totalCount', 'estimatedTotal', 'offset', 'nextOffset', 'hasMore', 'loading', 'refreshToken', 'errorMessage', 'selected', 'selectedBase', 'selectionAnchor',
  'sort', 'sortDir', 'randomSeed', 'viewMode', 'viewTitle', 'currentView', 'history', 'historyIndex', 'selectedFolderCard', 'dragDepth', 'scrollTop', 'query', 'sortCascade',
  'viewMemory', 'restoreScroll', 'filterLock',
  'previewId', 'previewZoom', 'previewView', 'previewToken', 'textSession', 'textSaving', 'slideshow'
];
// Eagle offers four grid layouts; 'justified' is our default, as it is there.
const paneViewModes = new Set(['justified', 'grid', 'waterfall', 'list']);
function storedPaneViewModes() {
  try {
    const parsed = JSON.parse(localStorage.getItem('eaglemv.paneViewModes') || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

let syncPanesEnabled = false;
try {
  syncPanesEnabled = localStorage.getItem('eaglemv.syncPanes') === 'true';
} catch {}

function setSyncPanesEnabled(enabled, { notify = false } = {}) {
  syncPanesEnabled = Boolean(enabled);
  try {
    localStorage.setItem('eaglemv.syncPanes', String(syncPanesEnabled));
  } catch {}
  const checkbox = $('#syncPanesCheckbox');
  if (checkbox) checkbox.checked = syncPanesEnabled;
  if (notify) showPreviewSyncNotice();
}

let previewSyncNoticeAnimation;
function showPreviewSyncNotice() {
  const notice = $('#previewSyncNotice');
  previewSyncNoticeAnimation?.cancel();
  notice.textContent = syncPanesEnabled ? '预览同步已开启' : '预览同步已关闭';
  notice.classList.remove('hidden');
  const animation = notice.animate([
    { opacity: 1, offset: 0 },
    { opacity: 1, offset: .625, easing: 'ease-out' },
    { opacity: 0, offset: 1 }
  ], { duration: 2400, fill: 'forwards' });
  previewSyncNoticeAnimation = animation;
  animation.finished.then(() => {
    if (previewSyncNoticeAnimation !== animation) return;
    notice.classList.add('hidden');
    previewSyncNoticeAnimation = null;
    animation.cancel();
  }).catch(() => {}); // Repeated toggles replace, rather than stack, notices.
}

function broadcastPaneAction(actionFn) {
  if (!syncPanesEnabled || !state.panes || state.panes.length <= 1) return;
  const currentActiveId = state.activePaneId;
  for (const pane of state.panes) {
    if (pane.id === currentActiveId) continue;
    withActivePane(pane.id, () => {
      try {
        actionFn(pane);
      } catch (err) {
        console.error(`Sync pane ${pane.id} action failed:`, err);
      }
    });
  }
}

function paneTitleForView(view) {
  if (view?.kind === 'folder') return findFolder(state.library?.folders, view.id)?.name || '文件夹';
  if (view?.kind === 'smart') return view.name || findFolder(state.library?.smartFolders, view.id)?.name || '智能文件夹';
  return ({
    root: state.library?.name || '资源库',
    all: '全部',
    unfiled: '未分类',
    untagged: '未标签',
    recent: '最近使用',
    random: '随机模式',
    trash: '回收站',
    tags: '标签管理'
  })[view?.kind] || '资源库';
}

function createPaneState(id, source = state, { inheritCurrentViewOnly = false } = {}) {
  const currentView = { ...(source.currentView || { kind: 'root' }) };
  const fresh = Boolean(inheritCurrentViewOnly);
  const initialItems = fresh ? [] : (source.items ? [...source.items] : []);
  const pane = {
    id,
    creationOrder: paneCreationOrder(id),
    items: initialItems,
    itemMap: new Map(initialItems.filter(item => item?.id).map(item => [item.id, item])),
    total: fresh ? 0 : (Number(source.total) || 0),
    get totalCount() { return this.total; },
    set totalCount(value) { this.total = Math.max(0, Number(value) || 0); },
    estimatedTotal: fresh ? false : Boolean(source.estimatedTotal),
    offset: fresh ? 0 : (Number(source.offset) || 0),
    nextOffset: fresh ? 0 : (Number(source.nextOffset) || 0),
    hasMore: fresh ? false : Boolean(source.hasMore),
    loading: false,
    refreshToken: 0,
    errorMessage: '',
    selected: fresh ? new Set() : new Set(source.selected || []),
    selectedBase: fresh ? null : (source.selectedBase || null),
    // Where ⇧-click and ⇧-arrows extend from: the last plain or ⌘-click.
    selectionAnchor: null,
    sort: fresh ? 'default' : (source.sort || 'default'),
    sortDir: source.sortDir || 'auto',
    sortCascade: sortCascadeEnabled,
    randomSeed: source.randomSeed || nextRandomSeed(),
    viewMode: fresh ? 'justified' : (paneViewModes.has(storedPaneViewModes()[id]) ? storedPaneViewModes()[id] : (source.viewMode || 'justified')),
    sortCapNoticeKey: '',
    // The new pane gets a display label derived from the inherited path, not
    // another pane's mutable presentation state.
    viewTitle: fresh ? paneTitleForView(currentView) : (source.viewTitle || '资源库'),
    currentView,
    history: fresh ? [] : [...(source.history || [])],
    historyIndex: fresh ? -1 : (Number.isInteger(source.historyIndex) ? source.historyIndex : -1),
    selectedFolderCard: fresh ? null : (source.selectedFolderCard || null),
    dragDepth: 0,
    draggingItemIds: null,
    scrollTop: fresh ? 0 : (Number(source.scrollTop) || 0),
    query: fresh ? createQuery() : cloneQuery(source.query),
    // Eagle's 锁定筛选: keep the search and filters when the view changes.
    filterLock: fresh ? false : Boolean(source.filterLock),
    viewMemory: new Map(source.viewMemory || []),
    restoreScroll: null,
    previewId: fresh ? null : (source.previewId || null),
    previewZoom: fresh ? { scale: 1, x: 0, y: 0, mode: 'fit', dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 } : (source.previewZoom ? structuredClone(source.previewZoom) : { scale: 1, x: 0, y: 0, mode: 'fit', dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 }),
    previewView: fresh ? (source.previewView ? { ...source.previewView } : { background: 'none', grayscale: false }) : (source.previewView ? { ...source.previewView } : { background: 'none', grayscale: false }),
    previewToken: 0,
    textSession: null,
    textSaving: false,
    slideshow: { timer: null, intervalMs: source.slideshow?.intervalMs || 4000 }
  };
  if (fresh) {
    // A new pane opens its view without passing through applyView, so it
    // reads the remembered sort here (B1-01).
    const remembered = rememberedSortFor(currentView);
    pane.sort = remembered?.sort || 'default';
    pane.sortDir = remembered?.sortDir || 'auto';
    pane.randomSeed = nextRandomSeed();
    pane.viewMemory = new Map();
  }
  return pane;
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

const paneLayouts = paneLayoutSpecs;
// Non-default sorts pull the full folder so the order is exact; very large
// folders stop auto-fetching here and fall back to scroll-driven loading.
const SORT_FETCH_CAP = 3000;
const LIBRARY_SYNC_DEBOUNCE_MS = 320;
const LIBRARY_MISSING_CONFIRM_TIMEOUT_MS = 1800;
let librarySyncTimer = null;
let librarySyncRunning = false;
let pendingLibraryChange = null;
let lastAppliedLibraryRevision = -1;
let libraryHubInstance = null;
let newestLibraryRevision = -1;
let visibleItemWatchQueued = false;
let activeMarquee = null;
// Touch long-press bookkeeping: while the finger is still down the browser
// may fire its own contextmenu, and right after lift-off it fires a synthetic
// click — both must be swallowed without eating the user's next real tap.
let suppressTouchClickUntil = 0;
let touchLongPressActive = false;
// A touch double-tap also fires dblclick after its two clicks; the taps have
// already selected and opened, so that dblclick must not open again.
let lastTouchGridTapAt = 0;
const TOUCH_LONG_PRESS_MS = 480;
const TOUCH_LONG_PRESS_SLOP = 12;

// Android WebView turns a touch long-press on a draggable card into a native
// drag session that never reports its end; the next one leaves Blink stuck in
// drag mode, dropping every tap and key until a reload. Touch has no drag
// gesture here (long-press selects and opens the menu), so drags started by a
// finger or pen are cancelled before any page handler sees them.
let lastPointerDownType = 'mouse';
window.addEventListener('pointerdown', event => {
  lastPointerDownType = event.pointerType || 'mouse';
}, true);
window.addEventListener('dragstart', event => {
  if (lastPointerDownType === 'mouse') return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

// Shared touch long-press: the grid and the folder tree both need "hold to
// get the menu" with the same timing, the same movement budget, and the same
// suppression of the synthetic click and native contextmenu that follow.
// Returns { cancel } so a caller can abandon the press (a second finger, a
// gesture taking over).
function bindTouchLongPress(element, { selector, ignore, onLongPress }) {
  let press = null;
  const cancel = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  element.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    if (ignore && event.target.closest(ignore)) return;
    const target = selector ? event.target.closest(selector) : element;
    if (!target) return;
    cancel();
    const point = { x: event.clientX, y: event.clientY };
    press = {
      startX: event.clientX,
      startY: event.clientY,
      timer: setTimeout(() => {
        press = null;
        touchLongPressActive = true;
        onLongPress(target, point);
      }, TOUCH_LONG_PRESS_MS)
    };
  });
  element.addEventListener('pointermove', event => {
    if (press && Math.hypot(event.clientX - press.startX, event.clientY - press.startY) > TOUCH_LONG_PRESS_SLOP) cancel();
  });
  const settle = () => {
    cancel();
    if (!touchLongPressActive) return;
    touchLongPressActive = false;
    // Swallow only the synthetic click that follows this lift-off; a window
    // measured from the press instead would eat the user's next real tap.
    suppressTouchClickUntil = Date.now() + 400;
  };
  element.addEventListener('pointerup', settle);
  element.addEventListener('pointercancel', settle);
  return { cancel };
}

function triggerTouchLongPress(card, paneId, point) {
  navigator.vibrate?.(10);
  if (card.classList.contains('folder-card')) {
    if (!selectFolderCard(card.dataset.openFolder)) return;
    showContextMenuAt(point.x, point.y, { kind: 'folder', ids: [], folderId: card.dataset.openFolder, paneId });
    return;
  }
  const id = card.dataset.id;
  // Long-press is touch's right-click and its ⌘-click: with nothing selected
  // it selects the item and opens the menu; with a selection it adds an
  // unselected item (a tap would replace the selection), and on a selected
  // one it opens the menu for the whole selection.
  if (!state.selected.has(id)) {
    const before = state.selected.size;
    if (!before) {
      if (!selectItem(id)) return;
    } else {
      if (selectItem(id, true) && before === 1) toast('已进入多选：长按其它素材继续加选，长按已选素材打开菜单', 3200);
      return;
    }
  }
  const selectedItems = [...state.selected].map(itemById).filter(Boolean);
  showContextMenuAt(point.x, point.y, {
    ids: [...state.selected],
    folderId: state.currentView.kind === 'folder' ? state.currentView.id : null,
    allPinned: selectedItems.length > 0 && selectedItems.every(itemIsPinned),
    allDeleted: selectedItems.length > 0 && selectedItems.every(item => item.isDeleted),
    tags: state.availableTags
  });
}

// Keyboard Cmd/Ctrl +/- steps only the middle-grid thumbnail size (the same
// variable the size slider and pinch drive), so the side columns stay put and
// the slider in the toolbar tracks the shortcut. Cmd/Ctrl+0 resets to default.
function changeThumbnailSize(direction) {
  applyThumbnailSize(gestures.stepThumbnailSize(currentThumbnailSize(), direction));
}

function resetThumbnailSize() {
  applyThumbnailSize(gestures.THUMB_DEFAULT);
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
  const outerForeground = foregroundPaneId;
  if (foregroundPaneId === null) foregroundPaneId = previous;
  state.activePaneId = id;
  try { return callback(); } finally {
    state.activePaneId = previous;
    foregroundPaneId = outerForeground;
  }
}
// True while running on behalf of a pane the user is not in. The inspector,
// search and filter controls and the sidebar belong to the real active pane.
function renderingBackgroundPane() {
  return foregroundPaneId !== null && state.activePaneId !== foregroundPaneId;
}
const KEYBOARD_ACTIVATED_CONTROLS = 'button, a[href], summary, [role="button"], [role="menuitem"], [role="option"], [role="tab"]';
function isEditableElement(target = document.activeElement) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}
function isInspectorEditor(target = document.activeElement) {
  return Boolean(target?.closest?.('#inspectorContent input, #inspectorContent textarea, #inspectorContent select'));
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
  const previousPaneId = state.activePaneId;
  const previousBreadcrumb = paneQuery(previousPaneId, '#breadcrumb');
  if (previousBreadcrumb?.classList.contains('is-editing')) {
    withActivePane(previousPaneId, () => cancelBreadcrumbEdit(previousBreadcrumb, previousPaneId));
  }
  state.activePaneId = id;
  // An editor left focused in another pane (TXT, path edit) would otherwise
  // keep receiving typing and ⌘V meant for this pane: blank-area marquee
  // presses and macOS button clicks do not move focus on their own.
  const focused = document.activeElement;
  if (isEditableElement(focused) && focused.closest('.content-pane') && !paneRoot(id)?.contains(focused)) focused.blur();
  state.paneActivationHistory = [id, previousPaneId, ...state.paneActivationHistory]
    .filter((value, index, ids) => paneById(value) && ids.indexOf(value) === index);
  for (const pane of document.querySelectorAll('.content-pane')) pane.classList.toggle('active', pane.dataset.paneId === id);
  renderQueryControls();
  renderFolderTree();
  renderInspector();
  saveSessionState();
  return true;
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function uiIcon(name, className = 'tree-icon-svg') {
  const paths = {
    revealPane: '<path d="M10 3h7v14H3v-4M10 3v14M1 8h6M4 5l3 3-3 3"></path>',
    folder: '<path d="M2.5 6.7h5l1.45 1.7h8.55v6.7a1.9 1.9 0 0 1-1.9 1.9H4.4a1.9 1.9 0 0 1-1.9-1.9V6.7Z"></path><path d="M2.5 7.5V5.9A1.9 1.9 0 0 1 4.4 4h3.1l1.5 1.7h6.6a1.9 1.9 0 0 1 1.9 1.9v.8"></path>',
    library: '<rect x="3" y="4" width="14" height="12.5" rx="2.2"></rect><path d="M6.5 4v12.5M3 7.5h3.5"></path>',
    all: '<rect x="3" y="3" width="5.5" height="5.5" rx="1.4"></rect><rect x="11.5" y="3" width="5.5" height="5.5" rx="1.4"></rect><rect x="3" y="11.5" width="5.5" height="5.5" rx="1.4"></rect><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.4"></rect>',
    unfiled: '<path d="M3 6.5h14v8.2a2.3 2.3 0 0 1-2.3 2.3H5.3A2.3 2.3 0 0 1 3 14.7V6.5Z"></path><path d="M2.5 6.5 5 3h10l2.5 3.5M7.2 10h5.6"></path>',
    recent: '<circle cx="10" cy="10" r="7"></circle><path d="M10 6v4l2.8 1.8"></path>',
    random: '<path d="M4 5h2.2c2.9 0 3.4 5 6.2 5h3.6"></path><path d="m13.5 7.3 2.5 2.7-2.5 2.7"></path><path d="M4 15h2.2c1.2 0 2-1 2.7-2.1M13.5 12.7 16 15.4 13.5 18"></path>',
    trash: '<path d="M4.5 6.5h11l-.6 10.5H5.1L4.5 6.5Z"></path><path d="M3.5 6.5h13M7.3 6.5V4h5.4v2.5M8 9.2v5.2M12 9.2v5.2"></path>',
    smart: '<path d="m10 2 1.35 4.15L15.5 7.5l-4.15 1.35L10 13l-1.35-4.15L4.5 7.5l4.15-1.35L10 2Z"></path><path d="m15.7 12 .65 2 2 .65-2 .65-.65 2-.65-2-2-.65 2-.65.65-2Z"></path>',
    layoutJustified: '<rect x="3" y="3.5" width="8" height="5.5" rx="1.2"></rect><rect x="12.5" y="3.5" width="4.5" height="5.5" rx="1.2"></rect><rect x="3" y="11" width="4.5" height="5.5" rx="1.2"></rect><rect x="9" y="11" width="8" height="5.5" rx="1.2"></rect>',
    layoutGrid: '<rect x="3" y="3.5" width="6" height="6" rx="1.2"></rect><rect x="11" y="3.5" width="6" height="6" rx="1.2"></rect><rect x="3" y="10.5" width="6" height="6" rx="1.2"></rect><rect x="11" y="10.5" width="6" height="6" rx="1.2"></rect>',
    layoutWaterfall: '<rect x="3" y="3" width="6" height="7.5" rx="1.2"></rect><rect x="3" y="12.5" width="6" height="4.5" rx="1.2"></rect><rect x="11" y="3" width="6" height="4.5" rx="1.2"></rect><rect x="11" y="9.5" width="6" height="7.5" rx="1.2"></rect>',
    layoutList: '<rect x="3" y="3.5" width="3.5" height="3.5" rx="1"></rect><path d="M8.5 5.2H17"></path><rect x="3" y="8.2" width="3.5" height="3.5" rx="1"></rect><path d="M8.5 10H17"></path><rect x="3" y="13" width="3.5" height="3.5" rx="1"></rect><path d="M8.5 14.8H17"></path>',
    chevronDown: '<path d="m5.5 7.5 4.5 5 4.5-5"></path>',
    chevronRight: '<path d="m7.5 5.5 5 4.5-5 4.5"></path>',
    pin: '<path d="m7 3 6 6-1.9 1.9 3.3 3.3-1.2 1.2-3.3-3.3L8 14 6 12l1.9-1.9-3.3-3.3L7 3Z"></path><path d="m6.8 13.2-3.3 3.3"></path>',
    open: '<path d="M4 4.5h5l1.5 2H16a1.8 1.8 0 0 1 1.8 1.8v6.2a1.8 1.8 0 0 1-1.8 1.8H4A1.8 1.8 0 0 1 2.2 14.5V6.3A1.8 1.8 0 0 1 4 4.5Z"></path><path d="m9.5 12 5-5M11 7h3.5v3.5"></path>',
    finder: '<path d="M3 3.5h14v13H3z"></path><path d="M6 7h8M6 10h5M6 13h3"></path>',
    openLocation: '<path d="M3.5 4h7l4 4v2.5M3.5 4v12a1.5 1.5 0 0 0 1.5 1.5h5.5"></path><path d="M10.5 4v4h4"></path><circle cx="14.5" cy="14.5" r="2.5"></circle><path d="m16.5 16.5 2 2"></path>',
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
    lock: '<rect x="5" y="9" width="10" height="7.5" rx="1.6"></rect><path d="M7 9V6.8a3 3 0 0 1 6 0V9"></path>',
    star: '<path d="m10 3 2.1 4.4 4.8.6-3.5 3.3.9 4.8L10 13.8l-4.3 2.3.9-4.8-3.5-3.3 4.8-.6L10 3Z"></path>',
    search: '<circle cx="8.8" cy="8.8" r="5"></circle><path d="m12.5 12.5 4 4"></path>'
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
  const editing = state.inspectorEditing || isInspectorEditor();
  if (state.inspectorDirty || state.inspectorSaving || editing) {
    if (external && state.selected.size === 1 && inspectorMetadataChanged(itemById([...state.selected][0]))) {
      $('#staleBanner').classList.remove('hidden');
    }
    return;
  }
  renderInspector();
}, 24);

function queueChangedInspectorRender(external) {
  pendingInspectorExternalChange ||= Boolean(external);
  scheduleChangedInspectorRender();
}

function paneMarkup(id, index) {
  return `<section class="content-pane${id === state.activePaneId ? ' active' : ''}" data-pane-id="${escapeHTML(id)}" tabindex="0">
    <div class="content-heading">
      <div class="heading-path-row">
        <div id="breadcrumb" class="breadcrumb" aria-label="当前路径"></div>
      </div>
      <div class="heading-main-row">
        <div class="navigation-controls">
          <button id="backButton" class="nav-button" title="${keyboardPlatform.shortcutText('返回（⌥← / ⌃←）')}" disabled aria-label="返回"><img class="nav-image-icon" src="eagle-assets/ic-modal-back.svg" alt=""></button>
          <button id="forwardButton" class="nav-button" title="${keyboardPlatform.shortcutText('前进（⌥→ / ⌃→）')}" disabled aria-label="前进"><img class="nav-image-icon mirror-x" src="eagle-assets/ic-modal-back.svg" alt=""></button>
          <button id="upButton" class="nav-button up" title="${keyboardPlatform.shortcutText('上一级（⌥↑ / ⌃↑）')}" disabled aria-label="上一级"><img class="nav-image-icon" src="eagle-assets/ic-arrow-up.svg" alt=""></button>
        </div>
        <div class="location-block">
          <h1 id="viewTitle">资源库</h1>
          <span id="resultCount" class="muted">正在连接…</span>
        </div>
        <div class="sort-controls">
          <div id="viewModeGroup" class="view-mode-group" role="group" aria-label="当前栏布局">
            <button class="view-mode-button" data-view-mode="justified" title="自适应布局" aria-label="自适应布局">${uiIcon('layoutJustified', 'view-mode-svg')}</button>
            <button class="view-mode-button" data-view-mode="grid" title="网格" aria-label="网格">${uiIcon('layoutGrid', 'view-mode-svg')}</button>
            <button class="view-mode-button" data-view-mode="waterfall" title="瀑布流" aria-label="瀑布流">${uiIcon('layoutWaterfall', 'view-mode-svg')}</button>
            <button class="view-mode-button" data-view-mode="list" title="列表" aria-label="列表">${uiIcon('layoutList', 'view-mode-svg')}</button>
          </div>
          <div class="sort-select-control">
            <button id="sortSelectButton" class="sort-select-button" type="button" aria-haspopup="menu" aria-expanded="false" title="当前栏排序">
              <svg class="sort-select-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5.5h12M4 10h8M4 14.5h4"></path></svg>
              <span id="sortSelectLabel" class="sort-select-label">Eagle 顺序</span>
              <svg class="sort-select-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8.5 4 4 4-4"></path></svg>
            </button>
            <select id="sortSelect" class="sort-select hidden-accessible" aria-label="当前栏排序" tabindex="-1">
              <option value="default">Eagle 顺序</option>
              <option value="name">名称</option>
              <option value="added">添加日期</option>
              <option value="newest">修改日期</option>
              <option value="created">创建日期</option>
              <option value="size">文件大小</option>
              <option value="resolution">分辨率</option>
              <option value="rating">评分</option>
              <option value="type">文件类型</option>
              <option value="tags">标签</option>
              <option value="random">随机</option>
            </select>
            <div id="sortPopover" class="sort-popover hidden" popover="manual" role="menu" aria-label="排序选项">
              <div class="sort-popover-layout" role="group" aria-label="当前栏布局">
                <button type="button" class="sort-popover-layout-button" data-view-mode="justified" title="自适应" aria-label="自适应">${uiIcon('layoutJustified', 'view-mode-svg')}</button>
                <button type="button" class="sort-popover-layout-button" data-view-mode="grid" title="网格" aria-label="网格">${uiIcon('layoutGrid', 'view-mode-svg')}</button>
                <button type="button" class="sort-popover-layout-button" data-view-mode="waterfall" title="瀑布流" aria-label="瀑布流">${uiIcon('layoutWaterfall', 'view-mode-svg')}</button>
                <button type="button" class="sort-popover-layout-button" data-view-mode="list" title="列表" aria-label="列表">${uiIcon('layoutList', 'view-mode-svg')}</button>
              </div>
              <div class="sort-popover-divider sort-popover-layout-divider"></div>
              <div class="sort-popover-options">
                <button type="button" class="sort-popover-option" data-sort="default">Eagle 顺序</button>
                <button type="button" class="sort-popover-option" data-sort="name">名称</button>
                <button type="button" class="sort-popover-option" data-sort="added">添加日期</button>
                <button type="button" class="sort-popover-option" data-sort="newest">修改日期</button>
                <button type="button" class="sort-popover-option" data-sort="created">创建日期</button>
                <button type="button" class="sort-popover-option" data-sort="size">文件大小</button>
                <button type="button" class="sort-popover-option" data-sort="resolution">分辨率</button>
                <button type="button" class="sort-popover-option" data-sort="rating">评分</button>
                <button type="button" class="sort-popover-option" data-sort="type">文件类型</button>
                <button type="button" class="sort-popover-option" data-sort="random">随机</button>
              </div>
              <div id="sortDirDivider" class="sort-popover-divider"></div>
              <div id="sortDirGroup" class="sort-popover-options sort-popover-dir-group">
                <button type="button" class="sort-popover-option" data-sort-dir="asc">升序</button>
                <button type="button" class="sort-popover-option" data-sort-dir="desc">降序</button>
              </div>
              <div id="sortCascadeDivider" class="sort-popover-divider"></div>
              <label id="sortCascadeItem" class="sort-popover-item sort-cascade-item">
                <input type="checkbox" id="sortCascadeCheck" class="sort-cascade-check">
                <span>排序应用到子文件夹</span>
              </label>
              <div class="sort-popover-divider"></div>
              <div class="sort-popover-toggles" role="group" aria-label="显示">
                <label class="sort-popover-item"><input type="checkbox" class="sort-cascade-check" data-card-display="subfolderContent"><span>显示子文件夹内容</span></label>
                <label class="sort-popover-item"><input type="checkbox" class="sort-cascade-check" data-card-display="name"><span>显示名称</span></label>
                <div class="sort-popover-item card-meta-toggle">
                  <label><input type="checkbox" class="sort-cascade-check" data-card-display="meta"><span>显示简介</span></label>
                  <select data-card-meta-type aria-label="简介内容">${cardDisplayAPI.META_TYPES.map(([type, label]) => `<option value="${type}">${label}</option>`).join('')}</select>
                </div>
                <label class="sort-popover-item"><input type="checkbox" class="sort-cascade-check" data-card-display="ext"><span>显示扩展名</span></label>
                <label class="sort-popover-item"><input type="checkbox" class="sort-cascade-check" data-card-display="extLabel"><span>显示扩展名标签</span></label>
                <label class="sort-popover-item"><input type="checkbox" class="sort-cascade-check" data-card-display="annotation"><span>显示标注数</span></label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div id="gridScroller" class="grid-scroller">
      <div id="pullRefresh" class="pull-refresh" aria-hidden="true">
        <span class="pull-refresh-spinner"></span><span id="pullRefreshText" class="pull-refresh-text">下拉刷新</span>
      </div>
      <div id="emptyState" class="empty-state hidden">
        <div class="empty-icon"><img src="brand-icon.png" alt=""></div>
        <h2>拖放文件到这里</h2>
        <p>你可以一次拖拽多个文件到这里添加</p>
        <button id="emptyRetryButton" class="secondary-button empty-retry-button hidden">重新读取</button>
      </div>
      <div id="itemGrid" class="item-grid"></div>
      <div id="loadIndicator" class="load-indicator hidden">正在载入更多…</div>
      <button id="scrollTopButton" class="scroll-top-button hidden" title="回到顶部（Home）">↑</button>
    </div>
    <div id="dropOverlay" class="drop-overlay hidden"><div><strong>导入到当前文件夹</strong><span>松开即可导入文件</span></div></div>
    <div id="previewModal" class="preview-modal hidden">
      <div id="slideshowControls" class="slideshow-controls">
        <button id="slideshowToggle" class="slideshow-button" type="button" title="幻灯片播放（S）" aria-pressed="false" aria-label="幻灯片播放">▶</button>
        <select id="slideshowInterval" class="slideshow-interval" aria-label="幻灯片间隔">
          <option value="2000">2 秒</option>
          <option value="4000" selected>4 秒</option>
          <option value="6000">6 秒</option>
          <option value="10000">10 秒</option>
        </select>
        <button id="previewBackground" class="slideshow-button preview-view-button" type="button" aria-label="透明区域背景"><span class="preview-bg-chip" aria-hidden="true"></span></button>
        <button id="previewGrayscale" class="slideshow-button preview-view-button" type="button" title="灰度查看（G）" aria-label="灰度查看" aria-pressed="false">灰</button>
      </div>
      <button id="closePreview" class="modal-close" type="button" aria-label="关闭预览">×</button>
      <div id="modalMedia" class="modal-media"></div>
      <div id="modalRating" class="modal-rating" role="group" aria-label="评分（按 0-5）"></div>
      <div id="modalCaption" class="modal-caption"></div>
    </div>
  </section>`;
}

function savePaneScrollPositions() {
  for (const pane of state.panes) {
    const scroller = paneQuery(pane.id, '#gridScroller');
    if (scroller) pane.scrollTop = scroller.scrollTop;
  }
}

function getLayoutSplitters(layout) {
  switch (layout) {
    case 'vertical2':
      return [{ axis: 'col', index: 0 }];
    case 'vertical3':
      return [{ axis: 'col', index: 0 }, { axis: 'col', index: 1 }];
    case 'vertical4':
      return [{ axis: 'col', index: 0 }, { axis: 'col', index: 1 }, { axis: 'col', index: 2 }];
    case 'horizontal2':
      return [{ axis: 'row', index: 0 }];
    case 'horizontal3':
      return [{ axis: 'row', index: 0 }, { axis: 'row', index: 1 }];
    case 'horizontal4':
      return [{ axis: 'row', index: 0 }, { axis: 'row', index: 1 }, { axis: 'row', index: 2 }];
    case 'grid4':
      return [{ axis: 'col', index: 0 }, { axis: 'row', index: 0 }];
    case 'leftStack':
      return [{ axis: 'col', index: 0 }, { axis: 'row', index: 0, subArea: 'right' }];
    case 'rightStack':
      return [{ axis: 'col', index: 0 }, { axis: 'row', index: 0, subArea: 'left' }];
    case 'topStack':
      return [{ axis: 'row', index: 0 }, { axis: 'col', index: 0, subArea: 'bottom' }];
    case 'bottomStack':
      return [{ axis: 'row', index: 0 }, { axis: 'col', index: 0, subArea: 'top' }];
    default:
      return [];
  }
}

function splitterMarkup(s) {
  const isCol = s.axis === 'col';
  const cls = isCol ? 'pane-splitter-vertical' : 'pane-splitter-horizontal';
  const orientation = isCol ? 'vertical' : 'horizontal';
  const label = isCol ? '调整分栏宽度，双击恢复等宽' : '调整分栏高度，双击恢复等高';
  const subAreaAttr = s.subArea ? ` data-sub-area="${s.subArea}"` : '';
  return `<div class="pane-splitter ${cls}" data-split-axis="${s.axis}" data-split-index="${s.index}"${subAreaAttr} role="separator" aria-orientation="${orientation}" aria-label="${label}" title="${label}"></div>`;
}

function applyLayoutSplitRatios(layoutRoot, ratios) {
  if (!layoutRoot) return;
  if (window.eagleMV.platform === 'web' && window.matchMedia('(max-width: 600px)').matches) {
    layoutRoot.style.gridTemplateColumns = '';
    layoutRoot.style.gridTemplateRows = '';
    return;
  }
  if (ratios?.cols?.length > 1) {
    layoutRoot.style.gridTemplateColumns = ratios.cols.map(c => `minmax(0, ${c})`).join(' ');
  } else {
    layoutRoot.style.gridTemplateColumns = '';
  }
  if (ratios?.rows?.length > 1) {
    layoutRoot.style.gridTemplateRows = ratios.rows.map(r => `minmax(0, ${r})`).join(' ');
  } else {
    layoutRoot.style.gridTemplateRows = '';
  }
}

function updateSplitterPositions() {
  const layoutRoot = $('#paneLayout');
  if (!layoutRoot) return;
  const layout = layoutRoot.dataset.layout || 'single';
  const splitters = layoutRoot.querySelectorAll('.pane-splitter');
  if (!splitters.length) return;
  const layoutRect = layoutRoot.getBoundingClientRect();
  if (layoutRect.width === 0 && layoutRect.height === 0) return;
  const panes = Array.from(layoutRoot.querySelectorAll('.content-pane'));
  if (!panes.length) return;

  for (const splitter of splitters) {
    const axis = splitter.dataset.splitAxis;
    const index = Number(splitter.dataset.splitIndex);
    const subArea = splitter.dataset.subArea;

    if (axis === 'col') {
      let leftPane = panes[index];
      let rightPane = panes[index + 1];

      if (layout === 'leftStack') {
        leftPane = panes[0];
        rightPane = panes[1];
      } else if (layout === 'rightStack') {
        leftPane = panes[0];
        rightPane = panes[2];
      } else if (layout === 'topStack') {
        leftPane = panes[1];
        rightPane = panes[2];
      } else if (layout === 'bottomStack') {
        leftPane = panes[0];
        rightPane = panes[1];
      }

      if (leftPane && rightPane) {
        const leftRect = leftPane.getBoundingClientRect();
        const rightRect = rightPane.getBoundingClientRect();
        const splitX = (leftRect.right + rightRect.left) / 2 - layoutRect.left;
        splitter.style.left = `${Math.round(splitX)}px`;

        if (subArea === 'bottom') {
          const topPane = panes[0];
          const topRect = topPane.getBoundingClientRect();
          const splitY = (topRect.bottom + leftRect.top) / 2 - layoutRect.top;
          splitter.style.top = `${Math.round(splitY)}px`;
          splitter.style.bottom = '0px';
          splitter.style.height = 'auto';
        } else if (subArea === 'top') {
          const bottomPane = panes[2];
          const bottomRect = bottomPane.getBoundingClientRect();
          const splitY = (leftRect.bottom + bottomRect.top) / 2 - layoutRect.top;
          splitter.style.top = '0px';
          splitter.style.height = `${Math.round(splitY)}px`;
          splitter.style.bottom = 'auto';
        } else {
          splitter.style.top = '0px';
          splitter.style.bottom = '0px';
          splitter.style.height = 'auto';
        }
      }
    } else if (axis === 'row') {
      let topPane = panes[index];
      let bottomPane = panes[index + 1];

      if (layout === 'grid4') {
        topPane = panes[0];
        bottomPane = panes[2];
      } else if (layout === 'leftStack') {
        topPane = panes[1];
        bottomPane = panes[2];
      } else if (layout === 'rightStack') {
        topPane = panes[0];
        bottomPane = panes[1];
      } else if (layout === 'topStack') {
        topPane = panes[0];
        bottomPane = panes[1];
      } else if (layout === 'bottomStack') {
        topPane = panes[0];
        bottomPane = panes[2];
      }

      if (topPane && bottomPane) {
        const topRect = topPane.getBoundingClientRect();
        const bottomRect = bottomPane.getBoundingClientRect();
        const splitY = (topRect.bottom + bottomRect.top) / 2 - layoutRect.top;
        splitter.style.top = `${Math.round(splitY)}px`;

        if (subArea === 'right') {
          const leftPane = panes[0];
          const leftRect = leftPane.getBoundingClientRect();
          const splitX = (leftRect.right + topRect.left) / 2 - layoutRect.left;
          splitter.style.left = `${Math.round(splitX)}px`;
          splitter.style.right = '0px';
          splitter.style.width = 'auto';
        } else if (subArea === 'left') {
          const rightPane = panes[2];
          const rightRect = rightPane.getBoundingClientRect();
          const splitX = (topRect.right + rightRect.left) / 2 - layoutRect.left;
          splitter.style.left = '0px';
          splitter.style.width = `${Math.round(splitX)}px`;
          splitter.style.right = 'auto';
        } else {
          splitter.style.left = '0px';
          splitter.style.right = '0px';
          splitter.style.width = 'auto';
        }
      }
    }
  }
}

function bindPaneSplitters() {
  const layoutRoot = $('#paneLayout');
  if (!layoutRoot) return;
  const splitters = layoutRoot.querySelectorAll('.pane-splitter');
  for (const handle of splitters) {
    handle.addEventListener('dblclick', event => {
      event.preventDefault();
      event.stopPropagation();
      const axis = handle.dataset.splitAxis;
      const layout = layoutRoot.dataset.layout || 'single';
      state.splitRatios = resetSplitRatioAxis(state.splitRatios, layout, axis);
      applyLayoutSplitRatios(layoutRoot, state.splitRatios);
      updateSplitterPositions();
      scheduleGridResize();
      saveSessionState();
    });

    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      const axis = handle.dataset.splitAxis;
      const index = Number(handle.dataset.splitIndex);
      const startX = event.clientX;
      const startY = event.clientY;
      const layoutRect = layoutRoot.getBoundingClientRect();
      const layout = layoutRoot.dataset.layout || 'single';

      handle.classList.add('dragging');
      handle.setPointerCapture?.(event.pointerId);

      const computedColStyle = getComputedStyle(layoutRoot).gridTemplateColumns;
      const computedRowStyle = getComputedStyle(layoutRoot).gridTemplateRows;
      const currentCols = computedColStyle.split(/\s+/).map(v => parseFloat(v)).filter(Number.isFinite);
      const currentRows = computedRowStyle.split(/\s+/).map(v => parseFloat(v)).filter(Number.isFinite);

      const startSizes = axis === 'col' ? [...currentCols] : [...currentRows];
      const totalDimension = axis === 'col' ? layoutRect.width : layoutRect.height;
      const minSize = axis === 'col' ? 180 : 150;

      const move = moveEvent => {
        const delta = axis === 'col' ? (moveEvent.clientX - startX) : (moveEvent.clientY - startY);
        const ratios = calculateSplitRatios(axis, index, startSizes, delta, totalDimension, minSize);

        if (!state.splitRatios) state.splitRatios = defaultSplitRatios(layout);
        if (axis === 'col') {
          state.splitRatios.cols = ratios;
        } else {
          state.splitRatios.rows = ratios;
        }
        applyLayoutSplitRatios(layoutRoot, state.splitRatios);
        updateSplitterPositions();
        scheduleGridResize();
      };

      const end = () => {
        handle.classList.remove('dragging');
        handle.releasePointerCapture?.(event.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        saveSessionState();
      };

      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  }
}

const scheduleGridResize = debounce(() => {
  updateSplitterPositions();
  for (const pane of state.panes) {
    const root = paneRoot(pane.id);
    if (root) {
      const breadcrumb = root.querySelector('#breadcrumb');
      if (breadcrumb) syncBreadcrumbLayout(breadcrumb);
    }
  }
}, 16);

function serializeSessionState() {
  const layout = $('#paneLayout')?.dataset.layout || 'single';
  const splitRatios = state.splitRatios || defaultSplitRatios(layout);
  return createSessionState({
    layout,
    splitRatios,
    activePaneId: state.activePaneId,
    panes: state.panes
  });
}

function saveSessionState() {
  if (!state.library) return;
  window.__eagleMVCurrentView = { libraryPath: state.library.path, view: structuredClone(activePane()?.currentView || state.currentView) };
  try {
    const session = serializeSessionState();
    localStorage.setItem('eaglemv.sessionState', JSON.stringify(session));
    localStorage.setItem('eaglemv.paneLayout', session.layout);
  } catch {}
}

function restoreSavedSessionPanes() {
  let session = null;
  try {
    session = JSON.parse(localStorage.getItem('eaglemv.sessionState') || 'null');
  } catch {}
  if (session && Array.isArray(session.panes) && session.panes.length) {
    for (let index = 0; index < state.panes.length; index += 1) {
      const pane = state.panes[index];
      const saved = session.panes[index] || session.panes.find(p => p.id === pane.id);
      if (saved) {
        const view = validateSessionView(saved.view, state.library?.folders, state.library?.smartFolders);
        pane.sort = saved.sort || 'default';
        pane.sortDir = saved.sortDir || 'auto';
        if (paneViewModes.has(saved.viewMode)) pane.viewMode = saved.viewMode;
        withActivePane(pane.id, () => {
          applyView(view);
          if (saved.sort) {
            pane.sort = saved.sort;
            pane.sortDir = saved.sortDir || 'auto';
            renderSortControls();
          }
          if ($('#viewTitle')) $('#viewTitle').textContent = pane.viewTitle;
          renderLocation();
          if (view.kind === 'folder') revealFolderPath(view.id);
        });
      } else {
        withActivePane(pane.id, () => {
          applyView({ kind: 'root' });
          if ($('#viewTitle')) $('#viewTitle').textContent = pane.viewTitle;
          renderSortControls();
          renderLocation();
        });
      }
    }
    const activeByIndex = Number.isInteger(session.activeIndex) ? state.panes[session.activeIndex] : null;
    if (activeByIndex) activatePane(activeByIndex.id);
    else if (session.activePaneId && state.panes.some(p => p.id === session.activePaneId)) {
      activatePane(session.activePaneId);
    }
  } else {
    navigate({ kind: 'root' }, { refreshView: false });
  }
  renderFolderTree();
}

function renderPaneLayout(layout = 'single', { refresh = true, splitRatios = null } = {}) {
  if (!paneLayouts[layout]) layout = 'single';
  const layoutRoot = $('#paneLayout');
  if (layoutRoot.dataset.layout === layout && layoutRoot.querySelector('.content-pane') && !splitRatios) return true;
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
  const oldLayout = layoutRoot.dataset.layout || 'single';
  const plan = coordinatePaneLayout({
    currentLayout: oldLayout,
    nextLayout: layout,
    panes: state.panes,
    activePaneId: state.activePaneId,
    createPane: ({ source }) => createPaneState(nextPaneId(), source, { inheritCurrentViewOnly: true })
  });
  if (!confirmTextSessionsLeave(plan.removed)) return false;
  for (const pane of plan.removed) {
    clearTimeout(pane.slideshow.timer);
    clearTimeout(pane.hudTimer);
    pane.slideshow.generation = (pane.slideshow.generation || 0) + 1;
    clearTimeout(pane.textSession?.autoSaveTimer);
    breadcrumbObservers.get(paneQuery(pane.id, '#breadcrumb'))?.disconnect();
    ++pane.previewToken;
    ++pane.refreshToken;
  }
  state.panes = plan.panes;
  state.activePaneId = plan.activePaneId || state.panes[0]?.id;
  layoutRoot.dataset.layout = layout;
  reportMenuState();
  const splitters = getLayoutSplitters(layout);
  const splittersHTML = splitters.map(s => splitterMarkup(s)).join('');
  layoutRoot.innerHTML = state.panes.map((pane, index) => paneMarkup(pane.id, index)).join('') + splittersHTML;
  state.splitRatios = splitRatios || (layout === oldLayout && state.splitRatios ? state.splitRatios : defaultSplitRatios(layout));
  applyLayoutSplitRatios(layoutRoot, state.splitRatios);
  bindPaneSplitters();
  updateSplitterPositions();
  try { localStorage.setItem('eaglemv.paneLayout', layout); } catch {}
  saveSessionState();
  for (const pane of state.panes) bindPaneEvents(pane.id);
  for (const pane of state.panes) {
    withActivePane(pane.id, () => {
      $('#viewTitle').textContent = pane.viewTitle;
      renderSortControls();
      renderLocation();
      renderGrid({ preserveScroll: true });
      if (pane.previewId) {
        const item = itemById(pane.previewId);
        if (item) {
          $('#previewModal')?.classList.remove('hidden');
          updatePreviewChrome(item);
          if (String(item.ext || '').toLowerCase() !== 'txt') {
            const media = $('#modalMedia');
            if (media) media.innerHTML = mediaMarkup(item);
            setPreviewZoom(pane.previewZoom?.mode || 'fit');
            setupPreviewMedia();
          } else if (pane.textSession) {
            renderTextPreview(pane.textSession);
          }
        }
      }
      renderPreviewView();
      renderSlideshow();
    });
    const scroller = paneQuery(pane.id, '#gridScroller');
    if (scroller) scroller.scrollTop = pane.scrollTop || 0;
  }
  for (const pane of document.querySelectorAll('.content-pane')) pane.classList.toggle('active', pane.dataset.paneId === state.activePaneId);
  renderQueryControls();
  renderFolderTree();
  syncPaneLayoutButton(layout);
  if (refresh && state.connected) refreshAllPanes({ reset: true, preserveScroll: true });
  return true;
}

function recentPanePair() {
  return [...new Set([state.activePaneId, ...state.paneActivationHistory, ...state.panes.map(pane => pane.id)])]
    .filter(id => paneById(id)).slice(0, 2);
}

function swapRecentPanes(ids = recentPanePair()) {
  const [first, second] = ids.map(id => state.panes.findIndex(pane => pane.id === id));
  if (first == null || second == null || first < 0 || second < 0 || first === second) return false;
  const root = $('#paneLayout');
  const nodes = state.panes.map(pane => paneRoot(pane.id));
  if (nodes.some(node => !node)) return false;
  savePaneScrollPositions();
  [state.panes[first], state.panes[second]] = [state.panes[second], state.panes[first]];
  // Move live panes, preserving media, TXT sessions, selection and focus.
  // moveBefore is state-preserving in current Electron and Chromium.
  const focused = document.activeElement;
  const boundary = root.querySelector('.pane-splitter');
  for (const pane of state.panes) {
    const node = nodes.find(node => node.dataset.paneId === pane.id);
    if (root.moveBefore) root.moveBefore(node, boundary);
    else root.insertBefore(node, boundary);
  }
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  for (const pane of state.panes) {
    const scroller = paneQuery(pane.id, '#gridScroller');
    if (scroller) scroller.scrollTop = pane.scrollTop || 0;
  }
  updateSplitterPositions();
  saveSessionState();
  return true;
}

function swapPanesMenuMarkup() {
  return state.panes.length < 2 ? '' : contextMenuRow({ icon: 'layoutGrid',
    label: state.panes.length === 2 ? '交换双栏' : '交换最近激活的两栏',
    action: 'swap-panes', payload: { paneIds: recentPanePair() } });
}

function syncPaneLayoutButton(layout) {
  const button = $('#paneLayoutButton');
  const option = document.querySelector('#paneLayoutPopover [data-layout="' + layout + '"]');
  const icon = option?.querySelector('svg');
  if (!button || !icon) return;
  button.querySelector('.pane-split-icon').replaceChildren(icon.cloneNode(true));
  button.dataset.layout = layout;
  const label = '分栏布局：' + option.getAttribute('aria-label');
  button.title = label;
  button.setAttribute('aria-label', label);
  for (const entry of document.querySelectorAll('.pane-layout-option')) {
    entry.classList.toggle('active', entry === option);
  }
}

async function requestRefreshAllPanes() {
  const button = $('#refreshAllPanesButton');
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.title = '正在刷新所有分栏…';
  try {
    await refreshAllPanes({ reset: true, preserveScroll: true });
  } catch (error) {
    toast(error?.message || '刷新失败，请重试');
  } finally {
    button.disabled = false;
    button.setAttribute('aria-busy', 'false');
    button.title = '刷新所有分栏';
  }
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

// Batches big enough to take a while count up in the status bar (P6-02).
const batchProgress = new Map();
let batchProgressFrame = 0;
function renderSyncStatus() {
  let text = state.operationTracker.currentText();
  if (batchProgress.size) {
    let done = 0;
    let total = 0;
    for (const entry of batchProgress.values()) { done += entry.done; total += entry.total; }
    text += `（${done.toLocaleString()}/${total.toLocaleString()}）`;
  }
  $('#syncText').textContent = text;
}

function trackBatchProgress(total) {
  if (total < 200) return () => {};
  const entry = { done: 0, total };
  batchProgress.set(entry, entry);
  renderSyncStatus();
  return finished => {
    if (finished) {
      batchProgress.delete(entry);
      renderSyncStatus();
      return;
    }
    entry.done += 1;
    if (!batchProgressFrame) batchProgressFrame = requestAnimationFrame(() => { batchProgressFrame = 0; renderSyncStatus(); });
  };
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
  const status = connected ? (state.library?.name || '已连接 Eagle') : (message || 'Eagle 未连接');
  $('#connectionText').textContent = status;
  // The status bar is 9px tall and sits under the home indicator on a phone,
  // so a dropped host is effectively invisible there — and every action then
  // fails silently. Say it across the top instead.
  const banner = $('#offlineBanner');
  if (banner) {
    banner.textContent = window.eagleMV.platform === 'web' ? `${status} · 正在重连主机…` : status;
    banner.classList.toggle('hidden', connected);
    // Push the workspace down rather than covering the search box for as long
    // as the host stays away.
    document.body.classList.toggle('host-offline', !connected);
  }
  for (const selector of ['#trashButton', '#batchTrashButton', '#addCommentButton', '#customThumbnailButton']) {
    $(selector).disabled = !connected;
  }
  $('#pinButton').disabled = !connected || state.currentView.kind !== 'folder' || state.selected.size !== 1;
}

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes))) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes), index = 0;
  const shown = () => value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1);
  // Step up on the rounded figure too, so 1023.95 KB reads "1.0 MB", not "1024 KB".
  while ((value >= 1024 || Number(shown()) >= 1024) && index < units.length - 1) { value /= 1024; index += 1; }
  return `${shown()} ${units[index]}`;
}

// Eagle's inspector format, yyyy/MM/dd HH:mm.
function formatDateTime(time) {
  const date = new Date(Number(time) || 0);
  if (!Number(time) || Number.isNaN(date.getTime())) return '—';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif', 'bmp', 'heic', 'tif', 'tiff']);
function isImageItem(item) { return imageExtensions.has(String(item?.ext || '').toLowerCase()); }
// Originals Chromium cannot decode whose preview rides Eagle's generated
// .info image (eaglemv://preview): design formats plus camera RAW.
const previewStandInExtensions = new Set(['psd', 'tif', 'tiff', 'heic', 'heif', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'raf', 'rw2']);
function itemFormat(item) { return String(item?.ext || '').trim().toUpperCase(); }

function compareItemsForView(a, b) {
  const folderCompare = state.currentView.kind === 'folder' ? eagleFolderComparator(state.currentView, state.sort) : null;
  if (state.currentView.kind === 'folder') {
    const left = pinTimestamp(a);
    const right = pinTimestamp(b);
    if (left && !right) return -1;
    if (!left && right) return 1;
    if (left !== right && state.sort !== 'manual') return right - left;
  }
  if (folderCompare) return folderCompare(a, b);
  if (state.sort === 'manual') return window.EagleMVManualOrder.compare(manualOrder(state.currentView, 'items'), a.id, b.id);
  return compareItemsBySort(state.sort, state.sortDir, a, b, { seed: state.randomSeed });
}

// A folder view follows the folder's own Eagle order (P1-02): "Eagle 顺序"
// is the sort the folder was given in Eagle, "自定义顺序" its manual order.
// Built once per folder state, since the item sort calls it per pair.
let eagleFolderOrderCache = null;
const eagleNameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
function libraryFolder(id) {
  return id ? findFolderInTree(state.library?.folders, id) : null;
}
function eagleFolderComparator(view, sort) {
  if (view?.kind !== 'folder') return null;
  const folder = libraryFolder(view.id);
  const cache = eagleFolderOrderCache;
  if (cache && cache.folder === folder && cache.sort === sort && cache.orderBy === folder?.orderBy && cache.increase === folder?.sortIncrease && cache.seed === state.randomSeed) return cache.compare;
  const order = window.EagleMVEagleOrder.folderOrder(folder, sort);
  let compare = order ? window.EagleMVEagleOrder.comparator(order, view.id, { collator: eagleNameCollator }) : null;
  if (order && !compare) compare = (a, b) => compareItemsBySort('random', 'auto', a, b, { seed: state.randomSeed });
  eagleFolderOrderCache = { folder, sort, orderBy: folder?.orderBy, increase: folder?.sortIncrease, seed: state.randomSeed, compare };
  return compare;
}
// Whether the pane's order comes from the client (so every page must load)
// rather than Eagle's API order.
function viewHasClientOrder(view = state.currentView, sort = state.sort) {
  return sort !== 'default' || Boolean(eagleFolderComparator(view, sort));
}

function manualScope(view) { return view.id ? `${view.kind}:${view.id}` : view.kind; }
// A folder showing its subfolders' files mixes items the folder's own order
// does not hold, so it has no custom order while 显示子文件夹内容 is on.
function supportsManual(view) {
  if (view.kind === 'folder' && cardDisplay.subfolderContent) return false;
  return ['root','folder','all','unfiled','untagged','smart'].includes(view.kind);
}
function manualOrder(view, kind) { return state.localOrders[window.EagleMVManualOrder.key(manualScope(view),kind)]; }
function acceptManualOrders(payload) {
  if (payload.libraryPath !== state.library?.path) return;
  const changedKey=window.EagleMVManualOrder.key(payload.scope,'items');
  const adopt=payload.kind==='items' && (payload.orders?.[changedKey]?.revision || 0) > (state.localOrders[changedKey]?.revision || 0);
  for (const [key, order] of Object.entries(payload.orders || {})) {
    if ((state.localOrders[key]?.revision || 0) <= order.revision) state.localOrders[key] = order;
  }
  for (const pane of state.panes) withActivePane(pane.id, () => {
    if (adopt && manualScope(pane.currentView)===payload.scope && pane.sort===payload.startSort) {
      pane.sort='manual';pane.sortDir='auto';
      sortMemory.remember(state.library.path,descriptorKey(pane.currentView),'manual','auto',Date.now(),state.library.folders);
    }
    renderSortControls();renderGrid({preserveScroll:true});
  });
  if (adopt) saveSessionState();
  renderFolderTree();
}
let manualDragAttached = false;
function attachManualDrag() {
  if (manualDragAttached) return;
  manualDragAttached = true;
  window.EagleMVManualOrder.attach({
    context: (node, snapshot = false) => {
      const paneId = node.closest('.content-pane')?.dataset.paneId || state.activePaneId;
      const pane = paneById(paneId); if (!pane) return null;
      return withActivePane(paneId, () => {
        const kind = node.matches('.item-card') ? 'items' : 'folders';
        const id = kind === 'items' ? node.dataset.id : node.dataset.folderNodeId;
        let view = pane.currentView, parentId = view.kind === 'folder' ? view.id : null;
        let known = snapshot ? (kind === 'items' ? sortedItems() : visibleChildFolders()) : [];
        if (node.matches('.folder-row')) {
          const trail = findFolderPath(state.library?.folders, id);
          if (!trail.length) return null;
          parentId = trail.at(-2)?.id || null;
          view = parentId ? {kind:'folder',id:parentId} : {kind:'root'};
          if (snapshot) known = window.EagleMVManualOrder.sort(parentId ? trail.at(-2).children : state.library.folders, manualOrder(view,'folders'));
        }
        const order = manualOrder(view,kind);
        // Folder items reorder in Eagle's own manual order, which Eagle
        // allows only without a filter or search and while the folder shows
        // that order (E-11).
        const eagleItems = kind === 'items' && view.kind === 'folder';
        const enabled = eagleItems
          ? supportsManual(view) && !queryFiltersActive(pane.query) && window.EagleMVEagleOrder.dragSortable(libraryFolder(view.id), pane.sort)
          : supportsManual(view);
        return {id,kind,parentId,paneId,scope:manualScope(view),libraryPath:state.library?.path,
          enabled,
          ready:(eagleItems || state.manualOrdersReady) && (kind==='folders' || (!pane.loading && !pane.errorMessage)),
          knownIds:known.map(item=>item.id),revision:order?.revision || 0,
          sourceView:descriptorKey(pane.currentView),refreshToken:pane.refreshToken,startSort:pane.sort,
          windowId:state.windowId,pinned:kind==='items' && itemIsPinned(itemById(id) || {})};
      });
    },
    begin: (node,ctx) => {
      if (!activatePane(ctx.paneId) || !confirmDiscardChanges()) return [];
      if (ctx.kind === 'folders') return state.connected ? [ctx.id] : [];
      if (!state.selected.has(ctx.id) && !selectItem(ctx.id)) return [];
      const ids=ctx.knownIds.filter(id=>state.selected.has(id));
      ctx.mixedPinned=ids.some(id=>itemIsPinned(itemById(id))!==ctx.pinned);
      state.draggingItemIds=ids;state.dragSourcePaneId=ctx.paneId;
      state.internalDrag={active:true,ids,sourceFolderId:ctx.parentId,sourceFolderIds:paneFolderScope(paneById(ctx.paneId),ctx.parentId),sourcePaneId:ctx.paneId,sourceWindowId:state.windowId,libraryPath:ctx.libraryPath};
      return ids;
    },
    submit: async (source,target,position) => {
      if (source.libraryPath!==state.library?.path) throw new Error('资源库已切换，请重新拖动');
      if (source.windowId===state.windowId) {
        const pane=paneById(source.paneId);
        if (!pane || descriptorKey(pane.currentView)!==source.sourceView || (source.kind==='items' && source.ids.some(id=>!pane.itemMap.has(id)))) throw new Error('来源视图已变化，请重新拖动');
      }
      if (source.kind==='items' && source.scope.startsWith('folder:')) return submitEagleItemOrder(source,target,position);
      const knownIds=[...new Set([...source.knownIds,...target.knownIds])];
      const result=await window.eagleMV.moveManualOrder({libraryPath:source.libraryPath,scope:source.scope,kind:source.kind,ids:source.ids,
        syncToEagle: true,
        anchorId:target.id,position,knownIds,revision:source.revision,rebase:source.kind==='items' && source.startSort!=='manual',startSort:source.startSort});
      acceptManualOrders({libraryPath:source.libraryPath,scope:source.scope,kind:source.kind,startSort:source.startSort,orders:result.orders});
      clearDragUI();
      if (result.conflict) throw new Error('其他窗口已调整顺序，已同步最新顺序，请重新拖动');
      if (!result.ok) throw new Error('本地排序未保存，请重试');
      toast(result.syncedToEagle ? '顺序已同步到 Eagle' : '此视图的顺序仅保存在 MultiView');
    },notify:toast,finish:clearDragUI,
    nativeSource: () => state.internalDrag?.active ? state.internalDrag.orderContext : null,
    nativeStart: hasCapability('nativeDrag') ? source => {
      state.internalDrag.orderContext=source;
      window.eagleMV.startDrag({ids:source.ids,sourceFolderId:source.parentId,sourceFolderIds:paneFolderScope(paneById(source.paneId),source.parentId),sourcePaneId:source.paneId,
        sourceWindowId:source.windowId,libraryPath:source.libraryPath,orderContext:source});
    } : null,
    forward: source => {
      if (source.kind!=='items') return;
      if (state.internalDrag?.orderContext===source) return;
      state.internalDrag={active:true,ids:source.ids,sourceFolderId:source.parentId,sourceFolderIds:paneFolderScope(paneById(source.paneId),source.parentId),sourcePaneId:source.paneId,
        sourceWindowId:source.windowId,libraryPath:source.libraryPath};
    }
  });
}

// Reorder folder items the way Eagle's own drag does: only the moved items get
// a new manual value, between their new neighbours, and the folder switches
// to its manual order (E-11). Pinned and unpinned items sort apart, so the
// neighbours come from the moved items' own group.
async function submitEagleItemOrder(source, target, position) {
  const folderId = source.scope.slice('folder:'.length);
  const pane = paneById(target.paneId);
  if (!pane) throw new Error('目标栏已关闭，请重新拖动');
  const displayedIds = withActivePane(pane.id, () => target.knownIds.filter(id => {
    const item = itemById(id);
    return item && itemIsPinned(item) === source.pinned;
  }));
  const { block, belowId } = window.EagleMVEagleOrder.blockNeighbours(displayedIds, source.ids, target.id, position);
  if (!belowId && pane.hasMore) throw new Error('后面还有未载入的素材，请先向下滚动载入后再拖到末尾');
  const folder = libraryFolder(folderId);
  const order = window.EagleMVEagleOrder.folderOrder(folder, 'manual');
  const result = await window.eagleMV.moveEagleOrder({ libraryPath: source.libraryPath, folderId, ids: block,
    anchorId: target.id, position, displayedIds, increase: order.increase });
  clearDragUI();
  if (folder && folder.orderBy !== 'MANUAL') { folder.orderBy = 'MANUAL'; folder.sortIncrease = true; }
  for (const changed of result?.items || []) {
    for (const candidate of state.panes) {
      const index = candidate.items.findIndex(item => item.id === changed.id);
      if (index < 0) continue;
      candidate.items[index] = changed;
      candidate.itemMap?.set(changed.id, changed);
    }
  }
  for (const candidate of state.panes) {
    if (candidate.currentView.kind === 'folder' && candidate.currentView.id === folderId) schedulePaneGridRender(candidate.id);
  }
  toast('顺序已同步到 Eagle');
}

function sortedItems() {
  return [...state.items].sort(compareItemsForView);
}

function firstSelectedInViewOrder() {
  let first = null;
  for (const item of state.items) {
    if (state.selected.has(item.id) && (!first || compareItemsForView(item, first) < 0)) first = item;
  }
  return first;
}

function renderViewModeControls() {
  reportMenuState();
  for (const button of $('#sortPopover')?.querySelectorAll('[data-view-mode]') || []) {
    button.classList.toggle('active', button.dataset.viewMode === (state.viewMode || 'justified'));
  }
  const group = $('#viewModeGroup');
  if (!group) return;
  for (const button of group.querySelectorAll('[data-view-mode]')) {
    button.classList.toggle('active', button.dataset.viewMode === (state.viewMode || 'justified'));
  }
}

// Layout choice is remembered per stable pane identity so a layout switch
// restores each pane's own view after it moves to another visual slot.
function setPaneViewMode(mode, paneId = state.activePaneId) {
  if (!paneViewModes.has(mode)) return;
  const pane = paneById(paneId);
  if (!pane || pane.viewMode === mode) return;
  pane.viewMode = mode;
  const stored = storedPaneViewModes();
  if (mode === 'justified') delete stored[paneId];
  else stored[paneId] = mode;
  try { localStorage.setItem('eaglemv.paneViewModes', JSON.stringify(stored)); } catch {}
  withActivePane(paneId, () => {
    renderViewModeControls();
    renderGrid({ preserveScroll: true });
  });
  saveSessionState();
}

const sortOptionLabels = {
  default: 'Eagle 顺序',
  manual: '自定义顺序',
  name: '名称',
  added: '添加日期',
  newest: '修改日期',
  created: '创建日期',
  size: '文件大小',
  resolution: '分辨率',
  rating: '评分',
  type: '文件类型',
  tags: '标签',
  random: '随机'
};

// The pane clips its overflow and, as a size container, is the containing
// block even for fixed descendants, so a popover taller than a split pane was
// cut off (P7-13). The top layer escapes both without moving the element out
// of its pane; it is then placed from the button, flipping up when there is
// no room below and scrolling when neither side fits.
function showSortPopover(popover, button) {
  if (!popover || !button || typeof popover.showPopover !== 'function') return;
  if (!popover.matches(':popover-open')) popover.showPopover();
  popover.classList.add('top-layer');
  popover.style.maxHeight = '';
  const margin = 8;
  const anchor = button.getBoundingClientRect();
  const below = window.innerHeight - anchor.bottom - 4 - margin;
  const above = anchor.top - 4 - margin;
  let height = popover.offsetHeight;
  const up = height > below && above > below;
  if (height > (up ? above : below)) {
    height = Math.max(120, up ? above : below);
    popover.style.maxHeight = `${height}px`;
  }
  const width = popover.offsetWidth;
  const left = Math.min(Math.max(margin, anchor.right - width), window.innerWidth - width - margin);
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(up ? anchor.top - 4 - height : anchor.bottom + 4)}px`;
}

function renderSortControls() {
  renderViewModeControls();
  const sortKey = state.sort || 'default';
  const select = $('#sortSelect');
  if (select) select.value = sortKey==='manual' ? 'default' : sortKey;
  const label = $('#sortSelectLabel');
  if (label) label.textContent = sortOptionLabels[sortKey] || 'Eagle 顺序';
  // The drag hint only holds where dragging can reorder (B1 wording); a
  // folder's "Eagle 顺序" names the sort the folder has in Eagle.
  const folder = state.currentView.kind === 'folder' ? libraryFolder(state.currentView.id) : null;
  const folderSort = sortKey === 'default' && folder?.orderBy ? window.EagleMVEagleOrder.LABELS[folder.orderBy] : null;
  const sortName = `${sortOptionLabels[sortKey] || 'Eagle 顺序'}${folderSort ? `（此文件夹在 Eagle 中为“${folderSort}”）` : ''}`;
  const draggable = state.currentView.kind === 'folder'
    ? supportsManual(state.currentView) && window.EagleMVEagleOrder.dragSortable(folder, sortKey)
    : supportsManual(state.currentView);
  if ($('#sortSelectButton')) $('#sortSelectButton').title = draggable
    ? `排序方式：${sortName}。也可直接拖动调整顺序`
    : `排序方式：${sortName}`;
  const popover = $('#sortPopover');
  if (popover) {
    for (const btn of popover.querySelectorAll('[data-sort]')) {
      btn.classList.toggle('active', btn.dataset.sort === sortKey);
      if (btn.dataset.sort === 'manual') btn.disabled = !supportsManual(state.currentView) || !state.manualOrdersReady;
    }
    const sortable = Boolean(state.sort) && !['default','random','manual'].includes(state.sort);
    const currentDir = effectiveSortDir(state.sort, state.sortDir);
    for (const btn of popover.querySelectorAll('[data-sort-dir]')) {
      btn.disabled = !sortable;
      btn.classList.toggle('active', sortable && btn.dataset.sortDir === currentDir);
    }
    const isFolder = state.currentView?.kind === 'folder';
    const divider = $('#sortCascadeDivider');
    const cascadeItem = $('#sortCascadeItem');
    if (divider) divider.classList.toggle('hidden', !isFolder);
    if (cascadeItem) cascadeItem.classList.toggle('hidden', !isFolder);
    const cascadeCheck = $('#sortCascadeCheck');
    if (cascadeCheck) cascadeCheck.checked = sortCascadeEnabled;
  }
  renderCardDisplayControls();
}

// Persist the active pane's sort choice for its current view, then re-render.
function applySortDirection(direction) {
  if (direction !== 'asc' && direction !== 'desc') return false;
  state.sortDir = direction;
  if (sortCascadeEnabled && state.currentView?.kind === 'folder') {
    sortMemory.rememberCascade(state.library?.path, state.currentView.id, state.library?.folders, state.sort, state.sortDir, Date.now());
  }
  commitSortChange();
  return true;
}

// One sort choice for the pane's popover and the blank-area menu's 排序方式:
// through the pane's own select, so random reshuffles and manual checks stay
// in one place.
function applySortFromMenu(sort, paneId = state.activePaneId) {
  if (!activatePane(paneId)) return false;
  if (sort === 'random' && state.sort === 'random') {
    state.randomSeed = nextRandomSeed();
    commitSortChange();
    return true;
  }
  const select = paneQuery(paneId, '#sortSelect');
  if (!select) return false;
  select.value = sort;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function sortMenuMarkup(paneId = state.activePaneId) {
  const pane = paneById(paneId);
  const current = pane?.sort || 'default';
  const sortable = Boolean(pane?.sort) && !['default', 'random', 'manual'].includes(pane.sort);
  const direction = effectiveSortDir(pane?.sort, pane?.sortDir);
  const options = ['default', 'name', 'added', 'newest', 'created', 'size', 'resolution', 'rating', 'type', 'random'].map(sort => contextMenuRow({
    label: sortOptionLabels[sort], checked: current === sort, action: 'set-sort', payload: { sort, paneId }
  }));
  const directions = [['asc', '升序'], ['desc', '降序']].map(([dir, label]) => contextMenuRow({
    label, checked: sortable && direction === dir, disabled: !sortable, action: 'set-sort-dir', payload: { dir, paneId }
  }));
  return [...options, '<div class="context-menu-separator"></div>', ...directions].join('');
}

const viewModeLabels = { justified: '自适应', grid: '网格', waterfall: '瀑布流', list: '列表' };
function viewModeMenuMarkup(paneId = state.activePaneId) {
  const current = paneById(paneId)?.viewMode || 'justified';
  const icons = { justified: 'layoutJustified', grid: 'layoutGrid', waterfall: 'layoutWaterfall', list: 'layoutList' };
  return Object.keys(viewModeLabels).map(mode => contextMenuRow({
    icon: icons[mode], label: viewModeLabels[mode], checked: current === mode, action: 'set-view-mode', payload: { mode, paneId }
  })).join('');
}

function commitSortChange() {
  sortMemory.remember(state.library?.path, descriptorKey(state.currentView), state.sort, state.sortDir, Date.now(), state.library?.folders);
  renderSortControls();
  renderGrid({ preserveScroll: true });
  renderFolderTree();
  saveSessionState();
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
  let folders;
  // 最近使用 filters by the search box like every other folder list (B1-08).
  if (state.currentView.kind === 'recent') folders = state.recentFolders || [];
  else {
    folders = state.currentView.kind === 'root'
      ? (state.library.folders || [])
      : (currentFolder()?.children || []);
    folders = window.EagleMVManualOrder.sort(folders,manualOrder(state.currentView,'folders'));
  }
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

// The Android shell asks for Back through evaluateJavascript and gives up after
// 1.5 s, so a confirm() inside its request outlived the request and the shell
// reported that the page did not answer (A-02). While the shell's request runs,
// the question waits: the request returns "blocked", the question is asked
// right after, and an accepted answer runs the same Back step again.
let shellBackDeferral = null;
let preAnsweredQuestion = null;

function confirmStep(message) {
  if (preAnsweredQuestion === message) {
    preAnsweredQuestion = null;
    return true;
  }
  if (shellBackDeferral) {
    shellBackDeferral.question ||= message;
    return false;
  }
  return confirm(message);
}

function confirmDiscardChanges({ includeText = true } = {}) {
  if (includeText && state.textSaving) {
    toast('正在保存 TXT，请稍候', 2400);
    return false;
  }
  const textDirty = includeText && state.textSession?.dirty;
  // Inspector metadata follows Eagle's edit-and-leave flow. The save routine
  // captures the selected pane and patch before its first await, so a
  // navigation can safely continue while that write finishes in background.
  if (state.inspectorDirty && !state.connected) {
    if (!confirmStep('Eagle 当前未连接，素材信息无法自动保存。\n\n按“确定”放弃素材信息修改并继续；按“取消”留在当前内容。')) return false;
    state.inspectorDirty = false;
    clearInspectorAutoSave();
  } else if (state.inspectorDirty) saveInspector();
  if (!textDirty) return true;
  if (state.inspectorSaving) {
    toast('正在保存素材信息，请稍候再离开 TXT 编辑', 2400);
    return false;
  }
  const discard = confirmStep('TXT 内容有尚未保存的修改。\n\n按“确定”放弃修改并继续；按“取消”留在当前内容。');
  if (discard && state.textSession) discardTextSession(state.textSession);
  return discard;
}

function filtersActive() {
  return queryFiltersActive(state.query);
}

function renderFilterState() {
  const active = filtersActive();
  $('#clearFiltersButton').classList.toggle('hidden', !active);
  // Offered while something is filtered, as Eagle shows its lock button.
  const lock = $('#lockFiltersButton');
  lock.classList.toggle('hidden', !active);
  lock.classList.toggle('active', Boolean(state.filterLock));
  lock.setAttribute('aria-pressed', String(Boolean(state.filterLock)));
  $('#filterButton').classList.toggle('locked', Boolean(state.filterLock) && active);
  $('#filterButton').title = state.filterLock && active ? '筛选已锁定：切换文件夹时保留' : '打开筛选器';
  $('#filterButton').classList.toggle('active', active || !$('#filterPopover').classList.contains('hidden'));
  const count = queryFilterCount(state.query);
  $('#filterCount').textContent = count;
  $('#filterCount').classList.toggle('hidden', !count);
}

// Eagle's named preset palette — single source for folder color dots and the
// color filter swatches.
const eagleNamedFolderColors = Object.freeze({
  red: '#e5484d', orange: '#f76b15', yellow: '#ffc53d', green: '#46a758',
  aqua: '#00a2c7', blue: '#0090ff', purple: '#8e4ec6', pink: '#d6409f', gray: '#8d8d8d'
});
const eagleColorLabels = Object.freeze({
  red: '红', orange: '橙', yellow: '黄', green: '绿', aqua: '青',
  blue: '蓝', purple: '紫', pink: '粉', gray: '灰'
});
const colorFilterChoices = Object.freeze([
  ['', '全部颜色'],
  ...Object.entries(eagleNamedFolderColors).map(([name, hex]) => [hex, eagleColorLabels[name] || name]),
  ['#1a1a1a', '黑'], ['#f2f2f2', '白']
]);

function renderColorFilter() {
  const box = $('#colorFilter');
  if (!box) return;
  const current = String(state.query.color || '').toLowerCase();
  box.innerHTML = colorFilterChoices.map(([hex, label]) => {
    const selected = current === hex;
    return `<button type="button" class="color-filter-swatch${hex ? '' : ' none'}${selected ? ' selected' : ''}" data-filter-color="${hex}" title="${label}"${hex ? ` style="background:${hex}"` : ''}>${hex ? '' : '✕'}</button>`;
  }).join('');
}

// Eagle's rule switch for the tag and folder filters (任意 / 全部 / 完全相同).
const filterLogicChoices = Object.freeze([
  ['OR', '任意', '任意 (OR)：包含其中任意一个'],
  ['AND', '全部', '全部 (AND)：同时包含全部'],
  ['EQUAL', '相同', '完全相同：恰好是这些，不多不少']
]);
const datePresetChoices = Object.freeze([
  ['today', '今日'], ['yesterday', '昨日'], ['last7', '最近 7 日'],
  ['last30', '最近 30 日'], ['last90', '最近 90 日'], ['last365', '最近 365 日']
]);
const FILTER_LIST_LIMIT = 400;

// Counts beside formats, folders and months, read over the active pane's
// view without its filters when the panel is open (Eagle counts what the
// view holds). Null while loading or where the view cannot be paged.
let filterFacets = { key: '', data: null, pending: false };

function filterFacetsQuery() {
  const pane = activePane();
  if (!pane || !state.library || ['trash', 'tags', 'recent', 'random'].includes(pane.currentView?.kind)) return null;
  return paneItemQuery({ ...pane, query: createQuery() }, pane.currentView);
}

function ensureFilterFacets() {
  if ($('#filterPopover')?.classList.contains('hidden') || !window.eagleMV.viewFacets) return;
  const query = filterFacetsQuery();
  const key = query ? `${state.library?.path}|${categoryStatsRevision}|${JSON.stringify(query)}` : '';
  if (key === filterFacets.key) return;
  filterFacets = { key, data: null, pending: Boolean(query) };
  if (!query) return;
  window.eagleMV.viewFacets(query)
    .then(data => { if (filterFacets.key === key) filterFacets = { key, data: data || null, pending: false }; },
      () => { if (filterFacets.key === key) filterFacets = { key, data: null, pending: false }; })
    .finally(() => { if (filterFacets.key === key) renderFilterLists(); });
}

function renderFilterLogic() {
  for (const box of document.querySelectorAll('[data-filter-logic]')) {
    const current = state.query[box.dataset.filterLogic] || 'OR';
    box.innerHTML = filterLogicChoices.map(([value, label, title]) => `<button type="button" class="filter-logic-option${current === value ? ' active' : ''}" role="radio" aria-checked="${current === value}" data-logic-value="${value}" title="${title}">${label}</button>`).join('');
  }
}

function filterCheckRow({ attr, value, label, title = label, count = null, checked = false, excluded = false, leading = '', depth = 0 }) {
  const mark = excluded ? 'excluded' : checked ? 'checked' : '';
  return `<button type="button" class="filter-check-row${mark ? ` ${mark}` : ''}" ${attr}="${escapeHTML(value)}" aria-pressed="${checked || excluded}" title="${escapeHTML(title)}${excluded ? '（已排除）' : ''}"${depth ? ` style="--depth:${Math.min(depth, 8)}"` : ''}>
    <span class="filter-checkbox" aria-hidden="true"></span>${leading}<span class="filter-check-name">${escapeHTML(label)}</span>${count === null ? '' : `<span class="filter-check-count">${Number(count).toLocaleString()}</span>`}
  </button>`;
}

// Re-rendering a list the user is scrolling must not jump it to the top.
function setListHTML(list, html) {
  if (!list) return;
  const top = list.scrollTop;
  list.innerHTML = html;
  list.scrollTop = top;
}

function filterListStatus(rows, { loading, empty }) {
  if (rows.length) return rows.join('');
  return `<span class="filter-check-empty">${filterFacets.pending ? loading : empty}</span>`;
}

function renderFolderFilterList() {
  const list = $('#folderFilterList');
  if (!list) return;
  const counts = filterFacets.data?.folders || null;
  const included = new Set(state.query.folderInclude || []);
  const excluded = new Set(state.query.folderExclude || []);
  const keyword = ($('#folderFilterSearch')?.value || '').trim().toLocaleLowerCase('zh-CN');
  const marked = id => included.has(id) || excluded.has(id);
  const rows = [];
  const unfiledCount = counts ? counts[NO_FOLDER] || 0 : null;
  if ((!keyword || '未分类'.includes(keyword)) && (unfiledCount === null || unfiledCount > 0 || marked(NO_FOLDER))) {
    rows.push(filterCheckRow({ attr: 'data-filter-folder', value: NO_FOLDER, label: '未分类', count: unfiledCount, checked: included.has(NO_FOLDER), excluded: excluded.has(NO_FOLDER) }));
  }
  // Without a keyword, the tree's indentation gives each name its context;
  // a search lists matches flat, with the whole path.
  for (const folder of flattenFolderTree(state.library?.folders || [])) {
    if (rows.length >= FILTER_LIST_LIMIT) break;
    const count = counts ? counts[folder.id] || 0 : null;
    if (count === 0 && !marked(folder.id)) continue;
    if (keyword && !folder.path.toLocaleLowerCase('zh-CN').includes(keyword)) continue;
    const node = findFolder(state.library?.folders, folder.id);
    rows.push(filterCheckRow({
      attr: 'data-filter-folder', value: folder.id, label: keyword ? folder.path : folder.name, title: folder.path,
      count, checked: included.has(folder.id), excluded: excluded.has(folder.id),
      leading: folderColorDot(node, 'filter-folder-dot'), depth: keyword ? 0 : folder.depth
    }));
  }
  if (rows.length >= FILTER_LIST_LIMIT) rows.push('<span class="filter-check-empty">结果较多，请输入关键字缩小范围</span>');
  setListHTML(list, filterListStatus(rows, { loading: '正在统计文件夹…', empty: keyword ? '没有匹配的文件夹' : '没有找到相关项目' }));
}

function renderExtFilterList() {
  const list = $('#extFilterList');
  if (!list) return;
  const counts = filterFacets.data?.exts || {};
  const included = new Set(state.query.ext || []);
  const excluded = new Set(state.query.extExclude || []);
  const keyword = ($('#extFilterSearch')?.value || '').trim().replace(/^\./, '').toLowerCase();
  const exts = [...new Set([...Object.keys(counts), ...included, ...excluded])]
    .filter(ext => !keyword || ext.includes(keyword))
    .sort((left, right) => (counts[right] || 0) - (counts[left] || 0) || left.localeCompare(right));
  const rows = exts.map(ext => filterCheckRow({
    attr: 'data-filter-ext', value: ext, label: ext.toUpperCase(),
    count: filterFacets.data ? counts[ext] || 0 : null, checked: included.has(ext), excluded: excluded.has(ext)
  }));
  setListHTML(list, filterListStatus(rows, { loading: '正在统计格式…', empty: keyword ? '没有匹配的格式' : '没有找到相关项目' }));
}

function renderDateFilters() {
  for (const box of document.querySelectorAll('[data-date-presets]')) {
    const chosen = new Set(state.query[`${box.dataset.datePresets}Presets`] || []);
    box.innerHTML = datePresetChoices.map(([value, label]) => `<button type="button" class="filter-preset${chosen.has(value) ? ' active' : ''}" data-date-preset="${value}" aria-pressed="${chosen.has(value)}">${label}</button>`).join('');
  }
  for (const list of document.querySelectorAll('[data-month-list]')) {
    const key = list.dataset.monthList;
    const counts = filterFacets.data?.[`${key}Months`] || {};
    const chosen = new Set(state.query[`${key}Months`] || []);
    const months = [...new Set([...Object.keys(counts), ...chosen])].sort().reverse();
    const rows = months.map(month => {
      const [year, number] = month.split('/');
      return filterCheckRow({ attr: 'data-filter-month', value: month, label: `${year} 年 ${Number(number)} 月`, count: filterFacets.data ? counts[month] || 0 : null, checked: chosen.has(month) });
    });
    setListHTML(list, filterListStatus(rows, { loading: '正在统计月份…', empty: '没有找到相关项目' }));
    // A chosen month stays in sight when the panel reopens.
    const details = list.closest('details');
    if (details && chosen.size) details.open = true;
  }
}

// Eagle's 形状 menu: the orientations, the common ratios and 自定, each with
// its count; a row the view has none of stays out unless it is ticked.
const SHAPE_FILTER_LABELS = [
  ['landscape', '横图'], ['portrait', '竖图'], ['square', '方形'], ['panoramic-landscape', '细长横图'], ['panoramic-portrait', '细长竖图'],
  ['4:3', '4:3'], ['3:4', '3:4'], ['16:9', '16:9'], ['9:16', '9:16'], ['custom', '自定']
];
function renderShapeFilterList() {
  const list = $('#shapeFilterList');
  if (!list) return;
  const counts = filterFacets.data?.shapes || null;
  const chosen = new Set(state.query.shape || []);
  const rows = SHAPE_FILTER_LABELS.filter(([shape]) => shape === 'custom' || chosen.has(shape) || !counts || counts[shape] > 0)
    .map(([shape, label]) => filterCheckRow({
      attr: 'data-filter-shape', value: shape, label,
      count: shape === 'custom' || !filterFacets.data ? null : counts?.[shape] || 0, checked: chosen.has(shape)
    }));
  setListHTML(list, rows.join(''));
  $('#shapeCustomFilter')?.classList.toggle('hidden', !chosen.has('custom'));
}

// Eagle's 评分 menu: five to one stars, then 尚未评分, each with its count.
function renderRatingFilterList() {
  const list = $('#ratingFilterList');
  if (!list) return;
  const counts = filterFacets.data?.ratings || null;
  const chosen = new Set(state.query.rating || []);
  const rows = [5, 4, 3, 2, 1, 0].filter(star => chosen.has(star) || !counts || counts[star] > 0)
    .map(star => filterCheckRow({
      attr: 'data-filter-rating', value: String(star), label: star ? `${star} 星` : '尚未评分',
      leading: star ? `<span class="filter-stars" aria-hidden="true">${'★'.repeat(star)}<span class="filter-stars-empty">${'★'.repeat(5 - star)}</span></span>` : '',
      count: filterFacets.data ? counts?.[star] || 0 : null, checked: chosen.has(star)
    }));
  setListHTML(list, filterListStatus(rows, { loading: '正在统计评分…', empty: '没有找到相关项目' }));
}

function renderFilterLists() {
  renderFilterLogic();
  const noTags = $('#noTagsFilter');
  if (noTags) noTags.checked = Boolean(state.query.noTags);
  renderFolderFilterList();
  renderExtFilterList();
  renderShapeFilterList();
  renderRatingFilterList();
  renderDateFilters();
  // 注释/链接: the keywords only narrow 有, as in Eagle's menus.
  for (const button of document.querySelectorAll('[data-text-state]')) {
    const [field, value] = button.dataset.textState.split(':');
    const active = (state.query[`${field}State`] || (String(state.query[field] || '').trim() ? 'has' : '')) === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  for (const field of ['annotation', 'url']) {
    const input = $(`#${field}Filter`);
    if (input) input.disabled = (state.query[`${field}State`] || (String(state.query[field] || '').trim() ? 'has' : '')) !== 'has';
  }
  for (const button of document.querySelectorAll('[data-comments-state]')) {
    const active = state.query.comments === button.dataset.commentsState;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  const commentsText = $('#commentsTextFilter');
  if (commentsText) commentsText.disabled = state.query.comments !== 'has';
  const unit = $('#durationUnitFilter');
  if (unit) unit.value = state.query.durationUnit || 's';
}

// One edit of the active pane's filters: apply, redraw the panel, re-query.
function updateActiveQuery(mutate) {
  const paneId = state.activePaneId;
  const pane = paneById(paneId);
  if (!pane) return;
  mutate(pane.query);
  renderTagEditor('filter');
  renderFilterLists();
  renderFilterState();
  schedulePaneFilterRefresh(paneId);
}

// Left-click ticks (and lifts an exclusion), right-click excludes (and lifts
// a tick), and the same click again clears, as in Eagle's filter menus.
function toggleIncludeExclude(query, includeKey, excludeKey, value, exclude) {
  const included = new Set(query[includeKey] || []);
  const excluded = new Set(query[excludeKey] || []);
  const [target, other] = exclude ? [excluded, included] : [included, excluded];
  if (target.has(value)) target.delete(value);
  else { target.add(value); other.delete(value); }
  query[includeKey] = [...included];
  query[excludeKey] = [...excluded];
}

function toggleListValue(query, key, value) {
  const values = new Set(query[key] || []);
  if (values.has(value)) values.delete(value);
  else values.add(value);
  query[key] = [...values];
}

// Range filters are stored as one {min, max} query key but edited through two
// inputs, so a binding names which end it drives and how the panel's unit maps
// to the stored one (MB to bytes, dates to timestamps).
const MEGABYTE = 1024 * 1024;
const scaledRange = factor => ({
  parse: value => (value === '' ? null : Number(value) * factor),
  toInput: value => (Number.isFinite(value) ? String(Math.round(value / factor * 100) / 100) : '')
});
// <input type="date"> speaks YYYY-MM-DD in local time; the end of the range is
// inclusive of its whole day.
const dateRange = end => ({
  parse: value => {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;
    return end ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() - 1 : date.getTime();
  },
  toInput: value => {
    if (!Number.isFinite(value)) return '';
    const date = new Date(value);
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
});

// The duration range is stored in seconds and shown in the chosen unit.
const durationUnitSeconds = Object.freeze({ s: 1, m: 60, h: 3600 });
const durationScale = () => durationUnitSeconds[state.query.durationUnit] || 1;
const durationRange = {
  parse: value => (value === '' ? null : Number(value) * durationScale()),
  toInput: value => (Number.isFinite(value) ? String(Math.round(value / durationScale() * 1000) / 1000) : '')
};

// Simple-value filter inputs bind declaratively; tags (chip editor) and
// color (swatch row) keep their bespoke widgets.
const filterInputBindings = [
  { key: 'search', selector: '#searchInput', event: 'input' },
  { key: 'searchScope', selector: '#searchScopeFilter', event: 'change' },
  { key: 'shapeWidth', selector: '#shapeWidthFilter', event: 'input', parse: value => (Number(value) > 0 ? Number(value) : null), toInput: value => (value ? String(value) : '') },
  { key: 'shapeHeight', selector: '#shapeHeightFilter', event: 'input', parse: value => (Number(value) > 0 ? Number(value) : null), toInput: value => (value ? String(value) : '') },
  { key: 'annotation', selector: '#annotationFilter', event: 'input' },
  { key: 'url', selector: '#urlFilter', event: 'input' },
  { key: 'size', part: 'min', selector: '#sizeMinFilter', event: 'input', ...scaledRange(MEGABYTE) },
  { key: 'size', part: 'max', selector: '#sizeMaxFilter', event: 'input', ...scaledRange(MEGABYTE) },
  { key: 'width', part: 'min', selector: '#widthMinFilter', event: 'input', ...scaledRange(1) },
  { key: 'width', part: 'max', selector: '#widthMaxFilter', event: 'input', ...scaledRange(1) },
  { key: 'height', part: 'min', selector: '#heightMinFilter', event: 'input', ...scaledRange(1) },
  { key: 'height', part: 'max', selector: '#heightMaxFilter', event: 'input', ...scaledRange(1) },
  { key: 'added', part: 'min', selector: '#addedFromFilter', event: 'change', ...dateRange(false) },
  { key: 'added', part: 'max', selector: '#addedToFilter', event: 'change', ...dateRange(true) },
  { key: 'modified', part: 'min', selector: '#modifiedFromFilter', event: 'change', ...dateRange(false) },
  { key: 'modified', part: 'max', selector: '#modifiedToFilter', event: 'change', ...dateRange(true) },
  { key: 'duration', part: 'min', selector: '#durationMinFilter', event: 'input', ...durationRange },
  { key: 'duration', part: 'max', selector: '#durationMaxFilter', event: 'input', ...durationRange },
  { key: 'commentsText', selector: '#commentsTextFilter', event: 'input' }
];

function filterBindingValue(query, binding) {
  return binding.part ? query[binding.key]?.[binding.part] ?? null : query[binding.key];
}

function renderQueryControls() {
  const query = state.query;
  for (const binding of filterInputBindings) {
    const input = $(binding.selector);
    if (!input) continue;
    const value = filterBindingValue(query, binding);
    input.value = binding.toInput ? binding.toInput(value) : String(value ?? '');
  }
  renderColorFilter();
  renderTagEditor('filter');
  ensureFilterFacets();
  renderFilterLists();
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

function tagChipHTML(tag, { removeAttr = 'data-remove-tag', removeLabel = `移除 ${tag}`, disabled = false, excluded = false } = {}) {
  const color = state.tagColors[tag];
  return `<span class="tag-chip${excluded ? ' excluded' : ''}"${excluded ? ' title="已排除：右键改回包含"' : ''}${color ? ` style="--tag-color:${escapeHTML(color)}"` : ''}><span title="${escapeHTML(tag)}">${escapeHTML(tag)}</span><button type="button" ${removeAttr}="${escapeHTML(tag)}" aria-label="${escapeHTML(removeLabel)}"${disabled ? ' disabled' : ''}>×</button></span>`;
}

function renderTagEditor(kind) {
  const config = tagEditors[kind];
  const chips = $(config.chips);
  if (!chips) return;
  chips.innerHTML = tagValues(kind).map(tag => tagChipHTML(tag)).join('')
    + (kind === 'filter' ? (state.query.tagsExclude || []).map(tag => tagChipHTML(tag, { removeAttr: 'data-remove-excluded-tag', removeLabel: `取消排除 ${tag}`, excluded: true })).join('') : '');
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

// The filter takes "-name" as an excluded tag, as Eagle's search does.
function addTagEntries(kind, entries) {
  const values = normalizeTags(entries);
  if (kind !== 'filter') {
    setTagValues(kind, [...tagValues(kind), ...values]);
    return;
  }
  const excluded = values.filter(value => value.length > 1 && value.startsWith('-')).map(value => value.slice(1).trim()).filter(Boolean);
  const included = values.filter(value => !(value.length > 1 && value.startsWith('-')));
  updateActiveQuery(query => {
    query.tags = normalizeTags([...(query.tags || []).filter(tag => !excluded.includes(tag)), ...included]);
    query.tagsExclude = normalizeTags([...(query.tagsExclude || []).filter(tag => !included.includes(tag)), ...excluded]);
  });
}

function commitTagInput(kind) {
  const input = $(tagEditors[kind].input);
  const pending = normalizeTags(input.value.split(/[,，\n]+/));
  if (!pending.length) return false;
  addTagEntries(kind, pending);
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
  const needle = (input?.value.trim().toLocaleLowerCase() || '').replace(kind === 'filter' ? /^-/ : /^$/, '');
  const selected = new Set([...tagValues(kind), ...(kind === 'filter' ? state.query.tagsExclude || [] : [])]);
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
  addTagEntries(kind, [kind === 'filter' && input.value.trim().startsWith('-') ? `-${name}` : name]);
  input.value = '';
  renderTagSuggestionPopover(kind, { open: true });
  input.focus();
  if (kind === 'batch') applyBatchTags();
}

function renderTagSuggestions() {
  $('#tagSuggestions').innerHTML = state.availableTags.slice(0, 1000).map(tag => `<option value="${escapeHTML(tag.name || tag)}"></option>`).join('');
  for (const kind of Object.keys(tagEditors)) {
    const input = $(tagEditors[kind].input);
    if (input?.matches(':focus')) renderTagSuggestionPopover(kind, { open: true });
  }
}

const TAG_COLOR_MANAGER_LIMIT = 200;
// An uncolored tag shows a hollow swatch; its picker starts on neutral gray
// so that the app's blue accent stays a colour that can be chosen (B1-07).
// Tag colours are picked from Eagle's tag group palette (BUG-02): 无 plus
// the eight named colours. A colour set earlier as free hex stays offered.
const tagPaletteColors = Object.freeze(['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'pink']);
let tagColorManagerOpen = null;

function tagColorPaletteMarkup(tag, current) {
  const value = String(current || '').toLowerCase();
  const swatch = (color, label) => {
    const checked = value === color;
    return `<button type="button" class="context-color-swatch${color ? '' : ' none'}${checked ? ' checked' : ''}" role="radio" aria-checked="${checked}" title="${escapeHTML(label)}" aria-label="颜色：${escapeHTML(label)}"${color ? ` style="--swatch:${escapeHTML(color)}"` : ''} data-tag-palette-color="${escapeHTML(color)}" data-tag="${escapeHTML(tag)}"></button>`;
  };
  const named = tagPaletteColors.map(name => [eagleNamedFolderColors[name], eagleColorLabels[name]]);
  const custom = value && !named.some(([hex]) => hex === value) ? [[value, `当前颜色 ${value}`]] : [];
  return `<div class="tag-color-palette" role="radiogroup" aria-label="标签“${escapeHTML(tag)}”的颜色">${[['', '无'], ...named, ...custom].map(([color, label]) => swatch(color, label)).join('')}</div>`;
}
function renderTagColors() {
  const manager = $('#tagColorManager');
  if (!manager) return;
  const previous = manager.querySelector('[data-tag-color-search]');
  const search = previous?.value || '';
  const searchFocused = previous && document.activeElement === previous;
  const needle = search.trim().toLocaleLowerCase();
  const names = state.availableTags.map(tag => tag.name || tag);
  const matches = needle ? names.filter(name => name.toLocaleLowerCase().includes(needle)) : names;
  const rows = matches.slice(0, TAG_COLOR_MANAGER_LIMIT).map(name => {
    const color = state.tagColors[name] || '';
    const open = tagColorManagerOpen === name;
    const swatch = color ? `<span class="tag-color-swatch" style="--tag-color:${escapeHTML(color)}"></span>` : '<span class="tag-color-swatch unset" title="未设置颜色"></span>';
    const clear = color ? `<button type="button" class="tag-color-clear" data-tag-color-clear="${escapeHTML(name)}" title="清除颜色" aria-label="清除${escapeHTML(name)}的颜色">×</button>` : '';
    // The whole row opens the palette under it; × stays a one-click clear.
    const row = `<div class="tag-color-row${open ? ' open' : ''}"><button type="button" class="tag-color-open" data-tag-color-open="${escapeHTML(name)}" aria-expanded="${open}" title="设置颜色" aria-label="设置${escapeHTML(name)}的颜色">${swatch}<span title="${escapeHTML(name)}">${escapeHTML(name)}</span></button>${clear}</div>`;
    return open ? `${row}${tagColorPaletteMarkup(name, color)}` : row;
  }).join('');
  const more = matches.length > TAG_COLOR_MANAGER_LIMIT ? `<small class="muted tag-color-more">还有 ${matches.length - TAG_COLOR_MANAGER_LIMIT} 个标签，请输入名称搜索</small>` : '';
  const empty = !names.length ? '<small class="muted">当前资源库还没有标签</small>' : !matches.length ? '<small class="muted">没有找到相关标签</small>' : '';
  const searchHTML = names.length ? `<input type="search" class="tag-color-search" data-tag-color-search placeholder="搜索标签" aria-label="搜索标签" autocomplete="off" value="${escapeHTML(search)}">` : '';
  manager.innerHTML = `${searchHTML}<div class="tag-color-list">${rows}${more}${empty}</div>`;
  if (searchFocused) {
    const input = manager.querySelector('[data-tag-color-search]');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function currentViewSmartFolderConditions() {
  const currentSmartFolder = state.currentView.kind === 'smart'
    ? findFolder(state.library?.smartFolders, state.currentView.id)
    : null;
  return buildSmartFolderConditions(state.currentView, state.query, currentSmartFolder?.conditions || [], {
    folderScope: paneItemQuery(activePane()).folderIds || null
  });
}

async function saveCurrentViewAsSmartFolder() {
  const libraryPath = state.library?.path;
  const converted = currentViewSmartFolderConditions();
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
  const converted = currentViewSmartFolderConditions();
  // "New" with no filter set is not "save this view": at the root that saved
  // 未分类, in a folder just that folder. Ask for conditions instead (B1-03).
  const nothingChosen = !queryFiltersActive(state.query);
  if (!converted.unsupported && !nothingChosen) return saveCurrentViewAsSmartFolder();
  if (nothingChosen || converted.unsupported === '当前视图没有可保存的筛选条件') {
    // Opened after the menu click has finished bubbling: the document
    // outside-click handler closed it again within the same click (B1-03).
    setTimeout(() => {
      $('#filterPopover').classList.remove('hidden');
      ensureFilterFacets();
      renderFilterLists();
      renderFilterState();
      $('#searchInput').focus();
    }, 0);
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

// An empty colour clears the tag's colour.
async function updateTagColor(tag, color) {
  if (!tag) return;
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
    toast('颜色需为六位十六进制，例如 #0072ef', 3200);
    return;
  }
  const libraryPath = state.library?.path;
  try {
    await runForegroundOperation('正在保存标签颜色…', { key: `tag-color:${libraryPath}:${tag}` }, async () => {
      state.tagColors = await window.eagleMV.setTagColor({ libraryPath, tag, color: color || null });
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
  state.query = createQuery();
  state.filterLock = false;
  renderQueryControls();
  refresh({ reset: true, preserveScroll: false, paneId: state.activePaneId });
}

function libraryDisplayName(libraryPath) {
  return String(libraryPath || '').split('/').filter(Boolean).pop()?.replace(/\.library$/i, '') || '资源库';
}

function renderLibraryList(entries) {
  const box = $('#libraryList');
  const known = [...entries];
  // Eagle's history may omit the currently open library; keep it visible.
  if (state.library?.path && !known.some(entry => entry.path === state.library.path)) {
    known.unshift({ path: state.library.path, name: state.library.name || libraryDisplayName(state.library.path), exists: true });
  }
  if (!known.length) {
    box.innerHTML = '<span class="muted">Eagle 没有返回资源库历史</span>';
    return;
  }
  box.innerHTML = known.map(entry => {
    const current = state.library?.path === entry.path;
    return `<button type="button" class="library-row${current ? ' current' : ''}" data-library-path="${escapeHTML(entry.path)}" data-library-name="${escapeHTML(entry.name)}" title="${escapeHTML(entry.path)}"${entry.exists ? '' : ' disabled'}>
      <span class="library-row-name">${escapeHTML(entry.name)}${entry.exists ? '' : '（找不到文件）'}</span>
      <span class="library-row-path">&lrm;${escapeHTML(entry.path)}&lrm;</span>
      ${current ? '<span class="library-row-check" aria-label="当前资源库">✓</span>' : ''}
    </button>`;
  }).join('');
}

async function openLibraryPopover() {
  const popover = $('#libraryPopover');
  const anchor = $('#libraryButton').getBoundingClientRect();
  popover.style.top = `${Math.round(anchor.bottom + 6)}px`;
  popover.style.left = `${Math.round(Math.max(10, anchor.left))}px`;
  popover.classList.remove('hidden');
  $('#libraryButton').setAttribute('aria-expanded', 'true');
  $('#libraryList').innerHTML = '<span class="muted">正在读取资源库列表…</span>';
  try {
    renderLibraryList(await window.eagleMV.getLibraryHistory());
  } catch (error) {
    $('#libraryList').innerHTML = `<span class="muted">读取失败：${escapeHTML(error.message)}</span>`;
  }
}

// The Android shell has no menu bar and normally never shows its host
// screen, so its update check and host switch live in this popover.
function renderShellAppSection() {
  const shellApp = window.eagleMV.shellApp;
  $('#shellAppSection').classList.toggle('hidden', !shellApp);
  if (shellApp) $('#shellAppTitle').textContent = `Eagle MultiView App${shellApp.version ? ` ${shellApp.version}` : ''}`;
}

function runShellAppAction(action) {
  const shellApp = window.eagleMV.shellApp;
  closeLibraryPopover();
  if (!shellApp) return;
  if (action === 'check-for-updates') shellApp.checkForUpdates();
  else if (action === 'change-host' && confirmDiscardChanges()) shellApp.changeHost();
}

function closeLibraryPopover() {
  $('#libraryPopover').classList.add('hidden');
  $('#libraryButton').setAttribute('aria-expanded', 'false');
}

async function switchToLibrary(libraryPath, name) {
  closeLibraryPopover();
  if (state.library?.path === libraryPath) {
    toast('已经是当前资源库', 2200);
    return;
  }
  if (!state.connected) {
    toast('Eagle 未连接，暂时无法切换资源库', 3200);
    return;
  }
  if (!confirmDiscardChanges()) return;
  try {
    // Success feedback arrives through the library-changed broadcast
    // ("Eagle 已切换资源库，所有窗口已跟随"), same as an Eagle-side switch.
    await runForegroundOperation(`正在切换到“${name}”…`, { key: 'library-switch' }, async () => {
      await window.eagleMV.switchLibrary({ libraryPath });
    });
  } catch (error) {
    toast(`切换资源库失败：${error.message}`, 4600);
  }
}

// Only the web client turns narrow side panels into overlay drawers. Desktop
// windows keep their columns even when UI zoom shrinks the CSS viewport.
const compactLayoutQuery = window.matchMedia('(max-width: 900px)');
const isCompactLayout = () => isWebClient && compactLayoutQuery.matches;
const isTouchEvent = event => event.pointerType === 'touch' ||
  (event.pointerType === undefined && window.matchMedia('(pointer: coarse)').matches);
// Android reports an active stylus as `pen`, even though it is used as the
// touch-like pointer on the preview surface. Keep swipe navigation and the
// swipe-down close gesture available when the close button is hidden on coarse
// web clients.
const isPreviewTouchPointer = event => event.pointerType === 'touch' ||
  event.pointerType === 'pen' ||
  // Some Android WebViews expose an active stylus as a mouse pointer. On a
  // coarse web client there is no desktop mouse fallback to preserve, so keep
  // the swipe gesture working for that reporting variant too.
  (event.pointerType === 'mouse' && window.matchMedia('(pointer: coarse)').matches);

// Thumbnail size has three drivers (slider, two-finger pinch, restore on
// launch) that must agree; they all go through here.
const gestures = window.EagleMVGridGestures;
// Read from the variable in effect, not the slider: compact layouts set a
// smaller base size in CSS, and a pinch has to start from what is on screen.
function currentThumbnailSize() {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thumb'));
  return Number.isFinite(value) && value > 0 ? value : gestures.THUMB_DEFAULT;
}
function applyThumbnailSize(size, { persist = true } = {}) {
  const clamped = gestures.clampThumbnailSize(size);
  document.documentElement.style.setProperty('--thumb', `${clamped}px`);
  scheduleWaterfallRelayout();
  const slider = $('#sizeSlider');
  if (slider) slider.value = String(clamped);
  if (persist) { try { localStorage.setItem('eaglemv.thumbnailSize', String(clamped)); } catch {} }
  return clamped;
}

function renderPanels() {
  const compact = isCompactLayout();
  document.body.classList.toggle('compact-layout', compact);
  document.body.classList.toggle('drawer-sidebar', compact && state.openDrawer === 'sidebar');
  document.body.classList.toggle('drawer-inspector', compact && state.openDrawer === 'inspector');
  document.body.classList.toggle('sidebar-hidden', !compact && !state.sidebarVisible);
  document.body.classList.toggle('inspector-hidden', !compact && !state.inspectorVisible);
  $('#toggleSidebarButton').classList.toggle('active', compact ? state.openDrawer === 'sidebar' : state.sidebarVisible);
  $('#toggleInspectorButton').classList.toggle('active', compact ? state.openDrawer === 'inspector' : state.inspectorVisible);
  // The full placeholder is cut off in a phone-width search box.
  $('#searchInput').placeholder = compact ? '搜索…' : '搜索名称、标签、备注、正向提示词…';
  // Rotating into or out of compact mode changes whether the selection strip
  // belongs on screen at all.
  renderSelectionBar();
  // Hiding/showing a panel resizes the content column and can unwrap the
  // toolbar; keep the centered-button-group wrap state in sync.
  updateToolbarWrapState();
}

function closeDrawers() {
  if (!state.openDrawer) return;
  state.openDrawer = null;
  renderPanels();
}

function togglePanel(panel) {
  if (isCompactLayout()) {
    state.openDrawer = state.openDrawer === panel ? null : panel;
  } else if (panel === 'sidebar') {
    state.sidebarVisible = !state.sidebarVisible;
  } else if (panel === 'inspector') {
    state.inspectorVisible = !state.inspectorVisible;
  }
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

function selectAllItems() {
  if (!confirmDiscardChanges()) return false;
  state.selectedFolderCard = null;
  state.selected = new Set(state.items.map(item => item.id));
  updateCardSelectionStyles();
  renderInspector();
  const pane = activePane();
  if (pane?.hasMore) selectRestOfView(pane).catch(error => toast(`全选失败：${error.message}`, 4000));
  return true;
}

// The query hub:view-ids lists the whole of a pane's view with.
function paneViewIdsQuery(pane) {
  const query = paneItemQuery(pane);
  return pane.currentView.kind === 'trash' ? { ...query, trash: true, libraryPath: state.library?.path } : query;
}

// Selected ids the grid has not loaded (⌘A over a big view, P6-02).
function unloadedSelection(pane = activePane()) {
  const ids = [];
  for (const id of pane?.selected || []) if (!pane.itemMap?.has(id)) ids.push(id);
  return ids;
}

// Drops unloaded selected ids that left the view (moved, deleted, filtered
// out), once the view's full id list is back. Calls for the same pane
// coalesce; a selection changed meanwhile is left alone.
const selectionReconciles = new Map();
function reconcileSelectionWithView(pane) {
  if (selectionReconciles.has(pane.id)) return selectionReconciles.get(pane.id);
  const viewKey = descriptorKey(pane.currentView);
  const job = (async () => {
    await Promise.resolve();
    const before = new Set(pane.selected);
    const ids = await window.eagleMV.viewIds?.(paneViewIdsQuery(pane)).catch(() => null);
    if (!ids || paneById(pane.id) !== pane || descriptorKey(pane.currentView) !== viewKey || !sameSelection(pane, before)) return;
    const inView = new Set(ids);
    const next = new Set([...pane.selected].filter(id => inView.has(id) || pane.itemMap?.has(id)));
    if (next.size === pane.selected.size) return;
    pane.selected = next;
    if (state.activePaneId === pane.id) {
      updateCardSelectionStyles();
      renderInspector();
    }
  })().finally(() => selectionReconciles.delete(pane.id));
  selectionReconciles.set(pane.id, job);
  return job;
}

// Eagle's ⌘A takes the whole view, but only 160 items are loaded at first,
// so a batch after ⌘A quietly touched a fraction of a big folder (P6-02).
// The grid is not virtualised: it loads as far as the locate feature does
// (SORT_FETCH_CAP), and the rest of the view joins the selection by id, so
// batch operations reach every item while the grid stays light.
async function selectRestOfView(pane) {
  const paneId = pane.id;
  const viewKey = descriptorKey(pane.currentView);
  const chosen = new Set(pane.selected);
  if (pane.items.length < SORT_FETCH_CAP) {
    toast('正在载入当前视图的全部素材以便全选…', 2400);
    await refresh({ paneId, reset: true, preserveScroll: true, minimumCount: SORT_FETCH_CAP });
    // Picked something else, or left the view, while it loaded: leave it be.
    if (paneById(paneId) !== pane || descriptorKey(pane.currentView) !== viewKey
      || !sameSelection(pane, new Set([...chosen].filter(id => pane.itemMap.has(id))))) return;
    pane.selected = new Set(pane.items.map(item => item.id));
    if (state.activePaneId === paneId) {
      updateCardSelectionStyles();
      renderInspector();
    }
  }
  if (pane.hasMore) {
    const loaded = new Set(pane.selected);
    const ids = window.eagleMV.viewIds ? await window.eagleMV.viewIds(paneViewIdsQuery(pane)) : null;
    if (paneById(paneId) !== pane || descriptorKey(pane.currentView) !== viewKey || !sameSelection(pane, loaded)) return;
    if (!ids) {
      toast(`已全选前 ${pane.selected.size.toLocaleString()} 个素材（当前视图共 ${Number(pane.total || 0).toLocaleString()} 个），超出部分请分批操作`, 5200);
      return;
    }
    pane.selected = new Set([...loaded, ...ids]);
    if (state.activePaneId === paneId) {
      updateCardSelectionStyles();
      renderInspector();
    }
    toast(`已全选 ${pane.selected.size.toLocaleString()} 个素材`, 2000);
  } else if (pane.selected.size > chosen.size) {
    toast(`已全选 ${pane.selected.size.toLocaleString()} 个素材`, 2000);
  }
}

function clearSelection() {
  if (!confirmDiscardChanges()) return false;
  state.selected.clear();
  state.selectedFolderCard = null;
  updateCardSelectionStyles();
  renderInspector();
  if (isCompactLayout()) closeDrawers();
  return true;
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
  const focusedCard = document.activeElement?.closest?.('#itemGrid .folder-card, #itemGrid .item-card');
  const focusedId = focusedCard?.dataset.id;
  if (focusedCard && root?.contains(focusedCard) && state.selected.size > 1 && focusedId && state.selected.has(focusedId)) {
    return focusedCard;
  }
  const selectedFolder = state.selectedFolderCard && root?.querySelector(`.folder-card[data-open-folder="${CSS.escape(state.selectedFolderCard)}"]`);
  const selectedItemId = state.selected.size === 1 ? [...state.selected][0] : null;
  const selectedItem = selectedItemId && root?.querySelector(`.item-card[data-id="${CSS.escape(selectedItemId)}"]`);
  return selectedFolder || selectedItem || null;
}

function directionalCard(cards, current, key) {
  if (!current) return null;
  const origin = current.getBoundingClientRect();
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  return cards.filter(card => card !== current).map(card => {
    const box = card.getBoundingClientRect();
    const primary = horizontal ? box.left - origin.left : box.top - origin.top;
    const secondary = horizontal ? Math.abs(box.top - origin.top) : Math.abs(box.left - origin.left);
    return { card, primary, secondary };
  }).filter(candidate => Math.sign(candidate.primary) === direction)
    .sort((a, b) => (Math.abs(a.primary) + a.secondary * 2) - (Math.abs(b.primary) + b.secondary * 2))[0]?.card || null;
}

function stepSelectionByKey(direction) {
  if (!state.selected.size || !confirmDiscardChanges()) return false;
  const { selected, edgeId } = stepSelection(sortedItems(), state.selected, state.selectionAnchor, direction);
  state.selectedFolderCard = null;
  state.selected = selected;
  updateCardSelectionStyles();
  renderInspector();
  if (edgeId) requestAnimationFrame(() => {
    const card = paneRoot()?.querySelector(`.item-card[data-id="${CSS.escape(edgeId)}"]`);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  return true;
}

function moveCardFocus(key) {
  const cards = [...(paneRoot()?.querySelectorAll('#itemGrid .folder-card, #itemGrid .item-card') || [])];
  if (!cards.length) return;
  const current = focusSelectedCard();
  let next = current || ((key === 'ArrowLeft' || key === 'ArrowUp') ? cards.at(-1) : cards[0]);
  if (current) next = directionalCard(cards, current, key) || current;
  if (next.classList.contains('folder-card')) selectFolderCard(next.dataset.openFolder);
  else selectItem(next.dataset.id);
  requestAnimationFrame(() => {
    const target = focusSelectedCard();
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function folderCoverURL(folderId) {
  return mediaURL('folder', folderId) + `?cover=${state.localFolderCovers.covers[folderId]?.revision || 0}&thumb=${thumbnailRevision}`;
}

function hasFolderCover(folder) {
  return !folder.password && (state.localFolderCovers.covers[folder.id]?.itemId || folder.coverId || folder.covers?.length);
}

function acceptFolderCovers(payload) {
  if (payload?.libraryPath !== state.library?.path || payload.revision < state.localFolderCovers.revision) return;
  state.localFolderCovers = { revision: payload.revision, covers: payload.covers || {} };
  state.folderCoversReady = true;
  // Replace only cover images; selection, scroll, drag state and focus stay put.
  for (const card of document.querySelectorAll('.folder-card[data-open-folder]')) {
    const folder = findFolder(state.library?.folders, card.dataset.openFolder);
    const container = card.querySelector('.folder-cover');
    if (!folder || !container) continue;
    const url = folderCoverURL(folder.id);
    if (hasFolderCover(folder)) {
      if (container.querySelector('img')?.getAttribute('src') === url) continue;
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
      img.src = url;
      container.replaceChildren(img);
    } else container.replaceChildren();
  }
}

async function setFolderCover(folderId, itemId, data) {
  const libraryPath = data.libraryPath;
  if (!state.folderCoversReady || libraryPath !== state.library?.path) return;
  const operationToken = beginForegroundOperation('正在保存文件夹封面…', { key: `folder-cover:${libraryPath}:${folderId}` });
  if (!operationToken) return;
  try {
    const result = await window.eagleMV.setFolderCover({ libraryPath, folderId, itemId,
      syncToEagle: true, eagleCoverId: data.eagleCoverIds?.[folderId] || null,
      revision: data.coverRevisions?.[folderId]?.revision || 0 });
    acceptFolderCovers({ libraryPath, ...result });
    if (state.library?.path !== libraryPath) return;
    toast(result.conflict ? '此封面已在其他窗口修改，请重新选择后再试'
      : itemId ? '已设为文件夹封面，并同步到 Eagle' : '已恢复默认封面，并同步到 Eagle');
  } catch (error) {
    toast(`封面设置失败：${error.message}`, 4000);
  } finally { endForegroundOperation(operationToken); }
}

function restoreFolderCoverMenu(folderId) {
  if (!window.eagleMV.setFolderCover || !(state.localFolderCovers.covers[folderId]?.itemId || findFolder(state.library?.folders, folderId)?.coverId)) return '';
  return contextMenuRow({ icon: 'refresh', label: '恢复 Eagle 默认封面', action: 'reset-folder-cover',
    payload: { folderId }, disabled: !state.connected || !state.folderCoversReady });
}

function folderCardMarkup(folder) {
  const childCount = (folder.children || []).length;
  const directCount = Number(folder.imageCount) || 0;
  return `<article class="folder-card ${state.selectedFolderCard === folder.id ? 'selected' : ''}" data-open-folder="${escapeHTML(folder.id)}" data-folder-node-id="${escapeHTML(folder.id)}" draggable="true" tabindex="0">
    <div class="folder-thumbnail">
      <span class="folder-sheet folder-sheet-back" aria-hidden="true"></span>
      <span class="folder-sheet folder-sheet-middle" aria-hidden="true"></span>
      <div class="folder-cover">
        ${hasFolderCover(folder) ? `<img loading="lazy" src="${folderCoverURL(folder.id)}" alt="">` : ''}
      </div>
    </div>
    <div class="folder-name" title="${escapeHTML(folder.name)}">${folderColorDot(folder, 'inline')}${escapeHTML(folder.name)}${folderLockBadge(folder)}</div>
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

// 标签管理, after Eagle's: a sidebar of 全部 / 未分类 / 常用标签 / 标签群组,
// and the tags of the chosen one as chips in sections — by initial (pinyin
// for Chinese) or by group — sorted by name or count. Sort and grouping are
// remembered for every pane, as Eagle keeps them; the open section, search
// and selection belong to each pane.
const TAG_MANAGER_PREFS_KEY = 'eaglemv.tagManager.v1';
function readTagManagerPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(TAG_MANAGER_PREFS_KEY) || '{}');
    return {
      sortBy: stored.sortBy === 'count' ? 'count' : 'name',
      ascending: stored.ascending !== false,
      groupBy: stored.groupBy === 'group' ? 'group' : 'alphabet',
      // Eagle's 格状 / 列表 switch (TAGVIEW_LAYOUT), one for every pane.
      layout: stored.layout === 'list' ? 'list' : 'inline'
    };
  } catch {
    return { sortBy: 'name', ascending: true, groupBy: 'alphabet', layout: 'inline' };
  }
}
let tagManagerPrefs = readTagManagerPrefs();
function setTagManagerPrefs(patch) {
  tagManagerPrefs = { ...tagManagerPrefs, ...patch };
  try { localStorage.setItem(TAG_MANAGER_PREFS_KEY, JSON.stringify(tagManagerPrefs)); } catch {}
  renderTagManagerPanes();
}
function renderTagManagerPanes() {
  for (const pane of state.panes) {
    if (pane.currentView.kind === 'tags') withActivePane(pane.id, () => renderGrid({ preserveScroll: true }));
  }
}

const tagManagerViews = new Map();
function tagManagerView(paneId = state.activePaneId) {
  if (!tagManagerViews.has(paneId)) tagManagerViews.set(paneId, { mode: 'all', groupId: null, keyword: '', selected: new Set(), anchor: null });
  const view = tagManagerViews.get(paneId);
  if (view.mode === 'group' && !(state.tagGroups || []).some(group => group.id === view.groupId)) Object.assign(view, { mode: 'all', groupId: null });
  return view;
}

// Initials by pinyin: ICU's zh pinyin collation orders every hanzi after
// the first character of its initial's block.
const pinyinCollator = new Intl.Collator('zh-CN-u-co-pinyin');
const PINYIN_INITIALS = [['A', '阿'], ['B', '八'], ['C', '嚓'], ['D', '哒'], ['E', '妸'], ['F', '发'], ['G', '旮'], ['H', '哈'], ['J', '讥'], ['K', '咔'], ['L', '垃'], ['M', '妈'], ['N', '拏'], ['O', '噢'], ['P', '妑'], ['Q', '七'], ['R', '呥'], ['S', '仨'], ['T', '他'], ['W', '屲'], ['X', '夕'], ['Y', '丫'], ['Z', '帀']];
const OTHER_INITIAL = '＃';
function tagInitial(name) {
  const first = String(name || '').trim().charAt(0);
  if (/[a-z]/i.test(first)) return first.toUpperCase();
  if (!/[㐀-鿿豈-﫿]/.test(first)) return OTHER_INITIAL;
  let letter = OTHER_INITIAL;
  for (const [initial, boundary] of PINYIN_INITIALS) {
    if (pinyinCollator.compare(first, boundary) < 0) break;
    letter = initial;
  }
  return letter;
}

const tagNameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
function sortTagRecords(records) {
  const byName = (left, right) => tagNameCollator.compare(left.name, right.name);
  const sorted = [...records].sort(tagManagerPrefs.sortBy === 'count'
    ? (left, right) => (right.count - left.count) || byName(left, right)
    : byName);
  return tagManagerPrefs.ascending ? sorted : sorted.reverse();
}

function tagGroupsOf(name) {
  return (state.tagGroups || []).filter(group => (group.tags || []).includes(name));
}

function tagManagerRecords() {
  const seen = new Map();
  for (const tag of state.availableTags || []) {
    const name = tagName(tag);
    if (name && !seen.has(name)) seen.set(name, { name, count: Number(tag?.imageCount || 0) });
  }
  return seen;
}

// The sections of the open sidebar entry: [{ key, title, tags: [record] }].
function tagManagerSections(view) {
  const records = tagManagerRecords();
  const record = name => records.get(name) || { name, count: 0 };
  const grouped = new Set((state.tagGroups || []).flatMap(group => group.tags || []));
  const keyword = view.keyword.trim().toLocaleLowerCase('zh-CN');
  const matches = entry => !keyword || entry.name.toLocaleLowerCase('zh-CN').includes(keyword);
  if (view.mode === 'group') {
    const group = (state.tagGroups || []).find(candidate => candidate.id === view.groupId);
    return [{ key: group.id, title: group.name || '未命名群组', group, tags: sortTagRecords((group.tags || []).map(record).filter(matches)), always: true }];
  }
  if (view.mode === 'starred') {
    return [{ key: 'starred', title: '常用标签', tags: sortTagRecords((state.starredTags || []).map(record).filter(matches)), always: true }];
  }
  const pool = [...records.values()].filter(entry => (view.mode === 'unfiled' ? !grouped.has(entry.name) : true)).filter(matches);
  if (tagManagerPrefs.groupBy === 'group') {
    const sections = (state.tagGroups || []).map(group => ({
      key: group.id, title: group.name || '未命名群组', group,
      tags: sortTagRecords(pool.filter(entry => (group.tags || []).includes(entry.name)))
    }));
    sections.push({ key: 'ungrouped', title: '未分类', tags: sortTagRecords(pool.filter(entry => !grouped.has(entry.name))) });
    return sections.filter(section => section.tags.length);
  }
  const byInitial = new Map();
  for (const entry of pool) {
    const initial = tagInitial(entry.name);
    if (!byInitial.has(initial)) byInitial.set(initial, []);
    byInitial.get(initial).push(entry);
  }
  return [...byInitial.entries()]
    .sort(([left], [right]) => (left === OTHER_INITIAL) - (right === OTHER_INITIAL) || left.localeCompare(right))
    .map(([initial, tags]) => ({ key: initial, title: initial, tags: sortTagRecords(tags) }));
}

function highlightedTagName(name, keyword) {
  const needle = keyword.trim();
  if (!needle) return escapeHTML(name);
  const at = name.toLocaleLowerCase('zh-CN').indexOf(needle.toLocaleLowerCase('zh-CN'));
  if (at < 0) return escapeHTML(name);
  return `${escapeHTML(name.slice(0, at))}<mark>${escapeHTML(name.slice(at, at + needle.length))}</mark>${escapeHTML(name.slice(at + needle.length))}`;
}

function tagManagerChipMarkup(entry, view) {
  const group = tagGroupsOf(entry.name)[0];
  const color = state.tagColors[entry.name] || (group?.color ? eagleNamedFolderColors[group.color] : '');
  return `<button type="button" class="tm-tag${view.selected.has(entry.name) ? ' selected' : ''}" data-tm-tag="${escapeHTML(entry.name)}" draggable="true" title="${escapeHTML(entry.name)}"${color ? ` style="--tag-color:${escapeHTML(color)}"` : ''}>
    <span class="tm-dot" aria-hidden="true"></span><span class="tm-name">${highlightedTagName(entry.name, view.keyword)}</span><span class="tm-count">(${entry.count.toLocaleString()})</span>
  </button>`;
}

function tagManagerBodyMarkup(view) {
  const sections = tagManagerSections(view);
  const total = sections.reduce((sum, section) => sum + section.tags.length, 0);
  if (!total && !sections.some(section => section.always)) {
    const message = view.keyword.trim() ? '没有找到相关标签'
      : view.mode === 'unfiled' && tagManagerRecords().size ? '所有标签都已归入群组' : '当前资源库还没有标签';
    return `<div class="tag-manager-empty">${message}</div>`;
  }
  return sections.map(section => {
    const description = section.group && view.mode === 'group'
      ? `<textarea class="tm-description" data-tm-description="${escapeHTML(section.group.id)}" rows="1" placeholder="添加描述..." aria-label="群组描述">${escapeHTML(section.group.description || '')}</textarea>`
      : '';
    const chips = section.tags.map(entry => tagManagerChipMarkup(entry, view)).join('')
      || `<span class="tm-section-empty">${view.keyword.trim() ? '没有匹配的标签' : view.mode === 'starred' ? '还没有常用标签（在 Eagle 中设置）' : '群组中还没有标签，可把标签拖到左侧群组'}</span>`;
    return `<section class="tm-section" data-tm-section="${escapeHTML(section.key)}">
      <h2 class="tm-section-title"><span>${escapeHTML(section.title)}</span><span class="tm-section-count">(${section.tags.length.toLocaleString()})</span></h2>
      ${description}
      <div class="tm-chips">${chips}</div>
    </section>`;
  }).join('');
}

function tagManagerNavRow({ mode, groupId = '', label, count, icon = 'tag', color = '' }, view) {
  const active = view.mode === mode && (mode !== 'group' || view.groupId === groupId);
  return `<button type="button" class="tm-nav${active ? ' active' : ''}" data-tm-mode="${mode}"${groupId ? ` data-tm-group="${escapeHTML(groupId)}" draggable="true"` : ''} title="${escapeHTML(label)}">
    ${color ? `<span class="tm-group-dot" style="background:${escapeHTML(color)}" aria-hidden="true"></span>` : uiIcon(icon, 'tm-nav-icon')}<span class="tm-nav-name">${escapeHTML(label)}</span><span class="tm-nav-count">${count || mode === 'group' ? count.toLocaleString() : ''}</span>
  </button>`;
}

function tagManagerTitle(view) {
  if (view.mode === 'group') return (state.tagGroups || []).find(group => group.id === view.groupId)?.name || '标签群组';
  return { all: '全部标签', unfiled: '未分类', starred: '常用标签' }[view.mode];
}

function tagManagerMarkup(paneId = state.activePaneId) {
  const view = tagManagerView(paneId);
  const records = tagManagerRecords();
  const grouped = new Set((state.tagGroups || []).flatMap(group => group.tags || []));
  const unfiled = [...records.keys()].filter(name => !grouped.has(name)).length;
  const groups = state.tagGroups || [];
  const sortLabel = `${tagManagerPrefs.sortBy === 'count' ? '数量' : '名称'}${tagManagerPrefs.ascending ? (tagManagerPrefs.sortBy === 'count' ? '↓' : '↑') : (tagManagerPrefs.sortBy === 'count' ? '↑' : '↓')}`;
  const layoutButton = (layout, label) => `<button type="button" class="tm-layout-button${tagManagerPrefs.layout === layout ? ' active' : ''}" data-tm-layout="${layout}" title="${label}" aria-label="${label}" aria-pressed="${tagManagerPrefs.layout === layout}">${uiIcon(layout === 'list' ? 'layoutList' : 'layoutGrid', 'tm-layout-icon')}</button>`;
  return `<div class="tag-manager${tagManagerPrefs.layout === 'list' ? ' list-mode' : ''}" data-tag-manager>
    <nav class="tm-sidebar" aria-label="标签分类">
      ${tagManagerNavRow({ mode: 'all', label: '全部', count: records.size, icon: 'tag' }, view)}
      ${tagManagerNavRow({ mode: 'unfiled', label: '未分类', count: unfiled, icon: 'unfiled' }, view)}
      ${tagManagerNavRow({ mode: 'starred', label: '常用标签', count: (state.starredTags || []).length, icon: 'star' }, view)}
      <div class="tm-groups-label"><span>标签群组${groups.length ? ` (${groups.length})` : ''}</span><button type="button" class="tm-add-group" data-tag-action="create-group" title="添加群组" aria-label="添加群组">+</button></div>
      <div class="tm-groups">${groups.map(group => tagManagerNavRow({ mode: 'group', groupId: group.id, label: group.name || '未命名群组', count: (group.tags || []).length, color: eagleNamedFolderColors[group.color] || '#7d838f' }, view)).join('')}</div>
    </nav>
    <section class="tm-main">
      <header class="tm-header">
        <h1 class="tm-title">${escapeHTML(tagManagerTitle(view))}</h1>
        <input class="tm-search" type="search" placeholder="搜索标签…" value="${escapeHTML(view.keyword)}" aria-label="搜索标签" autocomplete="off">
        <div class="tm-layout" role="group" aria-label="标签布局">${layoutButton('inline', '格状')}${layoutButton('list', '列表')}</div>
        <button type="button" class="tm-sort" data-tm-sort-menu title="排列与分组" aria-haspopup="menu">${sortLabel}</button>
      </header>
      <div class="tm-body">${tagManagerBodyMarkup(view)}</div>
    </section>
  </div>`;
}

// Typing in the search box redraws only the chips, keeping the field.
function renderTagManagerBody(paneId) {
  const body = paneQuery(paneId, '.tm-body');
  if (body) body.innerHTML = tagManagerBodyMarkup(tagManagerView(paneId));
}

function selectTagManagerTag(paneId, name, { toggle = false, range = false } = {}) {
  const view = tagManagerView(paneId);
  if (range && view.anchor) {
    const order = [...paneQuery(paneId, '.tm-body').querySelectorAll('[data-tm-tag]')].map(chip => chip.dataset.tmTag);
    const [from, to] = [order.indexOf(view.anchor), order.indexOf(name)].sort((left, right) => left - right);
    if (from >= 0) {
      view.selected = new Set(order.slice(from, to + 1));
      return paintTagManagerSelection(paneId);
    }
  }
  if (toggle) {
    if (view.selected.has(name)) view.selected.delete(name);
    else view.selected.add(name);
  } else {
    view.selected = new Set([name]);
  }
  view.anchor = name;
  paintTagManagerSelection(paneId);
}

function paintTagManagerSelection(paneId) {
  const view = tagManagerView(paneId);
  for (const chip of paneQuery(paneId, '.tm-body')?.querySelectorAll('[data-tm-tag]') || []) {
    chip.classList.toggle('selected', view.selected.has(chip.dataset.tmTag));
  }
}

function openTagManagerTagMenu(event, paneId, name) {
  const view = tagManagerView(paneId);
  if (!view.selected.has(name)) selectTagManagerTag(paneId, name);
  showContextMenu(event, { kind: 'tag-manager-tag', paneId, tags: [...view.selected], groupId: view.mode === 'group' ? view.groupId : null });
}

function tagManagerTagMenuMarkup(data) {
  const tags = data.tags || [];
  const one = tags.length === 1;
  const groups = state.tagGroups || [];
  const inGroup = group => tags.every(tag => (group.tags || []).includes(tag));
  const fromGroup = data.groupId || tagGroupsOf(tags[0])[0]?.id || null;
  const groupRows = action => groups.map(group => contextMenuRow({
    icon: 'tag', label: group.name || '未命名群组', action, payload: { groupId: group.id },
    disabled: inGroup(group), checked: action === 'tm-add-group' ? inGroup(group) : null
  })).join('') || contextMenuRow({ label: '还没有标签群组', disabled: true });
  return [
    contextMenuRow({ icon: 'search', label: '搜索包含标签的项目', action: 'tm-filter' }),
    '<div class="context-menu-separator"></div>',
    // Eagle shows 重命名 for one tag and 重命名 N 个项目... for several.
    one
      ? contextMenuRow({ icon: 'rename', label: '重命名', action: 'tm-rename' })
      : contextMenuRow({ icon: 'rename', label: `重命名 ${tags.length} 个项目...`, action: 'tm-batch-rename' }),
    ...(one ? [contextMenuRow({ icon: 'tag', label: '标签颜色…', action: 'tag-color', payload: { tag: tags[0] } })] : []),
    '<div class="context-menu-separator"></div>',
    contextMenuRow({ icon: 'tag', label: '添加至群组...', submenu: groupRows('tm-add-group') }),
    contextMenuRow({ icon: 'tag', label: '移动至群组...', submenu: groupRows('tm-move-group') }),
    contextMenuRow({ icon: 'remove', label: '从标签群组移除', action: 'tm-remove-group', payload: { groupId: fromGroup }, disabled: !fromGroup }),
    ...(tags.length > 1 ? [
      '<div class="context-menu-separator"></div>',
      contextMenuRow({ icon: 'tag', label: `合并 ${tags.length} 个标签`, action: 'tm-merge', disabled: tags.length > 5 })
    ] : [])
  ].join('');
}

function tagManagerGroupMenuMarkup(data) {
  const group = (state.tagGroups || []).find(candidate => candidate.id === data.groupId);
  if (!group) return contextMenuRow({ label: '群组已不存在', disabled: true });
  return [
    contextMenuRow({ icon: 'search', label: '搜索包含群组标签的项目', action: 'tm-filter-group', payload: { groupId: group.id }, disabled: !(group.tags || []).length }),
    contextMenuRow({ icon: 'rename', label: '重命名', action: 'tm-rename-group', payload: { groupId: group.id } }),
    '<div class="context-menu-separator"></div>',
    contextMenuRow({ icon: 'trashMenu', label: '删除群组', action: 'tm-remove-group-node', payload: { groupId: group.id }, danger: true }),
    ...tagGroupColorMenuRows(group)
  ].join('');
}

// Eagle's group menu ends with the same colour dots as a folder's
// (changeTagGroupColor); tagGroup/update keeps the old colour for a missing
// one, so 无 is sent as an empty string.
function tagGroupColorMenuRows(group) {
  const current = String(group.color || '').toLowerCase();
  const disabled = !state.connected;
  const swatches = folderMenuColors.map(color => {
    const label = color ? eagleColorLabels[color] : '无';
    const checked = current === color;
    return `<button type="button" class="context-color-swatch${color ? '' : ' none'}${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}" role="menuitemradio" aria-checked="${checked}" aria-disabled="${disabled}" title="${label}" aria-label="群组颜色：${label}"${color ? ` style="--swatch:${eagleNamedFolderColors[color]}"` : ''} data-context-action="tm-group-color" data-context-payload="${escapeHTML(JSON.stringify({ groupId: group.id, color }))}"></button>`;
  }).join('');
  return ['<div class="context-menu-separator"></div>', `<div class="context-menu-colors" role="group" aria-label="群组颜色">${swatches}</div>`];
}

// Eagle clears the own colour of every tag in the group, so they all show
// the group's; here that is the colour MultiView keeps for a tag locally.
async function setTagGroupColor(groupId, color) {
  const libraryPath = state.library?.path;
  const group = (state.tagGroups || []).find(candidate => candidate.id === groupId);
  if (!group || !libraryPath || !state.connected || !folderMenuColors.includes(color)) return;
  if (String(group.color || '').toLowerCase() === color) return;
  await runForegroundOperation('正在设置群组颜色…', { key: `tag-group-update:${libraryPath}:${groupId}` }, async () => {
    await window.eagleMV.updateTagGroup({ libraryPath, id: groupId, patch: { color } });
    group.color = color;
    for (const tag of group.tags || []) {
      if (state.tagColors[tag]) state.tagColors = await window.eagleMV.setTagColor({ libraryPath, tag, color: null });
    }
    renderTagColors();
    renderTagManagerPanes();
  });
}

// 重命名 N 个项目...: Eagle's batch rename dialog, then one Eagle rename (or
// merge, when the new name is taken) per tag.
function openTagBatchRename(paneId, tags) {
  const libraryPath = state.library?.path;
  if (!libraryPath || tags.length < 2) return;
  window.EagleMVBatchRename.openBatchRenameDialog({
    items: tags.map(name => ({ name })),
    initialPattern: '*',
    historyKey: 'eaglemv.batchRename.findHistory.TAGS',
    onRename: async (changes, total) => {
      if (!changes.length) return;
      // Eagle asks first whenever two or more tags are renamed.
      if (!confirm(`重命名提示\n\n将会重命名 ${total} 个文件，确定要重命名吗？`)) return;
      const steps = window.EagleMVBatchRename.planTagRenames(changes.map(change => ({ from: change.before, to: change.after })), tagManagerRecords().keys());
      await runForegroundOperation('正在重命名标签…', { key: `tag-batch-rename:${libraryPath}` }, async () => {
        for (const step of steps) {
          if (state.library?.path !== libraryPath) throw new Error('资源库已切换，剩余标签未重命名');
          if (step.kind === 'merge') await window.eagleMV.mergeTag({ libraryPath, source: step.from, target: step.to });
          else await window.eagleMV.renameTag({ libraryPath, originalName: step.from, name: step.to });
        }
        const renamedTo = new Map(changes.map(change => [change.before, change.after]));
        tagManagerView(paneId).selected = new Set(tags.map(tag => renamedTo.get(tag) || tag));
        toast(`${total} 个项目已重命名。`);
      });
    }
  });
}

function tagManagerSortMenuMarkup(data) {
  const { sortBy, ascending, groupBy } = tagManagerPrefs;
  const view = tagManagerView(data.paneId);
  const sortRow = (label, by, up) => contextMenuRow({ label, action: 'tm-sort', payload: { sortBy: by, ascending: up }, checked: sortBy === by && ascending === up });
  return [
    sortRow('A > Z', 'name', true),
    sortRow('Z > A', 'name', false),
    sortRow('数量（多→少）', 'count', true),
    sortRow('数量（少→多）', 'count', false),
    ...(['all', 'unfiled'].includes(view.mode) ? [
      '<div class="context-menu-separator"></div>',
      contextMenuRow({ icon: 'more', label: '分组依据', submenu: [
        contextMenuRow({ label: '字母', action: 'tm-group-by', payload: { groupBy: 'alphabet' }, checked: groupBy === 'alphabet' }),
        contextMenuRow({ label: '标签群组', action: 'tm-group-by', payload: { groupBy: 'group' }, checked: groupBy === 'group' })
      ].join('') })
    ] : [])
  ].join('');
}

// Merging several tags is a run of Eagle's one-to-one merges into the name
// typed; a name that is none of them is first taken by renaming one.
async function mergeTagManagerTags(libraryPath, tags, target) {
  let sources = tags.filter(tag => tag !== target);
  if (!tags.includes(target) && !tagManagerRecords().has(target)) {
    await window.eagleMV.renameTag({ libraryPath, originalName: sources[0], name: target });
    sources = sources.slice(1);
  }
  for (const source of sources) await window.eagleMV.mergeTag({ libraryPath, source, target });
}

async function executeTagManagerMenuAction(action, payload, data) {
  const libraryPath = state.library?.path;
  const paneId = data.paneId || state.activePaneId;
  const tags = data.tags || [];
  if (!libraryPath) return;
  if (action === 'tm-sort') return setTagManagerPrefs({ sortBy: payload.sortBy, ascending: payload.ascending });
  if (action === 'tm-group-by') return setTagManagerPrefs({ groupBy: payload.groupBy });
  if (action === 'tm-filter' || action === 'tm-filter-group') {
    const names = action === 'tm-filter' ? tags : ((state.tagGroups || []).find(group => group.id === payload.groupId)?.tags || []);
    return withActivePane(paneId, () => searchItemsWithTags(names));
  }
  if (action === 'tm-rename') return executeTagManagerAction('rename-tag', { tagName: tags[0] });
  if (action === 'tm-batch-rename') return openTagBatchRename(paneId, tags);
  if (action === 'tm-group-color') return setTagGroupColor(payload.groupId, payload.color);
  if (action === 'tm-rename-group') return executeTagManagerAction('rename-group', { groupId: payload.groupId });
  if (action === 'tm-remove-group-node') return executeTagManagerAction('remove-group', { groupId: payload.groupId });
  if (action === 'tm-add-group') {
    return runForegroundOperation('正在将标签加入群组…', { key: `tag-group-add:${libraryPath}:${payload.groupId}` }, async () => {
      await window.eagleMV.addTagsToGroup({ libraryPath, groupId: payload.groupId, tags });
      toast(tags.length > 1 ? `${tags.length} 个标签已加入群组` : '标签已加入群组');
    });
  }
  if (action === 'tm-move-group') {
    // Moving leaves every other group the tags were in, as in Eagle.
    return runForegroundOperation('正在移动标签…', { key: `tag-group-move:${libraryPath}:${payload.groupId}` }, async () => {
      await window.eagleMV.addTagsToGroup({ libraryPath, groupId: payload.groupId, tags });
      for (const group of state.tagGroups || []) {
        if (group.id === payload.groupId) continue;
        const leaving = tags.filter(tag => (group.tags || []).includes(tag));
        if (leaving.length) await window.eagleMV.removeTagsFromGroup({ libraryPath, groupId: group.id, tags: leaving });
      }
      toast(tags.length > 1 ? `${tags.length} 个标签已移动到群组` : '标签已移动到群组');
    });
  }
  if (action === 'tm-remove-group') {
    return runForegroundOperation('正在从群组移除标签…', { key: `tag-group-remove-tag:${libraryPath}:${payload.groupId}` }, async () => {
      await window.eagleMV.removeTagsFromGroup({ libraryPath, groupId: payload.groupId, tags });
      toast('标签已从群组移除');
    });
  }
  if (action === 'tm-merge') {
    const target = await requestNameDialog({ title: `合并 ${tags.length} 个标签`, initialValue: tags[0] || '', fieldLabel: '请输入合并后的标签名称：', submitLabel: '合并标签' });
    if (!target?.trim()) return;
    await runForegroundOperation('正在合并标签…', { key: `tag-merge:${libraryPath}` }, async () => {
      await mergeTagManagerTags(libraryPath, tags, target.trim());
      tagManagerView(paneId).selected = new Set([target.trim()]);
      toast('合并完成');
    });
  }
}

function handleTagManagerClick(event, paneId) {
  const view = tagManagerView(paneId);
  const nav = event.target.closest('[data-tm-mode]');
  if (nav) {
    Object.assign(view, { mode: nav.dataset.tmMode, groupId: nav.dataset.tmGroup || null, selected: new Set(), anchor: null });
    renderGrid({ preserveScroll: false });
    return;
  }
  // Either button flips the layout, as Eagle's toggleTagLayout does.
  if (event.target.closest('[data-tm-layout]')) {
    setTagManagerPrefs({ layout: tagManagerPrefs.layout === 'list' ? 'inline' : 'list' });
    return;
  }
  const sort = event.target.closest('[data-tm-sort-menu]');
  if (sort) {
    // The document's outside-click handler would close it on this same click.
    event.stopPropagation();
    const box = sort.getBoundingClientRect();
    showContextMenuAt(box.left, box.bottom + 4, { kind: 'tag-manager-sort', paneId });
    return;
  }
  const chip = event.target.closest('[data-tm-tag]');
  if (chip) {
    selectTagManagerTag(paneId, chip.dataset.tmTag, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey });
    return;
  }
  if (!event.target.closest('input, textarea, button') && view.selected.size) {
    view.selected.clear();
    paintTagManagerSelection(paneId);
  }
}

function openTagManagerMenu(event, paneId) {
  const chip = event.target.closest('[data-tm-tag]');
  if (chip) return openTagManagerTagMenu(event, paneId, chip.dataset.tmTag);
  const group = event.target.closest('[data-tm-group]');
  if (group) return showContextMenu(event, { kind: 'tag-manager-group', paneId, groupId: group.dataset.tmGroup });
  if (event.target.closest('.tm-main')) return showContextMenu(event, { kind: 'tag-manager-sort', paneId });
}

const TAG_DRAG_TYPE = 'application/x-eaglemv-tags';
const TAG_GROUP_DRAG_TYPE = 'application/x-eaglemv-tag-group';

// Eagle's 标签群组 can be dragged into order, but its API cannot store one
// (tagGroup/update takes name, tags, color and description only). The order
// here is MultiView's own, per library, in this app's storage; Eagle keeps
// its own order. Groups not placed yet follow, in Eagle's order.
const TAG_GROUP_ORDER_KEY = 'eaglemv.tagGroupOrder.v1';
function readTagGroupOrders() {
  try {
    const stored = JSON.parse(localStorage.getItem(TAG_GROUP_ORDER_KEY) || '{}');
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}
function orderTagGroups(groups, libraryPath = state.library?.path) {
  const order = readTagGroupOrders()[libraryPath];
  if (!Array.isArray(groups) || !Array.isArray(order) || !order.length) return groups;
  const rank = new Map(order.map((id, index) => [id, index]));
  const position = (group, index) => rank.has(group.id) ? rank.get(group.id) : order.length + index;
  return groups.map((group, index) => ({ group, at: position(group, index) }))
    .sort((left, right) => left.at - right.at)
    .map(entry => entry.group);
}
function applyTagGroupOrder() {
  state.tagGroups = orderTagGroups(state.tagGroups || []);
  renderTagManagerPanes();
}
function saveTagGroupOrder(ids) {
  const libraryPath = state.library?.path;
  if (!libraryPath) return;
  const orders = readTagGroupOrders();
  orders[libraryPath] = ids;
  try { localStorage.setItem(TAG_GROUP_ORDER_KEY, JSON.stringify(orders)); } catch {}
  applyTagGroupOrder();
}
// Other windows of this app share the storage and follow at once.
window.addEventListener('storage', event => {
  if (event.key === TAG_GROUP_ORDER_KEY) applyTagGroupOrder();
});

function bindTagManagerEvents(paneId, grid) {
  grid.addEventListener('input', event => {
    const search = event.target.closest('.tm-search');
    if (!search) return;
    const view = tagManagerView(paneId);
    view.keyword = search.value;
    view.selected.clear();
    renderTagManagerBody(paneId);
  });
  grid.addEventListener('keydown', event => {
    if (event.target.closest('.tm-search') && event.key === 'Escape' && event.target.value) {
      event.preventDefault();
      event.stopPropagation();
      event.target.value = '';
      event.target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const field = event.target.closest('[data-tm-description]');
    if (field && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); field.blur(); }
    if (field && event.key === 'Escape') {
      event.preventDefault();
      field.value = (state.tagGroups || []).find(group => group.id === field.dataset.tmDescription)?.description || '';
      field.blur();
    }
  });
  // 添加描述...: saved through Eagle when the field is left changed.
  grid.addEventListener('focusout', event => {
    const field = event.target.closest('[data-tm-description]');
    if (!field) return;
    const group = (state.tagGroups || []).find(candidate => candidate.id === field.dataset.tmDescription);
    const description = field.value.trim();
    if (!group || description === (group.description || '')) return;
    const libraryPath = state.library?.path;
    runForegroundOperation('正在保存群组描述…', { key: `tag-group-update:${libraryPath}:${group.id}` }, async () => {
      await window.eagleMV.updateTagGroup({ libraryPath, id: group.id, patch: { description } });
      group.description = description;
    }).catch(error => toast(`群组描述保存失败：${error.message}`, 4200));
  });
  // Tags drag onto a group in the sidebar to join it, as in Eagle.
  grid.addEventListener('dragstart', event => {
    const chip = event.target.closest?.('[data-tm-tag]');
    if (!chip) return;
    event.stopPropagation();
    const view = tagManagerView(paneId);
    if (!view.selected.has(chip.dataset.tmTag)) selectTagManagerTag(paneId, chip.dataset.tmTag);
    event.dataTransfer.setData(TAG_DRAG_TYPE, JSON.stringify([...view.selected]));
    event.dataTransfer.effectAllowed = 'copy';
  }, true);
  const dropTarget = event => (event.dataTransfer?.types || []).includes(TAG_DRAG_TYPE) ? event.target.closest?.('[data-tm-group]') : null;
  // Dragging a group row reorders the groups (MultiView's order, see above).
  let draggedGroup = null;
  const clearGroupMarks = () => {
    for (const row of grid.querySelectorAll('.tm-nav.drop-before, .tm-nav.drop-after')) row.classList.remove('drop-before', 'drop-after');
  };
  const groupDropPlace = event => {
    const row = event.target.closest?.('.tm-groups [data-tm-group]');
    if (!row || !draggedGroup || row.dataset.tmGroup === draggedGroup) return null;
    const box = row.getBoundingClientRect();
    return { row, after: event.clientY > box.top + box.height / 2 };
  };
  grid.addEventListener('dragstart', event => {
    const row = event.target.closest?.('.tm-groups [data-tm-group]');
    if (!row) return;
    event.stopPropagation();
    draggedGroup = row.dataset.tmGroup;
    event.dataTransfer.setData(TAG_GROUP_DRAG_TYPE, draggedGroup);
    event.dataTransfer.effectAllowed = 'move';
  }, true);
  grid.addEventListener('dragend', () => { draggedGroup = null; clearGroupMarks(); }, true);
  grid.addEventListener('dragover', event => {
    if (!(event.dataTransfer?.types || []).includes(TAG_GROUP_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    const place = groupDropPlace(event);
    event.dataTransfer.dropEffect = place ? 'move' : 'none';
    clearGroupMarks();
    place?.row.classList.add(place.after ? 'drop-after' : 'drop-before');
  }, true);
  grid.addEventListener('drop', event => {
    if (!(event.dataTransfer?.types || []).includes(TAG_GROUP_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    const place = groupDropPlace(event);
    const moving = draggedGroup;
    draggedGroup = null;
    clearGroupMarks();
    if (!place) return;
    const ids = (state.tagGroups || []).map(group => group.id).filter(id => id !== moving);
    const at = ids.indexOf(place.row.dataset.tmGroup) + (place.after ? 1 : 0);
    ids.splice(at, 0, moving);
    saveTagGroupOrder(ids);
  }, true);
  grid.addEventListener('dragover', event => {
    if (!(event.dataTransfer?.types || []).includes(TAG_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    const row = dropTarget(event);
    event.dataTransfer.dropEffect = row ? 'copy' : 'none';
    for (const candidate of grid.querySelectorAll('.tm-nav.drop-target')) if (candidate !== row) candidate.classList.remove('drop-target');
    row?.classList.add('drop-target');
  }, true);
  grid.addEventListener('dragleave', event => {
    if (event.target.closest?.('[data-tm-group]') && !event.target.closest('[data-tm-group]').contains(event.relatedTarget)) event.target.closest('[data-tm-group]').classList.remove('drop-target');
  }, true);
  grid.addEventListener('drop', event => {
    if (!(event.dataTransfer?.types || []).includes(TAG_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    for (const candidate of grid.querySelectorAll('.tm-nav.drop-target')) candidate.classList.remove('drop-target');
    const row = dropTarget(event);
    let tags = [];
    try { tags = JSON.parse(event.dataTransfer.getData(TAG_DRAG_TYPE) || '[]'); } catch {}
    if (!row || !tags.length) return;
    const groupId = row.dataset.tmGroup;
    const group = (state.tagGroups || []).find(candidate => candidate.id === groupId);
    const adding = tags.filter(tag => !(group?.tags || []).includes(tag));
    if (!adding.length) return;
    executeTagManagerMenuAction('tm-add-group', { groupId }, { paneId, tags: adding })
      .catch(error => toast(`加入群组失败：${error.message}`, 4200));
  }, true);
}

// 搜索包含标签的项目: every item in the library carrying any of the tags.
function searchItemsWithTags(names) {
  const tags = normalizeTags(names);
  if (!tags.length) return;
  // Passed to navigate, which otherwise starts a new view with no filters.
  navigate({ kind: 'all' }, { query: createQuery({ tags, tagLogic: 'OR' }) });
  renderQueryControls();
}

async function executeTagManagerAction(action, payload = {}) {
  const libraryPath = state.library?.path;
  if (!libraryPath) return;
  if (action === 'filter-tag') return searchItemsWithTags([payload.tagName]);
  if (action === 'create-group') {
    const name = await requestNameDialog({ title: '添加群组', submitLabel: '创建' });
    if (!name?.trim()) return;
    await runForegroundOperation('正在创建群组…', { key: `tag-group-create:${libraryPath}` }, async () => {
      await window.eagleMV.createTagGroup({ libraryPath, name: name.trim() });
      toast('群组已创建');
    });
    return;
  }
  if (action === 'rename-group') {
    const group = state.tagGroups.find(candidate => candidate.id === payload.groupId);
    if (!group) return;
    const name = await requestNameDialog({ title: '重命名群组', initialValue: group.name || '', submitLabel: '重命名' });
    if (!name?.trim() || name.trim() === group.name) return;
    await runForegroundOperation('正在重命名群组…', { key: `tag-group-update:${libraryPath}:${group.id}` }, async () => {
      await window.eagleMV.updateTagGroup({ libraryPath, id: group.id, patch: { name: name.trim() } });
      toast('群组已重命名');
    });
    return;
  }
  if (action === 'remove-group') {
    const group = state.tagGroups.find(candidate => candidate.id === payload.groupId);
    if (!group || !confirm(`删除群组“${group.name}”？\n\n群组会被删除，标签本身和素材不会删除。`)) return;
    await runForegroundOperation('正在删除群组…', { key: `tag-group-remove:${libraryPath}:${group.id}` }, async () => {
      await window.eagleMV.removeTagGroup({ libraryPath, id: group.id });
      toast('群组已删除');
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
    await runForegroundOperation('正在从群组移除标签…', { key: `tag-group-remove-tag:${libraryPath}:${payload.groupId}:${payload.tagName}` }, async () => {
      await window.eagleMV.removeTagsFromGroup({ libraryPath, groupId: payload.groupId, tags: [payload.tagName] });
      toast('标签已从群组移除');
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

// Empty-view wording follows Eagle's `empty.*` strings for each view.
function emptyStateCopy() {
  const kind = state.currentView.kind;
  if (String(state.query.search || '').trim() || queryFilterCount(state.query)) return ['没有找到相关文件', '也许换个搜索规则就能找到它！'];
  if (kind === 'trash') return ['回收站是空的', '这里会保存你删除的内容，你可以进行还原。'];
  if (kind === 'unfiled') return ['太棒啦！', '所有文件已经都分类完成啦！'];
  if (kind === 'untagged') return ['太棒啦！', '所有文件都已经有标签啦！'];
  if (kind === 'recent') return ['还没有最近使用的文件夹', '打开过的文件夹会显示在这里。'];
  if (kind === 'smart') return ['没有找到相关文件', '没有素材符合这个智能文件夹的条件。'];
  if (kind === 'random') return ['这里还没有素材', '资源库里有素材后，随机模式会从中挑选。'];
  if (!hasCapability('importLocal')) return ['这里还没有素材', '可以在桌面版中导入文件。'];
  return ['拖放文件到这里', '你可以一次拖拽多个文件到这里添加'];
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
    // A redraw from another window's tag change must not take the field the
    // user is typing in: put focus, caret and an unsaved description back.
    const grid = $('#itemGrid');
    const focused = grid.contains(document.activeElement) ? document.activeElement : null;
    const restore = focused?.matches('.tm-search, [data-tm-description]')
      ? { selector: focused.matches('.tm-search') ? '.tm-search' : `[data-tm-description="${CSS.escape(focused.dataset.tmDescription)}"]`, value: focused.value, start: focused.selectionStart, end: focused.selectionEnd }
      : null;
    grid.innerHTML = tagManagerMarkup();
    const field = restore && grid.querySelector(restore.selector);
    if (field) {
      field.value = restore.value;
      field.focus();
      try { field.setSelectionRange(restore.start, restore.end); } catch {}
    }
    scroller.scrollTop = preserveScroll ? scrollTop : 0;
    if (updateSharedFooter) updateScrollUI();
    return;
  }
  const orderedItems = sortedItems();
  // Load complete metadata for a global order, but keep thumbnail DOM work
  // scroll-driven in large libraries instead of creating tens of thousands
  // of image elements as soon as the background sort backfill finishes.
  const items = state.sort === 'manual' ? orderedItems.slice(0, activePane()?.manualRenderLimit || SORT_FETCH_CAP) : orderedItems;
  const folders = visibleChildFolders();
  const emptyState = $('#emptyState');
  emptyState.style.display = '';
  const [emptyTitle, emptyText] = state.errorMessage ? ['当前栏读取失败', state.errorMessage] : emptyStateCopy();
  emptyState.querySelector('h2').textContent = emptyTitle;
  emptyState.querySelector('p').textContent = emptyText;
  $('#emptyRetryButton').classList.toggle('hidden', !state.errorMessage);
  $('#emptyState').classList.toggle('hidden', items.length > 0 || folders.length > 0 || state.loading);
  const folderSection = folders.length
    ? `<button type="button" class="grid-section-heading grid-section-toggle" data-toggle-subfolders aria-expanded="${subfoldersCollapsed ? 'false' : 'true'}" title="${subfoldersCollapsed ? '展开子文件夹' : '收起子文件夹'}"><span>${uiIcon('chevronRight', 'grid-section-chevron')}子文件夹</span><span>${folders.length.toLocaleString()}</span></button>`
      + (subfoldersCollapsed ? '' : `<div class="folder-grid">${folders.map(folderCardMarkup).join('')}</div>`)
    : '';
  // Every layout carries its own class (including the default) so the CSS can
  // target one mode instead of excluding all the others.
  const viewModeClass = ` ${paneViewModes.has(state.viewMode) ? state.viewMode : 'justified'}`;
  const headingHTML = items.length && folders.length
    ? `<div class="grid-section-heading"><span>文件</span><span>${state.estimatedTotal ? '≥ ' : ''}${state.total.toLocaleString()}</span></div>`
    : '';
  // The list's column header leads the files, and changes with the sort.
  const listHeaderHTML = items.length && state.viewMode === 'list' ? listHeaderMarkup() : '';
  const gridPrefixHTML = folderSection + headingHTML + listHeaderHTML;
  const itemGrid = $('#itemGrid');
  // Fast path for lazy-load pages: when the already-rendered cards are an
  // exact prefix of the new list and everything before the asset grid is
  // unchanged, append only the tail. This keeps a 3000-card grid from being
  // rebuilt on every page and preserves focus/hover state while scrolling.
  const grid = itemGrid.querySelector('.asset-grid');
  const appended = preserveScroll && grid && itemGrid._gridPrefix === gridPrefixHTML &&
    grid.className === `asset-grid${viewModeClass}`.trim()
    ? appendableTailCount([...grid.children].map(card => card.dataset.id), items)
    : -1;
  if (appended > 0) {
    const renderedCount = items.length - appended;
    grid.insertAdjacentHTML('beforeend', items.slice(renderedCount).map(itemCardMarkup).join(''));
    hydrateGridCards([...grid.children].slice(renderedCount));
    layoutWaterfall(grid, { append: true });
    state.scrollTop = scrollTop;
    if (updateSharedFooter) updateScrollUI();
    scheduleVisibleItemWatch();
    return;
  }
  const itemSection = items.length ? `${headingHTML}${listHeaderHTML}<div class="asset-grid${viewModeClass}">${items.map(itemCardMarkup).join('')}</div>` : '';
  itemGrid.innerHTML = `${folderSection}${itemSection}`;
  itemGrid._gridPrefix = gridPrefixHTML;
  // Placed before the scroll position is restored: the cards give the grid
  // its height.
  layoutWaterfall(itemGrid.querySelector('.asset-grid'));
  waterfallResize?.observe(itemGrid);
  const root = paneRoot();
  hydrateGridCards(root?.querySelectorAll('#itemGrid .item-card') || []);
  for (const image of root?.querySelectorAll('.folder-cover img') || []) {
    if (image.complete) image.classList.add('loaded');
    image.addEventListener('load', () => image.classList.add('loaded'), { once: true });
  }
  const restoreTarget = paneRoot()?.dataset.paneId ? paneById(paneRoot().dataset.paneId)?.restoreScroll : state.restoreScroll;
  const targetScroll = preserveScroll ? scrollTop : (restoreTarget ? restoreTarget.scrollTop : 0);
  state.scrollTop = targetScroll;
  scroller.scrollTop = state.scrollTop;
  if (updateSharedFooter) updateScrollUI();
  scheduleVisibleItemWatch();
}

function applyCardDisplayClasses() {
  const body = document.body;
  body.classList.toggle('hide-card-name', !cardDisplay.name);
  body.classList.toggle('hide-card-meta', !cardDisplay.meta);
  body.classList.toggle('hide-card-ext', !cardDisplay.ext);
  body.classList.toggle('hide-card-ext-label', !cardDisplay.extLabel);
  body.classList.toggle('hide-card-annotation', !cardDisplay.annotation);
  // Hiding the name or meta line changes every card's height.
  scheduleWaterfallRelayout();
}

// 瀑布流 cards are placed by script, row by row into the shortest column like
// Eagle's GridLayout (D-10); CSS columns filled column by column instead, and
// reshuffled every card whenever a lazy-load page arrived. An append continues
// from the column heights the earlier cards left, so those never move.
function layoutWaterfall(grid, { append = false } = {}) {
  if (!grid?.classList.contains('waterfall')) return;
  const width = grid.clientWidth;
  // A hidden pane has no width; the resize observer lays it out once shown.
  if (!width) { grid._waterfall = null; return; }
  const columns = waterfall.columnsFor(width, currentThumbnailSize());
  const cards = [...grid.children];
  let layout = grid._waterfall;
  const resumes = append && layout && layout.width === width && layout.columnWidth === columns.width && layout.count <= cards.length;
  if (!resumes) layout = { width, columnWidth: columns.width, heights: new Array(columns.count).fill(0), count: 0 };
  const fresh = cards.slice(layout.count);
  // All widths first, then all heights, then all positions: one reflow.
  for (const card of fresh) card.style.width = `${layout.columnWidth}px`;
  const sizes = fresh.map(card => card.offsetHeight);
  waterfall.place(layout.heights, sizes, layout.columnWidth).forEach(({ left, top }, index) => {
    fresh[index].style.left = `${left}px`;
    fresh[index].style.top = `${top}px`;
  });
  layout.count = cards.length;
  grid.style.height = `${waterfall.contentHeight(layout.heights)}px`;
  grid._waterfall = layout;
}

function scheduleWaterfallRelayout() {
  if (waterfallFrame || typeof requestAnimationFrame !== 'function') return;
  waterfallFrame = requestAnimationFrame(() => {
    waterfallFrame = 0;
    for (const grid of document.querySelectorAll('.asset-grid.waterfall')) layoutWaterfall(grid);
  });
}



function renderCardDisplayControls() {
  for (const input of document.querySelectorAll('[data-card-display]')) input.checked = Boolean(cardDisplay[input.dataset.cardDisplay]);
  for (const select of document.querySelectorAll('[data-card-meta-type]')) {
    select.value = cardDisplay.metaType;
    select.disabled = !cardDisplay.meta;
  }
}

// Every pane and window follows one setting: here, through setCardDisplay;
// elsewhere, through the storage event.
function adoptCardDisplay(next) {
  const previous = cardDisplay;
  cardDisplay = next;
  applyCardDisplayClasses();
  renderCardDisplayControls();
  if (typeof state === 'undefined' || !Array.isArray(state.panes)) return;
  if (previous.metaType !== next.metaType) {
    for (const pane of state.panes) {
      withActivePane(pane.id, () => {
        // The meta line is in the card markup: rebuild, not append.
        if ($('#itemGrid')) $('#itemGrid')._gridPrefix = null;
        renderGrid({ preserveScroll: true });
      });
    }
  }
  if (previous.subfolderContent !== next.subfolderContent) {
    categoryStatsRevision += 1;
    categoryStatsCache.clear();
    for (const pane of state.panes) {
      if (pane.currentView.kind === 'folder') refresh({ reset: true, preserveScroll: false, paneId: pane.id });
    }
    renderSortControls();
  }
}

function setCardDisplay(patch) {
  const next = cardDisplayAPI.normalize({ ...cardDisplay, ...patch });
  try { localStorage.setItem(cardDisplayAPI.STORAGE_KEY, JSON.stringify(next)); } catch {}
  adoptCardDisplay(next);
}

function bindCardDisplayControls() {
  applyCardDisplayClasses();
  applyListColumnClasses();
  document.addEventListener('change', event => {
    const toggle = event.target.closest?.('[data-card-display]');
    if (toggle) { setCardDisplay({ [toggle.dataset.cardDisplay]: toggle.checked }); return; }
    const select = event.target.closest?.('[data-card-meta-type]');
    if (select) setCardDisplay({ metaType: select.value });
  });
}

function setSubfoldersCollapsed(collapsed) {
  if (subfoldersCollapsed === collapsed) return;
  subfoldersCollapsed = collapsed;
  try { localStorage.setItem(SUBFOLDERS_COLLAPSED_KEY, String(collapsed)); } catch {}
  renderSubfolderSections();
}

function renderSubfolderSections() {
  let inspectorChanged = false;
  for (const pane of state.panes) {
    // A folded card cannot stay selected.
    if (subfoldersCollapsed && pane.selectedFolderCard) {
      pane.selectedFolderCard = null;
      if (pane.id === state.activePaneId) inspectorChanged = true;
    }
    withActivePane(pane.id, () => renderGrid({ preserveScroll: true }));
  }
  if (inspectorChanged) renderInspector();
}

function itemCardMarkup(item) {
  const ext = String(item.ext || '').trim().toLowerCase().replace(/^\./, '');
  const isGif = ext === 'gif';
  const thumbURL = mediaURL('thumb', item.id);
  const originalURL = mediaURL('original', item.id);
  const aspect = itemThumbnailAspect(item);
  const annotations = cardDisplayAPI.annotationCount(item);
  // The list layout keeps its own columns; the 显示 switches shape the grids.
  const list = state.viewMode === 'list';
  return `
    <article class="item-card ${state.selected.has(item.id) ? 'selected' : ''} ${itemIsPinned(item) ? 'pinned' : ''}" data-id="${escapeHTML(item.id)}" draggable="true" tabindex="0" style="--item-aspect: ${aspect.toFixed(4)}">
      <div class="thumb-wrap">
        <img loading="lazy" src="${thumbURL}" alt="${escapeHTML(item.name)}"${isGif ? ` data-gif-static="${thumbURL}" data-gif-animated="${originalURL}"` : ''}>
        ${itemIsPinned(item) ? `<span class="pin-badge" title="已在当前文件夹置顶">${eagleIcon('ic-toolbar-pin.svg', 'pin-icon')}</span>` : ''}
        ${cardDisplayAPI.hasFormatLabel(item) ? `<span class="format-badge${isGif ? ' gif-badge' : ''}">${escapeHTML(itemFormat(item))}</span>` : ''}
        ${annotations ? `<span class="annotation-badge" title="${annotations} 个标注">${annotations}</span>` : ''}
      </div>
      <div class="card-name" title="${escapeHTML(item.name)}${ext ? `.${escapeHTML(ext)}` : ''}">${escapeHTML(item.name)}${ext ? `<span class="card-ext">.${escapeHTML(ext)}</span>` : ''}</div>
      ${list ? listRowColumns(item) : `<div class="card-meta">${escapeHTML(cardDisplayAPI.metaText(item, cardDisplay.metaType, { formatBytes, formatDateTime, itemDates }))}</div>`}
    </article>`;
}

// Eagle's list layout (index.html #list-layout-header): after the thumbnail
// and name come 标签, 尺寸, 评分, 扩展名, 文件大小 and 添加日期. Right-click
// on the header picks which show — 尺寸, 扩展名, 文件大小 and 添加日期 by
// default — and clicking one sorts by it. Rendered only in list mode: the
// other layouts would carry dead nodes per card, and the grid holds thousands.
const LIST_COLUMNS = [
  { key: 'tags', label: '标签', sort: 'tags', show: false },
  { key: 'resolution', label: '尺寸', sort: 'resolution', show: true },
  { key: 'rating', label: '评分', sort: 'rating', show: false },
  { key: 'ext', label: '扩展名', sort: 'type', show: true },
  { key: 'size', label: '文件大小', sort: 'size', show: true },
  { key: 'added', label: '添加日期', sort: 'added', show: true }
];
// A header click on a new column starts from Eagle's increasing order:
// A→Z, smallest first, newest first for the date (sortRawData).
const LIST_HEADER_SORT_DIRS = { name: 'asc', tags: 'asc', resolution: 'asc', rating: 'asc', type: 'asc', size: 'asc', added: 'desc' };
const LIST_COLUMNS_STORAGE_KEY = 'eaglemv.listColumns';

function listColumnSettings() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(LIST_COLUMNS_STORAGE_KEY) || '{}') || {}; } catch {}
  return Object.fromEntries(LIST_COLUMNS.map(column => [column.key, typeof stored[column.key] === 'boolean' ? stored[column.key] : column.show]));
}

function applyListColumnClasses() {
  const settings = listColumnSettings();
  for (const column of LIST_COLUMNS) document.body.classList.toggle(`list-hide-${column.key}`, !settings[column.key]);
}

function toggleListColumn(key) {
  if (!LIST_COLUMNS.some(column => column.key === key)) return false;
  const settings = listColumnSettings();
  settings[key] = !settings[key];
  try { localStorage.setItem(LIST_COLUMNS_STORAGE_KEY, JSON.stringify(settings)); } catch {}
  applyListColumnClasses();
  return settings[key];
}

function listColumnsMenuMarkup() {
  const settings = listColumnSettings();
  return LIST_COLUMNS.map(column => contextMenuRow({
    label: column.label, checked: settings[column.key], action: 'toggle-list-column', payload: { key: column.key }, keepOpen: true
  })).join('');
}

function listRatingHTML(rating) {
  return `<span class="list-stars-lit">${'★'.repeat(rating)}</span>${'★'.repeat(5 - rating)}`;
}

function listRowColumns(item) {
  const tags = (item.tags || []).map(String).filter(Boolean);
  const rating = Math.max(0, Math.min(5, Number(item.star) || 0));
  const { added } = itemDates(item);
  const ext = String(item.ext || '').trim().toLowerCase().replace(/^\./, '');
  return `<div class="list-col list-col-tags" title="${escapeHTML(tags.join('、'))}">${tags.length ? tags.map(tag => `<span class="card-list-tag">${escapeHTML(tag)}</span>`).join('') : '-'}</div>
      <div class="list-col list-col-resolution">${Number(item.width) || 0} x ${Number(item.height) || 0}</div>
      <div class="list-col list-col-rating"${rating ? ` title="${rating} 星"` : ''}>${listRatingHTML(rating)}</div>
      <div class="list-col list-col-ext">${escapeHTML(ext)}</div>
      <div class="list-col list-col-size">${formatBytes(item.size)}</div>
      <div class="list-col list-col-added" title="添加日期">${added ? escapeHTML(formatListDate(added)) : ''}</div>`;
}

function formatListDate(value) {
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function listHeaderMarkup() {
  const direction = effectiveSortDir(state.sort, state.sortDir);
  const cell = (key, label, sort) => {
    const active = state.sort === sort;
    const reversed = active && direction !== LIST_HEADER_SORT_DIRS[sort];
    return `<button type="button" class="list-head-cell list-col-${key}${active ? ' active' : ''}" data-list-sort="${sort}" title="按${label}排序"><span>${label}</span>${active ? `<img class="list-head-arrow${reversed ? ' up' : ''}" src="eagle-assets/ic-list-arrow-down.svg" alt="">` : ''}</button>`;
  };
  return `<div class="list-header" role="row">
    <span class="list-head-thumb" aria-hidden="true"></span>${cell('name', '名称', 'name')}${LIST_COLUMNS.map(column => cell(column.key, column.label, column.sort)).join('')}
  </div>`;
}

// Eagle's changeListOrderBy: the sorted column flips its direction, another
// column sorts in its increasing order.
function applyListHeaderSort(sort, paneId = state.activePaneId) {
  if (!activatePane(paneId) || !(sort in LIST_HEADER_SORT_DIRS)) return false;
  if (state.sort === sort) return applySortDirection(effectiveSortDir(state.sort, state.sortDir) === 'asc' ? 'desc' : 'asc');
  state.sort = sort;
  state.sortDir = LIST_HEADER_SORT_DIRS[sort];
  if (sortCascadeEnabled && state.currentView?.kind === 'folder') {
    sortMemory.rememberCascade(state.library?.path, state.currentView.id, state.library?.folders, state.sort, state.sortDir, Date.now());
  }
  commitSortChange();
  if (viewHasClientOrder() && state.hasMore) refresh({ reset: false, preserveScroll: true, paneId });
  return true;
}

function hydrateGridCards(cards) {
  for (const card of cards) {
    bindGifHover(card);
    for (const image of card.querySelectorAll('.thumb-wrap img')) {
      if (image.complete && image.naturalWidth > 0) image.classList.add('loaded');
      image.addEventListener('load', () => image.classList.add('loaded'), { once: true });
      // Text files and other items Eagle never generated a thumbnail for leave
      // an empty box; label it with the format instead of nothing.
      image.addEventListener('error', () => image.closest('.thumb-wrap')?.classList.add('thumb-missing'), { once: true });
    }
  }
}

function updateScrollUI() {
  const scroller = $('#gridScroller');
  // Eagle-style "N 个项目" (GUI-06); while the grid is still paging in, say how
  // many are loaded so far instead of a scroll percentage.
  const loaded = state.items.length;
  const total = `${state.estimatedTotal ? '至少 ' : ''}${state.total.toLocaleString()} 个项目`;
  $('#scrollStatus').textContent = loaded < state.total ? `${total} · 已载入 ${loaded.toLocaleString()}` : total;
  $('#scrollTopButton').classList.toggle('hidden', scroller.scrollTop < Math.max(240, scroller.clientHeight * 0.6));
}

function renderResultCount() {
  const childCount = visibleChildFolders().length;
  $('#resultCount').textContent = state.currentView.kind === 'tags'
    ? `${state.availableTags.length.toLocaleString()} 个标签 · ${(state.tagGroups || []).length.toLocaleString()} 个群组`
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
// presets (eagleNamedFolderColors, declared with the filter choices); unset
// folders have no color field at all.
function folderColorValue(folder) {
  // Eagle stores a folder's colour as iconColor; `color` is a legacy alias.
  const raw = String(folder?.iconColor || folder?.color || '').trim();
  if (!raw) return '';
  if (/^#[0-9a-f]{3,8}$/i.test(raw)) return raw;
  return eagleNamedFolderColors[raw.toLowerCase()] || '';
}

function folderColorDot(folder, variant = '') {
  const color = folderColorValue(folder);
  return color ? `<span class="folder-color-dot${variant ? ` ${variant}` : ''}" style="background:${escapeHTML(color)}" aria-hidden="true"></span>` : '';
}

function folderLockBadge(folder) {
  return folder?.password ? `<span class="folder-lock" title="加密文件夹">${uiIcon('lock', 'folder-lock-svg')}</span>` : '';
}

// Eagle's sidebar badge: thousands separators, and no badge at all for zero.
function folderCountBadge(count) {
  return Number.isFinite(count) && count > 0 ? `<span class="folder-count">${count.toLocaleString('en-US')}</span>` : '';
}

// Eagle shows the subtree total on a collapsed folder and only the folder's
// own items once it is expanded (the children then carry their own counts).
function folderTreeCount(folder, expanded) {
  if (!expanded && Number.isFinite(folder.descendantImageCount)) return folder.descendantImageCount;
  return folder.imageCount;
}

function countFolders(folders) {
  return (folders || []).reduce((total, folder) => total + 1 + countFolders(folder.children), 0);
}

function renderFolderTree() {
  if (!state.library) return;
  // The sidebar highlights the pane the user is in, even when a background
  // pane's refresh is what asked for the redraw (B2-07).
  if (renderingBackgroundPane()) return withActivePane(foregroundPaneId, renderFolderTree);
  const tree = $('#folderTree');
  const folderHTML = (folders, parentId = null) => {
    const view=parentId ? {kind:'folder',id:parentId} : {kind:'root'};
    const ordered=window.EagleMVManualOrder.sort(folders || [],manualOrder(view,'folders'));
    return ordered.map(folder => {
    const children = folder.children || [];
    const expanded = state.expandedFolders.has(folder.id);
    const count = folderTreeCount(folder, children.length > 0 && expanded);
    return `<div class="folder-node">
      <button class="folder-row ${state.currentView.kind === 'folder' && state.currentView.id === folder.id ? 'active' : ''}" data-folder-id="${escapeHTML(folder.id)}" data-folder-node-id="${escapeHTML(folder.id)}" draggable="true" data-folder-name="${escapeHTML(folder.name)}" title="${escapeHTML(folder.name)}" aria-expanded="${children.length ? String(expanded) : 'false'}">
        ${children.length ? `<span class="folder-toggle" data-toggle-folder="${escapeHTML(folder.id)}">${eagleIcon('ic-arrow-right.svg', `disclosure-icon${expanded ? ' expanded' : ''}`)}</span>` : '<span class="folder-toggle spacer"></span>'}
        <span class="folder-icon">${eagleIcon('ic-filter-item-folder.svg')}${folderColorDot(folder)}</span><span class="folder-name">${escapeHTML(folder.name)}</span>${folderLockBadge(folder)}
        ${folderCountBadge(count)}
      </button>
      ${children.length && expanded ? `<div class="folder-children">${folderHTML(children,folder.id)}</div>` : ''}
    </div>`;
    }).join('');
  };
  const smartFolderHTML = folders => (folders || []).map(folder => {
    const children = folder.children || [];
    const expanded = state.expandedFolders.has(folder.id);
    return `<div class="folder-node">
      <button class="folder-row ${state.currentView.kind === 'smart' && state.currentView.id === folder.id ? 'active' : ''}" data-smart-folder-id="${escapeHTML(folder.id)}" data-folder-name="${escapeHTML(folder.name)}" title="${escapeHTML(folder.name)}" aria-expanded="${children.length ? String(expanded) : 'false'}">
        ${children.length ? `<span class="folder-toggle" data-toggle-folder="${escapeHTML(folder.id)}">${eagleIcon('ic-arrow-right.svg', `disclosure-icon${expanded ? ' expanded' : ''}`)}</span>` : '<span class="folder-toggle spacer"></span>'}
        <span class="folder-icon smart">${uiIcon('smart')}</span><span class="folder-name">${escapeHTML(folder.name)}</span>
        ${folderCountBadge(folder.imageCount)}
      </button>
      ${children.length && expanded ? `<div class="folder-children">${smartFolderHTML(children)}</div>` : ''}
    </div>`;
  }).join('');
  const smartHTML = smartFolderHTML(state.library.smartFolders || []);
  const quickEntries = quickAccessEntries();
  const quickHTML = quickEntries.map(folder => folder.quickType === 'smart'
    ? `<button class="folder-row ${state.currentView.kind === 'smart' && state.currentView.id === folder.id ? 'active' : ''}" data-smart-folder-id="${escapeHTML(folder.id)}" data-folder-name="${escapeHTML(folder.name)}" title="${escapeHTML(folder.name)}">
      <span class="folder-toggle spacer"></span><span class="folder-icon smart">${uiIcon('smart')}</span><span class="folder-name">${escapeHTML(folder.name)}</span></button>`
    : `<button class="folder-row ${state.currentView.kind === 'folder' && state.currentView.id === folder.id ? 'active' : ''}" data-folder-id="${escapeHTML(folder.id)}" data-folder-node-id="${escapeHTML(folder.id)}" draggable="true" data-folder-name="${escapeHTML(folder.name)}">
      <span class="folder-toggle spacer"></span><span class="folder-icon">${eagleIcon('ic-filter-item-folder.svg')}${folderColorDot(folder)}</span><span class="folder-name">${escapeHTML(folder.name)}</span>${folderLockBadge(folder)}${folderCountBadge(folder.imageCount)}</button>`).join('');
  tree.innerHTML = `
    <button class="folder-row ${state.currentView.kind === 'root' ? 'active' : ''}" data-special="root" data-folder-node-root=""><span class="folder-toggle spacer"></span><span class="folder-icon special">${uiIcon('library')}</span><span class="folder-name">资源库根目录</span></button>
    <button class="folder-row ${state.currentView.kind === 'all' ? 'active' : ''}" data-special="all"><span class="folder-toggle spacer"></span><span class="folder-icon special">${eagleIcon('ic-sidebar-all.svg')}</span><span class="folder-name">全部</span></button>
    <button class="folder-row ${state.currentView.kind === 'unfiled' ? 'active' : ''}" data-special="unfiled"><span class="folder-toggle spacer"></span><span class="folder-icon special">${eagleIcon('ic-sidebar-unfiled.svg')}</span><span class="folder-name">未分类</span></button>
    <button class="folder-row ${state.currentView.kind === 'untagged' ? 'active' : ''}" data-special="untagged"><span class="folder-toggle spacer"></span><span class="folder-icon special">${uiIcon('tag')}</span><span class="folder-name">未标签</span></button>
    <button class="folder-row ${state.currentView.kind === 'tags' ? 'active' : ''}" data-special="tags"><span class="folder-toggle spacer"></span><span class="folder-icon special">${uiIcon('tag')}</span><span class="folder-name">标签管理</span>${folderCountBadge(state.availableTags.length)}</button>
    <button class="folder-row ${state.currentView.kind === 'recent' ? 'active' : ''}" data-special="recent"><span class="folder-toggle spacer"></span><span class="folder-icon special">${uiIcon('recent')}</span><span class="folder-name">最近使用</span></button>
    <button class="folder-row ${state.currentView.kind === 'random' ? 'active' : ''}" data-special="random"><span class="folder-toggle spacer"></span><span class="folder-icon special">${uiIcon('random')}</span><span class="folder-name">随机模式</span></button>
    <button class="folder-row ${state.currentView.kind === 'trash' ? 'active' : ''}" data-special="trash"><span class="folder-toggle spacer"></span><span class="folder-icon special">${uiIcon('trash')}</span><span class="folder-name">回收站</span></button>
    ${quickHTML ? `<div class="folder-section-label">快速访问 (${quickEntries.length})</div>${quickHTML}` : ''}
    ${smartHTML ? `<div class="folder-section-label">智能文件夹</div>${smartHTML}` : ''}
    <div class="folder-section-label">文件夹 (${countFolders(state.library.folders)})</div>${folderHTML(state.library.folders)}
    `;
  attachFolderDragTargets();
}

function toggleFolder(id) {
  state.expandedFolders.has(id) ? state.expandedFolders.delete(id) : state.expandedFolders.add(id);
  renderFolderTree();
}

function handleFolderTargetDragOver(event, targetElement) {
  const dropKind = classifyDrop(event.dataTransfer, activeDraggedItemIds());
  if (dropKind === 'unsupported') return false;
  event.preventDefault();
  const sourceFolderId = state.internalDrag?.sourceFolderId || null;
  // A plain drag follows Eagle's move semantics when the source is a folder.
  // Holding Option changes the same drop into a copy (add membership only).
  event.dataTransfer.dropEffect = dropKind === 'internal-items' && sourceFolderId && !event.altKey ? 'move' : 'copy';
  targetElement.classList.add('drop-target');
  return true;
}

function attachFolderDragTargets() {
  attachManualDrag();
  selectedFeatureUI().attachFolderDrag?.();
  for (const row of document.querySelectorAll('[data-folder-id]')) {
    row.addEventListener('dragover', event => {
      handleFolderTargetDragOver(event, row);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', event => {
      const drop = resolveItemDrop(event);
      const dropKind = drop.kind;
      if (dropKind === 'unsupported') return;
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove('drop-target');
      const folderId = row.dataset.folderId;
      if (dropKind === 'external-files') {
        scheduleExternalFolderImport(event.dataTransfer, folderId, state.activePaneId);
        return;
      }
      const ids = drop.ids;
      if (!ids.length) {
        toast('无法识别拖入的素材，请重新拖动', 3500);
        clearDragUI();
        return;
      }
      const session = drop.session;
      const libraryPath = session?.libraryPath || state.library?.path;
      const folderName = row.dataset.folderName;
      const sourceFolderId = session?.sourceFolderId || null;
      const sourceFolderIds = session?.sourceFolderIds || null;
      const move = Boolean(sourceFolderId && !event.altKey);
      const sourcePaneId = session ? (session.sourcePaneId || state.dragSourcePaneId || null) : null;
      scheduleDropTask(() => addItemsToFolder(ids, folderId, folderName, libraryPath, { move, sourceFolderId, sourceFolderIds, sourcePaneId }));
    });
  }
}

// The item query a pane's view pages through (refresh) and locates in.
function paneItemQuery(pane, currentView = pane.currentView) {
  const query = {
    ...cloneQuery(pane.query),
    folderId: currentView.kind === 'folder' ? currentView.id : null,
    smartFolderId: currentView.kind === 'smart' ? currentView.id : null,
    unfiled: currentView.kind === 'unfiled' || (currentView.kind === 'root' && !String(pane.query.search || '').trim()),
    isUntagged: currentView.kind === 'untagged',
    random: currentView.kind === 'random'
  };
  // A search, or 显示子文件夹内容, covers the folder's whole subtree.
  if (query.folderId && (String(query.search || '').trim() || cardDisplay.subfolderContent)) {
    const folderIds = [];
    const visit = nodes => (nodes || []).forEach(folder => {
      if (folder.id === query.folderId) {
        const collect = branch => (branch || []).forEach(child => { folderIds.push(child.id); collect(child.children); });
        folderIds.push(folder.id); collect(folder.children);
      } else visit(folder.children);
    });
    visit(state.library?.folders);
    if (folderIds.length) query.folderIds = folderIds;
  }
  return query;
}

// Folders a pane's items come from: the open folder, or its whole subtree while
// a search is active (paneItemQuery widens to descendants). Moving or removing
// must leave all of them, or subfolder results are only copied (D-07/B2-06).
function paneFolderScope(pane, folderId = pane?.currentView.kind === 'folder' ? pane.currentView.id : null) {
  if (!folderId) return [];
  if (pane?.currentView.kind !== 'folder' || pane.currentView.id !== folderId) return [folderId];
  const { folderIds } = paneItemQuery(pane);
  return folderIds?.length ? [...folderIds] : [folderId];
}

async function refresh({ reset = true, preserveScroll = true, paneId = state.activePaneId, quiet = false, minimumCount = 0 } = {}) {
  const pane = paneById(paneId);
  if (!pane || (pane.loading && !reset)) return;
  const refreshToken = ++pane.refreshToken;
  pane.loading = true;
  withActivePane(paneId, () => $('#loadIndicator').classList.remove('hidden'));
  setSyncStatus('正在同步…');
  const currentView = { ...pane.currentView };
  const selectedId = pane.selected.size === 1 ? [...pane.selected][0] : null;
  const offset = reset ? 0 : pane.nextOffset;
  const restoreCount = Math.max(state.pageSize, reset && preserveScroll ? pane.items.length : 0, minimumCount);
  const libraryPath = state.library?.path;
  const query = paneItemQuery(pane, currentView);
  try {
    const page = currentView.kind === 'tags'
      ? { data: [], total: 0, nextOffset: 0, hasMore: false }
      : currentView.kind === 'recent'
      ? { data: [], total: 0, nextOffset: 0, hasMore: false }
      : currentView.kind === 'trash'
        ? await window.eagleMV.getTrashItems({ ...query, libraryPath: state.library?.path, offset, limit: state.pageSize })
        : await window.eagleMV.query({ ...query, offset, limit: state.pageSize });
    // A reset is a replacement of the loaded range, not just page one. This
    // also allows every selected ID to be reconciled against the new query.
    while (reset && page.hasMore && (page.data || []).length < restoreCount && !page.error) {
      if (refreshToken !== pane.refreshToken || state.library?.path !== libraryPath || !paneById(paneId)) return;
      const nextOffset = page.nextOffset ?? (page.data || []).length;
      const next = currentView.kind === 'trash'
        ? await window.eagleMV.getTrashItems({ ...query, libraryPath, offset: nextOffset, limit: state.pageSize })
        : await window.eagleMV.query({ ...query, offset: nextOffset, limit: state.pageSize });
      if (next.error) { page.error = next.error; break; }
      const known = new Set((page.data || []).map(item => item.id));
      const additions = (next.data || []).filter(item => !known.has(item.id));
      page.data = [...(page.data || []), ...additions];
      page.total = next.total ?? page.total;
      page.nextOffset = next.nextOffset ?? (nextOffset + (next.data || []).length);
      page.hasMore = Boolean(next.hasMore);
      if (page.nextOffset <= nextOffset || !additions.length) break;
    }
    if (page.error) {
      const error = new Error(page.error.message || '读取失败');
      error.code = page.error.code;
      throw error;
    }
    if (refreshToken !== pane.refreshToken || state.library?.path !== libraryPath || !paneById(paneId)) return;
    const paneIsActive = state.activePaneId === paneId;
    withActivePane(paneId, () => {
      state.errorMessage = '';
      state.total = page.total || 0;
      state.estimatedTotal = Boolean(page.estimated);
      state.nextOffset = page.nextOffset ?? (offset + (page.data || []).length);
      state.hasMore = Boolean(page.hasMore ?? (state.nextOffset < state.total));
      if (reset) {
        pane.dataRevision = (pane.dataRevision || 0) + 1;
        state.items = page.data || [];
        state.itemMap = new Map((state.items || []).filter(item => item?.id).map(item => [item.id, item]));
      } else {
        const knownIds = new Set(state.items.map(item => item.id));
        const additions = (page.data || []).filter(next => !knownIds.has(next.id));
        state.items = [...state.items, ...additions];
        for (const item of additions) if (item?.id) state.itemMap?.set(item.id, item);
      }
      // Only an unfiltered folder total is the folder's own count; a search
      // also counts subfolder matches and a filter counts a subset (B2-03).
      if (currentView.kind === 'folder' && !queryFiltersActive(query) && !(query.folderIds?.length > 1)) reconcileLocalFolderCount(currentView.id, state.total);
      renderResultCount();
      $('#viewTitle').textContent = state.viewTitle;
      renderLocation();
      // Quiet pages belong to a sort backfill: skip the grid rebuild per page
      // and render once when the backfill settles (in the finally block).
      // Append pages must keep the scroll position (`preserveScroll && reset`
      // used to reset it, teleporting scroll-driven paging back to the top)
      // — with it preserved, renderGrid can take the append fast path.
      if (reset) {
        // A multi-selection past the reloaded range (⌘A over a big view,
        // P6-02) keeps its unloaded ids until the view's id list says
        // which are still in it; a single selection settles below.
        const kept = new Set();
        let beyond = 0;
        for (const id of state.selected) {
          if (state.itemMap.has(id)) kept.add(id);
          else if (state.hasMore && state.selected.size > 1) { kept.add(id); beyond += 1; }
        }
        state.selected = kept;
        if (beyond) reconcileSelectionWithView(pane);
      }
      if (!quiet) renderGrid({ preserveScroll });
      if (reset && !selectedId && paneIsActive) queueChangedInspectorRender(false);
      if (reset && selectedId) {
        const selectedAfter = itemById(selectedId);
        if (!selectedAfter) {
          state.selected.delete(selectedId);
          if (paneIsActive) renderInspector();
        } else if (!state.inspectorDirty && !state.inspectorSaving && !isInspectorEditor() && paneIsActive) {
          renderInspector();
        } else if (paneIsActive && inspectorMetadataChanged(selectedAfter, pane.selectedBase)) {
          $('#staleBanner').classList.remove('hidden');
        }
      }
    });
    setSyncStatus(`已同步 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
    setConnection(true);
  } catch (error) {
    if (refreshToken !== pane.refreshToken || state.library?.path !== libraryPath || !paneById(paneId)) return;
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
        const sortBackfillActive = viewHasClientOrder() && state.hasMore;
        const continueBackfill = sortBackfillActive && (state.sort === 'manual' || state.items.length < SORT_FETCH_CAP);
        const restoreTarget = pane.restoreScroll;
        const continueRestore = Boolean(restoreTarget) && state.hasMore && state.items.length < restoreTarget.count;
        if (needsViewportFill || continueBackfill || continueRestore) {
          // Backfill pages render nothing until the last one; viewport fill
          // must keep rendering so scrollHeight grows.
          const nextQuiet = (continueBackfill || continueRestore) && !needsViewportFill;
          setTimeout(() => refresh({ reset: false, preserveScroll: true, paneId, quiet: nextQuiet }), 0);
        } else {
          if (restoreTarget) {
            pane.restoreScroll = null;
            scroller.scrollTop = restoreTarget.scrollTop;
            pane.scrollTop = scroller.scrollTop;
          }
          if (quiet) renderGrid({ preserveScroll: true });
          if (restoreTarget) {
            // Back/up navigation: every remembered page is in, land where the
            // user left off (the browser clamps if the list shrank meanwhile).
            scroller.scrollTop = restoreTarget.scrollTop;
            pane.scrollTop = scroller.scrollTop;
            if (paneIsActive) updateScrollUI();
            requestAnimationFrame?.(() => {
              if (scroller && Math.abs(scroller.scrollTop - restoreTarget.scrollTop) > 1 && scroller.scrollHeight > scroller.clientHeight) {
                scroller.scrollTop = restoreTarget.scrollTop;
                pane.scrollTop = scroller.scrollTop;
                if (paneIsActive) updateScrollUI();
              }
            });
          }
          if (sortBackfillActive && state.items.length >= SORT_FETCH_CAP) {
            // One notice per (view, sort) episode — the key derives staleness
            // away instead of resetting a flag from every sort/navigation site.
            const capKey = `${descriptorKey(state.currentView)}|${state.sort}`;
            if (pane.sortCapNoticeKey !== capKey) {
              pane.sortCapNoticeKey = capKey;
              toast(`素材较多，当前排序先基于前 ${state.items.length} 个素材，继续滚动会继续载入`, 4200);
            }
          }
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
  // Eagle's rules (P6-03): ⇧-click on a selected item drops it; on another
  // item it adds the run from the anchor and keeps the rest; ⌘-click toggles,
  // and a plain or adding ⌘-click becomes the new anchor.
  if (range && state.selected.has(id)) {
    state.selected.delete(id);
  } else if (range && state.selected.size) {
    state.selected = extendSelection(sortedItems(), state.selected, state.selectionAnchor, id);
  } else if (additive) {
    if (state.selected.has(id)) state.selected.delete(id);
    else {
      state.selected.add(id);
      state.selectionAnchor = id;
    }
  } else {
    state.selected.clear();
    state.selected.add(id);
    state.selectionAnchor = id;
  }
  if (state.sort === 'manual') {
    const index=sortedItems().findIndex(item=>item.id===id);
    if (index >= (activePane().manualRenderLimit || SORT_FETCH_CAP)) {
      activePane().manualRenderLimit=index+1;
      renderGrid({preserveScroll:true});
    }
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
    return `<button type="button" class="palette-swatch" style="background:rgb(${rgb.join(',')})" data-color="${hex}" title="${hex} · ${pct}% · 点击复制，${keyboardPlatform.shortcutText('⌥')}点击筛选同色" aria-label="主色 ${hex}"></button>`;
  }).join('');
  box.classList.toggle('hidden', !box.innerHTML);
}

// A selection reaching past the loaded items is summarised by the main
// process (P6-02); null while that is on its way, and the inspector redraws
// when it lands. Keyed by the ids and the pane's data revision, so a batch
// edit or a sync refresh asks again.
const remoteSelectionSummaries = new Map();
function selectionSignature(ids) {
  let hash = 2166136261;
  for (const id of ids) for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return `${ids.length}:${hash >>> 0}`;
}

function currentSelectionSummary(pane = activePane()) {
  if (!pane) return computeSelectionSummary([]);
  if (!unloadedSelection(pane).length) return computeSelectionSummary(pane.items.filter(item => pane.selected.has(item.id)));
  const ids = [...pane.selected];
  const key = `${state.library?.path}|${pane.id}|${pane.dataRevision || 0}|${selectionSignature(ids)}`;
  const cached = remoteSelectionSummaries.get(key);
  if (cached) return cached === 'pending' ? null : cached;
  remoteSelectionSummaries.set(key, 'pending');
  if (remoteSelectionSummaries.size > 8) remoteSelectionSummaries.delete(remoteSelectionSummaries.keys().next().value);
  Promise.resolve(window.eagleMV.selectionSummary?.({ ids, libraryPath: state.library?.path, trash: pane.currentView.kind === 'trash' }))
    .then(summary => remoteSelectionSummaries.set(key, summary || computeSelectionSummary([])),
      () => remoteSelectionSummaries.delete(key))
    .finally(() => { if (state.activePaneId === pane.id && pane.selected.size > 1) renderInspector(); });
  return null;
}

function renderSharedTags() {
  const chips = $('#sharedTagChips');
  if (!chips) return;
  const tags = currentSelectionSummary()?.tags || [];
  chips.innerHTML = tags.map(tag => tagChipHTML(tag, {
    removeAttr: 'data-remove-shared-tag',
    removeLabel: `从所选素材移除 ${tag}`
  })).join('');
}

// Eagle's 评分 row: five stars, and clicking the lit one clears the rating.
function inspectorStarsHTML(rating) {
  const value = Math.max(0, Math.min(5, Number(rating) || 0));
  return [1, 2, 3, 4, 5].map(star =>
    `<button type="button" class="inspector-star${star <= value ? ' filled' : ''}" data-inspector-star="${star}" aria-label="${star} 星" aria-pressed="${star === value}" title="${star === value ? '再次点击清除评分' : `${star} 星`}">★</button>`
  ).join('');
}

function nextStarRating(current, clicked) {
  return Number(clicked) === Number(current || 0) ? 0 : Number(clicked);
}

// Eagle's 文件夹 block: a chip per folder (folder colour, full path on hover)
// that opens the folder, × to take the item out of just that folder, and
// 添加文件夹 for the folder picker.
function inspectorFolderChipsHTML(folderIds) {
  const folders = state.library?.folders;
  const chips = (folderIds || []).map(id => {
    const path = findFolderPath(folders, id);
    const folder = path.at(-1);
    if (!folder) return '';
    const color = folderColorValue(folder);
    const fullPath = path.map(entry => entry.name).join(' / ');
    return `<span class="tag-chip folder-chip"${color ? ` style="--tag-color:${escapeHTML(color)}"` : ''} title="${escapeHTML(fullPath)}"><button type="button" class="folder-chip-open" data-open-folder="${escapeHTML(folder.id)}" aria-label="打开文件夹 ${escapeHTML(fullPath)}">${escapeHTML(folder.name)}</button><button type="button" data-remove-folder="${escapeHTML(folder.id)}" aria-label="从文件夹“${escapeHTML(folder.name)}”移除">×</button></span>`;
  }).join('');
  const shortcut = keyboardPlatform.shortcutText('⌘⇧J');
  return chips + (chips
    ? `<button type="button" class="folder-chip-add" data-add-folder title="添加文件夹（${shortcut}）" aria-label="添加文件夹">+</button>`
    : `<button type="button" class="folder-chip-add full" data-add-folder title="添加文件夹（${shortcut}）">+ 添加文件夹</button>`);
}

function formatMediaDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (total <= 0) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// Eagle asks before an edit that touches 100 or more items at once.
const BULK_CONFIRM_THRESHOLD = 100;
function confirmBulkEdit(count) {
  if (count < BULK_CONFIRM_THRESHOLD) return true;
  return confirm(`批量操作确认\n\n这个操作会影响 ${count.toLocaleString()} 个文件，确定要继续吗？`);
}

function selectedItemsInOrder() {
  return state.items.filter(item => state.selected.has(item.id));
}

// What the multi-select panel shows. Fields being typed into keep their text:
// a refresh mid-edit must not wipe what the user is about to apply.
// Eagle's inspector blocks — 标签, 文件夹, 标注, 基本信息 — fold under their
// headings and are dragged into any order by them; Eagle keeps both for
// every window (eagle.inspector.itemsOrder and show*), and so does this,
// for the single and the multi-select inspector alike.
const INSPECTOR_SECTIONS_KEY = 'eaglemv.inspector.sections.v1';
const INSPECTOR_SECTION_KEYS = Object.freeze(['tags', 'folders', 'annotations', 'information']);
function readInspectorSections() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(INSPECTOR_SECTIONS_KEY) || '{}') || {}; } catch {}
  const order = (Array.isArray(stored.order) ? stored.order : []).filter((key, index, keys) => INSPECTOR_SECTION_KEYS.includes(key) && keys.indexOf(key) === index);
  for (const key of INSPECTOR_SECTION_KEYS) if (!order.includes(key)) order.splice(Math.min(INSPECTOR_SECTION_KEYS.indexOf(key), order.length), 0, key);
  const collapsed = Object.fromEntries(INSPECTOR_SECTION_KEYS.map(key => [key, stored.collapsed?.[key] === true]));
  return { order, collapsed };
}
function applyInspectorSections(sections = readInspectorSections()) {
  for (const container of document.querySelectorAll('[data-inspector-sections]')) {
    for (const key of sections.order) {
      const section = container.querySelector(`:scope > [data-inspector-section="${key}"]`);
      if (section) container.append(section);
    }
  }
  for (const section of document.querySelectorAll('[data-inspector-section]')) {
    const folded = sections.collapsed[section.dataset.inspectorSection];
    section.classList.toggle('collapsed', folded);
    section.querySelector('[data-section-toggle]')?.setAttribute('aria-expanded', String(!folded));
  }
}
function saveInspectorSections(patch) {
  const sections = { ...readInspectorSections(), ...patch };
  try { localStorage.setItem(INSPECTOR_SECTIONS_KEY, JSON.stringify(sections)); } catch {}
  applyInspectorSections(sections);
}

function bindInspectorSections() {
  applyInspectorSections();
  window.addEventListener('storage', event => {
    if (event.key === INSPECTOR_SECTIONS_KEY) applyInspectorSections();
  });
  // A heading moved 10px or more drags its block (Eagle's sortable uses the
  // same distance); a plain click folds it.
  let drag = null;
  let draggedJustNow = false;
  const clearMarks = () => {
    for (const section of document.querySelectorAll('[data-inspector-section].drop-before, [data-inspector-section].drop-after, [data-inspector-section].section-dragging')) {
      section.classList.remove('drop-before', 'drop-after', 'section-dragging');
    }
  };
  document.addEventListener('pointerdown', event => {
    const toggle = event.target.closest?.('[data-section-toggle]');
    // A finger on a heading scrolls the drawer instead (phones, tablets).
    if (!toggle || event.button !== 0 || event.pointerType === 'touch') return;
    const section = toggle.closest('[data-inspector-section]');
    drag = { section, container: section.parentElement, x: event.clientX, y: event.clientY, active: false, target: null };
  });
  document.addEventListener('pointermove', event => {
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 10) return;
      drag.active = true;
      drag.section.classList.add('section-dragging');
    }
    event.preventDefault();
    const others = [...drag.container.querySelectorAll(':scope > [data-inspector-section]')].filter(section => section !== drag.section && section.offsetParent);
    const over = others.find(section => {
      const box = section.getBoundingClientRect();
      return event.clientY >= box.top && event.clientY < box.bottom;
    }) || (others.length && event.clientY < others[0].getBoundingClientRect().top ? others[0] : others.at(-1));
    for (const section of others) section.classList.remove('drop-before', 'drop-after');
    if (!over) return;
    const box = over.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    over.classList.add(after ? 'drop-after' : 'drop-before');
    drag.target = { key: over.dataset.inspectorSection, after };
  });
  const finish = () => {
    const finished = drag;
    drag = null;
    clearMarks();
    if (!finished?.active) return;
    draggedJustNow = true;
    setTimeout(() => { draggedJustNow = false; }, 0);
    if (!finished.target) return;
    const moving = finished.section.dataset.inspectorSection;
    const order = readInspectorSections().order.filter(key => key !== moving);
    order.splice(order.indexOf(finished.target.key) + (finished.target.after ? 1 : 0), 0, moving);
    saveInspectorSections({ order });
  };
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', () => { drag = null; clearMarks(); });
  document.addEventListener('click', event => {
    const toggle = event.target.closest?.('[data-section-toggle]');
    if (!toggle) return;
    if (draggedJustNow) return;
    const key = toggle.dataset.sectionToggle;
    const sections = readInspectorSections();
    saveInspectorSections({ collapsed: { ...sections.collapsed, [key]: !sections.collapsed[key] } });
  });
}

// 导出 at the foot of 基本信息 opens Eagle's export menu, with the one kind
// MultiView can do (素材包, 指定格式或尺寸 and CSV are not available).
function openInspectorExportMenu(event) {
  event.stopPropagation();
  const ids = [...state.selected];
  if (!ids.length || !hasCapability('export')) return;
  const box = event.currentTarget.getBoundingClientRect();
  showContextMenuAt(box.left, box.bottom + 4, { kind: 'inspector-export', ids, paneId: state.activePaneId });
}

function renderMultiSelection(count) {
  const items = selectedItemsInOrder();
  $('#multiCount').textContent = count.toLocaleString();
  $('#multiCountLine').classList.toggle('warning', count >= BULK_CONFIRM_THRESHOLD);
  $('#multiPreview').innerHTML = items.slice(0, 5).map((item, index) =>
    `<img src="${mediaURL('thumb', item.id)}" alt="" style="--stack-index:${index}" draggable="false">`
  ).join('');
  $('#multiPreview').dataset.count = String(Math.min(items.length, 5));
  const summary = currentSelectionSummary();
  const pending = !summary;
  const annotation = summary?.annotation || { value: '', mixed: false };
  const url = summary?.url || { value: '', mixed: false };
  const annotationField = $('#batchAnnotation');
  const urlField = $('#batchURL');
  if (document.activeElement !== annotationField) {
    annotationField.value = annotation.value;
    resizeTextarea(annotationField);
  }
  if (document.activeElement !== urlField) {
    urlField.value = url.value;
    urlField.placeholder = url.mixed ? '多个链接' : 'http://';
  }
  renderSharedTags();
  $('#batchFolderChips').innerHTML = inspectorFolderChipsHTML(summary?.folders || []);
  const star = summary?.star || { value: 0, mixed: false };
  $('#batchStars').innerHTML = inspectorStarsHTML(star.value);
  $('#batchStars').dataset.rating = String(star.value);
  const totalSize = summary?.size || 0;
  $('#batchExportButton').hidden = !hasCapability('export');
  $('#batchMeta').innerHTML = pending
    ? '<span><em>文件大小</em>计算中…</span>'
    : totalSize > 0 ? `<span><em>文件大小</em>${formatBytes(totalSize)}</span>` : '';
}

// Applies one inspector field to every selected item, through the same
// field-level conflict check the single-item save uses.
async function setSelectionFields(payload) {
  const paneId = payload?.paneId || state.activePaneId;
  const pane = paneById(paneId);
  const ids = payload?.ids || [...(pane?.selected || [])];
  const patch = payload?.patch || {};
  if (!pane || !ids.length || !state.connected || !Object.keys(patch).length) return false;
  const libraryPath = state.library?.path;
  let operationToken = beginForegroundOperation('正在批量修改…', { key: `fields:${paneId}` });
  if (!operationToken) return false;
  const selectionBefore = new Set(pane.selected);
  // A field committed on blur may land after a click already moved the
  // selection; the new selection then stays as the user left it.
  const editsSelection = sameSelection(pane, new Set(ids));
  setSyncStatus('正在批量修改…');
  try {
    const outcome = await runItemBatch(ids, async id => {
      const item = pane.itemMap?.get(id) || await window.eagleMV.getItem(id);
      const result = await window.eagleMV.mutate({ id, patch, base: item, libraryPath });
      if (result?.conflict) throw new Error('素材已在其他窗口发生变化');
      return result;
    }, 'Eagle 批量修改请求超时');
    if (!outcome.succeeded.length) throw outcome.firstError || new Error('没有素材完成修改');
    const next = outcome.failed.length
      ? outcome.failed
      : idsStillSelectable(pane, ids);
    if (editsSelection && settleBatchSelection(pane, selectionBefore, next) && state.activePaneId === paneId) renderInspector();
    endForegroundOperation(operationToken);
    operationToken = null;
    await refresh({ reset: true, preserveScroll: true, paneId });
    toast(outcome.failed.length
      ? `已修改 ${outcome.succeeded.length} 个素材 · ${outcome.failed.length} 个失败并保持选中${batchFailureReason(outcome)}`
      : (payload.successMessage || `已修改 ${outcome.succeeded.length} 个素材`), outcome.failed.length ? 4200 : 2400);
    return true;
  } catch (error) {
    toast(`修改失败：${error.message}`, 4000);
    return false;
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

function updateURLActions() {
  const url = String($('#itemURL')?.value || '').trim();
  const openButton = $('#openURLButton');
  const copyButton = $('#copyURLButton');
  if (openButton) openButton.disabled = !/^https?:\/\//i.test(url);
  if (copyButton) copyButton.disabled = !url;
}

// Compact layouts hide the inspector behind a drawer, so a selection would
// otherwise be invisible once the drawer closes. This strip keeps what is
// selected — and the way out of it — one thumb-reach from the grid.
function renderSelectionBar() {
  const bar = $('#selectionBar');
  if (!bar) return;
  const count = state.selected.size;
  // The preview has its own caption and controls, and a swipe there moves
  // past the selected item, so the strip steps aside until it closes.
  const visible = isCompactLayout() && count > 0 && !state.previewId;
  bar.classList.toggle('hidden', !visible);
  document.body.classList.toggle('selection-bar-open', visible);
  if (!visible) return;
  const single = count === 1 ? itemById([...state.selected][0]) : null;
  $('#selectionBarTitle').textContent = single ? `${single.name}.${single.ext}` : `已选 ${count.toLocaleString()} 个素材`;
  $('#selectionBarMeta').textContent = single
    ? `${single.width || 0}×${single.height || 0} · ${formatBytes(single.size)}`
    : '拖到文件夹可批量归类';
  $('#selectionBarPreview').classList.toggle('hidden', !single);
}

function renderInspector() {
  renderSelectionBar();
  const count = state.selected.size;
  $('#noSelection').classList.toggle('hidden', count !== 0);
  if (count) $('#categoryInspector').classList.add('hidden');
  $('#inspectorContent').classList.toggle('hidden', count !== 1);
  $('#multiSelection').classList.toggle('hidden', count < 2);
  if (count !== 1) inspectorShown = null;
  if (count >= 2) {
    const allDeleted = [...state.selected].every(id => itemById(id)?.isDeleted);
    $('#batchTrashButton').textContent = allDeleted ? '恢复素材' : '丢到回收站…';
    renderMultiSelection(count);
    state.selectedBase = null;
    state.inspectorDirty = false;
    state.inspectorEditing = false;
    clearInspectorAutoSave();
    state.commentsToken = (Number.isFinite(state.commentsToken) ? state.commentsToken : 0) + 1;
    state.comments = [];
    $('#itemComments').innerHTML = '<span class="muted">选择单个素材查看评论</span>';
    return;
  }
  if (count !== 1) {
    state.metadataToken = (Number.isFinite(state.metadataToken) ? state.metadataToken : 0) + 1;
    state.commentsToken = (Number.isFinite(state.commentsToken) ? state.commentsToken : 0) + 1;
    state.comments = [];
    $('#itemComments').innerHTML = '<span class="muted">选择单个素材查看评论</span>';
    $('#generationMetadataSection').classList.add('hidden');
    if (!renderCategoryInspector()) {
      $('#noSelection').innerHTML = '<div class="inspector-placeholder"><img src="brand-icon.png" alt=""></div><p>选择一个素材查看详情</p><small>多个窗口可以停留在不同文件夹和搜索结果中</small>';
    }
    state.selectedBase = null;
    state.inspectorDirty = false;
    state.inspectorEditing = false;
    clearInspectorAutoSave();
    return;
  }
  const id = [...state.selected][0];
  const item = itemById(id);
  if (!item) { inspectorShown = null; return; }
  if (state.selectedBase?.id !== id) {
    clearInspectorAutoSave();
    state.inspectorEditing = false;
  }
  state.selectedBase = structuredClone(item);
  state.inspectorDirty = false;
  $('#staleBanner').classList.add('hidden');
  delete $('#staleBanner').dataset.conflictDraftKey;
  $('#staleBanner').textContent = '此素材已在另一个窗口更新；保存时会检查冲突。';
  $('#itemName').value = item.name || '';
  setTagValues('item', item.tags || [], false);
  $('#itemRating').value = String(item.star || 0);
  $('#itemAnnotation').value = item.annotation || '';
  $('#itemURL').value = item.url || '';
  const draftKey = inspectorDraftKey(state.activePaneId, id);
  let draft = inspectorDrafts.get(draftKey);
  if (!draft) {
    try {
      draft = JSON.parse(localStorage.getItem('eaglemv.inspectorDraft.v1.' + draftKey) || 'null');
      if (draft?.values && draft?.base) inspectorDrafts.set(draftKey, draft);
      else draft = null;
    } catch { draft = null; }
  }
  if (draft) {
    state.selectedBase = structuredClone(draft.base);
    $('#itemName').value = draft.values.name;
    setTagValues('item', draft.values.tags, false);
    $('#itemRating').value = String(draft.values.star);
    $('#itemAnnotation').value = draft.values.annotation;
    $('#itemURL').value = draft.values.url;
    state.inspectorDirty = Object.keys(collectPatch()).length > 0;
    if (draft.error === 'conflict') showInspectorDraftConflict(draft);
    else if (draft.error) $('#staleBanner').classList.remove('hidden');
  }
  syncRatingPlaceholder();
  updateURLActions();
  resizeAnnotation();
  // A refresh that re-renders the item already shown (a rating, a tag,
  // another window's change) updates it in place: rebuilding the thumbnail,
  // re-reading the file's generation metadata (which hides the section and
  // collapses an open workflow) and blanking the comments would flash the
  // whole inspector for an edit that touched none of them (B2-05).
  const shown = inspectorShown;
  const sameItem = shown?.paneId === state.activePaneId && shown.libraryPath === state.library?.path && shown.id === id;
  const fileKey = JSON.stringify([item.modificationTime, item.size, item.ext]);
  inspectorShown = { paneId: state.activePaneId, libraryPath: state.library?.path, id, fileKey };
  const previewHTML = `<img src="${mediaURL('thumb', item.id)}" alt="${escapeHTML(item.name)}">${item.ext ? `<span class="preview-format-badge">${escapeHTML(itemFormat(item))}</span>` : ''}`;
  if (!sameItem || shown.previewHTML !== previewHTML) $('#previewBox').innerHTML = previewHTML;
  inspectorShown.previewHTML = previewHTML;
  renderItemPalette(item);
  // Eagle's 基本信息 order; 尺寸 only for files that have pixels, 时长 only
  // for timed media.
  const duration = formatMediaDuration(item.duration);
  const dates = itemDates(item);
  $('#itemMeta').innerHTML = [
    Number(item.width) > 0 ? ['尺寸', `${item.width} × ${item.height || 0}`] : null,
    duration ? ['时长', duration] : null,
    ['文件大小', formatBytes(item.size)],
    ['格式', String(item.ext || '').toUpperCase()],
    ['添加日期', formatDateTime(dates.added)],
    ['创建日期', formatDateTime(dates.created)],
    ['修改日期', formatDateTime(dates.modified)]
  ].filter(Boolean).map(([label, value]) => `<span title="${escapeHTML(value)}"><em>${label}</em>${escapeHTML(value)}</span>`).join('');
  $('#itemFolderChips').innerHTML = inspectorFolderChipsHTML(item.folders);
  if (!sameItem || shown.fileKey !== fileKey) loadGenerationMetadata(item);
  $('#customThumbnailButton').disabled = !state.connected;
  $('#itemExportButton').hidden = !hasCapability('export');
  loadComments(item, { quiet: sameItem });
  $('#trashButton').textContent = item.isDeleted ? '恢复素材' : '丢到回收站…';
  const canPin = state.currentView.kind === 'folder';
  $('#pinButton').disabled = !canPin || !state.connected;
  $('#pinButton').textContent = canPin && itemIsPinned(item) ? '取消置顶' : '置顶';
  $('#pinButton').title = canPin ? '在当前文件夹内置顶；会同步到所有 MultiView 窗口' : '与 Eagle 原版一致，置顶只在普通文件夹中可用';
  if (!draft) offerInspectorDraftRecovery(id);
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
  state.commentsToken = (Number.isFinite(state.commentsToken) ? state.commentsToken : 0) + 1;
  const token = state.commentsToken;
  // A quiet reload keeps the comments on screen until the new ones arrive.
  if (!context.quiet) $('#itemComments').innerHTML = '<span class="muted">正在读取…</span>';
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
  const annotation = await askText({ title: '添加评论', fieldLabel: '评论内容', submitLabel: '添加' });
  if (annotation === null || !annotation.trim()) return;
  const item = pane.items.find(candidate => candidate.id === id);
  const payload = { id, libraryPath, annotation: annotation.trim() };
  const ext = String(item?.ext || '').toLowerCase();
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv'].includes(ext)) {
    const duration = await askText({ title: '评论时间点', fieldLabel: '视频时间点（秒），留空为普通评论', placeholder: '例如 12.5', allowEmpty: true, maxLength: 32 });
    if (duration === null) return;
    if (duration?.trim()) {
      const value = Number(duration);
      if (!Number.isFinite(value) || value < 0) { toast('时间点必须是大于等于 0 的数字', 3000); return; }
      payload.duration = value;
    }
  } else if (isImageItem(item)) {
    const rect = await askText({ title: '评论框选区域', fieldLabel: '框选坐标 x,y,width,height，留空为普通评论', placeholder: '例如 10,20,200,120', allowEmpty: true, maxLength: 80 });
    if (rect === null) return;
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
  const annotation = await askText({ title: '编辑评论', fieldLabel: '评论内容', initialValue: comment.annotation || '', submitLabel: '保存' });
  if (annotation === null || !annotation.trim() || annotation.trim() === String(comment.annotation || '').trim()) return;
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
  if (window.eagleMV.thumbnailOperation) return thumbnailFeatureUI().run('file');
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

const METADATA_ZOOM_MIN = 80;
const METADATA_ZOOM_MAX = 200;
const METADATA_ZOOM_STEP = 10;
const METADATA_ZOOM_DEFAULT = 100;
const METADATA_HEIGHT_MIN = 148;
const METADATA_HEIGHT_MAX = 720;
const METADATA_ZOOM_KEY = 'eaglemv.metadataViewerZoom';
const METADATA_HEIGHT_KEY = 'eaglemv.metadataViewerHeight';
let metadataViewerFocused = false;
let metadataViewerZoom = METADATA_ZOOM_DEFAULT;

function metadataViewerSection() { return $('#generationMetadataSection'); }

function metadataViewerIsFocused(event = null) {
  const section = metadataViewerSection();
  // A multi-select hides the single-item inspector around the viewer without
  // touching the viewer's own class, so check it is really on screen (B2-15).
  if (!section || section.classList.contains('hidden') || !section.offsetParent) return false;
  return metadataViewerFocused || section.contains(document.activeElement) || Boolean(event?.target && section.contains(event.target));
}

function clampMetadataZoom(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return METADATA_ZOOM_DEFAULT;
  return Math.max(METADATA_ZOOM_MIN, Math.min(METADATA_ZOOM_MAX, Math.round(number / METADATA_ZOOM_STEP) * METADATA_ZOOM_STEP));
}

function applyMetadataZoom(value, { persist = true } = {}) {
  const clamped = clampMetadataZoom(value);
  const section = metadataViewerSection();
  section?.style.setProperty('--metadata-zoom', String(clamped / 100));
  metadataViewerZoom = clamped;
  if (persist) {
    try { localStorage.setItem(METADATA_ZOOM_KEY, String(clamped)); } catch {}
  }
  return clamped;
}

function changeMetadataZoom(direction) {
  const current = metadataViewerZoom;
  return applyMetadataZoom(current + Math.sign(Number(direction) || 0) * METADATA_ZOOM_STEP);
}

function resetMetadataZoom() { return applyMetadataZoom(METADATA_ZOOM_DEFAULT); }

function clampMetadataHeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(METADATA_HEIGHT_MIN, Math.min(METADATA_HEIGHT_MAX, Math.round(number)));
}

function applyMetadataViewerHeight(value, { persist = true } = {}) {
  const clamped = clampMetadataHeight(value);
  const section = metadataViewerSection();
  if (!section || clamped === null) return null;
  section.style.setProperty('--metadata-viewer-height', `${clamped}px`);
  const handle = $('#metadataResizeHandle');
  handle?.setAttribute('aria-valuenow', String(clamped));
  if (persist) {
    try { localStorage.setItem(METADATA_HEIGHT_KEY, String(clamped)); } catch {}
  }
  return clamped;
}

function bindMetadataViewerControls() {
  const section = metadataViewerSection();
  const handle = $('#metadataResizeHandle');
  if (!section || !handle) return;
  section.addEventListener('pointerdown', event => {
    metadataViewerFocused = true;
    state.inspectorEditing = false;
    if (event.target === section) event.preventDefault();
  });
  handle.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = section.getBoundingClientRect().height;
    const next = event.key === 'Home' ? METADATA_HEIGHT_MIN
      : event.key === 'End' ? METADATA_HEIGHT_MAX
        : current + (event.key === 'ArrowDown' ? 24 : -24);
    applyMetadataViewerHeight(next);
  });
  handle.addEventListener('pointerdown', event => {
    event.preventDefault();
    event.stopPropagation();
    metadataViewerFocused = true;
    state.inspectorEditing = false;
    const startY = event.clientY;
    const startHeight = section.getBoundingClientRect().height;
    handle.classList.add('dragging');
    try { handle.setPointerCapture?.(event.pointerId); } catch {}
    const move = moveEvent => applyMetadataViewerHeight(startHeight + moveEvent.clientY - startY, { persist: false });
    const end = () => {
      handle.classList.remove('dragging');
      try { handle.releasePointerCapture?.(event.pointerId); } catch {}
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      applyMetadataViewerHeight(section.getBoundingClientRect().height);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  try {
    const storedZoom = localStorage.getItem(METADATA_ZOOM_KEY);
    const zoom = Number(storedZoom);
    applyMetadataZoom(storedZoom !== null && Number.isFinite(zoom) ? zoom : METADATA_ZOOM_DEFAULT, { persist: false });
    const storedHeight = localStorage.getItem(METADATA_HEIGHT_KEY);
    const height = Number(storedHeight);
    if (storedHeight !== null && Number.isFinite(height)) applyMetadataViewerHeight(height, { persist: false });
  } catch {
    applyMetadataZoom(METADATA_ZOOM_DEFAULT, { persist: false });
  }
}

function resizeTextarea(field) {
  if (!field) return;
  field.style.height = 'auto';
  field.style.height = `${Math.max(field.scrollHeight, 38)}px`;
}

function resizeAnnotation() {
  resizeTextarea($('#itemAnnotation'));
}

// The stars mirror the hidden #itemRating select, which the save, the draft
// and the conflict recovery all read.
function syncRatingPlaceholder() {
  const stars = $('#itemStars');
  if (!stars) return;
  const rating = Number($('#itemRating').value) || 0;
  stars.innerHTML = inspectorStarsHTML(rating);
  stars.dataset.rating = String(rating);
}

function renderGenerationMetadata(metadata) {
  const section = $('#generationMetadataSection');
  if (!metadata) {
    section.classList.add('hidden');
    metadataViewerFocused = false;
    section.dataset.positive = '';
    section.dataset.negative = '';
    $('#generationMetadata').replaceChildren();
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
  const characterHTML = (Array.isArray(metadata.characters) ? metadata.characters : []).map(character =>
    metadataPromptBlock(`角色 ${escapeHTML(character.index)} 提示词`, character.positive, 'character')
  ).join('');
  $('#generationMetadata').innerHTML = `${metadataPromptBlock('正向提示词', metadata.positive, 'positive')}${characterHTML}${metadataPromptBlock('负向提示词', metadata.negative, 'negative')}${parameterHTML}${loraHTML}${workflowHTML}`;
  applyMetadataZoom(metadataViewerZoom, { persist: false });
  section.classList.remove('hidden');
}

let generationMetadataAbort = null;
const stealthMetadataCache = new Map();
const STEALTH_METADATA_SETTLE_MS = 150;
async function loadGenerationMetadata(item) {
  generationMetadataAbort?.abort();
  const controller = new AbortController();
  generationMetadataAbort = controller;
  state.metadataToken = (Number.isFinite(state.metadataToken) ? state.metadataToken : 0) + 1;
  const token = state.metadataToken;
  $('#generationMetadataSection').classList.add('hidden');
  metadataViewerFocused = false;
  if (!isImageItem(item)) return;
  try {
    const result = await window.eagleMV.readMetadata(item.id);
    if (token !== state.metadataToken || state.selected.size !== 1 || !state.selected.has(item.id)) return;
    let metadata = result?.metadata || null;
    if (!metadata && ['png', 'webp'].includes(String(item.ext).toLowerCase())) {
      const url = mediaURL('original', item.id);
      const key = JSON.stringify([state.library?.path, url, item.modificationTime, item.size]);
      if (stealthMetadataCache.has(key)) metadata = stealthMetadataCache.get(key);
      else {
        // Arrow-key browsing settles before an original is decoded.
        await new Promise(resolve => setTimeout(resolve, STEALTH_METADATA_SETTLE_MS));
        if (controller.signal.aborted || token !== state.metadataToken || state.selected.size !== 1 || !state.selected.has(item.id)) return;
        const imageURL = url + `?metadata=${encodeURIComponent(JSON.stringify([item.modificationTime, item.size]))}`;
        const result = await window.EagleMVStealthMetadata.inspectImage(imageURL, { signal: controller.signal });
        if (controller.signal.aborted || token !== state.metadataToken || state.selected.size !== 1 || !state.selected.has(item.id)) return;
        metadata = result?.text ? window.EagleMVNovelAIMetadata.parseStealthText(result.text) : null;
        // Images without a payload are remembered too, so revisiting them is free.
        if (result) {
          if (stealthMetadataCache.size >= 500) stealthMetadataCache.delete(stealthMetadataCache.keys().next().value);
          stealthMetadataCache.set(key, metadata);
        }
      }
    }
    if (token !== state.metadataToken || state.selected.size !== 1 || !state.selected.has(item.id)) return;
    renderGenerationMetadata(metadata);
  } catch {
    if (token === state.metadataToken) renderGenerationMetadata(null);
  }
}

function markDirty() {
  state.inspectorDirty = Object.keys(collectPatch()).length > 0;
  captureInspectorDraft();
  if (state.inspectorDirty) queueInspectorAutoSave();
  else clearInspectorAutoSave();
  if (!state.inspectorDirty && !$('#staleBanner').classList.contains('hidden')) renderInspector();
}

function clearInspectorAutoSave() {
  if (state.inspectorAutoSaveTimer) clearTimeout(state.inspectorAutoSaveTimer);
  state.inspectorAutoSaveTimer = null;
}

const inspectorComposingControls = new Set();

const INSPECTOR_AUTOSAVE_DELAY = 3000;

function queueInspectorAutoSave({ immediate = false } = {}) {
  clearInspectorAutoSave();
  if (!state.inspectorDirty || !state.connected || state.inspectorSaving || inspectorComposingControls.size) return;
  if (immediate) {
    saveInspector();
    return;
  }
  state.inspectorAutoSaveTimer = setTimeout(() => {
    state.inspectorAutoSaveTimer = null;
    if (state.inspectorDirty && !state.inspectorSaving) saveInspector();
  }, INSPECTOR_AUTOSAVE_DELAY);
}

// Eagle keeps a name's or link's edge spaces until that field itself is
// edited (B2-12): an untouched field reports its stored value, so editing only
// the note never trims and renames the item.
function inspectorFormValues(base) {
  const edited = (raw, stored) => (raw === (stored ?? '') ? stored ?? '' : raw.trim());
  return {
    name: edited($('#itemName').value, base?.name),
    tags: [...state.draftTags],
    star: Number($('#itemRating').value),
    annotation: $('#itemAnnotation').value,
    url: edited($('#itemURL').value, base?.url)
  };
}

function collectPatch() {
  const base = state.selectedBase;
  if (!base) return {};
  const values = inspectorFormValues(base);
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
  // Auto-save must stay invisible to the editor. Disabling a focused control
  // makes Chromium blur it immediately, and the next Backspace then falls
  // through to the workspace trash shortcut. Keep the live form editable;
  // saveInspector owns an immutable patch and queues anything typed in-flight.
  $('#paneLayoutButton').disabled = state.inspectorSaving;
  for (const option of $('#paneLayoutPopover').querySelectorAll('[data-layout]')) option.disabled = state.inspectorSaving;
  $('#inspectorContent').classList.toggle('saving', state.inspectorSaving);
}

const inspectorDrafts = new Map();
function inspectorDraftKey(paneId, id, libraryPath = state.library?.path) {
  return JSON.stringify([textWindowKey, libraryPath, paneId, id]);
}
function persistInspectorDraft(draft, remove = false) {
  try {
    const key = 'eaglemv.inspectorDraft.v1.' + draft.key;
    if (remove) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ key: draft.key, id: draft.id, paneId: draft.paneId, libraryPath: draft.libraryPath, base: draft.base, values: draft.values, fieldVersions: draft.fieldVersions, revision: draft.revision, error: draft.error }));
    draft.storageError = false;
    return true;
  } catch {
    draft.storageError = true;
    toast('素材草稿备份失败；请保持窗口开启直至保存成功', 4400);
    return false;
  }
}
function offerInspectorDraftRecovery(id) {
  const current = state.selectedBase;
  let source;
  let sourceStorageKey;
  try {
    const obsolete = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith('eaglemv.inspectorDraft.v1.')) continue;
      const candidate = JSON.parse(localStorage.getItem(key) || 'null');
      if (!(candidate?.id === id && candidate.libraryPath === state.library?.path && candidate.values && candidate.base
        && candidate.key !== inspectorDraftKey(state.activePaneId, id))) continue;
      // A copy that matches Eagle's current values has nothing left to
      // recover; offering it again would only stage a false conflict.
      if (current?.id === id && !Object.keys(inspectorDraftPatch({ values: candidate.values, base: current })).length) {
        if (!inspectorDrafts.has(candidate.key)) obsolete.push(key);
        continue;
      }
      if (!source) { source = candidate; sourceStorageKey = key; }
    }
    for (const key of obsolete) localStorage.removeItem(key);
  } catch {}
  if (!source) return;
  const paneId = state.activePaneId;
  const banner = $('#staleBanner');
  delete banner.dataset.conflictDraftKey;
  banner.classList.remove('hidden');
  banner.innerHTML = '<span>其他编辑会话有本地素材信息草稿。</span><button type="button" class="small-action" data-draft-action="recover">恢复草稿副本</button><button type="button" class="small-action" data-draft-action="discard">丢弃</button>';
  const stillHere = () => state.activePaneId === paneId && state.library?.path === source.libraryPath && state.selected.has(id);
  banner.querySelector('[data-draft-action="recover"]').addEventListener('click', () => {
    if (!stillHere()) return;
    if (state.inspectorDirty && !confirm('恢复草稿将替换当前未保存的素材信息，是否继续？')) return;
    const draft = { ...structuredClone(source), key: inspectorDraftKey(paneId, id), paneId, saving: null, revision: 1 };
    inspectorDrafts.set(draft.key, draft);
    // The copy moves to this pane; leaving the source would offer it again
    // after saving, with a stale base that turns into a false conflict.
    if (persistInspectorDraft(draft)) {
      try { localStorage.removeItem(sourceStorageKey); } catch {}
    }
    renderInspector();
  });
  banner.querySelector('[data-draft-action="discard"]').addEventListener('click', () => {
    if (!stillHere() || !confirm('丢弃这份素材信息草稿？丢弃后无法恢复。')) return;
    try { localStorage.removeItem(sourceStorageKey); } catch {}
    banner.classList.add('hidden');
  });
}
function captureInspectorDraft() {
  const pane = activePane();
  if (pane?.selected.size !== 1 || !pane.selectedBase) return null;
  const id = [...pane.selected][0];
  const key = inspectorDraftKey(pane.id, id);
  let draft = inspectorDrafts.get(key);
  if (!draft) {
    if (!state.inspectorDirty) return null;
    draft = { key, id, paneId: pane.id, libraryPath: state.library?.path, base: structuredClone(pane.selectedBase), revision: 0 };
    inspectorDrafts.set(key, draft);
  }
  const values = inspectorFormValues(draft.base);
  draft.fieldVersions ||= {};
  for (const [field, value] of Object.entries(values)) {
    if (!inspectorValuesEqual(value, (draft.values || draft.base)[field])) {
      draft.fieldVersions[field] = (draft.fieldVersions[field] || 0) + 1;
    }
  }
  draft.values = values;
  draft.composing = inspectorComposingControls.size > 0;
  draft.revision += 1;
  persistInspectorDraft(draft);
  return draft;
}
function inspectorValuesEqual(value, reference) {
  const base = reference ?? (Array.isArray(value) ? [] : typeof value === 'number' ? 0 : '');
  return JSON.stringify(Array.isArray(value) ? [...value].sort() : value) === JSON.stringify(Array.isArray(base) ? [...base].sort() : base);
}
function inspectorMetadataChanged(item, base = state.selectedBase) {
  if (!item || !base || item.id !== base.id) return false;
  // Eagle can settle derived timestamps after its update ACK. Only a change
  // to the editable values relative to the user's accepted baseline is stale
  // inspector content; object key order and lastModified are not edits.
  return ['name', 'tags', 'star', 'annotation', 'url'].some(field => {
    const value = item[field] ?? (field === 'tags' ? [] : field === 'star' ? 0 : '');
    return !inspectorValuesEqual(value, base[field]);
  });
}
function inspectorDraftPatch(draft) {
  return Object.fromEntries(Object.entries(draft.values).filter(([key, value]) => !inspectorValuesEqual(value, draft.base[key])));
}
function showInspectorDraftConflict(draft) {
  const banner = $('#staleBanner');
  banner.dataset.conflictDraftKey = draft.key;
  banner.classList.remove('hidden');
  banner.innerHTML = '<span>外部内容已变化，你的草稿已保留。</span><button type="button" class="small-action" data-draft-action="reload">载入最新</button><button type="button" class="small-action" data-draft-action="overwrite">以草稿覆盖</button>';
  const current = () => state.library?.path === draft.libraryPath && state.activePaneId === draft.paneId && state.selected.size === 1 && state.selected.has(draft.id);
  banner.querySelector('[data-draft-action="overwrite"]').addEventListener('click', () => {
    if (current() && confirm('以当前草稿覆盖发生冲突的字段？其他未编辑字段不会覆盖。')) saveInspector(true);
  });
  banner.querySelector('[data-draft-action="reload"]').addEventListener('click', async () => {
    if (!current() || !confirm('放弃当前素材信息草稿并载入最新内容？')) return;
    try {
      const item = await window.eagleMV.getItem(draft.id);
      if (!item || !current()) return;
      const pane = paneById(draft.paneId);
      const index = pane.items.findIndex(candidate => candidate.id === draft.id);
      if (index >= 0) pane.items[index] = item;
      inspectorDrafts.delete(draft.key);
      persistInspectorDraft(draft, true);
      renderInspector();
    } catch (error) { toast(`载入失败，草稿已保留：${error.message}`, 4000); }
  });
}

async function saveInspector(force = false) {
  if (inspectorComposingControls.size) return false;
  const draft = captureInspectorDraft();
  if (!draft) return true;
  if (draft.error === 'conflict' && !force) {
    showInspectorDraftConflict(draft);
    return false;
  }
  if (draft.saving) return draft.saving;
  draft.saving = Promise.resolve().then(() => saveInspectorDraft(draft, force));
  return draft.saving;
}

async function saveInspectorDraft(draft, force = false) {
  const { paneId, id, libraryPath } = draft;
  const pane = paneById(paneId);
  let patch = inspectorDraftPatch(draft);
  if (!id || !Object.keys(patch).length) {
    draft.saving = null;
    inspectorDrafts.delete(draft.key);
    persistInspectorDraft(draft, true);
    state.inspectorDirty = false;
    clearInspectorAutoSave();
    return true;
  }
  clearInspectorAutoSave();
  let base = structuredClone(draft.base);
  let overwrite = Boolean(force);
  const operationToken = beginForegroundOperation('正在安全保存素材信息…', { key: `inspector-save:${draft.key}` });
  if (!operationToken) return false;
  setInspectorSaving(true);
  setSyncStatus('正在安全保存…');
  try {
    while (true) {
      const sentFieldVersions = { ...draft.fieldVersions };
      const result = await window.eagleMV.mutate({ id, patch, base, force: overwrite, libraryPath });
      if (state.library?.path !== libraryPath) throw new Error('Eagle 已切换资源库，旧资源库的保存结果已忽略');
      if (result.conflict) {
        draft.error = 'conflict';
        persistInspectorDraft(draft);
        if (state.activePaneId === paneId && pane.selected.has(id)) showInspectorDraftConflict(draft);
        toast('素材信息存在外部修改；你的输入已保留，请核对后再保存', 4400);
        return false;
      }
      const index = pane?.items.findIndex(item => item.id === id) ?? -1;
      if (index >= 0) pane.items[index] = result.item;
      // An ACK authorizes a new edit baseline only for our own sent fields.
      // A field first edited in-flight must retain the value the user saw;
      // otherwise an unseen remote change would be silently accepted as its
      // baseline and the next request could overwrite it without conflict.
      const nextBase = structuredClone(result.item);
      for (const [field, value] of Object.entries(draft.values)) {
        const editedInFlight = (draft.fieldVersions?.[field] || 0) !== (sentFieldVersions[field] || 0);
        const wasSent = Object.prototype.hasOwnProperty.call(patch, field);
        if (editedInFlight && (wasSent || !inspectorValuesEqual(value, draft.base[field]))) {
          if (!wasSent) nextBase[field] = structuredClone(draft.base[field] ?? (Array.isArray(value) ? [] : typeof value === 'number' ? 0 : ''));
          continue;
        }
        // Reverting an unsent field to its edit origin cancels that intent.
        // Adopt and show the remote value instead of clearing dirty while
        // leaving the old value on screen. Reverting a sent field stays above.
        draft.values[field] = structuredClone(result.item[field] ?? (Array.isArray(value) ? [] : typeof value === 'number' ? 0 : ''));
      }
      draft.base = nextBase;
      draft.error = null;
      const contextStillActive = state.activePaneId === paneId
        && pane?.selected.size === 1
        && pane.selected.has(id)
        && state.library?.path === libraryPath;
      if (contextStillActive) {
        pane.selectedBase = structuredClone(draft.base);
        for (const [field, selector] of Object.entries({ name: '#itemName', star: '#itemRating', annotation: '#itemAnnotation', url: '#itemURL' })) {
          const control = $(selector);
          if (inspectorComposingControls.has(control)) continue;
          const displayedValue = field === 'name' || field === 'url' ? control.value.trim() : control.value;
          if (displayedValue !== String(draft.values[field])) control.value = String(draft.values[field]);
        }
        if (!inspectorValuesEqual(state.draftTags, draft.values.tags)) setTagValues('item', draft.values.tags, false);
        syncRatingPlaceholder();
        updateURLActions();
        resizeAnnotation();
        state.inspectorDirty = Object.keys(collectPatch()).length > 0;
        // Clear only the passive notice once this ACK has reconciled the
        // editable baseline. Conflict/recovery action panels remain intact.
        const banner = $('#staleBanner');
        if (!inspectorMetadataChanged(itemById(id), pane.selectedBase) && !banner.querySelector('[data-draft-action]')) {
          banner.classList.add('hidden');
        }
        renderGrid();
      } else {
        schedulePaneGridRender(paneId);
      }
      patch = inspectorDraftPatch(draft);
      // An earlier save can finish while the user is choosing an IME
      // candidate. Keep that draft, but never send its uncommitted text.
      if (draft.composing) {
        persistInspectorDraft(draft);
        return true;
      }
      if (Object.keys(patch).length) {
        persistInspectorDraft(draft);
        base = structuredClone(draft.base);
        overwrite = false;
        continue;
      }
      if (contextStillActive && inspectorDrafts.get(draft.key) === draft) {
        const banner = $('#staleBanner');
        if (banner.dataset.conflictDraftKey === draft.key && banner.querySelector('[data-draft-action="overwrite"]')
          && !inspectorMetadataChanged(itemById(id), pane.selectedBase)) {
          // Only this draft's fully acknowledged conflict is resolved. A
          // queued edit can still conflict above; recovery belongs elsewhere.
          banner.classList.add('hidden');
          banner.textContent = '此素材已在另一个窗口更新；保存时会检查冲突。';
          delete banner.dataset.conflictDraftKey;
        }
      }
      inspectorDrafts.delete(draft.key);
      persistInspectorDraft(draft, true);
      return true;
    }
  } catch (error) {
    draft.error = error.message;
    persistInspectorDraft(draft);
    toast(`保存失败：${error.message}`, 4000);
    return false;
  } finally {
    draft.saving = null;
    setInspectorSaving([...inspectorDrafts.values()].some(other => other !== draft && other.saving));
    setSyncStatus(draft.error ? '仍有待保存草稿' : '所有窗口已同步');
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
    const pins = await window.eagleMV.setPins({
      libraryPath,
      folderId,
      ids,
      pinned,
      syncToEagle: true,
      eaglePins: Object.fromEntries(ids.map(id => [id, pane.itemMap.get(id)?.pinned?.[folderId] ?? null]))
    });
    // The reply is the old library's pin table once the library has switched.
    if (state.library?.path !== libraryPath) return;
    state.localPins = pins;
    if (paneById(paneId)) schedulePaneGridRender(paneId);
    if (state.activePaneId === paneId) renderInspector();
    toast(pinned ? `已置顶 ${ids.length} 个素材，并同步到 Eagle` : `已取消置顶，并同步到 Eagle`);
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

// Menu commands arrive over IPC, past the keydown guard, so each one checks
// for itself that nothing modal covers the workspace it would act on (F-05).
// An open context menu just gives way, as a native one would.
function whenWorkspaceFree(handler) {
  return (...args) => {
    if (!$('#contextMenu').classList.contains('hidden')) hideContextMenu();
    if (blockingSurfaceOpen() || document.querySelector('dialog[open]')) {
      toast('请先完成或关闭当前对话框', 2200);
      return undefined;
    }
    return handler(...args);
  };
}

// Outside-click checks read the event path, fixed when the click was
// dispatched: a colour swatch or tag chip re-renders itself out of the DOM
// in its own handler, and target.closest() then found no panel and closed
// the filter popover under the user (B3-03).
function clickWithin(event, selector) {
  return event.composedPath().some(node => node instanceof Element && node.matches(selector));
}

function blockingSurfaceOpen() {
  return Boolean(document.querySelector('.web-copy-dialog[open], .feature-dialog[open]')) ||
    ['#folderDialog', '#trashDialog', '#duplicateDialog', '#contextMenu', '#webAccessDialog']
    .some(selector => !$(selector).classList.contains('hidden'));
}

function chooseDuplicateAction(duplicates, total) {
  const duplicateCount = duplicates.length;
  $('#duplicateDialogMessage').textContent = `${total} 个待导入文件中有 ${duplicateCount} 个与资源库已有素材内容相同。请选择使用现有素材，或仍然保留两份。`;
  $('#duplicateDialog').classList.remove('hidden');
  $('#duplicateUseExistingButton').focus();
  return new Promise(resolve => { state.duplicateDialogResolve = resolve; });
}

async function canRemoveFromCurrentFolder(ids, paneId = state.activePaneId) {
  const pane = paneById(paneId);
  const currentFolder = pane?.currentView.kind === 'folder' ? pane.currentView.id : null;
  if (!currentFolder) return false;
  const scope = paneFolderScope(pane, currentFolder);
  // The loaded items answer this for a folder view without reading the
  // tens of thousands a ⌘A past the loaded range may hold (P6-02).
  if (ids.some(id => folderScopeRemovable(pane.itemMap?.get(id)?.folders, scope))) return true;
  const results = await settleWithConcurrency([...new Set(ids)].filter(id => !pane.itemMap?.has(id)).slice(0, 200), id => withTimeout(
    window.eagleMV.getItem(id),
    15000,
    'Eagle 素材信息读取超时'
  ));
  const items = results.filter(result => result.ok).map(result => result.value);
  return items.some(item => folderScopeRemovable(item?.folders, scope));
}

function chooseTrashAction(ids) {
  // The same dialog also asks 删除文件夹 (chooseFolderRemoval).
  $('#trashDialogTitle').textContent = '删除素材';
  $('#trashDeleteButton').textContent = '删除素材';
  $('#trashDialogCheck').classList.add('hidden');
  $('#trashDialogMessage').textContent = `已选择 ${ids.length} 个素材。请选择只从当前文件夹移除，还是删除素材并移入回收站。`;
  $('#trashRemoveButton').classList.remove('hidden');
  $('#trashDialog').classList.remove('hidden');
  // Return must never delete by default; the destructive choice needs a click.
  $('#trashCancelButton').focus();
  return new Promise(resolve => { state.trashDialogResolve = resolve; });
}

async function applyTrash(ids, deleted, paneId = state.activePaneId) {
  if (!ids.length) return;
  const pane = paneById(paneId);
  if (!pane) return;
  // Items already in the requested state need no write and must not enter the
  // undo stack: ⌫ in the trash view would otherwise "delete" deleted items
  // and a later ⌘Z would restore them.
  const known = new Map(pane.items.map(item => [item.id, item]));
  ids = ids.filter(id => !known.has(id) || Boolean(known.get(id).isDeleted) !== Boolean(deleted));
  if (!ids.length) {
    toast(deleted ? '所选素材已在回收站中' : '所选素材不在回收站中', 2400);
    return;
  }
  const libraryPath = state.library?.path;
  const action = deleted ? '丢到回收站' : '恢复';
  const operationToken = beginForegroundOperation(`正在${action}…`, { key: `trash:${paneId}` });
  if (!operationToken) return;
  const selectionBefore = new Set(pane.selected);
  const successor = deleted && pane.currentView.kind !== 'trash' ? selectionSuccessor(pane, ids) : null;
  trashMutationInFlight += 1;
  // The lock covers the writes only; the refresh after them is a plain read.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    trashMutationInFlight -= 1;
    endForegroundOperation(operationToken);
  };
  setSyncStatus(`正在${action}…`);
  try {
    const outcome = await runItemBatch(ids, async id => {
      const item = pane.itemMap?.get(id) || await window.eagleMV.getItem(id);
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
    if (deleted) {
      trashUndoStack.push({ ids: outcome.succeeded, libraryPath, paneId, viewKey: descriptorKey(pane.currentView) });
      if (trashUndoStack.length > 20) trashUndoStack.shift();
    } else {
      for (const entry of trashUndoStack) entry.ids = entry.ids.filter(id => !outcome.succeeded.includes(id));
      for (let index = trashUndoStack.length - 1; index >= 0; index -= 1) {
        if (!trashUndoStack[index].ids.length) trashUndoStack.splice(index, 1);
      }
    }
    const ownsSelection = settleBatchSelection(pane, selectionBefore, outcome.failed);
    if (ownsSelection && state.activePaneId === paneId) renderInspector();
    release();
    await refresh({ reset: true, preserveScroll: true, paneId });
    if (ownsSelection && !outcome.failed.length) selectSuccessor(pane, successor, ids);
    const done = deleted ? `${outcome.succeeded.length} 个素材已丢到回收站` : `已恢复 ${outcome.succeeded.length} 个素材`;
    toast(outcome.failed.length
      ? `${done} · ${outcome.failed.length} 个失败并保持选中${batchFailureReason(outcome)}`
      : done, outcome.failed.length ? 4400 : 2400);
  } catch (error) {
    toast(`${action}失败：${error.message}`, 4000);
  } finally {
    setSyncStatus('所有窗口已同步');
    release();
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

async function mutateSelectionSet(ids, field, delta, message, paneId = state.activePaneId, { keepSelection = false, successMessage = null, selectNext = false } = {}) {
  if (!ids?.length || !state.connected) return false;
  const pane = paneById(paneId);
  if (!pane) return false;
  const successor = selectNext ? selectionSuccessor(pane, ids) : null;
  const libraryPath = state.library?.path;
  let operationToken = beginForegroundOperation(message, { key: `set:${paneId}:${field}` });
  if (!operationToken) return false;
  const selectionBefore = new Set(pane.selected);
  setSyncStatus(message);
  try {
    const outcome = await runItemBatch(ids, id => window.eagleMV.mutateSet({
      id, field, ...delta, libraryPath
    }), 'Eagle 批量修改请求超时');
    if (!outcome.succeeded.length) throw outcome.firstError || new Error('没有素材完成修改');
    const ownsSelection = settleBatchSelection(pane, selectionBefore, outcome.failed.length || !keepSelection ? outcome.failed : ids);
    if (ownsSelection && state.activePaneId === paneId) renderInspector();
    const settledSelection = new Set(pane.selected);
    endForegroundOperation(operationToken);
    operationToken = null;
    await refresh({ reset: true, preserveScroll: true, paneId });
    const visibleIds = new Set(pane.items.map(item => item.id));
    // Ids past the loaded range stay while the view has more (P6-02).
    const kept = id => visibleIds.has(id) || (pane.hasMore && pane.selected.has(id));
    if (ownsSelection && keepSelection && !outcome.failed.length
      && sameSelection(pane, new Set([...settledSelection].filter(kept)))) {
      pane.selected = new Set(ids.filter(kept));
      if (state.activePaneId === paneId) withActivePane(paneId, () => {
        updateCardSelectionStyles();
        renderInspector();
      });
    }
    if (ownsSelection && !outcome.failed.length) selectSuccessor(pane, successor, ids);
    toast(outcome.failed.length
      ? `已完成 ${outcome.succeeded.length} 个素材 · ${outcome.failed.length} 个失败并保持选中${batchFailureReason(outcome)}`
      : (successMessage || '操作已同步到所有窗口'), outcome.failed.length ? 4200 : 2400);
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
  // Eagle adds the folder's auto tags to items that newly join it (P1-10).
  const paneId = payload?.paneId || state.activePaneId;
  const completed = await mutateSelectionSet(payload.ids, 'folders', { add: [folderId], autoTags: 'joined' }, '正在加入文件夹…', paneId, {
    keepSelection: Boolean(payload?.keepSelection),
    selectNext: paneById(paneId)?.currentView.kind === 'unfiled'
  });
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
  const delta = folderMoveDelta(payload?.sourceFolderIds || paneFolderScope(pane, sourceFolderId), folderId);
  const successor = pane.currentView.kind === 'folder' && pane.currentView.id === sourceFolderId ? selectionSuccessor(pane, ids) : null;
  let operationToken = beginForegroundOperation('正在移动到文件夹…', { key: `move:${paneId}` });
  if (!operationToken) return;
  const selectionBefore = new Set(pane.selected);
  setSyncStatus('正在移动到文件夹…');
  try {
    const outcome = await runItemBatch(ids, id => window.eagleMV.mutateSet({
      id, field: 'folders', ...delta, autoTags: 'joined', libraryPath
    }), 'Eagle 移动请求超时');
    if (!outcome.succeeded.length) throw outcome.firstError || new Error('没有素材完成移动');
    const ownsSelection = settleBatchSelection(pane, selectionBefore, outcome.failed);
    if (ownsSelection && state.activePaneId === paneId) renderInspector();
    endForegroundOperation(operationToken);
    operationToken = null;
    await refresh({ reset: true, preserveScroll: true, paneId });
    if (ownsSelection && !outcome.failed.length) selectSuccessor(pane, successor, ids);
    toast(outcome.failed.length
      ? `已移动 ${outcome.succeeded.length} 个素材 · ${outcome.failed.length} 个失败并保持选中${batchFailureReason(outcome)}`
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
  const onScreen = pane?.currentView.kind === 'folder' && pane.currentView.id === folderId;
  return mutateSelectionSet(payload.ids, 'folders', { remove: paneFolderScope(pane, folderId) }, '正在从文件夹移除…', paneId, { selectNext: onScreen });
}

function addTagToSelection(payload) {
  const tags = normalizeTags(Array.isArray(payload?.tag) ? payload.tag : [payload?.tag]);
  if (!tags.length) return false;
  return mutateSelectionSet(payload.ids, 'tags', { add: tags }, '正在添加标签…', payload?.paneId || state.activePaneId, {
    keepSelection: true,
    successMessage: tags.length === 1 ? `已添加标签“${tags[0]}”` : `已添加 ${tags.length} 个标签`
  });
}

async function setSelectionRating(payload) {
  const rating = Math.max(0, Math.min(5, Number(payload?.rating) || 0));
  const paneId = payload?.paneId || state.activePaneId;
  const pane = paneById(paneId);
  const ids = payload?.ids || [...(pane?.selected || [])];
  if (!ids.length || !state.connected) return;
  if (!pane) return;
  const libraryPath = state.library?.path;
  const selectionBefore = new Set(pane.selected);
  // Ratings of one pane queue behind each other instead of refusing a key
  // pressed while the previous write is still out ("3, →, 4" rates both).
  let operationToken = beginForegroundOperation('正在设置评分…');
  const previousTurn = ratingQueues.get(paneId);
  let endTurn;
  const turn = new Promise(resolve => { endTurn = resolve; });
  ratingQueues.set(paneId, turn);
  const finishTurn = () => {
    endTurn();
    if (ratingQueues.get(paneId) === turn) ratingQueues.delete(paneId);
  };
  setSyncStatus('正在设置评分…');
  try {
    await previousTurn;
    if (state.library?.path !== libraryPath || !paneById(paneId)) return;
    const outcome = await runItemBatch(ids, async id => {
      const item = pane.itemMap?.get(id) || await window.eagleMV.getItem(id);
      const result = await window.eagleMV.mutate({ id, patch: { star: rating }, base: item, libraryPath });
      if (result?.conflict) throw new Error('素材已在其他窗口发生变化');
      // A queued rating of the same item must compare against this write,
      // not the pre-refresh copy, or it reads as a cross-window conflict.
      const index = pane.items.findIndex(candidate => candidate.id === id);
      if (index >= 0 && result?.item) {
        pane.items[index] = result.item;
        pane.itemMap?.set(id, result.item);
      }
      return result;
    }, 'Eagle 评分请求超时');
    if (!outcome.succeeded.length) throw outcome.firstError || new Error('没有素材完成评分');
    // Rating never removes anything from the view, so the selection survives —
    // Eagle keeps it too, and dropping it after every keystroke made rating a
    // run of items needlessly awkward. Failures stay selected on their own.
    const next = outcome.failed.length
      ? outcome.failed
      : idsStillSelectable(pane, ids);
    if (settleBatchSelection(pane, selectionBefore, next) && state.activePaneId === paneId) renderInspector();
    finishTurn();
    endForegroundOperation(operationToken);
    operationToken = null;
    await refresh({ reset: true, preserveScroll: true, paneId });
    if (state.previewId) updatePreviewChrome(itemById(state.previewId) || { id: state.previewId, name: '', ext: '' });
    toast(outcome.failed.length
      ? `已为 ${outcome.succeeded.length} 个素材设置评分 · ${outcome.failed.length} 个失败并保持选中${batchFailureReason(outcome)}`
      : `已设置为 ${rating ? `${rating} 星` : '未评分'}`, outcome.failed.length ? 4200 : 2400);
  } catch (error) {
    toast(`评分失败：${error.message}`, 4000);
  } finally {
    finishTurn();
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

// The 文件夹 block of either inspector: a chip opens its folder and shows the
// item there (Eagle's quickOpenFolder), × takes the selection out of that one
// folder only — not its subfolders, unlike the grid's 从文件夹移除 — and
// 添加文件夹 opens the folder picker under the button.
function handleInspectorFolderClick(event) {
  const ids = [...state.selected];
  if (!ids.length) return;
  const remove = event.target.closest('[data-remove-folder]');
  const open = event.target.closest('[data-open-folder]');
  const add = event.target.closest('[data-add-folder]');
  if (remove) {
    const folderId = remove.dataset.removeFolder;
    if (!confirmBulkEdit(ids.length)) return;
    const name = findFolder(state.library?.folders, folderId)?.name || '文件夹';
    const pane = activePane();
    mutateSelectionSet(ids, 'folders', { remove: [folderId] }, '正在从文件夹移除…', state.activePaneId, {
      keepSelection: true,
      successMessage: `已从“${name}”移除`,
      selectNext: pane?.currentView.kind === 'folder' && pane.currentView.id === folderId
    });
  } else if (open) {
    openItemLocation(ids[0], open.dataset.openFolder);
  } else if (add) {
    showFolderAssignmentPicker(ids, { anchor: add, keepSelection: true });
  }
}

// A multi-select note or link applies to the items selected when editing
// began, and only if it changed: focusing and leaving a field is not an edit.
let batchFieldEdit = null;
function beginBatchFieldEdit(field, control) {
  batchFieldEdit = { field, paneId: state.activePaneId, ids: [...state.selected], original: control.value };
}

function commitBatchFieldEdit(field, control) {
  const edit = batchFieldEdit;
  batchFieldEdit = null;
  if (!edit || edit.field !== field) return;
  const value = field === 'url' ? control.value.trim() : control.value;
  const changed = value !== (field === 'url' ? edit.original.trim() : edit.original);
  if (changed && edit.ids.length >= 2 && confirmBulkEdit(edit.ids.length)) {
    setSelectionFields({
      ids: edit.ids,
      paneId: edit.paneId,
      patch: { [field]: value },
      successMessage: `已修改 ${edit.ids.length} 个素材的${field === 'url' ? '链接' : '注释'}`
    });
  }
  // The selection may have moved while the field held the focus.
  if (state.selected.size >= 2) renderMultiSelection(state.selected.size);
}

// Eagle's multi-select tag field applies a tag to every selected item as soon
// as it is entered; there is no separate 添加 step.
async function applyBatchTags() {
  commitTagInput('batch');
  const tags = [...state.batchTags];
  if (!tags.length) return;
  const paneId = state.activePaneId;
  const pane = paneById(paneId);
  const ids = [...(pane?.selected || [])];
  if (!ids.length || !confirmBulkEdit(ids.length)) return;
  const libraryPath = state.library?.path;
  let operationToken = beginForegroundOperation('正在合并标签…', { key: `batch-tags:${paneId}` });
  if (!operationToken) return;
  const selectionBefore = new Set(pane.selected);
  setSyncStatus('正在合并标签…');
  try {
    const outcome = await runItemBatch(ids, id => window.eagleMV.mutateSet({
      id, field: 'tags', add: tags, libraryPath
    }), 'Eagle 批量标签请求超时');
    if (!outcome.succeeded.length) throw outcome.firstError || new Error('没有素材完成标签修改');
    // Adding a tag keeps the selection, the way removing one already does
    // (removeTagFromSelection passes keepSelection) — the items are all
    // still on screen, and losing them after one tag makes the second tag a
    // re-selection chore.
    settleBatchSelection(pane, selectionBefore, outcome.failed.length
      ? outcome.failed
      : idsStillSelectable(pane, ids));
    $('#batchTagInput').value = '';
    setTagValues('batch', [], false);
    endForegroundOperation(operationToken);
    operationToken = null;
    await refresh({ reset: true, preserveScroll: true, paneId });
    if (state.activePaneId === paneId) withActivePane(paneId, () => {
      updateCardSelectionStyles();
      renderInspector();
    });
    toast(outcome.failed.length
      ? `已为 ${outcome.succeeded.length} 个素材添加标签 · ${outcome.failed.length} 个失败并保持选中${batchFailureReason(outcome)}`
      : `已为 ${outcome.succeeded.length} 个素材添加标签`, outcome.failed.length ? 4200 : 2400);
  } catch (error) {
    toast(`添加标签失败：${error.message}`, 4000);
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

function removeTagFromSelection(tag) {
  if (!tag || !confirmBulkEdit(state.selected.size)) return false;
  // Keeps the multi-selection on success so several shared tags can be
  // removed in a row; everything else rides the shared batch pipeline.
  return mutateSelectionSet([...state.selected], 'tags', { remove: [tag] }, '正在移除标签…', state.activePaneId, {
    keepSelection: true,
    successMessage: `已从所选素材移除“${tag}”`
  });
}

// What the preview shows for an image, or null when the item is not rendered
// as an <img> (video/audio/PDF/unsupported). Shared by the preview markup and
// the neighbour prefetch so they can never drift apart. `kind` matters to the
// prefetch: only 'original' streams the bytes item.size measures.
function previewImageSource(item) {
  const ext = String(item?.ext || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif', 'bmp'].includes(ext)) {
    return { kind: 'original', url: mediaURL('original', item.id) };
  }
  // Chromium cannot decode these originals (PSD/TIFF/HEIC and camera RAW);
  // Eagle's generated preview image in the .info folder stands in at full
  // resolution, with the thumbnail as fallback.
  if (previewStandInExtensions.has(ext)) return { kind: 'preview', url: mediaURL('preview', item.id) };
  return null;
}

function previewImageURL(item) {
  return previewImageSource(item)?.url || null;
}

// Eagle's getPDFPath: viewer.html?path=<file>&locale=<language>&theme=<theme>,
// served by the web host from the installed Eagle app (lib/web-server.js).
function eaglePdfViewerURL(item) {
  return `/eagle-app/pdf-viewer/web/viewer.html?path=${encodeURIComponent(mediaURL('original', item.id))}&locale=zh-CN&theme=dark`;
}

function mediaMarkup(item) {
  const url = mediaURL('original', item.id);
  const ext = String(item.ext || '').toLowerCase();
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv'].includes(ext)) return `<video src="${url}" controls autoplay playsinline></video>`;
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)) return `<audio src="${url}" controls autoplay></audio>`;
  // Web clients open Eagle's own pdf.js viewer, as Eagle's preview does
  // (phone and tablet WebViews cannot show a PDF <embed>); setupPreviewMedia
  // loads it once the host confirms it can serve it.
  if (ext === 'pdf' && isWebClient) return `<iframe class="pdf-viewer" data-pdf-viewer="${escapeHTML(eaglePdfViewerURL(item))}" title="${escapeHTML(item.name)}"></iframe>`;
  // Chromium's PDF viewer refuses custom-protocol streams, so the PDF embed
  // gets a direct file:// URL resolved asynchronously in setupPreviewMedia.
  if (ext === 'pdf') return `<embed data-pdf-item="${escapeHTML(item.id)}" type="application/pdf" width="100%" height="100%">`;
  const imageURL = previewImageURL(item);
  if (imageURL) return `<img src="${imageURL}" alt="${escapeHTML(item.name)}" draggable="false">`;
  return `<div class="unsupported-preview"><img src="${mediaURL('thumb', item.id)}" alt="${escapeHTML(item.name)}" draggable="false"><p>${escapeHTML(String(item.ext || '文件').toUpperCase())} 无法直接预览${hasCapability('openDefault') ? '<br><span>按 ⇧Enter 使用默认应用打开</span>' : ''}</p></div>`;
}

// Warming the neighbours makes swiping (and ←/→) show the next full-size
// image immediately instead of flashing an empty frame while it downloads.
// The Image objects stay referenced so the decoded bitmap survives long
// enough to be reused; the ring is small because these are full-size files.
const PREFETCH_RING = 6;
const PREFETCH_MAX_BYTES = 48 * 1024 * 1024;
const previewPrefetch = new Map();

function prefetchPreviewImage(item) {
  if (!item || previewPrefetch.has(item.id)) return;
  // Metered or explicitly data-saving connections should not pay for images
  // the user may never swipe to.
  if (navigator.connection?.saveData) return;
  const source = previewImageSource(item);
  if (!source) return;
  // item.size measures the original file, which is what /media/original
  // streams — but a stand-in preview serves Eagle's small generated image no
  // matter how heavy the original is, so a 780 MB PSD is still worth warming.
  if (source.kind === 'original' && Number(item.size) > PREFETCH_MAX_BYTES) return;
  const image = new Image();
  image.decoding = 'async';
  image.src = source.url;
  previewPrefetch.set(item.id, image);
  while (previewPrefetch.size > PREFETCH_RING) {
    previewPrefetch.delete(previewPrefetch.keys().next().value);
  }
}

function prefetchPreviewNeighbours(id) {
  const items = sortedItems();
  const index = items.findIndex(item => item.id === id);
  if (index < 0) return;
  // Forward first: swiping left (next) is the common direction.
  prefetchPreviewImage(items[index + 1]);
  prefetchPreviewImage(items[index - 1]);
}

function previewImage() { return $('#modalMedia img.preview-image'); }

function renderPreviewZoom() {
  const image = previewImage();
  const zoom = state.previewZoom;
  if (!image) return;
  const fit = zoom.mode === 'fit';
  image.classList.toggle('preview-actual', !fit);
  image.classList.toggle('dragging', Boolean(zoom.dragging));
  // 原始大小 shows one image pixel per CSS pixel; every other mode starts
  // from the fitted size (B2-13).
  const actual = zoom.mode === 'actual';
  image.style.maxWidth = actual ? 'none' : '100%';
  image.style.maxHeight = actual ? 'none' : '100%';
  image.style.width = 'auto';
  image.style.height = 'auto';
  image.style.transform = (zoom.x === 0 && zoom.y === 0 && zoom.scale === 1)
    ? ''
    : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  image.style.cursor = zoom.dragging ? 'grabbing' : 'grab';
}

function setPreviewZoom(mode, scale = null) {
  const nextScale = scale === null ? (mode === 'fit' ? 1 : mode === 'actual' ? 1 : state.previewZoom.scale) : scale;
  // Continued zooming keeps the current pan; fit/actual recenter the image.
  const keepPan = mode === 'zoom';
  state.previewZoom = {
    ...state.previewZoom,
    mode,
    scale: Math.max(.25, Math.min(6, nextScale)),
    x: keepPan ? state.previewZoom.x : 0,
    y: keepPan ? state.previewZoom.y : 0,
    dragging: false
  };
  renderPreviewZoom();
}

function changePreviewZoom(delta, anchor = null) {
  const previous = state.previewZoom.mode === 'fit' ? 1 : state.previewZoom.scale;
  const next = Math.max(.25, Math.min(6, previous + delta));
  if (anchor && next !== previous) {
    // Keep the image point under the cursor fixed: x' = a − (k'/k)·(a − x),
    // with the anchor measured from the container centre.
    const ratio = next / previous;
    state.previewZoom.x = anchor.x - ratio * (anchor.x - state.previewZoom.x);
    state.previewZoom.y = anchor.y - ratio * (anchor.y - state.previewZoom.y);
  }
  setPreviewZoom('zoom', next);
}

// Eagle's viewer page posts "Exit", "Prev" and "Next" to its parent when Esc,
// ← or → is released inside it; Eagle's preview then closes or moves to the
// neighbouring item, and so does this one. Only the frame of an open preview
// counts, so a message from a viewer already closed (by Back) does nothing.
function handleEaglePdfViewerMessage(event) {
  if (event.origin !== location.origin || !['Exit', 'Prev', 'Next'].includes(event.data)) return;
  const frame = [...document.querySelectorAll('iframe[data-pdf-viewer]')].find(node => node.contentWindow === event.source);
  const paneId = frame?.closest('.content-pane')?.dataset.paneId;
  if (!paneId || !paneById(paneId)?.previewId || !activatePane(paneId)) return;
  if (event.data === 'Exit') closePreview();
  else movePreview(event.data === 'Next' ? 1 : -1);
}

function setupPreviewMedia() {
  const owner = activePane();
  const ownerToken = owner.previewToken;
  const validOwner = () => paneById(owner.id) === owner && owner.previewToken === ownerToken;
  const image = $('#modalMedia img');
  // Image previews own the whole modal as a gesture surface (swipe/pinch);
  // text/PDF previews keep native touch behavior for their scrollables.
  $('#previewModal').classList.toggle('image-gesture', Boolean(image));
  if (image) {
    image.setAttribute('draggable', 'false');
    image.addEventListener('dragstart', event => event.preventDefault());
    image.classList.add('preview-image');
    image.addEventListener('load', () => { if (validOwner()) withActivePane(owner.id, () => renderPreviewZoom()); }, { once: true });
    // Eagle can hold an index entry whose file is gone (or a type with no
    // generated preview). A broken-image glyph in the middle of the modal is
    // worse than saying so.
    const token = state.previewToken;
    image.addEventListener('error', () => {
      if (!validOwner() || !image.isConnected) return;
      withActivePane(owner.id, () => {
        const item = itemById(state.previewId);
        $('#modalMedia').innerHTML = `<div class="unsupported-preview"><p>无法读取这个素材的图像<br><span>${escapeHTML(String(item?.ext || '文件').toUpperCase())} · 原文件可能已被移动或删除</span></p></div>`;
      });
    }, { once: true });
  }
  const pdfViewer = $('#modalMedia iframe[data-pdf-viewer]');
  if (pdfViewer) {
    const viewerURL = pdfViewer.dataset.pdfViewer;
    fetch(viewerURL, { method: 'HEAD', credentials: 'same-origin' }).then(response => response.ok, () => false).then(available => {
      if (!validOwner() || !pdfViewer.isConnected) return;
      if (available) {
        pdfViewer.src = viewerURL;
        return;
      }
      // No installed Eagle with its viewer on the host: say so over the
      // first-page thumbnail instead of an error page in the frame.
      withActivePane(owner.id, () => {
        const item = itemById(state.previewId);
        if (!item) return;
        $('#modalMedia').innerHTML = `<div class="unsupported-preview"><img src="${mediaURL('thumb', item.id)}" alt="${escapeHTML(item.name)}" draggable="false"><p>PDF 无法在此预览<br><span>主机上找不到 Eagle 的 PDF 查看器</span></p></div>`;
      });
    });
  }
  const pdfEmbed = $('#modalMedia embed[data-pdf-item]');
  if (pdfEmbed) {
    const token = state.previewToken;
    window.eagleMV.fileURL(pdfEmbed.dataset.pdfItem).then(fileURL => {
      if (!fileURL || !validOwner() || !pdfEmbed.isConnected) return;
      pdfEmbed.src = fileURL;
    }).catch(() => {});
  }
  renderPreviewZoom();
}

function pingPreviewHUD(paneId = state.activePaneId) {
  const modal = paneQuery(paneId, '#previewModal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.remove('hud-hidden');
  const pane = paneById(paneId);
  if (!pane) return;
  clearTimeout(pane.hudTimer);
  pane.hudTimer = setTimeout(() => {
    if (modal.isConnected && !modal.classList.contains('hidden')) {
      modal.classList.add('hud-hidden');
    }
  }, 1500);
}

function updatePreviewChrome(item) {
  const items = sortedItems();
  const index = items.findIndex(candidate => candidate.id === item.id);
  const position = index >= 0 ? `${index + 1} / ${state.total || items.length}` : '';
  const fileName = `${item.name}.${item.ext}`;
  const caption = $('#modalCaption');
  caption.textContent = window.matchMedia('(pointer: coarse)').matches && position
    ? `${position} · ${fileName}`
    : position;
  caption.title = fileName;
  renderPreviewRating(item);
  pingPreviewHUD();
}

// Rating without leaving the preview, the way Eagle's viewer does it. Touch
// has no number keys, and closing the preview just to rate is the kind of
// round trip that makes a phone tiring to use.
function renderPreviewRating(item) {
  const row = $('#modalRating');
  if (!row) return;
  const rating = Math.max(0, Math.min(5, Number(item?.star) || 0));
  row.dataset.rating = String(rating);
  row.innerHTML = [1, 2, 3, 4, 5].map(value =>
    `<button type="button" class="modal-star${value <= rating ? ' filled' : ''}" data-preview-rating="${value}" aria-label="${value} 星" title="${value} 星（按 ${value}）">★</button>`
  ).join('');
}

function ratePreviewItem(rating) {
  if (!state.previewId) return false;
  setSelectionRating({ ids: [state.previewId], rating });
  return true;
}

const TEXT_DRAFT_PREFIX = 'eaglemv.textDraft.v1.';
function createDraftWindowKey() {
  // randomUUID is secure-context-only; the default LAN HTTP client still
  // exposes getRandomValues. These IDs separate drafts, not authentication.
  const bytes = new Uint8Array(16);
  if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}
let textWindowKey;
try {
  // window.open clones the opener's sessionStorage, including its draft IDs.
  // A child document's first navigation must fork those identities. Reload
  // and history restoration remain the same editing window and keep theirs.
  const navigationType = performance.getEntriesByType('navigation')[0]?.type;
  const openedByAnotherWindow = Boolean(window.opener) && !['reload', 'back_forward'].includes(navigationType);
  textWindowKey = (!openedByAnotherWindow && sessionStorage.getItem('eaglemv.textWindowKey')) || createDraftWindowKey();
  sessionStorage.setItem('eaglemv.textWindowKey', textWindowKey);
} catch { textWindowKey = createDraftWindowKey(); }

const textDraftIdentities = new Map();
function textDraftId(paneId, libraryPath, id, { renew = false } = {}) {
  const identity = JSON.stringify([textWindowKey, paneId, libraryPath, id]);
  const storageKey = 'eaglemv.textSession.v1.' + identity;
  let draftId = textDraftIdentities.get(identity);
  try { draftId ||= sessionStorage.getItem(storageKey); } catch {}
  // A clean lifecycle may already have a high-revision removal tombstone.
  // Allocate a new identity instead of resetting that identity to revision 0.
  // Until the first lookup completes, retain the old ID to recover v1 drafts.
  if (renew) draftId = JSON.stringify([textWindowKey, paneId, createDraftWindowKey()]);
  if (draftId) {
    textDraftIdentities.set(identity, draftId);
    try { sessionStorage.setItem(storageKey, draftId); } catch {}
  }
  return draftId || identity;
}
function textDraftRecord(session) {
  return { draftId: session.draftId, libraryPath: session.libraryPath, id: session.id, revision: session.revision,
    content: session.content, base: session.fingerprint, original: session.original, updatedAt: Date.now() };
}
// Typing persists the draft on a short throttle instead of per key: every
// write serializes the whole text (up to 5 MB) into localStorage and sends it
// over IPC to the host store (R2-01). Blur, save, close and discard still
// write at once through persistTextDraft, which also cancels pending writes.
const TEXT_DRAFT_LOCAL_DELAY = 300;
const TEXT_DRAFT_HOST_DELAY = 1000;
function queueTextDraftPersist(session) {
  session.localDraftTimer ||= setTimeout(() => {
    session.localDraftTimer = null;
    persistLocalTextDraft(session, textDraftRecord(session));
  }, TEXT_DRAFT_LOCAL_DELAY);
  session.hostDraftTimer ||= setTimeout(() => {
    session.hostDraftTimer = null;
    persistHostTextDraft(session, textDraftRecord(session));
  }, TEXT_DRAFT_HOST_DELAY);
}
function flushTextDraft(session) {
  if (session?.localDraftTimer || session?.hostDraftTimer) persistTextDraft(session);
}
function persistTextDraft(session) {
  if (!session) return;
  clearTimeout(session.localDraftTimer);
  clearTimeout(session.hostDraftTimer);
  session.localDraftTimer = session.hostDraftTimer = null;
  const record = textDraftRecord(session);
  persistLocalTextDraft(session, record);
  persistHostTextDraft(session, record);
}
function persistLocalTextDraft(session, record) {
  try {
    if (session.dirty || session.saving) localStorage.setItem(TEXT_DRAFT_PREFIX + session.draftId, JSON.stringify(record));
    else localStorage.removeItem(TEXT_DRAFT_PREFIX + session.draftId);
    session.storageError = false;
  } catch {
    session.storageError = true;
    textSessionStatus(session, '草稿存储空间不足；请保持窗口开启并保存或复制正文');
  }
}
function persistHostTextDraft(session, record) {
  const { draftId, libraryPath, id, revision, content, base } = record;
  const identity = { draftId, libraryPath, id, revision };
  if (session.dirty || session.saving) {
    window.eagleMV.putTextDraft?.({ ...identity, content, base })?.then(saved => {
      if (session.dirty && session.revision === revision) session.hostDraftError = !saved;
    }).catch(() => {
      session.hostDraftError = true;
      if (session.storageError) textSessionStatus(session, '草稿备份失败；请保持窗口开启并复制正文');
    });
  } else {
    window.eagleMV.removeTextDraft?.(identity)?.catch(() => {});
  }
}
function readLocalTextDraft(draftId) {
  try { return JSON.parse(localStorage.getItem(TEXT_DRAFT_PREFIX + draftId) || 'null'); } catch { return null; }
}
async function recoverableTextDrafts(libraryPath, id, draftId) {
  const records = new Map();
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(TEXT_DRAFT_PREFIX)) continue;
      const record = JSON.parse(localStorage.getItem(key) || 'null');
      if (record?.libraryPath === libraryPath && record.id === id && record.draftId !== draftId) records.set(record.draftId, record);
    }
  } catch {}
  const persisted = await window.eagleMV.listTextDrafts?.({ libraryPath, id })?.catch(() => []);
  for (const record of persisted || []) {
    if (record.draftId !== draftId && (!records.has(record.draftId) || records.get(record.draftId).revision < record.revision)) records.set(record.draftId, record);
  }
  return [...records.values()].filter(record => typeof record.content === 'string').sort((left, right) => right.updatedAt - left.updatedAt);
}
function discardTextSession(session) {
  if (!session) return;
  clearTimeout(session.autoSaveTimer);
  clearTimeout(session.statusTimer);
  session.dirty = false;
  session.content = session.original;
  session.revision += 1;
  persistTextDraft(session);
}
function textSessionPane(session) {
  return state.panes.find(pane => pane.textSession === session) || null;
}
function textSessionStatus(session, message) {
  if (message) clearTimeout(session.statusTimer);
  const pane = textSessionPane(session);
  if (!pane) return;
  const status = paneQuery(pane.id, '#textStatus');
  if (status && message) {
    const detail = session.storageError && session.dirty
      ? '即时草稿备份失败；请保持窗口开启直至保存成功，或复制正文'
      : message;
    // Keep the visible label fixed-length; operational detail belongs on hover.
    const next = session.dirty ? '编辑中' : '已保存';
    if (status.textContent !== next) status.textContent = next;
    if (status.title !== detail) status.title = detail;
  }
}
function textSavedStatus(session, message, automatic) {
  if (!automatic) { textSessionStatus(session, message); return; }
  clearTimeout(session.statusTimer);
  const revision = session.revision;
  // Saving still runs at the original cadence. Only routine success feedback
  // waits for a typing pause, so every 500 ms save does not flash the toolbar.
  session.statusTimer = setTimeout(() => {
    if (session.revision === revision && !session.dirty && !session.saving && !session.composing) {
      textSessionStatus(session, message);
    }
  }, Math.max(0, 1200 - (Date.now() - (session.lastInputAt || 0))));
}
const EMPTY_TEXT_DRAFT_STATUS = '空白草稿已保留 · 暂未保存到 Eagle';
function confirmTextSessionsLeave(panes) {
  const sessions = panes.map(pane => pane.textSession).filter(Boolean);
  if (sessions.some(session => session.saving)) {
    toast('TXT 正在保存，请稍候再关闭其编辑栏', 2800);
    return false;
  }
  const dirty = sessions.filter(session => session.dirty);
  if (!dirty.length) return true;
  if (!confirm(`有 ${dirty.length} 个 TXT 草稿尚未保存。\n\n按“确定”放弃修改并继续；按“取消”保留编辑。`)) return false;
  dirty.forEach(discardTextSession);
  return true;
}
function queueTextAutoSave(session, { immediate = false } = {}) {
  clearTimeout(session.autoSaveTimer);
  if (!session.dirty || session.composing || session.saving || session.blocked || !state.connected) return;
  session.firstDirtyAt ||= Date.now();
  const wait = immediate ? 0 : Math.max(0, Math.min(500, 2500 - (Date.now() - session.firstDirtyAt)));
  session.autoSaveTimer = setTimeout(() => {
    session.autoSaveTimer = null;
    saveTextPreview(false, { session, automatic: true });
  }, wait);
}
function renderTextPreview(session) {
  const paneId = state.activePaneId;
  $('#modalMedia').innerHTML = `<div class="text-preview">
    <div class="text-toolbar">
      <span id="textStatus" class="text-status" title="UTF-8 · ${formatBytes(session.fingerprint?.size || 0)}">${session.dirty ? '编辑中' : '已保存'}</span>
    </div>
    ${session.recoveryDrafts?.length ? `<div class="text-toolbar"><select id="textDraftSelect" aria-label="选择可恢复草稿"><option value="">可恢复草稿（${session.recoveryDrafts.length}）</option>${session.recoveryDrafts.map((draft, index) => `<option value="${index}">${escapeHTML(new Date(draft.updatedAt || Date.now()).toLocaleString('zh-CN'))} · ${escapeHTML(draft.content.slice(0, 24) || '空白正文')}</option>`).join('')}</select><button id="restoreTextDraft" type="button" disabled>恢复所选草稿</button></div>` : ''}
    <textarea id="textEditor" class="text-editor" spellcheck="false" aria-label="TXT 内容"></textarea>
  </div>`;
  const editor = $('#textEditor');
  editor.value = session.content;
  const draftSelect = paneQuery(paneId, '#textDraftSelect');
  const restoreDraft = paneQuery(paneId, '#restoreTextDraft');
  draftSelect?.addEventListener('change', () => { restoreDraft.disabled = draftSelect.value === '' || Boolean(session.saving); });
  restoreDraft?.addEventListener('click', () => {
    const draft = session.recoveryDrafts[Number(draftSelect.value)];
    if (!draft || session.saving || draftSelect.value === '') return;
    if (session.dirty && !confirm('恢复所选草稿将替换当前编辑内容，是否继续？')) return;
    session.content = draft.content;
    session.fingerprint = draft.base;
    session.dirty = session.content !== session.original;
    session.revision += 1;
    session.blocked = 'recovered';
    persistTextDraft(session);
    // This is a copy into this window's own draft, not a claim on or deletion
    // of the source window's record. Saving still compares the source base.
    editor.value = session.content;
    textSessionStatus(session, keyboardPlatform.shortcutText('草稿已恢复；请核对正文，编辑或按 ⌘S 后提交'));
  });
  editor.addEventListener('input', () => {
    session.lastInputAt = Date.now();
    session.content = editor.value;
    session.revision += 1;
    session.dirty = session.content !== session.original;
    if (session.blocked !== 'conflict') session.blocked = false;
    if (session.dirty && !session.content.length && !session.blocked) session.blocked = 'empty';
    queueTextDraftPersist(session);
    textSessionStatus(session, session.blocked === 'conflict'
      ? '外部内容已变化；草稿已保留，重新载入前请核对或复制正文'
      : session.dirty ? (session.content.length ? '编辑中 · 草稿已保留' : EMPTY_TEXT_DRAFT_STATUS) : '已保存');
    queueTextAutoSave(session);
  });
  editor.addEventListener('compositionstart', () => { session.composing = true; clearTimeout(session.autoSaveTimer); });
  editor.addEventListener('compositionend', () => { session.composing = false; queueTextAutoSave(session); });
  editor.addEventListener('blur', () => {
    flushTextDraft(session);
    queueTextAutoSave(session, { immediate: true });
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
      saveTextPreview(false, { session });
    }
  });
  textSessionStatus(session, session.dirty ? (session.blocked ? '外部版本已变化；恢复的草稿已保留，请核对内容' : '已恢复未保存草稿 · 编辑后自动保存') : null);
}

function followPreviewInGrid(id, ownsResult) {
  const pane = activePane();
  // Touch preview starts without a selection; keep its tap-to-preview mode.
  if (state.selected.size && (state.selected.size !== 1 || !state.selected.has(id))) {
    state.selectedFolderCard = null;
    state.selected = new Set([id]);
    if (state.sort === 'manual') {
      const index = sortedItems().findIndex(item => item.id === id);
      if (index >= (pane.manualRenderLimit || SORT_FETCH_CAP)) {
        pane.manualRenderLimit = index + 1;
        renderGrid({ preserveScroll: true });
      }
    }
    updateCardSelectionStyles();
    renderInspector();
  }
  requestAnimationFrame(() => {
    if (!ownsResult()) return;
    const card = paneRoot(pane.id)?.querySelector(`.item-card[data-id="${CSS.escape(id)}"]`);
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    pane.scrollTop = paneQuery(pane.id, '#gridScroller')?.scrollTop || 0;
    if (state.activePaneId === pane.id) updateScrollUI();
  });
}

async function openPreview(id, { forceReload = false } = {}) {
  const pane = activePane();
  const paneId = pane?.id;
  const libraryPath = state.library?.path;
  const item = itemById(id);
  if (!item) return false;
  if (!forceReload && state.previewId && state.previewId !== id && !confirmDiscardChanges()) return false;
  if (forceReload && state.textSession) discardTextSession(state.textSession);
  const token = ++state.previewToken;
  const ownsResult = () => paneById(paneId) === pane && pane.previewToken === token && pane.previewId === id && state.library?.path === libraryPath;
  state.previewId = id;
  $('#previewModal').classList.remove('hidden');
  renderSelectionBar();
  updatePreviewChrome(item);
  followPreviewInGrid(id, ownsResult);
  if (String(item.ext || '').toLowerCase() !== 'txt') {
    clearTimeout(pane.textSession?.autoSaveTimer);
    state.textSession = null;
    $('#modalMedia').innerHTML = mediaMarkup(item);
    setPreviewZoom('fit');
    setupPreviewMedia();
    prefetchPreviewNeighbours(id);
    return true;
  }
  setPreviewZoom('fit');
  state.textSession = null;
  $('#modalMedia').innerHTML = '<div class="unsupported-preview"><p>正在读取 TXT…</p></div>';
  try {
    const result = await window.eagleMV.readText({ id, libraryPath });
    if (!ownsResult()) return false;
    let draftId = textDraftId(paneId, libraryPath, id);
    let draft = !forceReload && readLocalTextDraft(draftId);
    if (!forceReload && window.eagleMV.getTextDraft) {
      const persisted = await window.eagleMV.getTextDraft({ id, libraryPath, draftId }).catch(() => null);
      if (persisted && (!draft || persisted.revision > draft.revision)) draft = persisted;
    }
    if (!ownsResult()) return false;
    if (!draft) draftId = textDraftId(paneId, libraryPath, id, { renew: true });
    const session = { id, libraryPath, draftId, revision: Number(draft?.revision) || 0, content: result.content, original: result.content, fingerprint: result.fingerprint, dirty: false };
    session.recoveryDrafts = await recoverableTextDrafts(libraryPath, id, draftId);
    if (!ownsResult()) return false;
    if (draft && draft.libraryPath === libraryPath && draft.id === id && draft.content !== result.content) {
      session.content = draft.content;
      session.original = draft.original ?? result.content;
      session.fingerprint = draft.base;
      session.dirty = true;
      session.blocked = JSON.stringify(draft.base) !== JSON.stringify(result.fingerprint) ? 'conflict' : false;
    }
    pane.textSession = session;
    pane.textSaving = false;
    persistTextDraft(session);
    withActivePane(paneId, () => renderTextPreview(session));
    return true;
  } catch (error) {
    if (!ownsResult()) return false;
    pane.textSession = null;
    withActivePane(paneId, () => {
      $('#modalMedia').innerHTML = `<div class="unsupported-preview"><p>读取 TXT 失败<br><span>${escapeHTML(error.message)}</span></p></div>`;
    });
    return false;
  }
}

function setTextSaving(saving, session = state.textSession) {
  if (!session) return;
  const pane = textSessionPane(session);
  if (!pane) return;
  pane.textSaving = Boolean(saving);
  // Do not disable or replace the editor: input, IME, selection and focus stay
  // untouched while an immutable snapshot is being committed.
  textSessionStatus(session);
}

async function saveTextPreview(force = false, { session = state.textSession, automatic = false } = {}) {
  if (!session?.dirty) return true;
  if (session.saving) return session.saving;
  if (session.composing || (automatic && session.blocked)) return false;
  clearTimeout(session.autoSaveTimer);
  if (!session.content.length) {
    if (session.blocked !== 'conflict') session.blocked = 'empty';
    persistTextDraft(session);
    textSessionStatus(session, EMPTY_TEXT_DRAFT_STATUS);
    return false;
  }
  const task = async () => {
    setTextSaving(true, session);
    if (!automatic) textSessionStatus(session, '正在后台保存…');
    try {
      do {
        const { id, libraryPath, content } = session;
        if (state.library?.path !== libraryPath) throw new Error('资源库已切换；旧库草稿已保留');
        if (!content.length) {
          session.blocked = 'empty';
          textSessionStatus(session, EMPTY_TEXT_DRAFT_STATUS);
          return false;
        }
        const revision = session.revision;
        const result = await window.eagleMV.saveText({ id, libraryPath, content, base: structuredClone(session.fingerprint), force: Boolean(force) });
        force = false;
        if (result.conflict) {
          session.blocked = 'conflict';
          textSessionStatus(session, '外部内容已变化；草稿已保留，重新载入前请核对或复制正文');
          return false;
        }
        if (!result.fingerprint) throw new Error('保存回执缺少内容版本；草稿保留，请核对后重试');
        session.fingerprint = result.fingerprint;
        session.original = content;
        session.revision += 1;
        session.dirty = session.content !== content;
        session.blocked = false;
        session.firstDirtyAt = session.dirty ? Date.now() : null;
        // Keep a later input revision intact; never assign sent content back
        // into the live editor or delete a newer draft from another write.
        if (!session.dirty) session.revision = Math.max(session.revision, revision);
        persistTextDraft(session);
        if (!session.dirty) {
          if (result.status === 'written_pending_refresh') textSessionStatus(session, '正文已保存 · Eagle 预览刷新待确认');
          else textSavedStatus(session, automatic ? '已自动保存' : '已保存', automatic);
        }
      } while (session.dirty && !session.composing && state.library?.path === session.libraryPath);
      return !session.dirty;
    } catch (error) {
      session.blocked = true;
      textSessionStatus(session, `尚未保存 · ${error.message}`);
      if (!automatic) toast(`TXT 草稿已保留：${error.message}`, 4400);
      return false;
    } finally {
      session.saving = null;
      setTextSaving(false, session);
      persistTextDraft(session);
      if (session.dirty && !session.blocked) queueTextAutoSave(session);
    }
  };
  // Start on a microtask so the in-flight marker precedes even synchronous
  // validation failures and is cleared by finally, not overwritten afterwards.
  session.saving = Promise.resolve().then(task);
  setTextSaving(true, session);
  persistTextDraft(session);
  return session.saving;
}

function closePreview({ commitSelection = true, skipDiscard = false, syncBroadcast = true } = {}) {
  if (!skipDiscard && state.textSession?.dirty && !confirmDiscardChanges()) return false;
  stopSlideshow();
  persistTextDraft(state.textSession);
  clearTimeout(state.textSession?.autoSaveTimer);
  clearTimeout(state.textSession?.statusTimer);
  const finalId = state.previewId;
  const paneId = state.activePaneId;
  const wasActive = paneRoot(paneId)?.classList.contains('active');
  ++state.previewToken;
  state.previewId = null;
  state.textSession = null;
  $('#previewModal').classList.add('hidden');
  $('#modalMedia').innerHTML = '';
  renderSelectionBar();
  if (finalId && itemById(finalId)) {
    // Collapse the selection onto the final preview item only when the
    // preview was entered with a selection, so the item swiped to last is
    // what stays selected (and what the next touch tap reopens).
    if (commitSelection && state.selected.size) {
      state.selectedFolderCard = null;
      state.selected = new Set([finalId]);
      updateCardSelectionStyles();
      renderInspector();
    }
    requestAnimationFrame(() => {
      if (!wasActive || state.activePaneId !== paneId) return;
      const card = paneRoot(paneId)?.querySelector(`.item-card[data-id="${CSS.escape(finalId)}"]`);
      card?.focus({ preventScroll: true });
      card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      updateScrollUI();
    });
  }
  if (syncBroadcast) {
    broadcastPaneAction(pane => {
      if (pane.previewId) closePreview({ commitSelection: false, skipDiscard, syncBroadcast: false });
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

async function movePreview(delta, { fromSlideshow = false } = {}) {
  const pane = activePane();
  const paneId = pane.id;
  const token = pane.previewToken;
  const slideshowGeneration = pane.slideshow.generation;
  const before = pane.previewId;
  let items = sortedItems();
  let index = items.findIndex(item => item.id === state.previewId);
  let next = items[index + delta];
  if (!next && delta > 0 && state.hasMore) {
    await refresh({ reset: false, preserveScroll: true, paneId });
    if (paneById(paneId) !== pane || pane.previewToken !== token || (fromSlideshow && pane.slideshow.generation !== slideshowGeneration)) return false;
    items = withActivePane(paneId, () => sortedItems());
    index = items.findIndex(item => item.id === pane.previewId);
    next = items[index + delta];
  }
  if (next) await withActivePane(paneId, () => openPreview(next.id));
  // Stepping by hand during a slideshow restarts the dwell, so the picture you
  // just asked for gets its full turn rather than a leftover sliver of one.
  if (paneById(paneId) !== pane) return false;
  withActivePane(paneId, () => {
    if (!fromSlideshow && slideshowPlaying()) scheduleSlideshowStep();
  });
  // Report whether the preview actually moved, not merely whether a neighbour
  // existed: openPreview can be refused (an unsaved TXT prompts first), and a
  // slideshow that treated that as success would reopen the same prompt every
  // few seconds.
  return Boolean(next) && pane.previewId !== before;
}

function previewDirectionalItemId(key) {
  const root = paneRoot();
  const current = root?.querySelector(`#itemGrid .item-card[data-id="${CSS.escape(state.previewId)}"]`);
  const cards = [...(root?.querySelectorAll('#itemGrid .item-card') || [])];
  return directionalCard(cards, current, key)?.dataset.id || null;
}

async function movePreviewVertically(key) {
  const pane = activePane();
  const token = pane.previewToken;
  const before = pane.previewId;
  let nextId = previewDirectionalItemId(key);
  if (!nextId && key === 'ArrowDown' && state.hasMore) {
    await refresh({ reset: false, preserveScroll: true, paneId: pane.id });
    if (paneById(pane.id) !== pane || pane.previewToken !== token) return false;
    nextId = withActivePane(pane.id, () => previewDirectionalItemId(key));
  }
  if (nextId) await withActivePane(pane.id, () => openPreview(nextId));
  if (paneById(pane.id) !== pane) return false;
  withActivePane(pane.id, () => { if (slideshowPlaying()) scheduleSlideshowStep(); });
  return Boolean(nextId) && pane.previewId !== before;
}

// --- Preview view options --------------------------------------------------
// Eagle lets you park a checkerboard (or a flat colour) behind a transparent
// image and view it in grayscale. Both are pure display state: the background
// goes on the <img> itself so it fills exactly the picture's box rather than
// the whole modal, and both ride classes on the modal so swapping images keeps
// the setting.
const PREVIEW_BACKGROUNDS = [
  { key: 'none', label: '透明区域：默认' },
  { key: 'checker', label: '透明区域：棋盘格' },
  { key: 'white', label: '透明区域：白底' },
  { key: 'black', label: '透明区域：黑底' }
];
const PREVIEW_VIEW_KEY = 'eaglemv.previewView';

function renderPreviewView() {
  const modal = $('#previewModal');
  if (!modal) return;
  const { background, grayscale } = state.previewView;
  for (const option of PREVIEW_BACKGROUNDS) modal.classList.toggle(`bg-${option.key}`, option.key === background);
  modal.classList.toggle('preview-grayscale', grayscale);
  const current = PREVIEW_BACKGROUNDS.find(option => option.key === background) || PREVIEW_BACKGROUNDS[0];
  const backgroundButton = $('#previewBackground');
  if (backgroundButton) {
    backgroundButton.title = `${current.label}（B 切换）`;
    backgroundButton.setAttribute('aria-label', current.label);
    backgroundButton.dataset.background = background;
  }
  const grayscaleButton = $('#previewGrayscale');
  if (grayscaleButton) grayscaleButton.setAttribute('aria-pressed', String(grayscale));
}

function persistPreviewView() {
  try { localStorage.setItem(PREVIEW_VIEW_KEY, JSON.stringify(state.previewView)); } catch {}
}

function cyclePreviewBackground() {
  const index = PREVIEW_BACKGROUNDS.findIndex(option => option.key === state.previewView.background);
  const next = PREVIEW_BACKGROUNDS[(index + 1) % PREVIEW_BACKGROUNDS.length];
  state.previewView.background = next.key;
  renderPreviewView();
  persistPreviewView();
  toast(next.label, 1600);
}

function togglePreviewGrayscale() {
  state.previewView.grayscale = !state.previewView.grayscale;
  renderPreviewView();
  persistPreviewView();
  toast(state.previewView.grayscale ? '灰度查看已开启' : '灰度查看已关闭', 1600);
}

// --- Slideshow -------------------------------------------------------------
// Eagle's 幻灯片: dwell on each item, advance, wrap around at the end. Built on
// the preview rather than beside it, so zoom, swipe and the neighbour prefetch
// all keep working while it runs.
const SLIDESHOW_INTERVAL_KEY = 'eaglemv.slideshowInterval';

function slideshowPlaying() {
  return Boolean(state.slideshow.timer);
}

function renderSlideshow() {
  const playing = slideshowPlaying();
  const button = $('#slideshowToggle');
  if (!button) return;
  button.textContent = playing ? '❚❚' : '▶';
  button.setAttribute('aria-pressed', String(playing));
  button.title = playing ? '暂停幻灯片（S）' : '幻灯片播放（S）';
  button.setAttribute('aria-label', playing ? '暂停幻灯片' : '幻灯片播放');
  const interval = $('#slideshowInterval');
  if (interval) interval.value = String(state.slideshow.intervalMs);
  $('#previewModal').classList.toggle('slideshow-playing', playing);
}

function stopSlideshow() {
  if (state.slideshow.timer) clearTimeout(state.slideshow.timer);
  state.slideshow.timer = null;
  state.slideshow.generation = (state.slideshow.generation || 0) + 1;
  renderSlideshow();
}

function scheduleSlideshowStep() {
  const pane = activePane();
  const paneId = pane.id;
  const generation = (pane.slideshow.generation || 0) + 1;
  pane.slideshow.generation = generation;
  if (state.slideshow.timer) clearTimeout(state.slideshow.timer);
  state.slideshow.timer = setTimeout(async () => {
    if (paneById(paneId) !== pane || pane.slideshow.generation !== generation) return;
    pane.slideshow.timer = null;
    if (!pane.previewId) return withActivePane(paneId, () => renderSlideshow());
    const advanced = await withActivePane(paneId, () => advanceSlideshow());
    if (paneById(paneId) !== pane || pane.slideshow.generation !== generation) return;
    withActivePane(paneId, () => {
      if (advanced && state.previewId) scheduleSlideshowStep();
      else stopSlideshow();
    });
  }, state.slideshow.intervalMs);
  renderSlideshow();
}

// Forward one, wrapping to the first item once the list (and its remaining
// pages) run out. A single-item view has nowhere to go and ends the show.
async function advanceSlideshow() {
  const pane = activePane();
  const token = pane.previewToken;
  const generation = pane.slideshow.generation;
  const before = state.previewId;
  if (await movePreview(1, { fromSlideshow: true })) return true;
  if (paneById(pane.id) !== pane || pane.previewToken !== token || pane.slideshow.generation !== generation) return false;
  const items = withActivePane(pane.id, () => sortedItems());
  if (items.length < 2 || items[0].id === before) return false;
  return withActivePane(pane.id, () => openPreview(items[0].id));
}

function toggleSlideshow() {
  if (slideshowPlaying()) {
    stopSlideshow();
    toast('幻灯片已暂停');
    return;
  }
  if (!state.previewId) return;
  scheduleSlideshowStep();
  toast(`幻灯片播放中 · 每 ${Math.round(state.slideshow.intervalMs / 1000)} 秒一张`);
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
  if (descriptorKey(view)!==descriptorKey(state.currentView)) activePane().manualRenderLimit=SORT_FETCH_CAP;
  state.currentView = view;
  if (view.kind === 'folder') {
    const folder = findFolder(state.library?.folders, view.id);
    state.viewTitle = folder?.name || '文件夹';
  } else if (view.kind === 'smart') {
    state.viewTitle = view.name || findFolder(state.library?.smartFolders, view.id)?.name || '智能文件夹';
  } else {
    state.viewTitle = ({ root: state.library?.name || '资源库', all: '全部', unfiled: '未分类', untagged: '未标签', recent: '最近使用', random: '随机模式', trash: '回收站', tags: '标签管理' })[view.kind] || '资源库';
  }
  // Eagle remembers the sort per folder. Restoring here — the one place the
  // current view is assigned — covers every navigation path, including the
  // startup root view and library switches.
  const remembered = rememberedSortFor(view);
  state.sort = remembered?.sort || 'default';
  state.sortDir = remembered?.sortDir || 'auto';
  renderSortControls();
}

function rememberedSortFor(view) {
  return view?.kind === 'folder'
    ? sortMemory.recallFolderSort(state.library?.path, view.id, state.library?.folders)
    : sortMemory.recall(state.library?.path, descriptorKey(view));
}

// Leaving a view keeps its scroll offset and loaded-item count so back/up
// navigation can land where the user left off instead of the top of page one.
const VIEW_MEMORY_LIMIT = 50;
function rememberViewPosition(paneId = state.activePaneId) {
  const pane = paneById(paneId);
  const currentView = pane ? pane.currentView : state.currentView;
  if (!currentView) return;
  const key = descriptorKey(currentView);
  const memory = pane ? pane.viewMemory : state.viewMemory;
  if (!memory) return;
  memory.delete(key);
  const scroller = paneQuery(pane?.id || state.activePaneId, '#gridScroller') || $('#gridScroller');
  const scrollTop = scroller ? scroller.scrollTop : (pane ? pane.scrollTop : state.scrollTop) || 0;
  if (scrollTop <= 0) return;
  const count = Math.min((pane ? pane.items : state.items)?.length || 0, SORT_FETCH_CAP);
  memory.set(key, { scrollTop, count });
  while (memory.size > VIEW_MEMORY_LIMIT) memory.delete(memory.keys().next().value);
}

function navigate(view, { record = true, refreshView = true, skipDiscard = false, restoreScroll = true, exitSearch = false, query = null } = {}) {
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
  const currentQuery = cloneQuery(state.query);
  // Like Eagle, moving to another view starts without the search and filters
  // unless they are locked (R2-04); they used to follow every navigation and
  // silently narrow the next folder. History passes the query it restores.
  const nextQuery = query ? cloneQuery(query)
    : changed && !state.filterLock ? createQuery()
    : exitSearch && view.kind === 'folder' && currentQuery.search ? queryWithoutSearch(currentQuery)
    : currentQuery;
  if (record && changed) {
    const recorded = recordViewNavigation(
      state.history,
      state.historyIndex,
      createHistoryEntry(state.currentView, currentQuery),
      createHistoryEntry(view, nextQuery)
    );
    state.history = recorded.history;
    state.historyIndex = recorded.historyIndex;
  } else if (record && state.historyIndex < 0) {
    state.history = [createHistoryEntry(view, nextQuery)];
    state.historyIndex = 0;
  }
  state.query = nextQuery;
  const background = renderingBackgroundPane();
  if (!background) renderQueryControls();
  if (changed) rememberViewPosition();
  state.restoreScroll = changed && restoreScroll ? state.viewMemory.get(descriptorKey(view)) || null : null;
  applyView(view);
  if (view.kind === 'folder' && !background) revealFolderPath(view.id);
  $('#viewTitle').textContent = state.viewTitle;
  // Leaving this pane's folder is local navigation, not a preview-close gesture.
  closePreview({ commitSelection: false, skipDiscard: true, syncBroadcast: false });
  state.selected.clear();
  state.selectedFolderCard = null;
  const restoring = Boolean(state.restoreScroll);
  if (changed) {
    state.items = [];
    state.total = 0;
    state.estimatedTotal = false;
    state.nextOffset = 0;
    state.hasMore = false;
    $('#resultCount').textContent = '正在读取…';
    if (!restoring) {
      renderGrid({ preserveScroll: false });
    }
  }
  // A background pane (its folder deleted elsewhere) must not redraw the
  // shared inspector: that would drop the active pane's edit in progress.
  if (!background) {
    renderInspector();
    renderFolderTree();
  }
  renderLocation();
  if (refreshView) refresh({ reset: true, preserveScroll: false, quiet: restoring });
  // Picking a destination from the drawer should reveal the result.
  if (isCompactLayout() && !background) closeDrawers();
  saveSessionState();
  return true;
}

function enterFolderFromGrid(folderId) {
  return navigate({ kind: 'folder', id: folderId }, { exitSearch: true });
}

function navigateHistory(delta) {
  const next = state.historyIndex + delta;
  if (next < 0 || next >= state.history.length) {
    return { status: BACK_STATUS.BLOCKED, action: BACK_ACTION.HISTORY, reason: 'no-history' };
  }
  if (!confirmDiscardChanges()) {
    return { status: BACK_STATUS.BLOCKED, action: BACK_ACTION.HISTORY, reason: 'unsaved-edit' };
  }
  const target = readHistoryEntry(state.history[next]);
  if (state.historyIndex >= 0) state.history[state.historyIndex] = createHistoryEntry(state.currentView, cloneQuery(state.query));
  const previousQuery = state.query;
  state.query = target.hasQuery ? cloneQuery(target.query) : createQuery();
  state.historyIndex = next;
  if (!navigate(target.view, { record: false, skipDiscard: true, restoreScroll: true, query: state.query })) {
    state.historyIndex -= delta;
    state.query = previousQuery;
    renderQueryControls();
    return { status: BACK_STATUS.BLOCKED, action: BACK_ACTION.HISTORY, reason: 'navigation-refused' };
  }
  return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.HISTORY };
}

function closeTopTransientSurface({ selection = true } = {}) {
  if (activeMarquee?.started) {
    cancelMarquee({ restoreSelection: true });
    return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'marquee' };
  }
  // Native modal <dialog>s (feature, thumbnail, site import, web copy) own
  // their Escape handling through the cancel event; back goes the same way,
  // so a busy dialog that refuses to close blocks instead of navigating the
  // obscured workspace.
  const modal = [...document.querySelectorAll('dialog[open]')].at(-1);
  if (modal) {
    modal.dispatchEvent(new Event('cancel', { cancelable: true }));
    return modal.open && modal.isConnected
      ? { status: BACK_STATUS.BLOCKED, action: BACK_ACTION.TRANSIENT, reason: 'dialog-busy' }
      : { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'dialog' };
  }
  if (!$('#folderDialog').classList.contains('hidden')) {
    closeFolderDialog();
    return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'folder-dialog' };
  }
  if (!$('#webAccessDialog').classList.contains('hidden')) {
    closeWebAccessDialog();
    return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'web-access-dialog' };
  }
  if (!$('#trashDialog').classList.contains('hidden')) {
    closeTrashDialog();
    return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'trash-dialog' };
  }
  if (!$('#duplicateDialog').classList.contains('hidden')) {
    closeDuplicateDialog('cancel');
    return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'duplicate-dialog' };
  }
  if (!$('#contextMenu').classList.contains('hidden')) {
    hideContextMenu();
    return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'context-menu' };
  }
  if (document.querySelector('.sort-popover:not(.hidden)')) {
    for (const popover of document.querySelectorAll('.sort-popover:not(.hidden)')) popover.classList.add('hidden');
    for (const button of document.querySelectorAll('.sort-select-button[aria-expanded="true"]')) button.setAttribute('aria-expanded', 'false');
    return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'sort-popover' };
  }
  for (const kind of Object.keys(tagEditors)) {
    const popover = ensureTagSuggestionPopover(kind);
    if (popover && !popover.classList.contains('hidden')) {
      closeTagSuggestions(kind);
      return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'tag-suggestions' };
    }
  }
  if (!$('#tagColorManager').classList.contains('hidden')) {
    $('#tagColorManager').classList.add('hidden');
    return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'tag-color-manager' };
  }
  if (!$('#filterPopover').classList.contains('hidden')) {
    $('#filterPopover').classList.add('hidden');
    renderFilterState();
    return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'filter-popover' };
  }
  if (!$('#paneLayoutPopover').classList.contains('hidden')) {
    $('#paneLayoutPopover').classList.add('hidden');
    $('#paneLayoutButton').setAttribute('aria-expanded', 'false');
    return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'pane-layout-popover' };
  }
  if (!$('#libraryPopover').classList.contains('hidden')) {
    closeLibraryPopover();
    return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'library-popover' };
  }
  if (state.openDrawer) {
    closeDrawers();
    return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'drawer' };
  }
  // On touch clients back with a selection goes straight back through
  // history (navigating clears the selection anyway). Only with no history
  // left does back clear the selection first, so a stray back at the root
  // does not close the app with the selection still up. A preview on top is
  // closed by the preview step instead. The desktop app keeps Eagle's
  // behaviour of back moving through history.
  if (selection && isWebClient && state.historyIndex <= 0 && (state.selected.size || state.selectedFolderCard) && $('#previewModal').classList.contains('hidden')) {
    if (!confirmDiscardChanges()) return { status: BACK_STATUS.BLOCKED, action: BACK_ACTION.TRANSIENT, reason: 'unsaved-edit' };
    state.selected.clear();
    state.selectedFolderCard = null;
    updateCardSelectionStyles();
    renderInspector();
    return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'selection' };
  }
  return null;
}

const backActionRouter = createBackRouter({
  consumeTransient: closeTopTransientSurface,
  consumePreview: () => {
    if ($('#previewModal').classList.contains('hidden')) return null;
    return closePreview()
      ? { status: BACK_STATUS.HANDLED, action: BACK_ACTION.PREVIEW }
      : { status: BACK_STATUS.BLOCKED, action: BACK_ACTION.PREVIEW, reason: 'unsaved-edit' };
  },
  canNavigateBack: () => state.historyIndex > 0,
  navigateBack: () => navigateHistory(-1)
});

const shellBackEntry = Object.freeze({
  request() {
    const deferral = { question: null };
    shellBackDeferral = deferral;
    let result;
    try {
      result = backActionRouter.request();
    } finally {
      shellBackDeferral = null;
    }
    if (deferral.question) {
      setTimeout(() => {
        if (!confirm(deferral.question)) return;
        preAnsweredQuestion = deferral.question;
        try {
          backActionRouter.request();
        } finally {
          preAnsweredQuestion = null;
        }
      }, 0);
    }
    return result;
  }
});

function requestBackAction() {
  return window.EagleMVBack.request();
}

// A phone or tablet browser (not the Android shell, which sends its own back
// key) has no back semantics of its own: the gesture left the page with a
// preview, a drawer or a selection still up (W-08). While back has something
// to close, one sentinel history entry sits above the page; popping it runs
// the same back router, and it is re-armed while more remains. With nothing
// left it is removed, so the next back leaves the page as usual.
const browserBackGuard = isWebClient && !window.eagleMV.shellApp && typeof history?.pushState === 'function';
document.body.classList.toggle('browser-back', browserBackGuard);
let backGuardArmed = false;
let backGuardDisarming = false;
let backGuardSyncQueued = false;

function hasBackTarget() {
  if (activeMarquee?.started || document.querySelector('dialog[open], .sort-popover:not(.hidden), .tag-suggestion-popover:not(.hidden)')) return true;
  const surfaces = ['#folderDialog', '#webAccessDialog', '#trashDialog', '#duplicateDialog', '#contextMenu', '#tagColorManager', '#filterPopover', '#paneLayoutPopover', '#libraryPopover', '#previewModal'];
  if (surfaces.some(selector => $(selector) && !$(selector).classList.contains('hidden'))) return true;
  return Boolean(state.openDrawer || state.selected.size || state.selectedFolderCard || state.historyIndex > 0);
}

function syncBrowserBackGuard() {
  backGuardSyncQueued = false;
  if (!browserBackGuard || backGuardDisarming) return;
  const wanted = hasBackTarget();
  if (wanted && !backGuardArmed) {
    history.pushState({ eaglemvBackGuard: true }, '');
    backGuardArmed = true;
  } else if (!wanted && backGuardArmed && history.state?.eaglemvBackGuard) {
    backGuardArmed = false;
    backGuardDisarming = true;
    history.back();
  }
}

function scheduleBackGuardSync() {
  if (!browserBackGuard || backGuardSyncQueued) return;
  backGuardSyncQueued = true;
  setTimeout(syncBrowserBackGuard, 0);
}

if (browserBackGuard) {
  window.addEventListener('popstate', () => {
    if (backGuardDisarming) { backGuardDisarming = false; return; }
    if (!backGuardArmed) return;
    backGuardArmed = false;
    requestBackAction();
    syncBrowserBackGuard();
  });
  // Surfaces open and close on user input, so re-check after each one.
  for (const type of ['click', 'pointerup', 'keyup', 'touchend']) document.addEventListener(type, scheduleBackGuardSync, true);
}

function parentView() {
  return resolveParentView(state.library?.folders, state.currentView);
}

function navigateUp() {
  const parent = parentView();
  if (parent) navigate(parent, { restoreScroll: true });
}

const breadcrumbObservers = new WeakMap();

function eaglePathForView(view = state.currentView) {
  if (view?.kind === 'root') return '';
  if (view?.kind !== 'folder') return null;
  return formatEaglePath(state.library?.folders, view.id);
}

function breadcrumbPathError(code) {
  return ({
    'unsupported-format': '只支持 Eagle 逻辑路径，不支持本机路径',
    'ambiguous': 'Eagle 文件夹路径有歧义，请补全父级路径',
    'not-found': '未找到对应的 Eagle 文件夹路径'
  })[code] || 'Eagle 文件夹路径无效';
}

function cancelBreadcrumbEdit(breadcrumb, paneId = state.activePaneId) {
  if (!breadcrumb?.classList.contains('is-editing')) return;
  withActivePane(paneId, () => renderLocation());
}

function beginBreadcrumbEdit(breadcrumb, paneId = state.activePaneId) {
  if (!breadcrumb || breadcrumb.classList.contains('is-editing')) return false;
  const eaglePath = withActivePane(paneId, () => eaglePathForView());
  if (eaglePath === null) {
    toast('当前视图不是 Eagle 文件夹路径');
    return false;
  }
  breadcrumb.classList.add('is-editing');
  breadcrumb.innerHTML = '<input class="breadcrumb-input" type="text" autocomplete="off" spellcheck="false" aria-label="Eagle 文件夹路径" placeholder="Eagle 文件夹路径（根目录留空）">';
  const input = breadcrumb.querySelector('.breadcrumb-input');
  input.value = eaglePath;
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelBreadcrumbEdit(breadcrumb, paneId);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    withActivePane(paneId, () => {
      const result = resolveEaglePath(state.library?.folders, input.value);
      if (!result.ok) {
        input.setAttribute('aria-invalid', 'true');
        toast(breadcrumbPathError(result.code), 3200);
        input.focus();
        return;
      }
      input.removeAttribute('aria-invalid');
      const navigated = navigate(result.view, { restoreScroll: true });
      if (!navigated) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
    });
  });
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (breadcrumb.classList.contains('is-editing') && document.activeElement !== input) cancelBreadcrumbEdit(breadcrumb, paneId);
    }, 0);
  });
  input.focus();
  input.select();
  return true;
}

function breadcrumbButtonMarkup(crumb, index, { current = false, extraClass = '' } = {}) {
  const classes = ['breadcrumb-segment', extraClass, current ? 'breadcrumb-current' : ''].filter(Boolean).join(' ');
  const dropTarget = crumb.view.kind === 'folder' ? ` data-crumb-folder-id="${escapeHTML(crumb.view.id)}"` : crumb.view.kind === 'root' ? ' data-crumb-root' : '';
  return `<button type="button" class="${classes}" data-crumb-index="${index}"${dropTarget} title="${escapeHTML(crumb.label)}"${current ? ' disabled aria-current="page"' : ''}>${escapeHTML(crumb.label)}</button>`;
}

function breadcrumbSeparatorMarkup() {
  return '<span class="breadcrumb-separator" aria-hidden="true">›</span>';
}

function fullBreadcrumbMarkup(crumbs) {
  return `<div class="breadcrumb-track breadcrumb-full" role="list">${crumbs.map((crumb, index) => `${breadcrumbButtonMarkup(crumb, index, { current: index === crumbs.length - 1 })}${index < crumbs.length - 1 ? breadcrumbSeparatorMarkup() : ''}`).join('')}</div>`;
}

function collapsedBreadcrumbMarkup(crumbs) {
  const currentIndex = crumbs.length - 1;
  const parentIndex = currentIndex - 1;
  const hidden = crumbs.slice(1, Math.max(1, currentIndex - 1));
  const parts = [breadcrumbButtonMarkup(crumbs[0], 0), breadcrumbSeparatorMarkup()];
  if (hidden.length) {
    const hiddenLabels = hidden.map(crumb => crumb.label).join('、');
    parts.push(`<button type="button" class="breadcrumb-ellipsis" data-crumb-expand title="显示中间路径：${escapeHTML(hiddenLabels)}" aria-label="显示中间路径：${escapeHTML(hiddenLabels)}">…</button>`);
    parts.push(breadcrumbSeparatorMarkup());
  }
  if (parentIndex > 0) {
    parts.push(breadcrumbButtonMarkup(crumbs[parentIndex], parentIndex, { extraClass: 'breadcrumb-parent' }));
    parts.push(breadcrumbSeparatorMarkup());
  }
  parts.push(breadcrumbButtonMarkup(crumbs[currentIndex], currentIndex, { current: true }));
  return `<div class="breadcrumb-track breadcrumb-collapsed" role="list">${parts.join('')}</div>`;
}

function measureBreadcrumbWidth(track) {
  if (!track) return 0;
  const previous = {
    display: track.style.display,
    width: track.style.width,
    maxWidth: track.style.maxWidth,
    flex: track.style.flex,
    overflow: track.style.overflow
  };
  track.style.display = 'flex';
  track.style.width = 'max-content';
  track.style.maxWidth = 'none';
  track.style.flex = '0 0 auto';
  track.style.overflow = 'visible';
  const width = Math.ceil(track.getBoundingClientRect().width);
  track.style.display = previous.display;
  track.style.width = previous.width;
  track.style.maxWidth = previous.maxWidth;
  track.style.flex = previous.flex;
  track.style.overflow = previous.overflow;
  return width;
}

function syncBreadcrumbLayout(breadcrumb) {
  if (!breadcrumb) return;
  const full = breadcrumb.querySelector('.breadcrumb-full');
  const collapsed = breadcrumb.querySelector('.breadcrumb-collapsed');
  const collapsible = breadcrumb.dataset.collapsible === 'true';
  const expanded = breadcrumb.classList.contains('is-expanded');
  const width = breadcrumb.getBoundingClientRect().width;
  const fullWidth = measureBreadcrumbWidth(full);
  const compact = !expanded && collapsible && width > 0 && fullWidth > width + 1;
  breadcrumb.classList.toggle('is-compact', compact);
  full?.setAttribute('aria-hidden', String(compact || expanded));
  collapsed?.setAttribute('aria-hidden', String(!compact || expanded));
  const expandButton = collapsed?.querySelector('[data-crumb-expand]');
  expandButton?.setAttribute('aria-expanded', String(expanded));
}

function observeBreadcrumbLayout(breadcrumb) {
  breadcrumbObservers.get(breadcrumb)?.disconnect();
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => syncBreadcrumbLayout(breadcrumb));
    observer.observe(breadcrumb);
    breadcrumbObservers.set(breadcrumb, observer);
  }
  syncBreadcrumbLayout(breadcrumb);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => syncBreadcrumbLayout(breadcrumb));
}

function renderLocation() {
  if (!state.library) return;
  let crumbs = [{ label: state.library.name || '资源库', view: { kind: 'root' } }];
  if (state.currentView.kind === 'folder') {
    const folderPath = findFolderPath(state.library.folders, state.currentView.id);
    crumbs = folderPath.length
      ? crumbs.concat(folderPath.map(folder => ({ label: folder.name, view: { kind: 'folder', id: folder.id } })))
      : crumbs.concat({ label: state.viewTitle || '文件夹', view: state.currentView });
  } else if (state.currentView.kind !== 'root') {
    crumbs.push({ label: state.viewTitle, view: state.currentView });
  }
  const breadcrumb = $('#breadcrumb');
  if (!breadcrumb) return;
  const eaglePath = eaglePathForView(state.currentView);
  breadcrumb.dataset.depth = String(crumbs.length);
  breadcrumb.dataset.collapsible = String(crumbs.length >= 3);
  breadcrumb.dataset.eaglePath = eaglePath ?? '';
  breadcrumb.dataset.eagleEditable = String(eaglePath !== null);
  breadcrumb.classList.remove('is-expanded', 'is-compact');
  breadcrumb.classList.remove('is-editing');
  breadcrumb.innerHTML = `${fullBreadcrumbMarkup(crumbs)}${crumbs.length >= 3 ? collapsedBreadcrumbMarkup(crumbs) : ''}`;
  breadcrumb._crumbs = crumbs;
  observeBreadcrumbLayout(breadcrumb);
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

function importResultMessage(result, pending = 0) {
  const unknown = result.unknown?.length || 0;
  const notSubmitted = result.notSubmitted?.length || 0;
  const issues = result.rejected?.length || 0;
  const duplicateFailed = Number(result.duplicateFailed) || 0;
  return `已确认接收 ${result.count || 0} 个素材${pending ? ` · ${pending} 个仍由 Eagle 后台处理` : ''}`
    + (unknown ? ` · ${unknown} 个提交结果待核对，请勿直接重复导入` : '')
    + (notSubmitted ? ` · ${notSubmitted} 个尚未提交` : '')
    + (issues ? ` · ${issues} 项路径或处理异常` : '')
    + (duplicateFailed ? ` · ${duplicateFailed} 个重复素材处理失败，请核对目标文件夹` : '')
    + (result.error?.message ? ` · ${result.error.message}` : '');
}

function importTargetFolderId() {
  return state.currentView.kind === 'folder' ? state.currentView.id : null;
}

async function importFiles(paths = null, source = 'picker', target = {}) {
  if (!state.connected || state.importing) return;
  const targetPaneId = target.paneId || state.activePaneId;
  const libraryPath = target.libraryPath || state.library?.path;
  const folderId = Object.prototype.hasOwnProperty.call(target, 'folderId') ? target.folderId : importTargetFolderId();
  const operationToken = beginForegroundOperation('正在导入到 Eagle…', { key: 'import' });
  if (!operationToken) return;
  state.importing = true;
  setSyncStatus('正在导入到 Eagle…');
  try {
    const payload = { folderId, libraryPath, ...(target.clipboardText ? { clipboardText: target.clipboardText } : {}) };
    let result = source === 'clipboard'
      ? await window.eagleMV.importClipboard(payload)
      : source === 'url'
        ? await window.eagleMV.importURL({ ...payload, url: target.url, image: Boolean(target.image) })
        : await window.eagleMV.importItems({ ...payload, ...(paths?.length ? { paths } : {}) });
    if (result.canceled) return;
    if (result.needsDuplicateDecision) {
      const rejected = result.rejected || [];
      const choice = await chooseDuplicateAction(result.duplicates || [], result.total || result.paths?.length || paths?.length || 0) || 'cancel';
      // Web uploads already imported the rest of the batch and the host holds
      // the duplicates, so a cancel is still sent to release them.
      if (choice === 'cancel' && !result.stagedUploads) return;
      result = await window.eagleMV.importItems({ ...payload, paths: result.paths, duplicateChoice: choice });
      result.rejected = [...rejected, ...(result.rejected || [])];
      if (result.canceled) return;
    }
    if (!result.count) {
      const uncertain = result.unknown?.length || result.notSubmitted?.length;
      toast(result.error || result.duplicateFailed || uncertain ? importResultMessage(result)
        : source === 'clipboard' ? '剪贴板里没有可导入的文件或图片'
        : source === 'url' ? (result.source === 'unsupported' ? '网页端暂不支持拖入网址；请在主机窗口中拖入' : '没有可导入的网址')
        : (result.rejected?.[0]?.message || '没有可导入的文件'), 5000);
      return;
    }
    if (result.nativeDecisionPending) {
      toast('Eagle 尚未完成重复确认，请在 Eagle 核对；本次不会重复提交文件', 6500);
    } else await window.eagleMV.focusWindow().catch(() => {});
    await refreshAllPanes({ reset: true, preserveScroll: true });
    const pending = Math.max(0, result.count - result.ready);
    toast(importResultMessage(result, pending), result.partial || result.duplicateFailed ? 6500 : 4200);
    if (pending) {
      const refreshPaneIds = new Set([targetPaneId]);
      if (folderId && Array.isArray(state.panes)) {
        for (const pane of state.panes) {
          if (pane.currentView?.kind === 'folder' && pane.currentView.id === folderId) {
            refreshPaneIds.add(pane.id);
          }
        }
      }
      for (const pId of refreshPaneIds) {
        setTimeout(() => refresh({ reset: true, preserveScroll: true, paneId: pId }), 1600);
        setTimeout(() => refresh({ reset: true, preserveScroll: true, paneId: pId }), 4200);
      }
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
      if (popover && !popover.classList.contains('hidden')) event.preventDefault();
      closeTagSuggestions(kind);
    } else if (event.key === 'Enter' && activeIndex >= 0 && suggestions[activeIndex]) {
      event.preventDefault();
      chooseTagSuggestion(kind, suggestions[activeIndex].name);
    } else if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
      event.preventDefault();
      if (kind === 'batch' && event.key === 'Enter') applyBatchTags();
      else commitTagInput(kind);
    } else if (event.key === 'Backspace' && !input.value && tagValues(kind).length) {
      removeTag(kind, tagValues(kind).at(-1));
    }
  });
  input.addEventListener('focus', () => openTagSuggestions(kind));
  input.addEventListener('input', () => renderTagSuggestionPopover(kind, { open: true }));
  input.addEventListener('blur', () => {
    // A multi-select tag applies on Return only, as in Eagle: leaving the
    // field must not tag a whole selection with a half-typed word.
    if (kind !== 'batch') commitTagInput(kind);
    if (kind === 'item') queueInspectorAutoSave({ immediate: true });
    setTimeout(() => {
      if (document.activeElement !== input && !popover?.contains(document.activeElement)) closeTagSuggestions(kind);
    }, 0);
  });
  input.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text') || '';
    if (!/[,，\n]/.test(text)) return;
    event.preventDefault();
    addTagEntries(kind, text.split(/[,，\n]+/));
  });
  chips.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-tag]');
    if (button) removeTag(kind, button.dataset.removeTag);
    const excluded = event.target.closest('[data-remove-excluded-tag]');
    if (excluded) updateActiveQuery(query => { query.tagsExclude = (query.tagsExclude || []).filter(tag => tag !== excluded.dataset.removeExcludedTag); });
  });
  // Right-click turns a filter tag into an excluded one and back (Eagle's
  // 排除 on the tag list).
  if (kind === 'filter') chips.addEventListener('contextmenu', event => {
    const chip = event.target.closest('.tag-chip');
    const button = chip?.querySelector('[data-remove-tag], [data-remove-excluded-tag]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const tag = button.dataset.removeTag ?? button.dataset.removeExcludedTag;
    updateActiveQuery(query => toggleIncludeExclude(query, 'tags', 'tagsExclude', tag, button.dataset.removeTag !== undefined));
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

// Eagle's folder menu ends with a row of colour dots: 无 plus the eight
// colours /api/v2/folder/update accepts (P1-12). Each dot is its own action.
const folderMenuColors = Object.freeze(['', 'red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'pink']);
// Eagle's folder menu toggles the same global 显示子文件夹内容 switch.
function subfolderContentMenuRow() {
  return '<div class="context-menu-separator"></div>' + contextMenuRow({ label: '在父文件夹显示子文件夹内容', checked: cardDisplay.subfolderContent, action: 'toggle-subfolder-content' });
}

function folderColorMenuRows(folderId) {
  const folder = findFolder(state.library?.folders, folderId);
  if (!folder || !window.eagleMV.updateFolderProperties) return [];
  const current = String(folder.iconColor || '').toLowerCase();
  const disabled = !state.connected;
  const swatches = folderMenuColors.map(color => {
    const label = color ? eagleColorLabels[color] : '无';
    const checked = current === color;
    return `<button type="button" class="context-color-swatch${color ? '' : ' none'}${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}" role="menuitemradio" aria-checked="${checked}" aria-disabled="${disabled}" title="${label}" aria-label="文件夹颜色：${label}"${color ? ` style="--swatch:${eagleNamedFolderColors[color]}"` : ''} data-context-action="set-folder-color" data-context-payload="${escapeHTML(JSON.stringify({ folderId, color }))}"></button>`;
  }).join('');
  return ['<div class="context-menu-separator"></div>', `<div class="context-menu-colors" role="group" aria-label="文件夹颜色">${swatches}</div>`];
}

// Eagle's folder menus (sidebar and subfolder card) end with 删除文件夹 ⌘⌫.
// The sidebar one then opens the next folder, the card one stays put.
function removeFolderMenuRows(folderId, { selectNext }) {
  const folder = findFolder(state.library?.folders, folderId);
  if (!window.eagleMV.removeFolder || !folder) return [];
  // Eagle disables it for a locked folder; MultiView cannot unlock one.
  return ['<div class="context-menu-separator"></div>', contextMenuRow({
    icon: 'trashMenu', label: '删除文件夹', shortcut: '⌘ ⌫', action: 'remove-folder-node',
    payload: { folderId, selectNext }, disabled: !state.connected || Boolean(folder.password), danger: true
  })];
}

function contextMenuRow({ icon = 'more', label, shortcut = '', action = '', payload = {}, submenu = null, disabled = false, danger = false, checked = null, keepOpen = false }) {
  // keepOpen: a check row that toggles in place, like Eagle's keepOpen items.
  const attributes = action ? ` data-context-action="${escapeHTML(action)}" data-context-payload="${escapeHTML(JSON.stringify(payload))}"${keepOpen ? ' data-keep-open="true"' : ''}` : '';
  const className = `context-menu-row${submenu ? ' has-submenu' : ''}${disabled ? ' disabled' : ''}${danger ? ' danger' : ''}${checked ? ' checked' : ''}`;
  const child = submenu ? `<span class="context-menu-arrow">›</span><div class="context-submenu">${submenu}</div>` : '';
  // A choice row (checked true/false) leads with a check mark, like a native menu.
  const leading = checked === null ? uiIcon(icon, 'context-menu-icon') : (checked ? '<span class="context-menu-check" aria-hidden="true">✓</span>' : '');
  return `<div class="${className}" role="${checked === null ? 'menuitem' : 'menuitemradio'}"${checked === null ? '' : ` aria-checked="${checked ? 'true' : 'false'}"`}${attributes} aria-disabled="${disabled ? 'true' : 'false'}">
    <span class="context-menu-leading">${leading}</span><span class="context-menu-label">${escapeHTML(label)}</span>${shortcut ? `<span class="context-menu-shortcut">${escapeHTML(keyboardPlatform.shortcutText(shortcut))}</span>` : ''}${child}
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
    // Phones have no menu bar and no right-click: this row is the touch
    // entry point for imports (desktop keeps it too — same pipeline).
    ...(hasCapability('importLocal') ? [contextMenuRow({ icon: 'import', label: state.importing ? '正在导入…' : '导入文件…', shortcut: '⌘ ⇧ O', action: 'import', disabled: !state.connected || state.importing })] : []),
    ...(window.eagleMV.startSiteImport ? [contextMenuRow({ icon: 'import', label: '站点导入', submenu: [
      contextMenuRow({ label: 'ArtStation 作品挑选…', action: 'site-import', disabled: !state.connected }),
      contextMenuRow({ label: 'Pinterest 导入说明', action: 'pinterest-help' })
    ].join('') })] : []),
    ...(hasCapability('multiWindow') ? [contextMenuRow({ icon: 'window', label: '新建窗口', shortcut: '⌘ ⌥ N', action: 'new-window' })] : [])
  ].join('');
}

function newWindowMenuMarkup() {
  return [
    contextMenuRow({ icon: 'library', label: '新建在根目录', action: 'new-window-root' }),
    contextMenuRow({ icon: 'folder', label: '新建在当前 Eagle 路径', action: 'new-window-eagle' }),
    contextMenuRow({ icon: 'window', label: '新建在当前 MultiView 路径（默认）', action: 'new-window-multiview' })
  ].join('');
}

const paneLayoutLabels = Object.freeze({
  single: '单栏',
  vertical2: '左右两栏',
  horizontal2: '上下两栏',
  grid4: '四格',
  leftStack: '左大右上下',
  rightStack: '左上下右大',
  topStack: '上大下左右',
  bottomStack: '上左右下大',
  horizontal3: '三行',
  vertical3: '三栏',
  vertical4: '四栏',
  horizontal4: '四行'
});

function paneLayoutMenuMarkup(paneId = state.activePaneId) {
  return Object.keys(paneLayouts).map(layout => contextMenuRow({
    icon: 'layoutGrid',
    label: paneLayoutLabels[layout] || layout,
    action: 'set-pane-layout',
    payload: { layout, paneId }
  })).join('');
}

function capturePaneReveal(data) {
  const source = paneById(data.paneId || state.activePaneId);
  if (!source) return null;
  const folderId = data.kind === 'folder' ? data.folderId : data.kind === 'sidebar' ? data.targetFolderId : null;
  const isPath = ['workspace', 'folder', 'sidebar', 'smart-folder'].includes(data.kind);
  return {
    sourcePaneId: source.id,
    libraryPath: state.library?.path,
    layout: $('#paneLayout').dataset.layout,
    view: folderId ? { kind: 'folder', id: folderId }
      : data.kind === 'smart-folder' ? { kind: 'smart', id: data.smartFolderId }
      : { ...source.currentView },
    query: isPath ? createQuery() : cloneQuery(source.query),
    ids: isPath ? [] : [...new Set(data.ids || [])],
    loadedCount: isPath ? 0 : source.items.length
  };
}

function revealInPaneMenuMarkup(data) {
  const context = data.paneReveal;
  if (!context) return '';
  const targets = paneRevealTargets(context.layout, state.panes, context.sourcePaneId, { stacked: isCompactLayout() });
  if (!targets.length) return '';
  const disabled = !state.connected;
  const row = target => contextMenuRow({
    icon: 'revealPane', label: target.label, action: 'reveal-in-pane',
    payload: { paneId: target.paneId }, disabled
  });
  if (targets.length === 1) return row({ ...targets[0], label: '在另一窗格显示' });
  return contextMenuRow({ icon: 'revealPane', label: '在窗格中显示', submenu: '<div class="pane-target-options">' + targets.map(row).join('') + '</div>', disabled });
}

async function revealInPane(context, targetPaneId) {
  if (!context || context.libraryPath !== state.library?.path ||
      context.layout !== $('#paneLayout').dataset.layout || !paneById(context.sourcePaneId)) return false;
  const target = paneById(targetPaneId);
  if (!target || target.id === context.sourcePaneId) return false;
  if (!state.connected) { toast('Eagle 未连接，请连接后重试'); return false; }
  if (state.inspectorSaving || state.operationTracker.size || target.textSaving) {
    toast('正在保存或处理操作，请稍候再切换窗格');
    return false;
  }
  if (context.view.kind === 'folder') {
    const folder = findFolder(state.library?.folders, context.view.id);
    if (!folder || folder.password) { toast('目标文件夹不可用或已加密'); return false; }
  }
  const previousPaneId = state.activePaneId;
  if (!activatePane(target.id)) return false;
  // Navigate owns draft confirmation and history. Pass the replacement query
  // only after that confirmation so Cancel leaves the target completely intact.
  if (!navigate(context.view, { query: context.query, refreshView: false, restoreScroll: false })) {
    activatePane(previousPaneId);
    return false;
  }
  const viewKey = descriptorKey(target.currentView);
  const queryKey = JSON.stringify(target.query);
  const refreshToken = target.refreshToken + 1;
  const stillCurrent = () => paneById(target.id) === target &&
    state.library?.path === context.libraryPath && target.refreshToken === refreshToken &&
    descriptorKey(target.currentView) === viewKey && JSON.stringify(target.query) === queryKey;
  await refresh({ paneId: target.id, reset: true, preserveScroll: false, minimumCount: context.loadedCount });
  if (!stillCurrent() || target.errorMessage) return false;
  if (context.ids.length) {
    const available = new Set(target.items.map(item => item.id));
    target.selected = new Set(context.ids.filter(id => available.has(id)));
    withActivePane(target.id, () => {
      if (target.sort === 'manual') {
        const selectedEnd = sortedItems().reduce((end, item, index) => target.selected.has(item.id) ? index + 1 : end, 0);
        if (selectedEnd > (target.manualRenderLimit || SORT_FETCH_CAP)) {
          target.manualRenderLimit = selectedEnd;
          renderGrid({ preserveScroll: true });
        }
      }
      updateCardSelectionStyles();
    });
    if (state.activePaneId === target.id) renderInspector();
    if (target.selected.size !== context.ids.length) toast('部分素材已变化或不在当前结果中，请刷新来源窗格后重试');
  }
  saveSessionState();
  requestAnimationFrame(() => {
    if (!stillCurrent() || state.activePaneId !== target.id) return;
    const firstId = [...target.selected][0];
    const card = firstId && paneRoot(target.id)?.querySelector('.item-card[data-id="' + CSS.escape(firstId) + '"]');
    if (card) {
      card.scrollIntoView({ block: 'nearest' });
      card.focus({ preventScroll: true });
    } else {
      paneRoot(target.id)?.scrollIntoView({ block: 'nearest' });
    }
  });
  return true;
}

async function openItemLocation(id, folderId = null, { paneId = state.activePaneId } = {}) {
  const pane = paneById(paneId) || activePane();
  if (!pane) return false;
  if (!state.connected) {
    toast('Eagle 未连接，请连接后重试');
    return false;
  }
  if (state.inspectorSaving || state.operationTracker.size || pane.textSaving) {
    toast('正在保存或处理操作，请稍候再切换位置');
    return false;
  }
  let targetView = { kind: 'all' };
  if (folderId) {
    const folder = findFolder(state.library?.folders, folderId);
    if (!folder) {
      toast('目标文件夹不存在或已被删除');
      return false;
    }
    if (folder.password) {
      toast('该文件夹已加密，MultiView 无法解锁（Eagle API 限制）', 3600);
      return false;
    }
    targetView = { kind: 'folder', id: folder.id, name: folder.name };
  }
  if (state.activePaneId !== pane.id && !activatePane(pane.id)) return false;

  const libraryPath = state.library?.path;
  const freshQuery = createQuery();
  if (!navigate(targetView, { query: freshQuery, refreshView: false, restoreScroll: false })) {
    return false;
  }

  const viewKey = descriptorKey(pane.currentView);
  const queryKey = JSON.stringify(pane.query);
  // Background syncs and viewport fills may refresh the pane meanwhile; only
  // leaving the view, changing the query or switching library abandons it.
  const stillCurrent = () => paneById(pane.id) === pane &&
    state.library?.path === libraryPath &&
    descriptorKey(pane.currentView) === viewKey && JSON.stringify(pane.query) === queryKey;

  await refresh({ paneId: pane.id, reset: true, preserveScroll: false });
  if (!stillCurrent() || pane.errorMessage) return false;

  let itemIndex = pane.items.findIndex(item => item.id === id);
  if (itemIndex === -1 && pane.hasMore) {
    // Ask the host where the item sits (ids only, about a second for 85k
    // items), then load just that far. Loading past SORT_FETCH_CAP stalls
    // the page for seconds, so a deeper item is reported instead.
    toast('正在定位素材…', 15000);
    let position = null;
    try {
      position = (await window.eagleMV.locateItem({ query: paneItemQuery(pane), id }))?.index ?? null;
    } catch {}
    if (!stillCurrent()) return false;
    const where = targetView.kind === 'all' ? '全部' : `“${targetView.name}”`;
    if (position === -1) {
      toast(`${where}中没有找到该素材，它可能已被移动或删除`, 4200);
      saveSessionState();
      return true;
    }
    if (position !== null && position >= SORT_FETCH_CAP) {
      toast(`该素材在${where}的第 ${(position + 1).toLocaleString()} 个，超出可直接定位的范围（前 ${SORT_FETCH_CAP.toLocaleString()} 个）`, 5200);
      saveSessionState();
      return true;
    }
    await refresh({ paneId: pane.id, reset: true, preserveScroll: false, minimumCount: position === null ? SORT_FETCH_CAP : position + 1 });
    if (!stillCurrent() || pane.errorMessage) return false;
    itemIndex = pane.items.findIndex(item => item.id === id);
    if (itemIndex === -1) toast(`没能在${where}中定位到该素材，请刷新后重试`, 4200);
    else $('#toast').classList.add('hidden');
  }

  if (itemIndex !== -1) {
    pane.selectedFolderCard = null;
    pane.selected = new Set([id]);
    withActivePane(pane.id, () => {
      if (pane.sort === 'manual') {
        const selectedEnd = sortedItems().reduce((end, item, index) => pane.selected.has(item.id) ? index + 1 : end, 0);
        if (selectedEnd > (pane.manualRenderLimit || SORT_FETCH_CAP)) {
          pane.manualRenderLimit = selectedEnd;
          renderGrid({ preserveScroll: true });
        }
      }
      updateCardSelectionStyles();
    });
    if (state.activePaneId === pane.id) renderInspector();
    saveSessionState();
    requestAnimationFrame(() => {
      if (!stillCurrent() || state.activePaneId !== pane.id) return;
      const card = paneRoot(pane.id)?.querySelector('.item-card[data-id="' + CSS.escape(id) + '"]');
      if (card) {
        card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        card.focus({ preventScroll: true });
        pane.scrollTop = paneQuery(pane.id, '#gridScroller')?.scrollTop || 0;
        if (state.activePaneId === pane.id) updateScrollUI();
      }
    });
  } else {
    saveSessionState();
  }
  return true;
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

function openItemLocationMenuMarkup(id, paneId = state.activePaneId) {
  const pane = paneById(paneId) || activePane();
  const item = (pane?.items || []).find(candidate => candidate?.id === id) || itemById(id);
  const locations = itemFolderLocations(item, state.library?.folders);
  const allRow = contextMenuRow({
    icon: 'all',
    label: '全部',
    action: 'open-item-location',
    payload: { id, folderId: null }
  });
  const folderRows = locations.map(folder => contextMenuRow({
    icon: 'folder',
    label: folder.name,
    action: 'open-item-location',
    payload: { id, folderId: folder.id }
  })).join('');
  return contextMenuRow({
    icon: 'openLocation',
    label: '打开文件所在的位置',
    submenu: allRow + folderRows
  });
}

function contextMenuMarkup(data) {
  if (data.kind === 'new-menu') return newCreationMenuMarkup(data);
  if (data.kind === 'tag-manager-tag') return tagManagerTagMenuMarkup(data);
  if (data.kind === 'tag-manager-group') return tagManagerGroupMenuMarkup(data);
  if (data.kind === 'tag-manager-sort') return tagManagerSortMenuMarkup(data);
  if (data.kind === 'new-window-menu') return newWindowMenuMarkup();
  if (data.kind === 'list-columns') return listColumnsMenuMarkup();
  if (data.kind === 'inspector-export') return contextMenuRow({ icon: 'export', label: window.eagleMV.platform === 'web' ? '下载到此设备' : '导出到计算机', action: 'inspector-export' });
  if (data.kind === 'shortcut-folder-picker') {
    return `<div class="context-shortcut-picker">${contextFolderPicker(data.pickerAction || 'add-folder')}</div>`;
  }
  if (data.kind === 'smart-folder') {
    return [
      revealInPaneMenuMarkup(data),
      contextMenuRow({ icon: 'rename', label: '重命名智能文件夹', action: 'rename-smart-folder', payload: { id: data.smartFolderId } }),
      contextMenuRow({ icon: 'smart', label: '将当前筛选另存为智能文件夹', action: 'save-smart-folder' }),
      '<div class="context-menu-separator"></div>',
      contextMenuRow({ icon: 'trashMenu', label: '移除智能文件夹…', action: 'remove-smart-folder', payload: { id: data.smartFolderId }, danger: true })
    ].join('');
  }
  if (data.kind === 'sidebar') {
    return [
      revealInPaneMenuMarkup(data),
      restoreFolderCoverMenu(data.targetFolderId),
      ...(data.targetFolderId && window.eagleMV.moveFolder ? [contextMenuRow({ icon: 'folder', label: '移动文件夹本身…', action: 'move-folder-node', payload: { folderId: data.targetFolderId } })] : []),
      ...(data.targetFolderId && window.eagleMV.copyFolder ? [contextMenuRow({ icon: 'copy', label: '复制文件夹…', action: 'copy-folder-node', payload: { folderId: data.targetFolderId } })] : []),
      ...(data.targetFolderId ? [contextMenuRow({ icon: 'rename', label: '重命名', shortcut: '⌘ R', action: 'rename-folder', payload: { folderId: data.targetFolderId } }), '<div class="context-menu-separator"></div>'] : []),
      contextMenuRow({ icon: 'folder', label: '新建同级文件夹', action: 'create-folder', payload: { parentId: data.siblingParentId || null, subfolder: false, paneId: data.paneId } }),
      ...(data.targetFolderId ? [contextMenuRow({ icon: 'folder', label: '新建子文件夹', shortcut: '⌥ N', action: 'create-folder', payload: { parentId: data.targetFolderId, subfolder: true } })] : []),
      ...(data.targetFolderId ? [subfolderContentMenuRow()] : []),
      ...(data.targetFolderId ? folderColorMenuRows(data.targetFolderId) : []),
      ...(data.targetFolderId ? removeFolderMenuRows(data.targetFolderId, { selectNext: true }) : [])
    ].join('');
  }
  if (data.kind === 'folder') {
    return [
      revealInPaneMenuMarkup(data),
      restoreFolderCoverMenu(data.folderId),
      ...(window.eagleMV.moveFolder ? [contextMenuRow({ icon: 'folder', label: '移动文件夹本身…', action: 'move-folder-node', payload: { folderId: data.folderId } })] : []),
      ...(window.eagleMV.copyFolder ? [contextMenuRow({ icon: 'copy', label: '复制文件夹…', action: 'copy-folder-node', payload: { folderId: data.folderId } })] : []),
      contextMenuRow({ icon: 'rename', label: '重命名', shortcut: '⌘ R', action: 'rename-folder', payload: { folderId: data.folderId } }),
      '<div class="context-menu-separator"></div>',
      contextMenuRow({ icon: 'folder', label: '新建子文件夹', action: 'create-folder', payload: { parentId: data.folderId, subfolder: true, paneId: data.paneId } }),
      subfolderContentMenuRow(),
      ...folderColorMenuRows(data.folderId),
      ...removeFolderMenuRows(data.folderId, { selectNext: false })
    ].join('');
  }
  if (data.kind === 'workspace') {
    return [
      revealInPaneMenuMarkup(data),
      restoreFolderCoverMenu(data.folderId),
      contextMenuRow({ icon: 'all', label: '全选', shortcut: '⌘ A', action: 'select-all', disabled: !state.items.length }),
      ...(state.selected.size ? [contextMenuRow({ icon: 'remove', label: '取消选择', action: 'clear-selection' })] : []),
      '<div class="context-menu-separator"></div>',
      newCreationMenuMarkup({ folderId: data.folderId, paneId: data.paneId }),
      '<div class="context-menu-separator"></div>',
      ...(hasCapability('importLocal') ? [contextMenuRow({ icon: 'import', label: state.importing ? '正在导入…' : '导入文件…', action: 'import', disabled: !state.connected || state.importing })] : []),
      contextMenuRow({ icon: 'refresh', label: '刷新所有分栏', action: 'refresh-all', disabled: !state.connected }),
      '<div class="context-menu-separator"></div>',
      contextMenuRow({ icon: 'more', label: '排序方式', submenu: sortMenuMarkup(data.paneId) }),
      contextMenuRow({ icon: 'layoutJustified', label: '布局', submenu: viewModeMenuMarkup(data.paneId) }),
      contextMenuRow({ icon: 'layoutGrid', label: '分栏布局', submenu: paneLayoutMenuMarkup(data.paneId) })
    ].join('');
  }
  const one = data.ids.length === 1;
  const currentFolder = state.currentView.kind === 'folder' ? state.currentView.id : null;
  const finderLabel = window.eagleMV.platform === 'darwin' ? '在访达中打开' : '在文件资源管理器中显示';
  const folderEntries = contextFolderPicker('add-folder');
  const moveEntries = currentFolder ? contextFolderPicker('move-folder') : '';
  const ratingEntries = [0, 1, 2, 3, 4, 5].map(rating => contextMenuRow({ icon: 'more', label: rating ? `${'★'.repeat(rating)}（${rating} 星）` : '未评分', action: 'rating', payload: { rating } })).join('');
  const moreEntries = [
    ...(window.eagleMV.thumbnailOperation ? [contextMenuRow({ icon: 'refresh', label: '缩略图', submenu: [
      contextMenuRow({ icon: 'refresh', label: '刷新缩略图', action: 'thumbnail-refresh' }),
      contextMenuRow({ icon: 'image', label: '从文件设置…', action: 'thumbnail-file' }),
      contextMenuRow({ icon: 'copy', label: '从剪贴板设置…', action: 'thumbnail-clipboard' }),
      contextMenuRow({ label: '取消自定义：接口尚不支持', action: 'thumbnail-clear' })
    ].join('') })] : []),
    // Eagle: 重命名 for one item, 重命名 N 个项目... (batch rename) for several.
    one
      ? contextMenuRow({ icon: 'rename', label: '重命名', shortcut: '⌘ R', action: 'rename' })
      : contextMenuRow({ icon: 'rename', label: `重命名 ${data.ids.length.toLocaleString()} 个项目...`, shortcut: '⌘ R', action: 'batch-rename' }),
    contextMenuRow({ icon: 'copy', label: one ? '复制素材名称' : `复制 ${data.ids.length} 个素材名称`, action: 'copy-name' }),
    contextMenuRow({ icon: 'tag', label: '添加标签', submenu: contextTagPicker('add-tag', '搜索或输入标签…') }),
    contextMenuRow({ icon: 'copy', label: '复制标签', shortcut: '⌘ ⇧ C', action: 'copy-tags' }),
    contextMenuRow({ icon: 'tag', label: '粘贴标签', shortcut: '⌘ ⇧ V', action: 'paste-tags', disabled: !state.copiedTags.length }),
    contextMenuRow({ icon: 'more', label: '设置评分', submenu: ratingEntries }),
    contextMenuRow({ icon: 'tag', label: '标签颜色', submenu: contextTagPicker('tag-color') })
  ].join('');
  return [
    ...(hasCapability('multiWindow') ? [contextMenuRow({ icon: 'window', label: '在新窗口打开', shortcut: '⌘ O', action: 'open-window' })] : []),
    revealInPaneMenuMarkup(data),
    ...(hasCapability('openDefault') ? [contextMenuRow({ icon: 'open', label: '在默认应用打开', shortcut: '⇧ Enter', action: 'open-default', disabled: !one })] : []),
    ...(hasCapability('openOther') ? [contextMenuRow({ icon: 'open', label: '在其它应用打开…', action: 'open-other', disabled: !one })] : []),
    ...(hasCapability('finder') ? [
      contextMenuRow({ icon: 'finder', label: finderLabel, shortcut: '⌘ Enter', action: 'finder' })
    ] : []),
    ...(one ? [openItemLocationMenuMarkup(data.ids[0], data.paneId)] : []),
    '<div class="context-menu-separator"></div>',
    contextMenuRow({ icon: 'folder', label: '添加至上次使用的文件夹…', shortcut: '⇧ D', action: 'last-folder', disabled: !state.recentFolders?.length }),
    contextMenuRow({ icon: 'folder', label: '添加至文件夹…', shortcut: '⌘ ⇧ J', submenu: folderEntries }),
    ...(currentFolder ? [contextMenuRow({ icon: 'folder', label: '移动到文件夹…', submenu: moveEntries })] : []),
    ...(hasCapability('export') ? [contextMenuRow({ icon: 'export', label: window.eagleMV.platform === 'web' ? '下载到此设备' : '导出', action: 'export' })] : []),
    ...(hasCapability('share') ? [contextMenuRow({ icon: 'share', label: '分享', action: 'share' })] : []),
    '<div class="context-menu-separator"></div>',
    contextMenuRow({ icon: 'pin', label: data.allPinned ? '取消置顶' : '置顶', action: 'pin', disabled: !currentFolder }),
    ...(window.eagleMV.setFolderCover && one && isImageItem(itemById(data.ids[0])) && !data.allDeleted ? [contextMenuRow({
      icon: 'image', label: '设为文件夹封面',
      ...(currentFolder ? { action: 'set-folder-cover', payload: { folderId: currentFolder } }
        : { submenu: contextFolderPicker('set-folder-cover') }),
      disabled: !state.connected || !state.folderCoversReady
    })] : []),
    ...(hasCapability('clipboardFiles') ? [contextMenuRow({ icon: 'copy', label: one ? '复制文件' : `复制 ${data.ids.length} 个文件`, shortcut: '⌘ C', action: 'copy-files' })] : []),
    ...(hasCapability('copyPath') ? [contextMenuRow({ icon: 'path', label: '复制文件路径', shortcut: '⌘ ⌥ C', action: 'copy-path', disabled: !one })] : []),
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
  $('#contextMenu').setAttribute('aria-label', '素材操作菜单');
  $('#newButton')?.setAttribute('aria-expanded', 'false');
  $('#newWindowMenuButton')?.setAttribute('aria-expanded', 'false');
}

const windowActions = createWindowActions({
  bridge: window.eagleMV,
  currentView: () => activePane()?.currentView,
  windowStateForView
});

// The Android shell has a single window; split panes are its way to see two places.
const SINGLE_WINDOW_HINT = '此设备只有一个窗口，可用分栏布局同时浏览多个位置';

function openNewWindowAt(target = 'multiview') {
  if (!hasCapability('multiWindow')) {
    toast(SINGLE_WINDOW_HINT, 3200);
    return Promise.resolve(false);
  }
  return windowActions.open(target);
}

function requestDefaultNewWindow() {
  return openNewWindowAt('multiview').catch(error => toast(`无法新建窗口：${error.message}`, 4000));
}

async function navigateToCurrentEaglePath() {
  const button = $('#currentEaglePathButton');
  const paneId = state.activePaneId;
  button.disabled = true;
  let previousQuery = null;
  try {
    const initialState = await windowActions.eagleState();
    const pane = paneById(paneId);
    if (!pane) return false;
    previousQuery = cloneQuery(pane.query);
    const navigated = withActivePane(paneId, () => {
      state.query = createQuery();
      const result = navigate(initialState.view);
      if (!result) state.query = previousQuery;
      return result;
    });
    if (state.activePaneId === paneId) renderQueryControls();
    return navigated;
  } catch (error) {
    if (previousQuery && paneById(paneId)) {
      paneById(paneId).query = previousQuery;
      if (state.activePaneId === paneId) renderQueryControls();
    }
    toast(`无法跳转到 Eagle 路径：${error.message}`, 4000);
    return false;
  } finally {
    button.disabled = false;
  }
}

function contextMenuAriaLabel(kind) {
  if (kind === 'new-window-menu') return '新窗口位置';
  if (kind === 'list-columns') return '列表显示的列';
  if (kind === 'new-menu') return '新建项目';
  return '素材操作菜单';
}

function openSelectionInNewWindow(ids = []) {
  if (!hasCapability('multiWindow')) {
    toast(SINGLE_WINDOW_HINT, 3200);
    return Promise.resolve(false);
  }
  const uniqueIds = [...new Set(ids || [])].filter(Boolean);
  return window.eagleMV.newWindow({
    view: { ...state.currentView },
    query: cloneQuery(state.query),
    selectedIds: uniqueIds,
    previewId: uniqueIds.length === 1 ? uniqueIds[0] : null
  });
}

function folderCoverSnapshot(folders) {
  return (folders || []).flatMap(folder => [[folder.id, folder.coverId || null], ...folderCoverSnapshot(folder.children)]);
}

function showContextMenuAt(x, y, data) {
  state.contextMenu = { ...data, x, y, paneReveal: capturePaneReveal(data),
    eagleCoverIds: Object.fromEntries(folderCoverSnapshot(state.library?.folders)),
    libraryPath: state.library?.path, coverRevisions: state.localFolderCovers.covers };
  const menu = $('#contextMenu');
  menu.setAttribute('aria-label', contextMenuAriaLabel(data.kind));
  const body = contextMenuMarkup(state.contextMenu);
  const swap = (!data.kind || ['workspace', 'folder', 'sidebar', 'smart-folder', 'items', 'item'].includes(data.kind)) ? swapPanesMenuMarkup() : '';
  // A folder menu ends with its colour dots; keep them a block of their own.
  const endsWithColors = /<div class="context-menu-colors"[^]*<\/button><\/div>$/.test(body);
  menu.innerHTML = body + (swap && endsWithColors ? '<div class="context-menu-separator"></div>' : '') + swap;
  menu.classList.remove('hidden');
  // Narrow screens get a bottom sheet instead of a cursor-anchored panel: the
  // menu is 294px wide and its submenus fly out another 270px, which on a
  // phone lands entirely off the right edge. As a sheet it spans the viewport
  // and the submenus open inline (see the compact rules in styles.css).
  const sheet = isCompactLayout();
  menu.classList.toggle('context-menu-sheet', sheet);
  menu.scrollTop = 0;
  if (sheet) {
    menu.style.left = '';
    menu.style.top = '';
    return;
  }
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    const position = window.EagleMVContextMenuPosition.menuPosition({ x, y }, rect, { width: window.innerWidth, height: window.innerHeight });
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
  });
}

// Submenus are fixed-positioned so the scrolling menu cannot clip them; each
// one is measured when it opens and kept inside the window.
function placeContextSubmenu(row) {
  const menu = $('#contextMenu');
  if (!row || menu.classList.contains('context-menu-sheet')) return;
  const submenu = row.querySelector(':scope > .context-submenu');
  if (!submenu) return;
  const size = submenu.getBoundingClientRect();
  const position = window.EagleMVContextMenuPosition.submenuPosition(row.getBoundingClientRect(), size,
    { width: window.innerWidth, height: window.innerHeight });
  submenu.style.left = `${position.left}px`;
  submenu.style.top = `${position.top}px`;
}

function showContextMenu(event, data) {
  showContextMenuAt(event.clientX, event.clientY, data);
}

// Shared by the sidebar's right-click and its touch long-press.
function openSidebarContextMenu(target, point) {
  const smartRow = target.closest?.('[data-smart-folder-id]');
  if (smartRow) {
    showContextMenuAt(point.x, point.y, { kind: 'smart-folder', smartFolderId: smartRow.dataset.smartFolderId });
    return;
  }
  const targetFolderId = target.closest?.('[data-folder-id]')?.dataset.folderId || null;
  showContextMenuAt(point.x, point.y, {
    kind: 'sidebar',
    ids: [],
    paneId: state.activePaneId,
    targetFolderId,
    siblingParentId: siblingParentId(targetFolderId)
  });
}

async function executeContextAction(action, payload) {
  const data = state.contextMenu;
  if (!data) return;
  if (action.startsWith('tm-')) return executeTagManagerMenuAction(action, payload, data);
  if (action === 'swap-panes') return swapRecentPanes(payload.paneIds);
  if (action === 'inspector-export') return exportItems(data.ids || []);
  if (action === 'set-folder-cover') return setFolderCover(payload.folderId, data.ids?.[0], data);
  if (action === 'reset-folder-cover') return setFolderCover(payload.folderId, null, data);
  if (action === 'reveal-in-pane') return revealInPane(data.paneReveal, payload.paneId);
  if (action === 'site-import') return siteFeatureUI().open();
  if (action === 'pinterest-help') return window.eagleMV.openExternal('https://docs-cn.eagle.cool/article/828-import-from-pinterest');
  if (action === 'move-folder-node') return selectedFeatureUI().moveFolder(payload.folderId);
  if (action === 'copy-folder-node') return selectedFeatureUI().copyFolder(payload.folderId);
  if (action === 'save-smart-folder') return saveCurrentViewAsSmartFolder();
  if (action === 'rename-smart-folder') return renameSmartFolder(payload.id);
  if (action === 'remove-smart-folder') return removeSmartFolder(payload.id);
  if (action === 'create-smart-folder') return createSmartFolderFromNewMenu();
  if (action === 'create-folder' || action === 'create-current-folder') return createFolder(payload.parentId || null, Boolean(payload.subfolder || payload.parentId), payload.paneId || data.paneId);
  if (action === 'create-document') return createNewDocument(payload.type, { folderId: payload.folderId || null, paneId: payload.paneId || data.paneId });
  if (action === 'new-window' || action === 'new-window-multiview') return openNewWindowAt('multiview');
  if (action === 'new-window-root') return openNewWindowAt('root');
  if (action === 'new-window-eagle') return openNewWindowAt('eagle');
  if (action === 'rename-folder') return renameFolderById(payload.folderId || data.folderId);
  if (action === 'remove-folder-node') return removeFolderById(payload.folderId, { selectNext: Boolean(payload.selectNext), paneId: data.paneId });
  if (action === 'set-folder-color') return setFolderColor(payload.folderId, payload.color);
  if (action === 'toggle-subfolder-content') return setCardDisplay({ subfolderContent: !cardDisplay.subfolderContent });
  if (action === 'import') return importFiles();
  if (action === 'refresh-all') return refreshAllPanes({ reset: true, preserveScroll: true });
  if (action === 'set-sort') return applySortFromMenu(payload.sort, payload.paneId || data.paneId);
  if (action === 'toggle-list-column') return toggleListColumn(payload.key);
  if (action === 'set-sort-dir') {
    const paneId = payload.paneId || data.paneId;
    if (paneId && !activatePane(paneId)) return false;
    return applySortDirection(payload.dir);
  }
  if (action === 'set-view-mode') {
    const paneId = payload.paneId || data.paneId || state.activePaneId;
    if (!activatePane(paneId)) return false;
    setPaneViewMode(payload.mode, paneId);
    return true;
  }
  if (action === 'set-pane-layout') {
    const paneId = payload.paneId || data.paneId;
    if (paneId && !activatePane(paneId)) return false;
    return renderPaneLayout(payload.layout, { refresh: true });
  }
  // Touch has no ⌘A and no ⌘-click, so the blank-space menu is the only route
  // to a whole-view selection there.
  if (action === 'select-all') { selectAllItems(); return; }
  if (action === 'clear-selection') { clearSelection(); return; }
  const ids = data.ids || [];
  if (action.startsWith('thumbnail-')) return thumbnailFeatureUI().run(action.slice('thumbnail-'.length), ids);
  const firstId = ids[0];
  if (action === 'open-window') return openSelectionInNewWindow(ids);
  if (action === 'open-default') return openWithDefault(firstId);
  if (action === 'open-other') return openWithOtherApp(firstId);
  if (action === 'finder') return showItemInFileManager(firstId);
  if (action === 'open-item-location') return openItemLocation(payload.id || firstId, payload.folderId ?? null, { paneId: data.paneId });
  if (action === 'copy-files') return copySelectedFiles(ids);
  if (action === 'export') return exportItems(ids);
  if (action === 'share') {
    return window.eagleMV.shareFiles({ ids }).then(result => {
      if (!result?.ok) toast(result?.message || '无法打开分享菜单', 4000);
    });
  }
  if (action === 'duplicate') return duplicateSelection(ids);
  if (action === 'copy-name') return copyTextWithFeedback(ids.map(id => itemById(id)?.name || '').filter(Boolean).join('\n'));
  if (action === 'copy-path') return copyItemPath(firstId);
  if (action === 'copy-tags') return copyTagsFromItems(ids);
  if (action === 'paste-tags') return pasteTagsToItems(ids);
  if (action === 'add-folder') return addSelectionToFolder({ ids, folderId: payload.folderId, keepSelection: Boolean(data.keepSelection) });
  if (action === 'move-folder') return moveSelectionToFolder({ ids, folderId: payload.folderId });
  if (action === 'remove-folder') return removeSelectionFromFolder({ ids, folderId: state.currentView.id });
  if (action === 'last-folder') return addSelectionToFolder({ ids, folderId: state.recentFolders[0]?.id });
  if (action === 'add-tag') return addTagToSelection({ ids, tag: payload.tag });
  if (action === 'tag-color') {
    const tag = String(payload.tag || '').trim();
    if (!tag) return;
    const color = await askTagColor(tag);
    if (color !== null) return updateTagColor(tag, color);
    return;
  }
  if (action === 'rating') return setSelectionRating({ ids, rating: payload.rating });
  if (action === 'pin') return setPinned(ids, !data.allPinned);
  if (action === 'rename') {
    return renameItem(itemById(firstId));
  }
  if (action === 'batch-rename') return openItemBatchRename(ids);
  if (action === 'trash') return setTrash(ids, !data.allDeleted);
}

function openWithOtherApp(id) {
  return window.eagleMV.openOther({ ids: [id] }).then(result => {
    if (result?.message) toast(result.message, 4000);
    else if (result?.missing) toast(`已打开 ${result.count} 个文件 · ${result.missing} 个原文件缺失`, 3500);
  });
}

function exportItems(ids) {
  return window.eagleMV.exportFiles({ ids, libraryPath: state.library?.path }).then(result => {
    if (result?.canceled) return;
    toast(result?.downloaded
      ? `已开始下载 ${result?.count || 0} 个文件${(result?.count || 0) > 1 ? '（打包为 zip）' : ''}`
      : `已导出 ${result?.count || 0} 个文件${result?.missing ? ` · ${result.missing} 个原文件缺失` : ''}`, 4000);
  });
}

// Menu-bar commands (command:menu). Each one checks what the matching
// keyboard shortcut checks, so a click on the menu item and the key do the
// same thing — and a key the page left alone (no selection, preview open)
// stays a no-op after main hands it to the menu.
function runMenuCommand(payload = {}) {
  const command = payload.command;
  const previewOpen = !$('#previewModal').classList.contains('hidden');
  const selectedIds = selectedActionIds();
  const activeItemId = previewOpen && state.previewId ? state.previewId : selectedIds[0];
  const singleItemId = state.previewId || (state.selected.size === 1 ? [...state.selected][0] : null);
  const report = error => toast(`操作失败：${error.message}`, 4000);
  switch (command) {
    case 'switch-library': return openLibraryPopover();
    case 'new-menu': $('#newButton')?.click(); return;
    case 'export':
      if (hasCapability('export') && selectedIds.length) exportItems(selectedIds).catch(report);
      return;
    case 'copy-items': {
      const ids = selectedActionIds({ includePreview: previewOpen });
      if (hasCapability('clipboardFiles') && ids.length) copySelectedFiles(ids).catch(error => toast(`复制失败：${error.message}`, 4000));
      return;
    }
    case 'select-all': selectAllItems(); return;
    case 'copy-path':
      if (hasCapability('copyPath') && activeItemId) copyItemPath(activeItemId).catch(error => toast(`复制路径失败：${error.message}`, 4000));
      return;
    case 'copy-name': {
      const names = selectedActionIds({ includePreview: previewOpen }).map(id => itemById(id)?.name || '').filter(Boolean);
      if (names.length) copyTextWithFeedback(names.join('\n'));
      return;
    }
    case 'duplicate':
      if (!previewOpen && selectedIds.length) duplicateSelection(selectedIds).catch(error => toast(`创建副本失败：${error.message}`, 4000));
      return;
    case 'thumbnail':
      if (window.eagleMV.thumbnailOperation && ['refresh', 'file', 'clipboard'].includes(payload.operation) && selectedIds.length) {
        thumbnailFeatureUI().run(payload.operation, selectedIds);
      }
      return;
    case 'move-current-folder': {
      const folderId = state.selectedFolderCard || (state.currentView.kind === 'folder' ? state.currentView.id : null);
      if (folderId && window.eagleMV.moveFolder) selectedFeatureUI().moveFolder(folderId);
      return;
    }
    case 'remove-from-folder':
      if (previewOpen || !selectedIds.length) return;
      if (state.currentView.kind !== 'folder') toast('请在具体文件夹中使用“从文件夹中移除”', 3500);
      else removeSelectionFromFolder({ ids: selectedIds, folderId: state.currentView.id });
      return;
    case 'trash':
      if (!previewOpen && selectedIds.length) setTrash(selectedIds, true);
      else if (!previewOpen) requestFolderRemovalShortcut();
      return;
    case 'search': $('#searchInput').focus(); return;
    case 'search-all':
      if (navigate({ kind: 'all' }) !== false) requestAnimationFrame(() => $('#searchInput').focus());
      return;
    case 'toggle-filter': $('#filterButton').click(); return;
    case 'reset-filter': clearFilters(); return;
    case 'folder-picker':
      if (previewOpen || !selectedIds.length) return;
      if (payload.action === 'move-folder' && state.currentView.kind !== 'folder') {
        toast('请在具体文件夹中使用“移动到文件夹”', 3500);
        return;
      }
      showFolderAssignmentPicker(selectedIds, { action: payload.action === 'move-folder' ? 'move-folder' : 'add-folder' });
      return;
    case 'last-folder': {
      if (previewOpen || !selectedIds.length) return;
      const folderId = state.recentFolders[0]?.id;
      if (folderId) addSelectionToFolder({ ids: selectedIds, folderId });
      else toast('还没有上次使用的文件夹', 3000);
      return;
    }
    case 'add-tag': focusSelectionTagInput(previewOpen); return;
    case 'rating': {
      const rating = Math.max(0, Math.min(5, Number(payload.rating) || 0));
      if (previewOpen) ratePreviewItem(rating);
      else if (state.selected.size) setSelectionRating({ ids: [...state.selected], rating });
      return;
    }
    case 'copy-tags':
      if (!previewOpen && selectedIds.length) copyTagsFromItems(selectedIds);
      return;
    case 'paste-tags':
      if (!previewOpen && selectedIds.length) pasteTagsToItems(selectedIds);
      return;
    case 'toggle-pin': {
      if (previewOpen || !selectedIds.length) return;
      if (state.currentView.kind !== 'folder') { toast('请在具体文件夹中使用“置顶”', 3500); return; }
      const items = selectedIds.map(itemById).filter(Boolean);
      setPinned(selectedIds, !(items.length && items.every(itemIsPinned)));
      return;
    }
    case 'view-mode': setPaneViewMode(payload.mode, state.activePaneId); return;
    case 'pane-layout': renderPaneLayout(payload.layout, { refresh: true }); return;
    case 'scroll':
      if (!previewOpen) scrollGridByKey(payload.key);
      return;
    case 'zoom': {
      const step = Number(payload.step) || 0;
      if (previewOpen && previewImage()) {
        if (step) changePreviewZoom(step * .25);
        else setPreviewZoom(state.previewZoom.mode === 'actual' ? 'fit' : 'actual');
      } else if (step) changeThumbnailSize(step);
      else resetThumbnailSize();
      return;
    }
    case 'grayscale':
      if (previewOpen) togglePreviewGrayscale();
      return;
    case 'open-window':
      if (singleItemId) openSelectionInNewWindow([singleItemId]);
      return;
    case 'open-default':
      if (hasCapability('openDefault') && singleItemId) openWithDefault(singleItemId);
      return;
    case 'open-other':
      if (hasCapability('openOther') && activeItemId) openWithOtherApp(activeItemId).catch(report);
      return;
    case 'finder':
      if (hasCapability('finder') && activeItemId) showItemInFileManager(activeItemId);
      return;
    case 'open-url': {
      const url = String(itemById(activeItemId)?.url || '').trim();
      if (/^https?:\/\//i.test(url)) window.eagleMV.openExternal(url).catch(error => toast(`打开来源失败：${error.message}`, 4000));
      return;
    }
    case 'toggle-panel':
      if (payload.panel === 'both') {
        if (isCompactLayout()) return;
        const show = !(state.sidebarVisible || state.inspectorVisible);
        state.sidebarVisible = show;
        state.inspectorVisible = show;
        renderPanels();
      } else if (payload.panel === 'sidebar' || payload.panel === 'inspector') {
        togglePanel(payload.panel);
      }
      return;
    case 'card-display':
      if (['name', 'meta', 'annotation', 'subfolderContent'].includes(payload.key)) setCardDisplay({ [payload.key]: !cardDisplay[payload.key] });
      return;
  }
}

// Eagle's ⌘T opens the tag field of the right panel for the selection.
function focusSelectionTagInput(previewOpen) {
  if (previewOpen || !state.selected.size) return;
  if (isCompactLayout()) {
    if (state.openDrawer !== 'inspector') { state.openDrawer = 'inspector'; renderPanels(); }
  } else if (!state.inspectorVisible) {
    state.inspectorVisible = true;
    renderPanels();
  }
  requestAnimationFrame(() => {
    const input = ['#itemTagInput', '#batchTagInput'].map(selector => $(selector))
      .find(element => element && !element.disabled && element.getClientRects().length);
    input?.focus();
  });
}

// Main asks this before running a menu command (MENU_FOCUS_PROBE): a shortcut
// typed into a field is ignored, and copy / select-all stay with the text.
window.eagleMVMenuFocus = () => {
  const target = document.activeElement;
  const editable = isEditableElement(target) || Boolean(target?.closest?.('iframe, webview')) || Boolean(state.inspectorEditing) ||
    Boolean(document.querySelector('.web-copy-dialog[open], .feature-dialog[open]'));
  const selection = window.getSelection?.();
  const textSelected = Boolean(selection && !selection.isCollapsed && selection.toString().length > 0);
  return {
    editable,
    nativeCopy: editable || textSelected,
    nativeSelectAll: editable || textSelected || Boolean(target?.closest?.('#generationMetadataSection, .generation-metadata'))
  };
};

// The menu bar ticks the focused window's view mode and pane layout; main
// keeps the last report per window.
function reportMenuState() {
  const report = { viewMode: state.viewMode || 'justified', paneLayout: $('#paneLayout')?.dataset.layout || 'single' };
  const key = `${report.viewMode}|${report.paneLayout}`;
  if (reportMenuState.last === key) return;
  reportMenuState.last = key;
  window.eagleMV.reportMenuState?.(report);
}

function closeFolderDialog(name = null) {
  $('#folderDialog').classList.add('hidden');
  $('#folderDialog').classList.remove('palette-mode');
  $('#folderDialogPalette').replaceChildren();
  const resolve = state.folderDialogResolve;
  state.folderDialogResolve = null;
  if (resolve) resolve(name);
}

// Shared modal focus boundary. aria-modal alone does not remove background
// controls from keyboard navigation. Business-specific Escape/submit handlers
// remain responsible for closing; the observer restores the invoking focus.
function bindModalFocusBoundary() {
  const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')];
  const previousFocus = new Map();
  const inertBefore = new Map();
  let stack = [];
  const focusable = dialog => [...dialog.querySelectorAll('button, input, textarea, select, a[href], [tabindex]')]
    .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length && !element.closest('.hidden'));
  const sync = () => {
    const visible = dialogs.filter(dialog => !dialog.classList.contains('hidden'));
    const closed = stack.filter(dialog => !visible.includes(dialog));
    for (const dialog of visible) if (!stack.includes(dialog)) {
      previousFocus.set(dialog, document.activeElement);
      stack.push(dialog);
    }
    stack = stack.filter(dialog => visible.includes(dialog));
    for (const [element, inert] of inertBefore) element.inert = inert;
    inertBefore.clear();
    const current = stack.at(-1);
    if (current) {
      for (const child of document.body.children) if (child !== current && !child.contains(current)) {
        inertBefore.set(child, child.inert);
        child.inert = true;
      }
      if (!current.contains(document.activeElement)) (focusable(current)[0] || current).focus({ preventScroll: true });
    } else if (closed.length) {
      const previous = previousFocus.get(closed[0]);
      const target = previous?.isConnected && !previous.closest('.hidden') ? previous : paneRoot();
      target?.focus({ preventScroll: true });
    }
    for (const dialog of closed) previousFocus.delete(dialog);
  };
  const observer = new MutationObserver(sync);
  dialogs.forEach(dialog => observer.observe(dialog, { attributes: true, attributeFilter: ['class'] }));
  document.addEventListener('keydown', event => {
    const current = stack.at(-1);
    if (!current || event.key !== 'Tab') return;
    const targets = focusable(current);
    if (!targets.length) { event.preventDefault(); return; }
    const index = targets.indexOf(document.activeElement);
    if (event.shiftKey ? index <= 0 : index < 0 || index === targets.length - 1) {
      event.preventDefault();
      (event.shiftKey ? targets.at(-1) : targets[0]).focus();
    }
  }, true);
  document.addEventListener('focusin', event => {
    const current = stack.at(-1);
    if (current && !current.contains(event.target)) (focusable(current)[0] || current).focus({ preventScroll: true });
  });
  sync();
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

// Electron has no window.prompt(): it returns null without showing anything.
// Text questions reuse the in-app name dialog instead. Resolves to null when
// cancelled and to the trimmed text (possibly empty when allowed) otherwise.
// The in-app dialog showing the palette instead of the text field. Resolves
// to the picked colour ('' for 无, which clears) or null when cancelled.
function askTagColor(tag) {
  if (state.folderDialogResolve) {
    toast('请先完成当前的输入', 2800);
    return Promise.resolve(null);
  }
  const dialog = $('#folderDialog');
  dialog.classList.add('palette-mode');
  $('#folderDialogTitle').textContent = `设置标签“${tag}”颜色`;
  $('#folderDialogPalette').innerHTML = tagColorPaletteMarkup(tag, state.tagColors[tag]);
  dialog.classList.remove('hidden');
  requestAnimationFrame(() => {
    const palette = $('#folderDialogPalette');
    (palette.querySelector('[aria-checked="true"]') || palette.querySelector('button'))?.focus();
  });
  return new Promise(resolve => { state.folderDialogResolve = resolve; });
}

async function askText({ title, fieldLabel, initialValue = '', placeholder = '', submitLabel = '确定', allowEmpty = false, maxLength = 4000 }) {
  if (state.folderDialogResolve) {
    toast('请先完成当前的输入', 2800);
    return null;
  }
  const input = $('#folderNameInput');
  const defaultMaxLength = input.maxLength;
  state.folderDialogAllowEmpty = allowEmpty;
  input.maxLength = maxLength;
  try {
    return await requestNameDialog({ title, initialValue, submitLabel, fieldLabel, placeholder });
  } finally {
    state.folderDialogAllowEmpty = false;
    input.maxLength = defaultMaxLength;
  }
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
  setSubfoldersCollapsed(false);
  pane.selectedFolderCard = id;
  withActivePane(paneId, () => {
    // The ordering reconciliation emits a second library snapshot. Its
    // refresh preserves the old viewport (often the bottom of a long list),
    // but a newly-created folder is inserted at the top and must be revealed
    // from the top rather than leaving the user stranded at the old offset.
    const scroller = paneQuery(paneId, '#gridScroller');
    if (scroller) { scroller.scrollTop = 0; pane.scrollTop = 0; }
    renderGrid({ preserveScroll: true });
    renderInspector();
  });
  requestAnimationFrame(() => {
    const card = paneQuery(paneId, `.folder-card[data-open-folder="${CSS.escape(id)}"]`);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // A queued Eagle refresh may render once more after this frame; reassert
    // the top anchor briefly so that late ordering snapshots cannot restore
    // the pre-creation bottom offset.
    for (const delay of [80, 260, 700]) setTimeout(() => {
      const current = paneQuery(paneId, '#gridScroller');
      if (current && pane.selectedFolderCard === id) { current.scrollTop = 0; pane.scrollTop = 0; }
    }, delay);
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
  if (!paneById(paneId)) return false;
  // Ask before creating. Eagle names a new folder at creation time; we used to
  // create 未命名文件夹 outright and leave renaming to the user, so every
  // mis-click left a stray empty folder behind — and Eagle's API has no
  // delete-folder endpoint to take it back. Cancelling here creates nothing.
  const name = await requestNameDialog({
    title: subfolder ? '新建子文件夹' : '新建文件夹',
    initialValue: '未命名文件夹',
    submitLabel: '创建',
    placeholder: '未命名文件夹'
  });
  if (name === null) return false;
  const sourcePane = paneById(paneId);
  if (!sourcePane) return false;
  const libraryPath = state.library?.path;
  const viewKey = descriptorKey(sourcePane.currentView);
  const operationToken = beginForegroundOperation(subfolder ? '正在创建子文件夹…' : '正在创建文件夹…', { key: `create-folder:${libraryPath}:${parentId || 'root'}` });
  if (!operationToken) return false;
  try {
    const result = await window.eagleMV.createFolder({ name: name.trim() || '未命名文件夹', parent: parentId, libraryPath });
    if (!result?.id) throw new Error('Eagle 没有返回新文件夹');
    const revealed = await revealCreatedFolder({ paneId, viewKey, libraryPath, parentId, id: result.id });
    if (!revealed && state.library?.path === libraryPath) {
      setTimeout(() => revealCreatedFolder({ paneId, viewKey, libraryPath, parentId, id: result.id }).catch(() => {}), 900);
    }
    toast(result.orderWarning || (result.renamed
      ? `已创建 ${result.name}（同名文件夹已自动编号）`
      : `已创建 ${result.name}`), result.orderWarning ? 6500 : result.renamed ? 3800 : 2400);
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
    toast(result.orderWarning || (result.renamed
      ? `已创建 ${result.name}.${type}（同名文件已自动改名）`
      : `已创建 ${result.name}.${type}`), result.orderWarning ? 6500 : result.renamed ? 4200 : 2800);
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

// Eagle's batch rename for several items (OPEN_RENAME type IMAGE): the
// same dialog as for tags, starting from the last name used (else
// 新名字 - %N), with thumbnails; ten or more ask first. Each item is renamed
// through Eagle with the usual conflict check; a name changed elsewhere
// meanwhile is left alone and reported.
const ITEM_BATCH_RENAME_NAME_KEY = 'eaglemv.batchRename.lastName';
async function openItemBatchRename(ids) {
  const paneId = state.activePaneId;
  const pane = paneById(paneId);
  const libraryPath = state.library?.path;
  if (!pane || !libraryPath || !state.connected || ids.length < 2) return false;
  if (!confirmDiscardChanges()) return false;
  const wanted = new Set(ids);
  const loaded = withActivePane(paneId, () => sortedItems()).filter(item => wanted.has(item.id));
  const missing = ids.filter(id => !pane.itemMap?.has(id));
  let fetched = [];
  if (missing.length) {
    const outcome = await runForegroundOperation('正在读取所选素材…', { key: `batch-rename-read:${paneId}` }, () =>
      settleWithConcurrency(missing, id => window.eagleMV.getItem(id), 6));
    fetched = (outcome || []).filter(result => result?.ok && result.value).map(result => result.value);
  }
  const items = [...loaded, ...fetched];
  if (items.length < 2) return false;
  let initialPattern = '新名字 - %N';
  try { initialPattern = localStorage.getItem(ITEM_BATCH_RENAME_NAME_KEY) || initialPattern; } catch {}
  window.EagleMVBatchRename.openBatchRenameDialog({
    items,
    kind: 'file',
    initialPattern,
    historyKey: 'eaglemv.batchRename.findHistory.IMAGE',
    folderNamesOf: item => (item.folders || []).map(id => findFolder(state.library?.folders, id)?.name).filter(Boolean),
    thumbnailOf: item => mediaURL('thumb', item.id),
    onRename: async (changes, total, { pattern }) => {
      if (pattern) try { localStorage.setItem(ITEM_BATCH_RENAME_NAME_KEY, pattern); } catch {}
      if (!changes.length) return;
      if (total >= 10 && !confirm(`重命名提示\n\n将会重命名 ${total} 个文件，确定要重命名吗？`)) return;
      if (state.library?.path !== libraryPath) return;
      let operationToken = beginForegroundOperation('正在重命名素材…', { key: `batch-rename:${paneId}` });
      if (!operationToken) return;
      setSyncStatus('正在重命名…');
      try {
        const next = new Map(changes.map(change => [change.item.id, change]));
        const outcome = await runItemBatch([...next.keys()], async id => {
          const change = next.get(id);
          const result = await window.eagleMV.mutate({ id, patch: { name: change.after }, base: { name: change.before }, libraryPath });
          if (result?.conflict) throw new Error('名称已在其他窗口或 Eagle 中修改');
          if (!result?.ok) throw new Error('重命名未完成');
          return result;
        }, 'Eagle 重命名请求超时');
        endForegroundOperation(operationToken);
        operationToken = null;
        await refresh({ reset: true, preserveScroll: true, paneId });
        toast(outcome.failed.length
          ? `${outcome.succeeded.length} 个项目已重命名。 · ${outcome.failed.length} 个未重命名${batchFailureReason(outcome)}`
          : `${outcome.succeeded.length} 个项目已重命名。`, outcome.failed.length ? 4200 : 2400);
      } catch (error) {
        toast(`重命名失败：${error.message}`, 4000);
      } finally {
        setSyncStatus('所有窗口已同步');
        endForegroundOperation(operationToken);
      }
    }
  });
  return true;
}

let selectedFeatureController;
let siteFeatureController;
function siteFeatureUI() {
  siteFeatureController ||= window.createSiteImportUI({
    api: window.eagleMV,
    context: () => ({ libraryPath: state.library?.path, folders: state.library?.folders || [],
      folderId: state.currentView.kind === 'folder' ? state.currentView.id : null }),
    canStart: () => state.connected && confirmDiscardChanges(),
    refresh: () => refreshAllPanes({ reset: true, preserveScroll: true }),
    notify: toast
  });
  return siteFeatureController;
}

let thumbnailFeatureController;
function thumbnailFeatureUI() {
  thumbnailFeatureController ||= window.createThumbnailUI({
    api: window.eagleMV,
    context: () => ({ libraryPath: state.library?.path, paneId: state.activePaneId, ids: [...state.selected] }),
    canStart: () => state.connected && confirmDiscardChanges(),
    refresh: () => refreshAllPanes({ reset: true, preserveScroll: true }),
    notify: toast
  });
  return thumbnailFeatureController;
}

function selectedFeatureUI() {
  selectedFeatureController ||= window.createSelectedFeatureUI({
    api: window.eagleMV,
    context: () => ({ libraryPath: state.library?.path, folders: state.library?.folders || [],
      folderOrder: (parentId, folders) => window.EagleMVManualOrder.sort(folders || [], manualOrder(parentId ? { kind: 'folder', id: parentId } : { kind: 'root' }, 'folders')),
      paneDestination: paneId => {
        const view = paneById(paneId)?.currentView;
        return view?.kind === 'folder' ? view.id : view?.kind === 'root' ? null : undefined;
      },
      folderId: state.currentView.kind === 'folder' ? state.currentView.id : null,
      paneId: state.activePaneId, ids: [...state.selected] }),
    canStart: () => state.connected && confirmDiscardChanges(),
    refresh: () => refreshAllPanes({ reset: true, preserveScroll: true }),
    notify: toast,
    // This window's own store: its cached parse sees the copies at once.
    cloneSortMemory: (libraryPath, folderMap) => sortMemory.cloneFolders(libraryPath, folderMap)
  });
  return selectedFeatureController;
}

async function renameFolderById(folderId) {
  const folder = findFolder(state.library?.folders, folderId);
  if (!folder || !state.connected) return;
  if (!confirmDiscardChanges()) return;
  const nextName = await requestNameDialog({ title: '重命名文件夹', initialValue: folder.name || '', submitLabel: '重命名' });
  if (nextName === null || nextName === folder.name) return;
  return renameFolderTo(folder, nextName);
}

// Where Eagle's removeFolder goes after deleting a folder: the sibling now in
// its place, else the one before, else the first; with no siblings left, the
// parent; at the top level, 全部. Siblings in the order the sidebar shows.
function folderViewAfterRemoval(folderId) {
  const trail = findFolderPath(state.library?.folders || [], folderId);
  if (!trail.length) return { kind: 'all' };
  const parent = trail.length > 1 ? trail.at(-2) : null;
  const view = parent ? { kind: 'folder', id: parent.id } : { kind: 'root' };
  const siblings = window.EagleMVManualOrder.sort(parent ? parent.children || [] : state.library.folders, manualOrder(view, 'folders'));
  const index = siblings.findIndex(folder => folder.id === folderId);
  const rest = siblings.filter(folder => folder.id !== folderId);
  const next = rest[index] || rest[index - 1] || rest[0];
  if (next) return { kind: 'folder', id: next.id };
  return parent ? { kind: 'folder', id: parent.id } : { kind: 'all' };
}

function subtreeFolderIds(folder, ids = new Set()) {
  if (!folder?.id) return ids;
  ids.add(folder.id);
  for (const child of folder.children || []) subtreeFolderIds(child, ids);
  return ids;
}

// Eagle asks only when the folder holds items or subfolders, with
// "把文件夹内项目丢到回收站" ticked each time, focus on 确认删除.
function chooseFolderRemoval(folder) {
  $('#trashDialogTitle').textContent = '删除文件夹';
  $('#trashDialogMessage').textContent = `这个操作无法进行复原，确认要删除“${folder.name || '未命名文件夹'}”文件夹吗？`;
  $('#trashRemoveButton').classList.add('hidden');
  $('#trashDeleteButton').textContent = '确认删除';
  $('#trashDialogCheckbox').checked = true;
  $('#trashDialogCheck').classList.remove('hidden');
  $('#trashDialog').classList.remove('hidden');
  $('#trashDeleteButton').focus();
  return new Promise(resolve => {
    state.trashDialogResolve = choice => resolve(choice === 'delete' ? { isDeleteImages: $('#trashDialogCheckbox').checked } : null);
  });
}

// Eagle's 删除文件夹 (sidebar, subfolder card, ⌘⌫). The API has no delete;
// the main process runs Eagle's own removeFolder with the answers given here.
async function removeFolderById(folderId, { selectNext = false, paneId = state.activePaneId } = {}) {
  const folder = findFolder(state.library?.folders, folderId);
  if (!folder || !state.connected || !window.eagleMV.removeFolder) return false;
  // Eagle will not delete a locked folder, and MultiView cannot unlock one.
  if (folder.password) {
    toast('该文件夹已加密，请在 Eagle 中解锁后删除', 3600);
    return false;
  }
  const libraryPath = state.library?.path;
  const removed = subtreeFolderIds(folder);
  const target = folderViewAfterRemoval(folder.id);
  const showing = pane => pane.currentView.kind === 'folder' && removed.has(pane.currentView.id);
  const moving = state.panes.filter(pane => showing(pane) || (selectNext && pane.id === paneId));
  if (moving.length && !confirmDiscardChanges()) return false;
  let isDeleteImages = true;
  if ((Number(folder.imageCount) || 0) > 0 || (folder.children || []).length > 0) {
    const choice = await chooseFolderRemoval(folder);
    if (!choice) return false;
    isDeleteImages = choice.isDeleteImages;
    // Eagle then confirms when 50 or more items are affected.
    const affected = Number.isFinite(folder.descendantImageCount) ? folder.descendantImageCount : Number(folder.imageCount) || 0;
    if (affected >= 50 && !confirm(`批量操作确认\n\n这个操作会影响 ${affected.toLocaleString()} 个文件，确定要继续吗？`)) return false;
  }
  const operationToken = beginForegroundOperation('正在删除文件夹…', { key: `remove-folder:${libraryPath}:${folder.id}` });
  if (!operationToken) return false;
  setSyncStatus('正在删除…');
  // The library update may reach this window before the reply; it sends
  // panes on the deleted folders where Eagle would go, not to the root.
  for (const id of removed) state.folderRemovalRedirects.set(id, target);
  setTimeout(() => { for (const id of removed) if (state.folderRemovalRedirects.get(id) === target) state.folderRemovalRedirects.delete(id); }, 15000);
  try {
    const result = await window.eagleMV.removeFolder({ id: folder.id, baseName: folder.name, isDeleteImages, libraryPath });
    if (result?.missing) {
      toast('这个文件夹已不存在，已刷新', 3500);
      scheduleRefresh();
      return false;
    }
    if (result?.conflict) {
      toast(`这个文件夹已在 Eagle 或另一个窗口中改名为“${result.current?.name || '未命名'}”，未删除；请确认后重试`, 5000);
      scheduleRefresh();
      return false;
    }
    if (!result?.ok) throw new Error('删除未完成');
    for (const pane of state.panes) {
      if (pane.selectedFolderCard && removed.has(pane.selectedFolderCard)) pane.selectedFolderCard = null;
      if (showing(pane) || (selectNext && pane.id === paneId)) {
        withActivePane(pane.id, () => navigate(target, { skipDiscard: true }) !== false
          || navigate({ kind: 'all' }, { skipDiscard: true }));
      }
    }
    if (!state.selected.size) renderInspector();
    toast(`“${folder.name || '未命名文件夹'}”已删除。`);
    return true;
  } catch (error) {
    toast(`删除文件夹失败：${error.message}`, 6000);
    return false;
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

// ⌘⌫ with no item selected: a selected subfolder card, else the folder row
// focused in the sidebar (Eagle: sidebar focus deletes the current folder).
function requestFolderRemovalShortcut() {
  if (state.selectedFolderCard) {
    removeFolderById(state.selectedFolderCard, { selectNext: false });
    return true;
  }
  const row = document.activeElement?.closest?.('#folderTree [data-folder-id]');
  if (row?.dataset.folderId) {
    removeFolderById(row.dataset.folderId, { selectNext: true });
    return true;
  }
  return false;
}

// Shared by the rename dialog and the inspector's name field; baseName is the
// name the user started from, for the cross-window conflict check.
async function renameFolderTo(folder, nextName, { baseName = folder.name } = {}) {
  const libraryPath = state.library?.path;
  const operationToken = beginForegroundOperation('正在重命名文件夹…', { key: `rename-folder:${libraryPath}:${folder.id}` });
  if (!operationToken) return false;
  setSyncStatus('正在重命名…');
  try {
    let result = await window.eagleMV.mutateFolder({
      id: folder.id,
      name: nextName,
      baseName,
      libraryPath
    });
    if (result?.conflict) {
      const overwrite = confirm(`这个文件夹已在 Eagle 或另一个窗口中重命名为“${result.current?.name || '未命名'}”。\n\n按“确定”覆盖为当前名称；按“取消”载入最新名称。`);
      if (!overwrite) {
        scheduleRefresh();
        return false;
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
    if (state.library?.folders) {
      state.library.folders = overlayFolder(state.library.folders, folder.id, { name: nextName });
    }
    for (const pane of state.panes) {
      if (pane.currentView.kind === 'folder' && pane.currentView.id === folder.id) {
        pane.viewTitle = nextName;
      }
    }
    if (state.currentView.kind === 'folder' && state.currentView.id === folder.id) {
      state.viewTitle = nextName;
      $('#viewTitle').textContent = nextName;
    }
    renderLocation();
    revealFolderPath(folder.id);
    renderFolderTree();
    renderGrid({ preserveScroll: true });
    if (!state.selected.size) renderInspector();
    toast('文件夹已重命名');
    return true;
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

// Colour and description writes (P1-12, P2-05). Eagle has no conflict
// prompt, but another window may have changed the same field since this one
// drew it: ask before overwriting, as a rename does.
async function writeFolderProperties(folder, patch, { label, done, base = null }) {
  const libraryPath = state.library?.path;
  base ||= Object.fromEntries(Object.keys(patch).map(field => [field, folder[field] ?? '']));
  const operationToken = beginForegroundOperation(label, { key: `folder-properties:${libraryPath}:${folder.id}` });
  if (!operationToken) return false;
  setSyncStatus(label);
  try {
    let result = await window.eagleMV.updateFolderProperties({ id: folder.id, patch, base, libraryPath });
    if (result?.conflict) {
      const fieldNames = { iconColor: '颜色', description: '描述' };
      const fields = result.conflicts.map(conflict => fieldNames[conflict.field] || conflict.field).join('、');
      const overwrite = confirm(`这个文件夹的${fields}已在 Eagle 或另一个窗口中修改。\n\n按“确定”用你的修改覆盖；按“取消”载入最新内容。`);
      if (!overwrite) {
        scheduleRefresh();
        return false;
      }
      result = await window.eagleMV.updateFolderProperties({ id: folder.id, patch, base, force: true, libraryPath });
    }
    if (!result?.ok) throw new Error('修改未完成');
    if (state.library?.folders) {
      const confirmed = result.folder || { ...folder, ...patch };
      state.library.folders = overlayFolder(state.library.folders, folder.id, {
        iconColor: confirmed.iconColor || undefined,
        description: confirmed.description ?? folder.description
      });
    }
    renderFolderTree();
    renderGrid({ preserveScroll: true });
    if (!state.selected.size) renderInspector();
    if (done) toast(done);
    return true;
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

// With no item selected the inspector describes the selected folder card, or
// else the view itself, as Eagle's does (P2-05): a folder's name and
// description are editable there; every view shows its file count and size.
let categoryShown = null;
let categoryStatsRevision = 0;
const categoryStatsCache = new Map();

function categoryTarget() {
  const pane = paneById(state.activePaneId);
  const card = Boolean(state.selectedFolderCard);
  const view = card ? { kind: 'folder', id: state.selectedFolderCard } : state.currentView;
  if (!pane || !state.library || !view || ['tags', 'recent'].includes(view.kind)) return null;
  const folder = view.kind === 'folder' ? findFolder(state.library.folders, view.id) : null;
  if (view.kind === 'folder' && !folder) return null;
  return {
    key: `${state.library.path}|${descriptorKey(view)}`,
    view, folder, card,
    name: folder ? folder.name || '' : state.viewTitle,
    locked: Boolean(folder?.password),
    editable: Boolean(folder && !folder.password && state.connected),
    // Count and size are of the view itself, without the search and filters.
    query: view.kind === 'trash' ? null : paneItemQuery({ ...pane, query: createQuery() }, view)
  };
}

function categoryStats(target) {
  if (!target.query || target.locked || !window.eagleMV.viewStats) return null;
  const key = `${state.library?.path}|${categoryStatsRevision}|${JSON.stringify(target.query)}`;
  if (categoryStatsCache.has(key)) return categoryStatsCache.get(key);
  categoryStatsCache.set(key, 'pending');
  window.eagleMV.viewStats(target.query)
    .then(stats => categoryStatsCache.set(key, stats || null), () => categoryStatsCache.set(key, null))
    .finally(() => { if (categoryShown && !state.selected.size) renderCategoryInspector(); });
  return 'pending';
}

function resizeCategoryDescription() {
  const field = $('#categoryDescription');
  field.style.height = 'auto';
  field.style.height = `${Math.max(field.scrollHeight, 38)}px`;
}

function renderCategoryInspector() {
  const target = categoryTarget();
  $('#categoryInspector').classList.toggle('hidden', !target);
  $('#noSelection').classList.toggle('hidden', Boolean(target));
  if (!target) { categoryShown = null; return false; }
  const nameField = $('#categoryName');
  const descriptionField = $('#categoryDescription');
  const same = categoryShown?.key === target.key;
  // Never overwrite a field the user is typing in; a broadcast of their own
  // earlier save would otherwise undo the characters typed since.
  const keepName = same && document.activeElement === nameField;
  const keepDescription = same && document.activeElement === descriptionField;
  if (!keepName) nameField.value = target.name;
  nameField.readOnly = !target.editable;
  nameField.title = target.locked ? '该文件夹已加密，MultiView 无法解锁（Eagle API 限制）' : '';
  descriptionField.closest('.inspector-field').classList.toggle('hidden', !target.editable);
  if (!keepDescription) descriptionField.value = target.folder?.description || '';
  resizeCategoryDescription();
  categoryShown = {
    key: target.key,
    folderId: target.folder?.id || null,
    baseName: keepName ? categoryShown.baseName : target.name,
    baseDescription: keepDescription ? categoryShown.baseDescription : target.folder?.description || ''
  };
  const stats = categoryStats(target);
  const filtered = queryFiltersActive(state.query) || String(state.query.search || '').trim();
  const count = stats && stats !== 'pending' ? stats.count
    : target.card ? Number(target.folder.imageCount) || 0
      : !filtered && !state.estimatedTotal ? state.total : null;
  const size = stats === 'pending' ? '计算中…' : stats ? formatBytes(stats.size) : '—';
  const rows = target.locked ? [['状态', '已加密']] : [
    ['文件数', Number.isFinite(count) ? count.toLocaleString() : '—'],
    ['占用空间', size],
    ...(target.folder?.modificationTime ? [['添加日期', formatDateTime(target.folder.modificationTime)]] : [])
  ];
  $('#categoryMeta').innerHTML = rows.map(([label, value]) => `<span title="${escapeHTML(value)}"><em>${label}</em>${escapeHTML(value)}</span>`).join('');
  $('#categoryHint').textContent = target.card ? '双击或按 Return 进入' : '';
  return true;
}

async function commitCategoryName() {
  const shown = categoryShown;
  const field = $('#categoryName');
  if (!shown?.folderId || field.readOnly) return;
  const next = field.value.trim();
  if (!next || next === shown.baseName) { field.value = shown.baseName; return; }
  const folder = findFolder(state.library?.folders, shown.folderId);
  if (!folder) return;
  shown.baseName = next;
  try {
    if (!await renameFolderTo(folder, next, { baseName: folder.name })) renderCategoryInspector();
  } catch (error) {
    toast(`重命名失败：${error.message}`, 4000);
    renderCategoryInspector();
  }
}

async function commitCategoryDescription() {
  const shown = categoryShown;
  const value = $('#categoryDescription').value;
  if (!shown?.folderId || value === shown.baseDescription) return;
  const folder = findFolder(state.library?.folders, shown.folderId);
  if (!folder) return;
  const base = shown.baseDescription;
  shown.baseDescription = value;
  try {
    const saved = await writeFolderProperties(folder, { description: value }, { label: '正在保存文件夹描述…', base: { description: base } });
    if (!saved && categoryShown === shown) shown.baseDescription = base;
  } catch (error) {
    if (categoryShown === shown) shown.baseDescription = base;
    toast(`描述未保存：${error.message}`, 4000);
  }
}

function bindCategoryInspector() {
  const nameField = $('#categoryName');
  const descriptionField = $('#categoryDescription');
  nameField.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); nameField.blur(); }
    if (event.key === 'Escape') {
      event.preventDefault();
      nameField.value = categoryShown?.baseName ?? nameField.value;
      nameField.blur();
    }
  });
  nameField.addEventListener('blur', () => { commitCategoryName(); });
  descriptionField.addEventListener('input', resizeCategoryDescription);
  descriptionField.addEventListener('keydown', event => {
    if (event.isComposing || event.key !== 'Escape') return;
    event.preventDefault();
    descriptionField.value = categoryShown?.baseDescription ?? descriptionField.value;
    resizeCategoryDescription();
    descriptionField.blur();
  });
  descriptionField.addEventListener('blur', () => { commitCategoryDescription(); });
}

async function setFolderColor(folderId, color) {
  const folder = findFolder(state.library?.folders, folderId);
  if (!folder || !state.connected || !folderMenuColors.includes(color)) return false;
  if (String(folder.iconColor || '').toLowerCase() === color) return false;
  return writeFolderProperties(folder, { iconColor: color }, { label: '正在设置文件夹颜色…' });
}

// Eagle's ⌘R in a tag group (renameCurrentFolder): several selected tags
// open the batch rename, one is renamed, none renames the group itself.
function renameInTagManager() {
  const paneId = state.activePaneId;
  const view = tagManagerView(paneId);
  if (view.mode !== 'group') return false;
  const tags = [...view.selected];
  if (tags.length > 1) return openTagBatchRename(paneId, tags);
  if (tags.length === 1) return executeTagManagerAction('rename-tag', { tagName: tags[0] });
  return executeTagManagerAction('rename-group', { groupId: view.groupId });
}

async function renameSelection() {
  if (state.currentView.kind === 'tags') return renameInTagManager();
  if (state.selected.size === 1) return renameItem(itemById([...state.selected][0]));
  if (state.selected.size > 1) return openItemBatchRename([...state.selected]);
  if (state.selectedFolderCard) return renameFolderById(state.selectedFolderCard);
  const activeFolderRow = document.activeElement?.closest?.('[data-folder-id]');
  if (activeFolderRow?.dataset.folderId) return renameFolderById(activeFolderRow.dataset.folderId);
  if (state.currentView.kind === 'folder') return renameFolderById(state.currentView.id);
  return false;
}

function requestRenameSelection() {
  const editable = isEditableElement();
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
    toast(`无法在访达中打开：${error.message}`, 4000);
    return false;
  }
}

async function copyTextWithFeedback(text, message = '', duration) {
  try {
    const copied = await window.eagleMV.copyText(text);
    if (copied === false) return false;
    if (message) toast(message, duration);
    return true;
  } catch (error) {
    if (error?.code !== 'COPY_CANCELED') toast(`复制失败：${error?.message || String(error)}`, 4000);
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
  return copyTextWithFeedback(filePath, '文件路径已复制');
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
  const sourceContext = JSON.stringify({ view: pane.currentView, query: pane.query });
  const sameContext = () => paneById(paneId) === pane && state.library?.path === libraryPath
    && JSON.stringify({ view: pane.currentView, query: pane.query }) === sourceContext;
  return runForegroundOperation('正在创建副本…', { key: `duplicate:${paneId}` }, async () => {
    const result = await window.eagleMV.duplicateFiles({ ids: uniqueIds, folderId, preserveFolders, libraryPath });
    if (!result?.count) {
      toast(result?.error ? importResultMessage(result) : result?.message || '没有可创建副本的原文件', 4000);
      return false;
    }
    if (result.nativeDecisionPending) {
      toast('副本已提交，但 Eagle 尚未完成重复确认，请到 Eagle 核对；请勿重复创建', 6000);
      return false;
    }
    const createdItems = (await Promise.all((result.ids || []).map(id => window.eagleMV.getItem(id).catch(() => null)))).filter(Boolean);
    const mergeCreatedItems = () => {
      const sourcePane = paneById(paneId);
      if (!sameContext() || !createdItems.length || queryFiltersActive(pane.query) || !['folder', 'all', 'root', 'unfiled'].includes(pane.currentView.kind)) return;
      const known = new Set(sourcePane.items.map(item => item.id));
      const additions = createdItems.filter(item => !known.has(item.id)
        && (folderId ? (item.folders || []).includes(folderId) : pane.currentView.kind === 'all' || !(item.folders || []).length));
      if (!additions.length) return;
      sourcePane.items = [...additions, ...sourcePane.items];
      sourcePane.total = Math.max(sourcePane.items.length, sourcePane.total + additions.length);
      reconcileLocalFolderCount(folderId, sourcePane.total);
      withActivePane(paneId, () => {
        renderGrid({ preserveScroll: true });
        renderResultCount();
      });
    };
    if (sameContext()) await refresh({ reset: true, preserveScroll: true, paneId });
    mergeCreatedItems();
    for (const delay of [1600, 4200]) setTimeout(async () => {
      if (!sameContext()) return;
      await refresh({ reset: true, preserveScroll: true, paneId }).catch(() => {});
      mergeCreatedItems();
    }, delay);
    toast(result.partial ? importResultMessage(result) : `已创建 ${result.count} 个副本${result.missing ? ` · ${result.missing} 个原文件缺失` : ''}${result.folderAssignmentFailed ? ` · ${result.folderAssignmentFailed} 个未能保留原文件夹` : ''}`, 4200);
    return true;
  });
}

// `anchor` opens the picker under that element (the inspector's 添加文件夹)
// instead of the first selected card; `keepSelection` keeps the items
// selected afterwards, as Eagle's inspector does.
function scrollGridByKey(key) {
  if (!['PageDown', 'PageUp', 'Home', 'End'].includes(key)) return;
  const grid = $('#gridScroller');
  if (!grid) return;
  const top = key === 'Home' ? 0 : key === 'End' ? grid.scrollHeight : grid.scrollTop + (key === 'PageDown' ? 1 : -1) * grid.clientHeight * .86;
  grid.scrollTo({ top, behavior: key.startsWith('Page') ? 'smooth' : 'auto' });
}

function showFolderAssignmentPicker(ids = selectedActionIds(), { anchor = null, keepSelection = false, action = 'add-folder' } = {}) {
  const uniqueIds = [...new Set(ids || [])].filter(Boolean);
  if (!uniqueIds.length) return false;
  const card = anchor || paneRoot()?.querySelector(`.item-card[data-id="${CSS.escape(uniqueIds[0])}"]`);
  const rect = card?.getBoundingClientRect();
  const x = rect ? rect.left + (anchor ? 0 : Math.min(rect.width, 34)) : Math.round(window.innerWidth / 2 - 147);
  const y = rect ? Math.min(rect.bottom + 6, window.innerHeight - 180) : Math.round(window.innerHeight / 2 - 180);
  showContextMenuAt(x, y, {
    kind: 'shortcut-folder-picker',
    ids: uniqueIds,
    folderId: state.currentView.kind === 'folder' ? state.currentView.id : null,
    pickerAction: action === 'move-folder' ? 'move-folder' : 'add-folder',
    keepSelection
  });
  requestAnimationFrame(() => $('#contextMenu').querySelector('.context-folder-search')?.focus());
  return true;
}

function activeDraggedItemIds() {
  const sharedIds = state.internalDrag?.active ? state.internalDrag.ids : [];
  return sharedIds?.length ? sharedIds : (state.draggingItemIds || []);
}

// Decides at drop time what was dropped. Electron never delivers dragend for
// a native drag that ends outside the window, so drag state can outlive its
// session; the dropped paths, not leftover ids, decide whether files from
// Finder are imports or library items being re-filed.
function resolveItemDrop(event) {
  const dataTransfer = event.dataTransfer;
  let paths = [];
  if (dragHasType(dataTransfer, 'Files') && !dragHasType(dataTransfer, window.EagleMVDragDrop.ITEM_TYPE)) {
    try {
      paths = [...(dataTransfer.files || [])].map(file => window.eagleMV.pathForFile(file)).filter(Boolean);
    } catch {}
  }
  const drop = resolveDrop(dataTransfer, {
    sessionIds: activeDraggedItemIds(),
    sessionFiles: state.internalDrag?.files || [],
    libraryPaths: [state.internalDrag?.libraryPath, state.library?.path].filter(Boolean),
    paths
  });
  return { ...drop, session: drop.fromSession ? state.internalDrag : null };
}

function externalDropImportables(dataTransfer) {
  const files = [...(dataTransfer?.files || [])];
  const paths = files.map(file => window.eagleMV.pathForFile(file)).filter(Boolean);
  return paths.length ? paths : (window.eagleMV.platform === 'web' ? files : []);
}

function scheduleExternalFolderImport(dataTransfer, folderId, paneId = state.activePaneId) {
  const importable = externalDropImportables(dataTransfer);
  const libraryPath = state.library?.path;
  if (importable.length) {
    scheduleDropTask(() => importFiles(importable, 'drop', { folderId, libraryPath, paneId }));
    return true;
  }
  // A browser image or link imports its address, like Eagle (D-08).
  const link = dragHasType(dataTransfer, 'Files') ? null : droppedURL(dataTransfer);
  clearDragUI();
  if (link && (/^https?:/i.test(link.url) || /^data:image\//i.test(link.url))) {
    scheduleDropTask(() => importFiles(null, 'url', { folderId, libraryPath, paneId, url: link.url, image: link.image }));
    return true;
  }
  toast(link?.url.startsWith('blob:') ? '这张图片是浏览器的临时地址，无法直接添加；请先存到本地再拖入'
    : link?.url.startsWith('data:') ? '只能添加网页里的图片'
    : dragHasType(dataTransfer, 'Files') ? '无法读取拖入的项目（例如“照片”App 中的照片）；请先导出到 Finder 再拖入'
    : '只能拖入文件、网页图片或网址', 4600);
  return false;
}

function resetDragState() {
  pageDragActive = false;
  state.dragDepth = 0;
  state.draggingItemIds = null;
  state.dragSourcePaneId = null;
  state.internalDrag = null;
  for (const pane of state.panes || []) {
    pane.dragDepth = 0;
    pane.draggingItemIds = null;
  }
  for (const target of document.querySelectorAll('.drop-target')) target.classList.remove('drop-target');
  for (const overlay of document.querySelectorAll('.drop-overlay')) overlay.classList.add('hidden');
}

function clearDragUI() {
  const token = state.internalDrag?.token || null;
  resetDragState();
  if (token) window.eagleMV.cancelDrag?.(token);
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
  const progress = trackBatchProgress(values.length);
  const run = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      try {
        results[index] = { ok: true, value: await worker(values[index]) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
      progress(false);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  } finally {
    progress(true);
  }
  return results;
}

// The first failure's reason, so a batch over thousands says why some
// stayed behind instead of only how many.
function batchFailureReason(outcome) {
  const message = String(outcome?.firstError?.message || '').trim();
  return message ? `（${message.length > 40 ? `${message.slice(0, 40)}…` : message}）` : '';
}

// What a batch leaves selected when nothing failed: the ids still shown,
// plus those past the loaded range, which the next refresh reconciles.
function idsStillSelectable(pane, ids) {
  const shown = new Set(pane.items.map(item => item.id));
  return ids.filter(id => shown.has(id) || !pane.itemMap?.has(id));
}

// Eagle selects the item after the ones that left the view — else the one
// before, else nothing — when they are taken out of the folder on screen,
// moved out of it, put in the trash, or filed from 未分类. Worked out before
// the write, from the order on screen.
function selectionSuccessor(pane, ids) {
  const leaving = new Set(ids);
  const order = withActivePane(pane.id, () => sortedItems());
  const first = order.findIndex(item => leaving.has(item.id));
  if (first < 0) return null;
  return {
    after: order.slice(first + 1).find(item => !leaving.has(item.id))?.id || null,
    before: order[first - 1]?.id || null
  };
}

// Only once the items have actually left and nothing else got selected
// meanwhile (failures stay selected, a click elsewhere wins).
function selectSuccessor(pane, successor, ids) {
  if (!successor || !paneById(pane.id) || pane.selected.size) return false;
  const shown = new Set(pane.items.map(item => item.id));
  if (ids.some(id => shown.has(id))) return false;
  const id = [successor.after, successor.before].find(candidate => candidate && shown.has(candidate));
  if (!id) return false;
  pane.selected = new Set([id]);
  pane.selectionAnchor = id;
  if (state.activePaneId === pane.id) {
    updateCardSelectionStyles();
    renderInspector();
    requestAnimationFrame(() => paneRoot(pane.id)?.querySelector(`.item-card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }
  return true;
}

// A batch leaves its result selection behind only if the user has not picked
// something else while it ran; otherwise "rate A, → to B" snapped back to A.
function sameSelection(pane, snapshot) {
  return pane.selected.size === snapshot.size && [...snapshot].every(id => pane.selected.has(id));
}

function settleBatchSelection(pane, snapshot, next) {
  if (!sameSelection(pane, snapshot)) return false;
  pane.selected = new Set(next);
  return true;
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

async function addItemsToFolder(ids, folderId, folderName = '目标文件夹', libraryPath = state.library?.path, { move = false, sourceFolderId = null, sourceFolderIds = null, sourcePaneId = null } = {}) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  if (!uniqueIds.length || (!folderId && !(move && sourceFolderId))) return false;
  if (!state.connected) {
    toast('Eagle 未连接，暂时无法修改归类', 3500);
    return true;
  }
  if (move && sourceFolderId && sourceFolderId === folderId) {
    toast('素材已经在这个文件夹中', 3000);
    return true;
  }
  // Dragging out of "全部/未分类" has no source folder to leave, so an
  // ⌥-drop there degrades to a plain add, mirroring Eagle.
  const sourceScope = sourceFolderIds?.length ? sourceFolderIds : [sourceFolderId];
  const delta = folderId ? folderMoveDelta(move ? sourceScope : null, folderId) : { add: [], remove: sourceScope };
  const moving = delta.remove.length > 0;
  const verb = moving ? '移动' : '归类';
  const operationToken = beginForegroundOperation(`正在${verb} ${uniqueIds.length} 个素材…`, { key: `folder-${moving ? 'move' : 'add'}:${libraryPath}:${folderId}` });
  if (!operationToken) return true;
  setSyncStatus(`正在${verb} ${uniqueIds.length} 个素材…`);
  try {
    const results = await settleWithConcurrency(uniqueIds, id => withTimeout(
      // A drop files like Eagle's classifySelected, auto tags included.
      window.eagleMV.mutateSet({
        id,
        field: 'folders',
        ...delta,
        autoTags: 'always',
        libraryPath
      }),
      15000,
      'Eagle 归类请求超时'
    ));
    const failed = results.filter(result => !result.ok);
    const succeeded = results.length - failed.length;
    if (!succeeded) throw failed[0]?.error || new Error(`没有素材完成${verb}`);

    if (moving && sourceFolderId) {
      const movedIds = new Set();
      results.forEach((res, idx) => { if (res?.ok) movedIds.add(uniqueIds[idx]); });
      for (const pane of state.panes) {
        if (pane.currentView.kind === 'folder' && pane.currentView.id === sourceFolderId
          && !paneFolderScope(pane).includes(folderId)) {
          pane.items = pane.items.filter(item => !movedIds.has(item.id));
          movedIds.forEach(id => { pane.itemMap?.delete(id); });
          pane.total = Math.max(0, (Number(pane.total) || 0) - movedIds.size);
          if ('totalCount' in pane) pane.totalCount = pane.total;
          movedIds.forEach(id => pane.selected.delete(id));
          if (movedIds.has(pane.selectedBase?.id)) pane.selectedBase = null;
          if (pane.id === state.activePaneId) {
            renderResultCount();
            updateScrollUI();
            renderGrid({ preserveScroll: true });
            renderInspector();
          } else {
            schedulePaneGridRender(pane.id);
          }
        }
      }
    }

    toast(`${moving ? '已移动到' : '已加入'}“${folderName || '目标文件夹'}”${failed.length ? ` · ${failed.length} 个失败` : ''}`);
    if (failed.length) console.warn('Some dragged items could not be assigned:', failed.map(result => result.error?.message));
    if (state.library?.path === libraryPath) markFolderUsed(folderId, libraryPath);
    return true;
  } catch (error) {
    toast(`${verb}失败：${error.message}`, 4600);
    return true;
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
}

function paneItemDropContext(targetPaneId, event, drop = resolveItemDrop(event)) {
  const targetPane = paneById(targetPaneId);
  const internalDrag = drop.session;
  const ids = drop.ids;
  if (!targetPane || !ids.length) return null;
  let sourcePaneId = internalDrag ? (state.dragSourcePaneId || internalDrag.sourcePaneId || null) : null;
  try { sourcePaneId = event.dataTransfer.getData('application/x-eagle-multiview-source-pane') || sourcePaneId; } catch {}
  const sourceIsThisWindow = !internalDrag?.sourceWindowId || internalDrag.sourceWindowId === state.windowId;
  const sourcePane = sourceIsThisWindow && sourcePaneId ? paneById(sourcePaneId) : null;
  const sourceFolderId = sourcePane?.currentView.kind === 'folder'
    ? sourcePane.currentView.id
    : (internalDrag?.sourceFolderId || null);
  const sourceFolderIds = sourcePane?.currentView.kind === 'folder'
    ? paneFolderScope(sourcePane)
    : (internalDrag?.sourceFolderIds || (sourceFolderId ? [sourceFolderId] : []));
  return {
    targetPaneId,
    ids,
    libraryPath: internalDrag?.libraryPath || state.library?.path,
    targetFolderId: targetPane.currentView.kind === 'folder' ? targetPane.currentView.id : null,
    sourceFolderId,
    sourceFolderIds,
    sourcePaneId,
    move: Boolean(sourceFolderId && !event.altKey)
  };
}

async function handlePaneItemDrop(context) {
  if (!context) return false;
  const { targetPaneId, ids, libraryPath, targetFolderId, sourceFolderId, sourceFolderIds, move } = context;
  if (!state.connected) { toast('Eagle 未连接，暂时无法修改归类', 3500); return true; }
  if (!targetFolderId) { toast('请将素材拖入一个具体文件夹栏', 3500); return true; }
  if (sourceFolderId && sourceFolderId === targetFolderId) { toast('素材已经在这个文件夹中'); return true; }
  let operationToken = beginForegroundOperation(`${move ? '正在移动' : '正在复制'} ${ids.length} 个素材…`, { key: `pane-drop:${targetPaneId}` });
  if (!operationToken) return true;
  setSyncStatus(`${move ? '正在移动' : '正在复制'} ${ids.length} 个素材…`);
  try {
    const results = await settleWithConcurrency(ids, id => withTimeout(
      window.eagleMV.mutateSet({
        id,
        field: 'folders',
        ...folderMoveDelta(move && sourceFolderId ? (sourceFolderIds?.length ? sourceFolderIds : [sourceFolderId]) : null, targetFolderId),
        autoTags: 'always',
        libraryPath
      }),
      15000,
      'Eagle 归类请求超时'
    ));
    const failed = results.filter(result => !result.ok);
    const succeeded = results.length - failed.length;
    if (!succeeded) throw failed[0]?.error || new Error('没有素材完成归类');
    if (failed.length) console.warn('Some dropped items could not be assigned:', failed.map(result => result.error?.message));

    if (move && sourceFolderId) {
      const movedIds = new Set();
      results.forEach((res, idx) => { if (res?.ok) movedIds.add(ids[idx]); });
      for (const pane of state.panes) {
        if (pane.currentView.kind === 'folder' && pane.currentView.id === sourceFolderId
          && !paneFolderScope(pane).includes(targetFolderId)) {
          pane.items = pane.items.filter(item => !movedIds.has(item.id));
          movedIds.forEach(id => { pane.itemMap?.delete(id); });
          pane.total = Math.max(0, (Number(pane.total) || 0) - movedIds.size);
          if ('totalCount' in pane) pane.totalCount = pane.total;
          movedIds.forEach(id => pane.selected.delete(id));
          if (movedIds.has(pane.selectedBase?.id)) pane.selectedBase = null;
          if (pane.id === state.activePaneId) {
            renderResultCount();
            updateScrollUI();
            renderGrid({ preserveScroll: true });
            renderInspector();
          } else {
            schedulePaneGridRender(pane.id);
          }
        }
      }
    }

    toast(`${move ? '已移动' : '已复制'} ${succeeded} 个素材到当前栏${failed.length ? ` · ${failed.length} 个失败` : ''}`);
    if (state.library?.path === libraryPath) markFolderUsed(targetFolderId, libraryPath);
    endForegroundOperation(operationToken);
    operationToken = null;
    // Refresh the drop target now, but do not hold the native drop completion
    // open while every other pane performs a network query.
    // The move is done; a slow refresh must not be reported as a failed move.
    await withTimeout(refresh({ reset: true, preserveScroll: true, paneId: targetPaneId }), 12000, '刷新目标栏超时')
      .catch(error => console.warn('Drop target refresh after a completed drop:', error.message));
    setTimeout(() => refreshAllPanes({ reset: true, preserveScroll: true }).catch(() => {}), 0);
  } catch (error) {
    toast(`${move ? '移动' : '复制'}失败：${error.message}`, 4200);
  } finally {
    setSyncStatus('所有窗口已同步');
    endForegroundOperation(operationToken);
  }
  return true;
}

// The toolbar's centered button group spans the whole gap between the left
// controls and the slider on one row. When the toolbar wraps to two rows the
// whole cluster (buttons + divider + slider) drops down as a unit, and it
// then hugs its own content on the left of the second row instead of still
// spanning the full width (which would leave a lone right-aligned slider).
function updateToolbarWrapState() {
  const toolbar = $('.toolbar');
  const search = $('.search-box');
  const cluster = $('.toolbar-cluster');
  if (!toolbar || !search || !cluster) return;
  const searchTop = Math.round(search.getBoundingClientRect().top);
  const clusterTop = Math.round(cluster.getBoundingClientRect().top);
  toolbar.classList.toggle('wrapped', clusterTop > searchTop);
  const popover = $('#paneLayoutPopover');
  if (popover && !popover.classList.contains('hidden')) positionPaneLayoutPopover();
}

function bindToolbarWrapState() {
  // Window resizes cover zoom changes and breakpoint switches; panel drags
  // and panel visibility toggles call updateToolbarWrapState() directly in
  // their own handlers, so the class can never go stale.
  updateToolbarWrapState();
  window.addEventListener('resize', updateToolbarWrapState);
}

// Keep the layout popover horizontally centred under its toolbar button so it
// always reads as "below the button", while clamping to the viewport so no
// option column (in particular the single-pane one) is ever clipped off-screen.
// The little arrow tracks the button centre via a CSS custom property.
function positionPaneLayoutPopover() {
  const button = $('#paneLayoutButton');
  const popover = $('#paneLayoutPopover');
  if (!button || !popover) return;
  const anchor = popover.offsetParent || button;
  const buttonRect = button.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const { left, arrowLeft } = paneLayoutPopoverPosition({
    buttonLeft: buttonRect.left,
    buttonWidth: buttonRect.width,
    popoverWidth: popover.offsetWidth,
    viewportWidth: window.innerWidth,
    anchorLeft: anchorRect.left
  });
  popover.style.left = `${left}px`;
  popover.style.right = 'auto';
  popover.style.setProperty('--popover-arrow-left', `${arrowLeft}px`);
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
        // The middle content column's grid minimum is 400px on wide windows
        // and 360px in the narrow (<=1120px) layout; keep the drag clamp in
        // step with the grid so an expanded panel never pushes it into overflow.
        const contentMin = rect.width <= 1120 ? 360 : 400;
        const max = Math.max(kind === 'sidebar' ? 170 : 240, rect.width - other - contentMin);
        // Sidebar keeps its folder labels readable down to 115px; the
        // inspector stays overflow-free down to 125px (verified at both
        // floors with an item selected).
        const next = Math.max(kind === 'sidebar' ? 115 : 125, Math.min(max, startValue + delta));
        root.style.setProperty(property, `${Math.round(next)}px`);
        updateToolbarWrapState();
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

function cancelMarquee({ restoreSelection = false } = {}) {
  const session = activeMarquee;
  if (!session) return;
  activeMarquee = null;
  if (session.rafId) cancelAnimationFrame(session.rafId);
  clearTimeout(session.inspectorTimer);
  session.rectEl?.remove();
  session.scroller.classList.remove('marquee-active');
  try { session.scroller.releasePointerCapture(session.pointerId); } catch {}
  if (!session.started) return;
  if (restoreSelection) {
    state.selected = new Set(session.base);
    state.selectedFolderCard = session.baseFolderCard;
    updateCardSelectionStyles();
  }
  renderInspector();
}

function bindMarqueeSelection(paneId, scroller) {
  const contentPoint = event => {
    const box = scroller.getBoundingClientRect();
    return {
      x: event.clientX - box.left + scroller.scrollLeft,
      y: event.clientY - box.top + scroller.scrollTop
    };
  };
  // Card rectangles are read per frame instead of cached: lazy-load refreshes
  // replace the grid DOM mid-drag and stale rectangles would select blindly.
  // Measured in the same scroller-content frame as the pointer: offsetLeft
  // and offsetTop would be relative to the 瀑布流 grid, whose cards are
  // placed inside it.
  const cardRects = () => {
    const cards = [];
    const box = scroller.getBoundingClientRect();
    for (const card of scroller.querySelectorAll('#itemGrid .item-card')) {
      const rect = card.getBoundingClientRect();
      const left = rect.left - box.left + scroller.scrollLeft;
      const top = rect.top - box.top + scroller.scrollTop;
      cards.push({ id: card.dataset.id, left, top, right: left + rect.width, bottom: top + rect.height });
    }
    return cards;
  };
  const applyGeometry = session => {
    const point = contentPoint(session.lastEvent);
    const rect = marqueeClampRect(
      marqueeNormalizeRect(session.origin.x, session.origin.y, point.x, point.y),
      scroller.scrollWidth,
      scroller.scrollHeight
    );
    session.rectEl.style.left = `${rect.left}px`;
    session.rectEl.style.top = `${rect.top}px`;
    session.rectEl.style.width = `${rect.right - rect.left}px`;
    session.rectEl.style.height = `${rect.bottom - rect.top}px`;
    const next = marqueeCombineSelection(session.base, marqueeHitIds(rect, cardRects()), session.additive);
    if (marqueeSameSelection(next, state.selected)) return;
    state.selected = next;
    state.selectedFolderCard = null;
    updateCardSelectionStyles();
    if (!session.inspectorTimer) {
      session.inspectorTimer = setTimeout(() => {
        session.inspectorTimer = null;
        if (activeMarquee === session) renderInspector();
      }, 150);
    }
  };
  const autoScrollTick = () => {
    const session = activeMarquee;
    if (!session || session.scroller !== scroller || !session.started) return;
    const box = scroller.getBoundingClientRect();
    const speed = marqueeAutoScrollSpeed(session.lastEvent.clientY, box.top, box.bottom);
    if (speed) {
      const before = scroller.scrollTop;
      scroller.scrollTop = before + speed;
      if (scroller.scrollTop !== before) applyGeometry(session);
    }
    session.rafId = speed ? requestAnimationFrame(autoScrollTick) : 0;
  };
  scroller.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    // Touch pointers scroll and tap; rubber-band selection is mouse/pen only
    // (preventDefault here would kill native touch scrolling entirely).
    if (event.pointerType === 'touch') return;
    if (activeMarquee) cancelMarquee();
    if (event.target.closest('.item-card, .folder-card, button, input, select, textarea, a, [data-tag-manager]')) return;
    const box = scroller.getBoundingClientRect();
    if (event.clientX - box.left >= scroller.clientWidth || event.clientY - box.top >= scroller.clientHeight) return;
    if (!confirmDiscardChanges()) return;
    activeMarquee = {
      paneId,
      scroller,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      origin: contentPoint(event),
      base: new Set(state.selected),
      baseFolderCard: state.selectedFolderCard,
      additive: event.metaKey || event.ctrlKey || event.shiftKey,
      started: false,
      rectEl: null,
      rafId: 0,
      inspectorTimer: null,
      lastEvent: event
    };
    try { scroller.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
  });
  scroller.addEventListener('pointermove', event => {
    const session = activeMarquee;
    if (!session || session.scroller !== scroller || event.pointerId !== session.pointerId) return;
    session.lastEvent = event;
    if (!session.started) {
      if (!marqueeExceedsThreshold(event.clientX - session.startClientX, event.clientY - session.startClientY)) return;
      session.started = true;
      session.rectEl = document.createElement('div');
      session.rectEl.className = 'marquee-rect';
      scroller.appendChild(session.rectEl);
      scroller.classList.add('marquee-active');
    }
    applyGeometry(session);
    const box = scroller.getBoundingClientRect();
    if (!session.rafId && marqueeAutoScrollSpeed(event.clientY, box.top, box.bottom)) {
      session.rafId = requestAnimationFrame(autoScrollTick);
    }
  });
  const finishMarquee = event => {
    const session = activeMarquee;
    if (!session || session.scroller !== scroller || event.pointerId !== session.pointerId) return;
    const wasClick = !session.started && event.type === 'pointerup';
    const additive = session.additive;
    cancelMarquee();
    // Eagle clears the selection on a plain blank click; modifier clicks keep it.
    if (wasClick && !additive && (state.selected.size || state.selectedFolderCard)) {
      state.selected.clear();
      state.selectedFolderCard = null;
      updateCardSelectionStyles();
      renderInspector();
    }
  };
  scroller.addEventListener('pointerup', finishMarquee);
  scroller.addEventListener('pointercancel', finishMarquee);
}

// Grid touch gestures: pull-to-refresh and two-finger thumbnail resizing.
// These use native touch events rather than pointer events because both have
// to call preventDefault — the pull to keep the browser's own overscroll
// refresh out of the way, the pinch to stop iOS page zoom (Safari ignores
// user-scalable=no). `touch-action: pan-y` on coarse pointers claims the
// gesture before the browser's zoom recognizer sees it. The gesture maths
// live in src/grid-gestures.js so they can be unit tested.
function bindGridTouchGestures(paneId, scroller, cancelLongPress) {
  const indicator = scroller.querySelector('#pullRefresh');
  const indicatorText = scroller.querySelector('#pullRefreshText');
  if (!indicator || !indicatorText) return;
  let pull = null;
  let pinch = null;
  const drawPull = (offset, label) => {
    indicator.style.transform = `translateY(${offset}px)`;
    indicator.style.opacity = String(gestures.pullOpacity(offset));
    indicatorText.textContent = label;
  };
  const resetPull = () => {
    pull = null;
    indicator.classList.remove('armed', 'refreshing');
    indicator.style.transform = '';
    indicator.style.opacity = '';
  };
  scroller.addEventListener('touchstart', event => {
    if (event.touches.length === 2) {
      resetPull();
      cancelLongPress();
      pinch = { spread: gestures.spread(event.touches), size: currentThumbnailSize() };
      return;
    }
    if (pinch || event.touches.length !== 1 || scroller.scrollTop > 0) return;
    pull = { startY: event.touches[0].clientY, offset: 0, armed: false };
  }, { passive: true });
  scroller.addEventListener('touchmove', event => {
    if (pinch) {
      if (event.touches.length !== 2) return;
      event.preventDefault();
      applyThumbnailSize(
        gestures.pinchThumbnailSize(pinch.size, pinch.spread, gestures.spread(event.touches)),
        { persist: false }
      );
      return;
    }
    if (!pull || event.touches.length !== 1) return;
    // A long-press has already opened a menu under this finger; dragging on
    // should not also arm a refresh behind it.
    if (touchLongPressActive) {
      if (pull.offset) resetPull();
      pull = null;
      return;
    }
    const delta = event.touches[0].clientY - pull.startY;
    // Scrolling up, or a list that scrolled away from the top mid-gesture,
    // hands the gesture back to the scroller instead of fighting it.
    if (delta <= 0 || scroller.scrollTop > 0) {
      if (pull.offset) resetPull();
      pull = null;
      return;
    }
    event.preventDefault();
    pull.offset = gestures.pullOffset(delta);
    pull.armed = gestures.pullArmed(pull.offset);
    indicator.classList.toggle('armed', pull.armed);
    drawPull(pull.offset, pull.armed ? '松开刷新' : '下拉刷新');
  }, { passive: false });
  const settle = event => {
    if (pinch && event.touches.length < 2) {
      pinch = null;
      applyThumbnailSize(currentThumbnailSize());
      suppressTouchClickUntil = Date.now() + 400;
    }
    if (!pull) return;
    const { armed, offset } = pull;
    pull = null;
    // A pull is not a tap: keep it from reaching the blank-space handler that
    // clears a touch multi-selection.
    if (offset > 4) suppressTouchClickUntil = Date.now() + 400;
    if (!armed) {
      resetPull();
      return;
    }
    indicator.classList.remove('armed');
    indicator.classList.add('refreshing');
    drawPull(gestures.PULL_TRIGGER, '正在刷新…');
    activatePane(paneId);
    Promise.resolve(refresh({ reset: true, preserveScroll: false, paneId }))
      .catch(() => {})
      .finally(() => setTimeout(resetPull, 220));
  };
  scroller.addEventListener('touchend', settle);
  scroller.addEventListener('touchcancel', settle);
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
  query('#backButton').addEventListener('click', () => { if (activatePane(paneId)) requestBackAction(); });
  query('#forwardButton').addEventListener('click', () => { if (activatePane(paneId)) navigateHistory(1); });
  query('#upButton').addEventListener('click', () => { if (activatePane(paneId)) navigateUp(); });
  const pathRow = root.querySelector('.heading-path-row');
  const breadcrumb = query('#breadcrumb');
  // Folder crumbs take items like sidebar rows. The library root takes only
  // Finder files (an import without a folder): like the sidebar, which has
  // no root row, it is no target for library items (B3-07).
  const crumbDropTarget = (event, kind) => (kind === 'internal-items'
    ? event.target.closest('[data-crumb-folder-id]')
    : event.target.closest('[data-crumb-folder-id], [data-crumb-root]'));
  if (breadcrumb) breadcrumb.addEventListener('dragover', event => {
    const kind = classifyDrop(event.dataTransfer, activeDraggedItemIds());
    if (kind === 'unsupported') return;
    const target = crumbDropTarget(event, kind);
    if (!target) {
      if (kind === 'internal-items' && event.target.closest('[data-crumb-root]')) {
        event.preventDefault(); event.stopPropagation();
        event.dataTransfer.dropEffect = 'none';
      }
      return;
    }
    event.preventDefault(); event.stopPropagation();
    const sourceFolderId = state.internalDrag?.sourceFolderId || null;
    event.dataTransfer.dropEffect = sourceFolderId && !event.altKey ? 'move' : 'copy';
    target.classList.add('drop-target');
  });
  if (breadcrumb) breadcrumb.addEventListener('dragleave', event => {
    const target = crumbDropTarget(event);
    if (target && !target.contains(event.relatedTarget)) target.classList.remove('drop-target');
  });
  if (breadcrumb) breadcrumb.addEventListener('drop', event => {
    const drop = resolveItemDrop(event);
    const kind = drop.kind;
    const target = crumbDropTarget(event, kind);
    if (!target || kind === 'unsupported') return;
    event.preventDefault(); event.stopPropagation();
    breadcrumb.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target'));
    const folderId = target.dataset.crumbFolderId || null;
    if (kind === 'external-files') {
      scheduleExternalFolderImport(event.dataTransfer, folderId, paneId);
      return;
    }
    const ids = drop.ids;
    const session = drop.session;
    const libraryPath = session?.libraryPath || state.library?.path;
    const sourceFolderId = session?.sourceFolderId || null;
    const sourceFolderIds = session?.sourceFolderIds || null;
    const sourcePaneId = session ? (session.sourcePaneId || state.dragSourcePaneId || null) : null;
    const name = target.textContent;
    const move = Boolean(sourceFolderId && !event.altKey);
    scheduleDropTask(() => addItemsToFolder(ids, folderId, name, libraryPath, { move, sourceFolderId, sourceFolderIds, sourcePaneId }));
  });
  pathRow?.addEventListener('pointerdown', event => {
    if (breadcrumb.classList.contains('is-editing')) return;
    if (event.target.closest('[data-crumb-expand]')) return;
    const button = event.target.closest('[data-crumb-index]');
    if (button && !button.disabled) return;
    if (!activatePane(paneId)) return;
    event.preventDefault();
    event.stopPropagation();
    beginBreadcrumbEdit(breadcrumb, paneId);
  });
  pathRow?.addEventListener('click', event => {
    if (!activatePane(paneId)) return;
    if (breadcrumb.classList.contains('is-editing')) return;
    if (event.target.closest('[data-crumb-expand]')) {
      breadcrumb.classList.add('is-expanded');
      syncBreadcrumbLayout(breadcrumb);
      return;
    }
    const button = event.target.closest('[data-crumb-index]');
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
      beginBreadcrumbEdit(breadcrumb, paneId);
      return;
    }
    const crumb = breadcrumb._crumbs?.[Number(button.dataset.crumbIndex)];
    if (crumb) navigate(crumb.view, { restoreScroll: true });
  });
  query('#sortSelectButton')?.addEventListener('click', event => {
    event.stopPropagation();
    if (!activatePane(paneId)) return;
    const popover = query('#sortPopover');
    if (!popover) return;
    const opening = popover.classList.contains('hidden');
    for (const p of document.querySelectorAll('.sort-popover:not(.hidden)')) {
      p.classList.add('hidden');
    }
    for (const b of document.querySelectorAll('.sort-select-button[aria-expanded="true"]')) {
      b.setAttribute('aria-expanded', 'false');
    }
    if (opening) {
      renderSortControls();
      popover.classList.remove('hidden');
      showSortPopover(popover, query('#sortSelectButton'));
      query('#sortSelectButton')?.setAttribute('aria-expanded', 'true');
    }
  });
  query('#sortPopover')?.addEventListener('click', event => {
    const layoutBtn = event.target.closest('[data-view-mode]');
    if (layoutBtn) {
      if (!activatePane(paneId)) return;
      setPaneViewMode(layoutBtn.dataset.viewMode, paneId);
      query('#sortPopover')?.classList.add('hidden');
      query('#sortSelectButton')?.setAttribute('aria-expanded', 'false');
      return;
    }
    const optionBtn = event.target.closest('[data-sort]');
    if (optionBtn) {
      applySortFromMenu(optionBtn.dataset.sort, paneId);
      query('#sortPopover')?.classList.add('hidden');
      query('#sortSelectButton')?.setAttribute('aria-expanded', 'false');
      return;
    }
    const dirBtn = event.target.closest('[data-sort-dir]');
    if (dirBtn && !dirBtn.disabled) {
      if (!activatePane(paneId)) return;
      if (applySortDirection(dirBtn.dataset.sortDir)) {
        query('#sortPopover')?.classList.add('hidden');
        query('#sortSelectButton')?.setAttribute('aria-expanded', 'false');
      }
    }
  });
  query('#sortCascadeCheck')?.addEventListener('change', event => {
    if (!activatePane(paneId)) { syncSortCascadeChecks(); return; }
    const checked = event.target.checked;
    setSortCascadeEnabled(checked);
    if (checked && state.currentView?.kind === 'folder') {
      sortMemory.rememberCascade(
        state.library?.path,
        state.currentView.id,
        state.library?.folders,
        state.sort,
        state.sortDir,
        Date.now()
      );
      toast('已将当前排序应用到所有子文件夹');
    }
  });
  query('#sortSelect').addEventListener('change', event => {
    if (!activatePane(paneId)) return;
    if (event.target.value==='manual' && (!supportsManual(state.currentView) || !state.manualOrdersReady)) {renderSortControls();return;}
    state.sort = event.target.value;
    state.sortDir = 'auto';
    // Picking 随机 deals a new order; re-picking it from the dropdown fires no
    // change event, which is why the direction button doubles as reshuffle.
    if (state.sort === 'random') state.randomSeed = nextRandomSeed();
    if (sortCascadeEnabled && state.currentView?.kind === 'folder') {
      sortMemory.rememberCascade(
        state.library?.path,
        state.currentView.id,
        state.library?.folders,
        state.sort,
        state.sortDir,
        Date.now()
      );
    }
    commitSortChange();
    if (viewHasClientOrder() && state.hasMore) refresh({ reset: false, preserveScroll: true, paneId });
  });
  query('#viewModeGroup').addEventListener('click', event => {
    const button = event.target.closest('[data-view-mode]');
    if (!button) return;
    if (!activatePane(paneId)) return;
    setPaneViewMode(button.dataset.viewMode, paneId);
  });
  query('#itemGrid').addEventListener('click', event => {
    if (!activatePane(paneId)) return;
    if (Date.now() < suppressTouchClickUntil) return;
    if (event.target.closest('[data-toggle-subfolders]')) {
      setSubfoldersCollapsed(!subfoldersCollapsed);
      return;
    }
    const listSort = event.target.closest('[data-list-sort]');
    if (listSort) {
      applyListHeaderSort(listSort.dataset.listSort, paneId);
      return;
    }
    const tagAction = event.target.closest('[data-tag-action]');
    if (tagAction) {
      executeTagManagerAction(tagAction.dataset.tagAction, {
        tagName: tagAction.dataset.tagName,
        groupId: tagAction.dataset.tagGroupId
      }).catch(error => toast(`标签操作失败：${error.message}`, 4200));
      return;
    }
    if (event.target.closest('[data-tag-manager]')) {
      handleTagManagerClick(event, paneId);
      return;
    }
    const touch = isTouchEvent(event);
    if (touch) lastTouchGridTapAt = Date.now();
    // Touch has no double-click: the first tap selects (replacing any
    // selection, as a mouse click does) and a tap on what is already the
    // only selection opens it. Long-press adds to the selection.
    const folder = event.target.closest('.folder-card');
    if (folder) {
      const folderId = folder.dataset.openFolder;
      if (touch && state.selectedFolderCard === folderId && !state.selected.size) { enterFolderFromGrid(folderId); return; }
      selectFolderCard(folderId);
      return;
    }
    const card = event.target.closest('.item-card');
    if (card) {
      const id = card.dataset.id;
      if (touch) {
        if (state.selected.size === 1 && state.selected.has(id)) {
          openPreview(id);
          broadcastPaneAction(() => {
            if (itemById(id)) openPreview(id);
          });
        } else {
          selectItem(id);
        }
        return;
      }
      selectItem(id, event.metaKey || event.ctrlKey, event.shiftKey);
      return;
    }
  });
  // Tap on empty space (grid gaps and the blank area below the last row)
  // exits touch multi-select — the marquee's click-to-clear path is disabled
  // for touch pointers, and #itemGrid does not cover the trailing space.
  query('#gridScroller').addEventListener('click', event => {
    if (!isTouchEvent(event) || Date.now() < suppressTouchClickUntil) return;
    if (event.target.closest('.item-card, .folder-card, button, input, select, textarea, a, [data-tag-action]')) return;
    if (!(state.selected.size || state.selectedFolderCard)) return;
    clearSelection();
  });
  // Long-press: first use selects (entering multi-select), later ones open
  // the context menu. The browser's synthetic contextmenu/click that follow
  // a touch long-press are suppressed via the shared timestamp.
  const { cancel: cancelLongPress } = bindTouchLongPress(query('#itemGrid'), {
    selector: '.item-card, .folder-card',
    onLongPress: (card, point) => {
      if (!activatePane(paneId)) return;
      triggerTouchLongPress(card, paneId, point);
    }
  });
  bindTagManagerEvents(paneId, query('#itemGrid'));
  query('#itemGrid').addEventListener('dblclick', event => {
    if (Date.now() - lastTouchGridTapAt < 600) return;
    if (!activatePane(paneId)) return;
    const tagChip = event.target.closest('[data-tm-tag]');
    if (tagChip) { searchItemsWithTags([tagChip.dataset.tmTag]); return; }
    const groupRow = event.target.closest('[data-tm-group]');
    if (groupRow) { executeTagManagerAction('rename-group', { groupId: groupRow.dataset.tmGroup }).catch(error => toast(`标签操作失败：${error.message}`, 4200)); return; }
    const folder = event.target.closest('.folder-card');
    if (folder) { enterFolderFromGrid(folder.dataset.openFolder); return; }
    const card = event.target.closest('.item-card');
    if (card) {
      openPreview(card.dataset.id);
      broadcastPaneAction(() => {
        if (itemById(card.dataset.id)) openPreview(card.dataset.id);
      });
    }
  });
  query('#itemGrid').addEventListener('contextmenu', event => {
    // Touch long-press menus are driven by triggerTouchLongPress; swallow the
    // browser's own long-press contextmenu so it cannot double-open.
    if (touchLongPressActive || Date.now() < suppressTouchClickUntil) {
      event.preventDefault();
      return;
    }
    if (!activatePane(paneId)) {
      event.preventDefault();
      return;
    }
    if (event.target.closest('[data-tag-manager]')) {
      if (event.target.closest('input, textarea')) return;
      event.preventDefault();
      event.stopPropagation();
      openTagManagerMenu(event, paneId);
      return;
    }
    if (event.target.closest('.list-header')) {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event, { kind: 'list-columns', ids: [], paneId });
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
    const ids = [...state.selected];
    const libraryPath = state.library?.path;
    const sourceFolderId = state.currentView.kind === 'folder' ? state.currentView.id : null;
    const sourceFolderIds = paneFolderScope(paneById(paneId), sourceFolderId);
    if (hasCapability('nativeDrag')) {
      // Electron's native file drag must replace Chromium's default HTML5
      // drag session. Leaving the default session alive can make macOS wait
      // indefinitely after dropping into another pane or the folder tree.
      event.preventDefault();
    } else {
      // Web: no native session exists, so the default HTML5 drag stays alive
      // and carries the ids for in-page drops (folder cards, panes, the tree).
      event.dataTransfer.setData(window.EagleMVDragDrop.ITEM_TYPE, JSON.stringify(ids));
      event.dataTransfer.effectAllowed = 'copyMove';
    }
    state.draggingItemIds = ids;
    state.dragSourcePaneId = paneId;
    state.internalDrag = {
      active: true,
      token: null,
      ids,
      sourceFolderId,
      sourceFolderIds,
      sourcePaneId: paneId,
      sourceWindowId: state.windowId,
      libraryPath
    };
    window.eagleMV.startDrag({
      ids,
      sourceFolderId,
      sourceFolderIds,
      sourcePaneId: paneId,
      sourceWindowId: state.windowId,
      libraryPath
    });
  });
  itemGrid.addEventListener('dragend', clearDragUI);
  itemGrid.addEventListener('dragover', event => {
    const folder = event.target.closest('.folder-card');
    if (!folder) return;
    if (handleFolderTargetDragOver(event, folder)) {
      event.stopPropagation();
    }
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
    if (!folder) return;
    const drop = resolveItemDrop(event);
    const dropKind = drop.kind;
    if (dropKind === 'unsupported') return;
    event.preventDefault();
    event.stopPropagation();
    folder.classList.remove('drop-target');
    if (dropKind === 'external-files') {
      scheduleExternalFolderImport(event.dataTransfer, folder.dataset.openFolder, paneId);
      return;
    }
    const ids = drop.ids;
    if (!ids.length) {
      toast('无法识别拖入的素材，请重新拖动', 3500);
      clearDragUI();
      return;
    }
    const target = findFolder(state.library?.folders, folder.dataset.openFolder);
    const session = drop.session;
    const libraryPath = session?.libraryPath || state.library?.path;
    const sourceFolderId = session?.sourceFolderId || null;
    const sourceFolderIds = session?.sourceFolderIds || null;
    const move = Boolean(sourceFolderId && !event.altKey);
    const sourcePaneId = session ? (session.sourcePaneId || state.dragSourcePaneId || paneId) : null;
    scheduleDropTask(() => addItemsToFolder(ids, folder.dataset.openFolder, target?.name, libraryPath, { move, sourceFolderId, sourceFolderIds, sourcePaneId }));
  });
  const scroller = query('#gridScroller');
  bindMarqueeSelection(paneId, scroller);
  bindGridTouchGestures(paneId, scroller, cancelLongPress);
  const openWorkspaceMenu = point => {
    if (!activatePane(paneId)) return;
    const pane = paneById(paneId);
    showContextMenuAt(point.x, point.y, {
      kind: 'workspace',
      ids: [],
      paneId,
      folderId: pane?.currentView.kind === 'folder' ? pane.currentView.id : null
    });
  };
  scroller.addEventListener('contextmenu', event => {
    if (event.target.closest('.item-card, .folder-card')) return;
    event.preventDefault();
    if (touchLongPressActive || Date.now() < suppressTouchClickUntil) return;
    openWorkspaceMenu({ x: event.clientX, y: event.clientY });
  });
  // Touch has no right-click and no ⌘A, so the workspace menu (and 全选 with
  // it) needs a gesture. Blank grid space carries it, but at phone width the
  // grid is nearly wall-to-wall cards and lazy loading keeps refilling the
  // tail, so the only reliable gaps are a few pixels between rows. The pane
  // heading always has room, so it carries the same press.
  const workspaceLongPress = {
    ignore: '.item-card, .folder-card, button, input, select, textarea, a, [data-tag-action]',
    onLongPress: (_target, point) => {
      navigator.vibrate?.(10);
      openWorkspaceMenu(point);
    }
  };
  bindTouchLongPress(scroller, workspaceLongPress);
  const heading = query('.content-heading');
  if (heading) {
    bindTouchLongPress(heading, workspaceLongPress);
    heading.addEventListener('contextmenu', event => {
      if (event.target.closest('button, input, select, textarea, a')) return;
      event.preventDefault();
      if (touchLongPressActive || Date.now() < suppressTouchClickUntil) return;
      openWorkspaceMenu({ x: event.clientX, y: event.clientY });
    });
  }
  scroller.addEventListener('scroll', event => {
    const element = event.currentTarget;
    const pane = paneById(paneId);
    if (!pane) return;
    pane.scrollTop = element.scrollTop;
    if (state.activePaneId === paneId) updateScrollUI();
    if (pane.sort==='manual' && pane.items.length>(pane.manualRenderLimit || SORT_FETCH_CAP) && element.scrollTop+element.clientHeight>element.scrollHeight-500) {
      pane.manualRenderLimit=(pane.manualRenderLimit || SORT_FETCH_CAP)+state.pageSize;
      withActivePane(paneId,()=>renderGrid({preserveScroll:true}));
    }
    if (!pane.loading && pane.hasMore && element.scrollTop + element.clientHeight > element.scrollHeight - 500) refresh({ reset: false, preserveScroll: true, paneId });
  });
  query('#scrollTopButton').addEventListener('click', () => {
    if (!activatePane(paneId)) return;
    scroller.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
  query('#emptyRetryButton').addEventListener('click', () => {
    if (!activatePane(paneId)) return;
    refresh({ reset: true, preserveScroll: true, paneId });
  });
  // A drag only passing over this pane must not activate it: that would
  // rebuild the shared sidebar and inspector mid-drag (and could raise a
  // discard confirm inside the native drag session). The drop activates it.
  // The overlay and its depth counter are this pane's own, never the active
  // pane's, so enter/leave pairs of neighbouring panes cannot cross.
  scroller.addEventListener('dragenter', event => {
    const fallbackIds = activeDraggedItemIds();
    if (classifyDrop(event.dataTransfer, fallbackIds) === 'unsupported') return;
    event.preventDefault();
    const pane = paneById(paneId);
    if (!pane || !hasCapability('importLocal') || !shouldShowImportOverlay(event.dataTransfer, fallbackIds)) return;
    pane.dragDepth = (pane.dragDepth || 0) + 1;
    query('#dropOverlay').classList.remove('hidden');
  });
  // Items let go in the folder they came from are already there: refuse the
  // drop with the cursor instead of acting or reporting it.
  const dropsIntoSourceFolder = () => {
    const drag = state.internalDrag;
    if (!drag?.active) return false;
    const sameWindow = !drag.sourceWindowId || drag.sourceWindowId === state.windowId;
    if (sameWindow && (drag.sourcePaneId || state.dragSourcePaneId) === paneId) return true;
    const view = paneById(paneId)?.currentView;
    return Boolean(drag.sourceFolderId && view?.kind === 'folder' && view.id === drag.sourceFolderId);
  };
  scroller.addEventListener('dragover', event => {
    const fallbackIds = activeDraggedItemIds();
    const dropKind = classifyDrop(event.dataTransfer, fallbackIds);
    if (dropKind === 'unsupported') return;
    event.preventDefault();
    if (dropKind === 'internal-items' && dropsIntoSourceFolder()) {
      event.dataTransfer.dropEffect = 'none';
      return;
    }
    const sourceFolderId = state.internalDrag?.sourceFolderId || null;
    event.dataTransfer.dropEffect = dropKind === 'internal-items' && sourceFolderId && !event.altKey ? 'move' : 'copy';
  });
  scroller.addEventListener('dragleave', () => {
    const overlay = query('#dropOverlay');
    const pane = paneById(paneId);
    if (!pane || overlay.classList.contains('hidden')) return;
    pane.dragDepth = Math.max(0, (pane.dragDepth || 0) - 1);
    if (!pane.dragDepth) overlay.classList.add('hidden');
  });
  scroller.addEventListener('drop', event => {
    event.preventDefault();
    const drop = resolveItemDrop(event);
    if (drop.kind === 'unsupported' || (drop.kind === 'internal-items' && dropsIntoSourceFolder())) {
      clearDragUI();
      return;
    }
    if (!activatePane(paneId)) {
      clearDragUI();
      return;
    }
    if (drop.kind === 'internal-items') {
      const context = paneItemDropContext(paneId, event, drop);
      if (!context) {
        toast('无法识别拖入的素材，请重新拖动', 3500);
        clearDragUI();
        return;
      }
      scheduleDropTask(() => handlePaneItemDrop(context));
      return;
    }
    const targetPane = paneById(paneId);
    scheduleExternalFolderImport(event.dataTransfer, targetPane?.currentView.kind === 'folder' ? targetPane.currentView.id : null, paneId);
  });
  const previewModal = query('#previewModal');
  if (previewModal) {
    // A tap has almost no pointer-move, so wake the HUD on pointer-down too
    // (touch users need it just as much as desktop mouse users).
    previewModal.addEventListener('pointerdown', () => pingPreviewHUD(paneId));
    previewModal.addEventListener('pointermove', () => pingPreviewHUD(paneId));
    previewModal.addEventListener('pointerleave', () => {
      const pane = paneById(paneId);
      if (pane) {
        clearTimeout(pane.hudTimer);
        pane.hudTimer = setTimeout(() => {
          if (previewModal.isConnected && !previewModal.classList.contains('hidden')) {
            previewModal.classList.add('hud-hidden');
          }
        }, 400);
      }
    });
    query('#closePreview')?.addEventListener('click', () => {
      activatePane(paneId);
      withActivePane(paneId, () => closePreview());
    });
    query('#slideshowToggle')?.addEventListener('click', event => {
      event.stopPropagation();
      activatePane(paneId);
      withActivePane(paneId, () => toggleSlideshow());
    });
    query('#slideshowInterval')?.addEventListener('change', event => {
      const pane = paneById(paneId);
      if (pane) {
        pane.slideshow.intervalMs = Number(event.target.value) || 4000;
        try { localStorage.setItem(SLIDESHOW_INTERVAL_KEY, String(pane.slideshow.intervalMs)); } catch {}
        if (pane.slideshow.timer) {
          withActivePane(paneId, () => scheduleSlideshowStep());
        }
      }
    });
    query('#slideshowControls')?.addEventListener('click', event => event.stopPropagation());
    query('#previewBackground')?.addEventListener('click', () => {
      activatePane(paneId);
      withActivePane(paneId, () => cyclePreviewBackground());
    });
    query('#previewGrayscale')?.addEventListener('click', () => {
      activatePane(paneId);
      withActivePane(paneId, () => togglePreviewGrayscale());
    });
    query('#modalRating')?.addEventListener('click', event => {
      event.stopPropagation();
      const star = event.target.closest('[data-preview-rating]');
      if (!star) return;
      if (!activatePane(paneId)) return;
      const value = Number(star.dataset.previewRating);
      const rating = value === Number(event.currentTarget.dataset.rating || 0) ? 0 : value;
      withActivePane(paneId, () => {
        ratePreviewItem(rating);
      });
    });
    const modalMedia = query('#modalMedia');
    if (modalMedia) {
      modalMedia.addEventListener('wheel', event => {
        const pane = paneById(paneId);
        if (!pane?.previewId) return;
        activatePane(paneId);
        withActivePane(paneId, () => {
          if (!previewImage()) return;
          event.preventDefault();
          const box = modalMedia.getBoundingClientRect();
          const anchor = { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 };
          changePreviewZoom(event.deltaY < 0 ? .15 : -.15, anchor);
        });
      }, { passive: false });
    }

    const previewPointers = new Map();
    let pinchBase = null;
    let swipeSession = null;
    let swipeClickSuppressUntil = 0;
    // Photo-album paging: while a finger drags the fitted image sideways, the
    // neighbour it would turn to rides in from that edge. Letting go far
    // enough, or with a quick flick, slides both into place; otherwise both
    // slide back. With nothing to turn to that way the drag rubber-bands.
    // Taps and arrow keys still cut straight to the next item.
    let swipeTurning = false;
    const swipeNeighbour = delta => withActivePane(paneId, () => {
      const items = sortedItems();
      const index = items.findIndex(item => item.id === state.previewId);
      return index >= 0 ? items[index + delta] || null : null;
    });
    const startSwipeSession = (event, image) => {
      const media = paneQuery(paneId, '#modalMedia');
      const neighbours = { 1: swipeNeighbour(1), [-1]: swipeNeighbour(-1) };
      if (image) image.style.transition = 'none';
      return {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        image,
        width: (media || previewModal).getBoundingClientRect().width || window.innerWidth,
        padding: media ? getComputedStyle(media).padding : '0px',
        neighbours,
        canTurn: { 1: Boolean(neighbours[1]) || withActivePane(paneId, () => state.hasMore), [-1]: Boolean(neighbours[-1]) },
        samples: [{ t: event.timeStamp, x: event.clientX }],
        offset: 0,
        peek: null,
        peekDelta: 0
      };
    };
    const removeSwipePeek = session => {
      session.peek?.remove();
      session.peek = null;
      session.peekDelta = 0;
    };
    const showSwipePeek = (session, delta) => {
      if (session.peekDelta === delta) return;
      removeSwipePeek(session);
      const item = delta ? session.neighbours[delta] : null;
      if (!item) return;
      const peek = document.createElement('div');
      peek.className = 'preview-swipe-peek';
      peek.setAttribute('aria-hidden', 'true');
      peek.style.padding = session.padding;
      const image = document.createElement('img');
      image.className = 'preview-image';
      image.alt = '';
      image.draggable = false;
      image.src = previewImageURL(item) || mediaURL('thumb', item.id);
      peek.append(image);
      previewModal.append(peek);
      session.peek = peek;
      session.peekDelta = delta;
    };
    const swipeSlot = (session, delta) => delta * (session.width + PREVIEW_SWIPE_GAP);
    const paintSwipe = (session, dx) => {
      const delta = dx < 0 ? 1 : dx > 0 ? -1 : 0;
      session.offset = delta && !session.canTurn[delta] ? dx * .35 : dx;
      showSwipePeek(session, session.canTurn[delta] ? delta : 0);
      if (session.image) session.image.style.transform = `translateX(${session.offset}px)`;
      if (session.peek) session.peek.style.transform = `translateX(${session.offset + swipeSlot(session, session.peekDelta)}px)`;
    };
    const swipeVelocity = (session, event) => {
      const recent = session.samples.find(sample => event.timeStamp - sample.t <= 100) || session.samples.at(-1);
      const elapsed = event.timeStamp - recent.t;
      return elapsed > 0 ? (event.clientX - recent.x) / elapsed : 0;
    };
    const swipeDuration = (session, distance, velocity = 0) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
      let duration = distance / session.width * 360;
      if (Math.abs(velocity) > .1) duration = Math.min(duration, distance / Math.abs(velocity) * 1.6);
      return Math.round(Math.max(140, Math.min(320, duration)));
    };
    const slideSwipeLayer = (element, from, to, duration) => {
      if (!element) return Promise.resolve();
      element.style.transform = `translateX(${to}px)`;
      if (!duration || from === to) return Promise.resolve();
      const animation = element.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
        { duration, easing: 'cubic-bezier(.2, .8, .2, 1)' });
      // A page that stops painting (backgrounded app, hidden view) freezes the
      // animation clock; never let that strand the turn half-way.
      return Promise.race([
        animation.finished.catch(() => {}),
        new Promise(resolve => setTimeout(resolve, duration + 120))
      ]).then(() => animation.cancel());
    };
    const releaseSwipeImage = image => {
      if (!image?.isConnected) return;
      image.style.transform = '';
      image.style.transition = '';
    };
    const slideSwipeBack = async (session, from = session.offset) => {
      const duration = swipeDuration(session, Math.abs(from));
      const peekFrom = from + swipeSlot(session, session.peekDelta);
      await Promise.all([
        slideSwipeLayer(session.image, from, 0, duration),
        slideSwipeLayer(session.peek, peekFrom, swipeSlot(session, session.peekDelta), duration)
      ]);
      removeSwipePeek(session);
      releaseSwipeImage(session.image);
    };
    const turnPreviewBySwipe = async (session, delta, velocity) => {
      swipeTurning = true;
      const target = -swipeSlot(session, delta);
      const duration = swipeDuration(session, Math.abs(target - session.offset), velocity);
      try {
        await Promise.all([
          slideSwipeLayer(session.image, session.offset, target, duration),
          slideSwipeLayer(session.peek, session.offset + swipeSlot(session, session.peekDelta), 0, duration)
        ]);
        const moving = withActivePane(paneId, () => movePreview(delta));
        broadcastPaneAction(pane => {
          if (pane.previewId) movePreview(delta);
        });
        if (!await moving) {
          session.peekDelta = session.peek ? delta : 0;
          await slideSwipeBack(session, target);
          return;
        }
        // Keep the peek over the new image until that has painted, so the
        // hand-over is seamless rather than a blank frame.
        const incoming = paneQuery(paneId, '#modalMedia img');
        if (session.peek && incoming && !incoming.complete) {
          await Promise.race([incoming.decode().catch(() => {}), new Promise(resolve => setTimeout(resolve, 400))]);
        }
      } finally {
        removeSwipePeek(session);
        swipeTurning = false;
      }
    };
    const settleSwipe = event => {
      const session = swipeSession;
      if (!session || event.pointerId !== session.pointerId) return;
      swipeSession = null;
      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      if (Math.hypot(dx, dy) > 15) swipeClickSuppressUntil = Date.now() + 400;
      const delta = dx < 0 ? 1 : -1;
      const velocity = swipeVelocity(session, event);
      const far = Math.abs(dx) > Math.max(70, session.width * .25);
      const flick = Math.abs(dx) > 24 && Math.abs(velocity) > .45 && Math.sign(velocity) === Math.sign(dx);
      if ((far || flick) && Math.abs(dx) > Math.abs(dy) * 1.4 && session.canTurn[delta]) {
        turnPreviewBySwipe(session, delta, velocity);
        return;
      }
      if (dy > 90 && dy > Math.abs(dx) * 1.4) {
        removeSwipePeek(session);
        releaseSwipeImage(session.image);
        withActivePane(paneId, () => closePreview());
        return;
      }
      slideSwipeBack(session);
    };
    const pinchGeometry = () => {
      const [first, second] = [...previewPointers.values()];
      return {
        distance: Math.hypot(second.x - first.x, second.y - first.y),
        centerX: (first.x + second.x) / 2,
        centerY: (first.y + second.y) / 2
      };
    };
    previewModal.addEventListener('pointerdown', event => {
      const image = paneQuery(paneId, '#modalMedia img.preview-image');
      if (!previewModal.classList.contains('image-gesture')) return;
      if (event.target.closest('#slideshowControls, #modalRating')) return;
      const pane = paneById(paneId);
      if (!pane) return;
      if (isPreviewTouchPointer(event)) {
        previewPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture(event.pointerId);
        if (previewPointers.size === 2) {
          if (!image) return;
          pane.previewZoom.dragging = false;
          if (swipeSession) {
            removeSwipePeek(swipeSession);
            releaseSwipeImage(swipeSession.image);
            swipeSession = null;
          }
          pinchBase = { ...pinchGeometry(), scale: pane.previewZoom.mode === 'fit' ? 1 : pane.previewZoom.scale };
          return;
        }
        if (!image || pane.previewZoom.mode === 'fit') {
          if (!swipeTurning) swipeSession = startSwipeSession(event, image);
          return;
        }
      }
      if (!image || event.button !== 0) return;
      event.preventDefault();
      pane.previewZoom.dragging = true;
      pane.previewZoom.startX = event.clientX;
      pane.previewZoom.startY = event.clientY;
      pane.previewZoom.originX = pane.previewZoom.x;
      pane.previewZoom.originY = pane.previewZoom.y;
      event.currentTarget.setPointerCapture(event.pointerId);
      withActivePane(paneId, () => renderPreviewZoom());
    });
    previewModal.addEventListener('pointermove', event => {
      const pane = paneById(paneId);
      if (!pane) return;
      if (swipeSession && event.pointerId === swipeSession.pointerId && previewPointers.size === 1 && pane.previewZoom.mode === 'fit') {
        previewPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        swipeSession.samples.push({ t: event.timeStamp, x: event.clientX });
        if (swipeSession.samples.length > 8) swipeSession.samples.shift();
        paintSwipe(swipeSession, event.clientX - swipeSession.startX);
        return;
      }
      if (previewPointers.has(event.pointerId)) {
        previewPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (previewPointers.size === 2 && pinchBase) {
          const current = pinchGeometry();
          if (pinchBase.distance > 0 && current.distance > 0) {
            const modalMedia = query('#modalMedia');
            const box = modalMedia?.getBoundingClientRect() || { left: 0, top: 0, width: 0, height: 0 };
            const anchor = { x: current.centerX - box.left - box.width / 2, y: current.centerY - box.top - box.height / 2 };
            const targetScale = Math.max(.25, Math.min(6, pinchBase.scale * (current.distance / pinchBase.distance)));
            withActivePane(paneId, () => {
              changePreviewZoom(targetScale - (pane.previewZoom.mode === 'fit' ? 1 : pane.previewZoom.scale), anchor);
            });
          }
          return;
        }
      }
      if (!pane.previewZoom.dragging) return;
      pane.previewZoom.x = pane.previewZoom.originX + event.clientX - pane.previewZoom.startX;
      pane.previewZoom.y = pane.previewZoom.originY + event.clientY - pane.previewZoom.startY;
      withActivePane(paneId, () => renderPreviewZoom());
    });
    const releasePreviewPointer = event => {
      settleSwipe(event);
      const pane = paneById(paneId);
      if (previewPointers.delete(event.pointerId) && previewPointers.size < 2) pinchBase = null;
      if (!pane?.previewZoom.dragging) return;
      pane.previewZoom.dragging = false;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      withActivePane(paneId, () => renderPreviewZoom());
    };
    previewModal.addEventListener('pointerup', releasePreviewPointer);
    previewModal.addEventListener('pointercancel', releasePreviewPointer);
    // E-reader style paging: a quick, still tap on the left or right third of
    // the preview steps to the previous or next item; the middle third does
    // nothing. Drags, swipes, pinches, taps on media controls or the TXT editor,
    // and any tap while the image is zoomed keep their own meaning.
    let tapSession = null;
    previewModal.addEventListener('pointerdown', event => {
      const pane = paneById(paneId);
      tapSession = null;
      if (!pane || !event.isPrimary || event.button !== 0) return;
      if (swipeTurning || pane.previewZoom.mode !== 'fit' || event.target.closest(PREVIEW_TAP_EXCLUDED)) return;
      tapSession = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp };
    });
    previewModal.addEventListener('pointermove', event => {
      if (tapSession?.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - tapSession.x, event.clientY - tapSession.y) > PREVIEW_TAP_SLOP) tapSession = null;
    });
    previewModal.addEventListener('pointercancel', () => { tapSession = null; });
    previewModal.addEventListener('pointerup', event => {
      const session = tapSession;
      tapSession = null;
      const pane = paneById(paneId);
      if (!session || session.pointerId !== event.pointerId || !pane?.previewId) return;
      if (pane.previewZoom.mode !== 'fit' || previewPointers.size > 0) return;
      if (Math.hypot(event.clientX - session.x, event.clientY - session.y) > PREVIEW_TAP_SLOP) return;
      if (event.timeStamp - session.time > PREVIEW_TAP_MAX_MS) return;
      const delta = previewTapZoneDelta(previewModal.getBoundingClientRect(), event.clientX);
      if (!delta) return;
      activatePane(paneId);
      withActivePane(paneId, () => movePreview(delta));
      broadcastPaneAction(other => {
        if (other.previewId) movePreview(delta);
      });
    });
  }
}

const PREVIEW_SWIPE_GAP = 24;
const PREVIEW_TAP_SLOP = 10;
const PREVIEW_TAP_MAX_MS = 500;
const PREVIEW_TAP_EXCLUDED = 'button, a, input, select, textarea, video, audio, embed, iframe, .text-preview, #slideshowControls, #modalRating';
// Left third steps back, right third steps forward, the middle third is inert.
function previewTapZoneDelta(box, clientX) {
  if (!box.width) return 0;
  const ratio = (clientX - box.left) / box.width;
  if (ratio < 1 / 3) return -1;
  if (ratio > 2 / 3) return 1;
  return 0;
}

function bindEvents() {
  bindWorkspaceResizers();
  bindToolbarWrapState();
  bindMetadataViewerControls();
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
  $('#currentEaglePathButton').addEventListener('click', navigateToCurrentEaglePath);
  $('#refreshAllPanesButton').addEventListener('click', requestRefreshAllPanes);
  $('#toggleSidebarButton').addEventListener('click', () => togglePanel('sidebar'));
  $('#toggleInspectorButton').addEventListener('click', () => togglePanel('inspector'));
  $('#drawerBackdrop').addEventListener('click', closeDrawers);
  // Touch has no Esc: the multi-select panel needs an explicit way out.
  $('#clearSelectionButton').addEventListener('click', clearSelection);
  $('#selectionBarClear').addEventListener('click', clearSelection);
  $('#selectionBarPreview').addEventListener('click', () => {
    const id = [...state.selected][0];
    if (id) openPreview(id);
  });
  $('#selectionBarDetails').addEventListener('click', () => {
    state.openDrawer = 'inspector';
    renderPanels();
  });
  // Rotating a tablet between drawer and column modes re-renders the panels.
  compactLayoutQuery.addEventListener?.('change', () => renderPanels());
  window.addEventListener('resize', () => {
    applyLayoutSplitRatios($('#paneLayout'), state.splitRatios);
    renderPanels();
    scheduleGridResize();
  });
  const paneLayoutElement = $('#paneLayout');
  if (paneLayoutElement && typeof ResizeObserver === 'function') {
    const paneLayoutObserver = new ResizeObserver(() => scheduleGridResize());
    paneLayoutObserver.observe(paneLayoutElement);
  }
  $('#generationMetadata').addEventListener('click', async event => {
    const button = event.target.closest('[data-metadata-copy]');
    if (!button) return;
    const value = button.closest('.metadata-block')?.querySelector('.metadata-prompt-text')?.textContent || '';
    if (!value) return;
    await copyTextWithFeedback(value, '提示词已复制');
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
  $('#lockFiltersButton').addEventListener('click', () => {
    state.filterLock = !state.filterLock;
    renderFilterState();
    toast(state.filterLock ? '已锁定筛选：切换文件夹时保留搜索与筛选' : '已解除筛选锁定', 2400);
  });
  // The search box's icon, padding and shortcut hint are part of the field:
  // a tap there (a finger rarely lands on the 18px-tall input) focuses it (W-07).
  document.querySelector('.search-box')?.addEventListener('pointerdown', event => {
    if (event.target.closest('input, button, select')) return;
    event.preventDefault();
    $('#searchInput').focus();
  });
  $('#filterButton').addEventListener('click', () => {
    $('#filterPopover').classList.toggle('hidden');
    ensureFilterFacets();
    renderFilterLists();
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
  $('#tagColorManager').addEventListener('input', event => {
    if (event.target.closest('[data-tag-color-search]')) renderTagColors();
  });
  $('#tagColorManager').addEventListener('click', event => {
    const clear = event.target.closest('[data-tag-color-clear]');
    if (clear) { tagColorManagerOpen = null; updateTagColor(clear.dataset.tagColorClear, ''); return; }
    const open = event.target.closest('[data-tag-color-open]');
    if (open) {
      tagColorManagerOpen = tagColorManagerOpen === open.dataset.tagColorOpen ? null : open.dataset.tagColorOpen;
      renderTagColors();
      return;
    }
    const swatch = event.target.closest('[data-tag-palette-color]');
    if (swatch) {
      tagColorManagerOpen = null;
      updateTagColor(swatch.dataset.tag, swatch.dataset.tagPaletteColor);
    }
  });
  // The sort popover is placed in window coordinates when it opens; a window
  // or splitter resize would leave it floating away from its button.
  window.addEventListener('resize', () => {
    for (const popover of document.querySelectorAll('.sort-popover.top-layer:not(.hidden)')) popover.classList.add('hidden');
    for (const button of document.querySelectorAll('.sort-select-button[aria-expanded="true"]')) button.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', event => {
    if (!clickWithin(event, '#filterButton, #filterPopover')) {
      $('#filterPopover').classList.add('hidden');
      renderFilterState();
    }
    if (!clickWithin(event, '#paneLayoutButton, #paneLayoutPopover')) {
      $('#paneLayoutPopover').classList.add('hidden');
      $('#paneLayoutButton').setAttribute('aria-expanded', 'false');
    }
    if (!clickWithin(event, '#libraryButton, #libraryPopover')) closeLibraryPopover();
    if (!clickWithin(event, '.sort-select-control')) {
      for (const p of document.querySelectorAll('.sort-popover:not(.hidden)')) {
        p.classList.add('hidden');
      }
      for (const b of document.querySelectorAll('.sort-select-button[aria-expanded="true"]')) {
        b.setAttribute('aria-expanded', 'false');
      }
    }
  });
  $('#libraryButton').addEventListener('click', event => {
    event.stopPropagation();
    if ($('#libraryPopover').classList.contains('hidden')) openLibraryPopover();
    else closeLibraryPopover();
  });
  $('#libraryList').addEventListener('click', event => {
    const row = event.target.closest('[data-library-path]');
    if (!row || row.disabled) return;
    switchToLibrary(row.dataset.libraryPath, row.dataset.libraryName);
  });
  renderShellAppSection();
  $('#shellAppSection').addEventListener('click', event => {
    const row = event.target.closest('[data-shell-action]');
    if (row) runShellAppAction(row.dataset.shellAction);
  });
  $('#paneLayoutButton').addEventListener('click', event => {
    event.stopPropagation();
    const popover = $('#paneLayoutPopover');
    const opening = popover.classList.contains('hidden');
    popover.classList.toggle('hidden');
    if (opening) {
      positionPaneLayoutPopover();
      const syncCb = $('#syncPanesCheckbox');
      if (syncCb) syncCb.checked = syncPanesEnabled;
    }
    $('#paneLayoutButton').setAttribute('aria-expanded', String(!popover.classList.contains('hidden')));
    for (const option of popover.querySelectorAll('[data-layout]')) option.classList.toggle('active', option.dataset.layout === $('#paneLayout').dataset.layout);
  });
  $('#syncPanesCheckbox')?.addEventListener('change', event => {
    setSyncPanesEnabled(event.target.checked, { notify: true });
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
    if (!name && !state.folderDialogAllowEmpty) { $('#folderNameInput').focus(); return; }
    closeFolderDialog(name);
  });
  $('#folderDialogCancelButton').addEventListener('click', () => closeFolderDialog());
  $('#folderDialogPalette').addEventListener('click', event => {
    const swatch = event.target.closest('[data-tag-palette-color]');
    if (swatch) closeFolderDialog(swatch.dataset.tagPaletteColor);
  });
  $('#folderDialog').addEventListener('click', event => {
    if (event.target === event.currentTarget) closeFolderDialog();
  });
  for (const binding of filterInputBindings) {
    $(binding.selector).addEventListener(binding.event, event => {
      const paneId = state.activePaneId;
      const pane = paneById(paneId);
      if (!pane) return;
      const parsed = binding.parse ? binding.parse(event.target.value) : event.target.value;
      pane.query[binding.key] = binding.part
        ? normalizeQueryRange({ ...pane.query[binding.key], [binding.part]: parsed })
        : parsed;
      renderFilterState();
      schedulePaneFilterRefresh(paneId);
    });
  }
  for (const kind of Object.keys(tagEditors)) bindTagEditor(kind);
  $('#colorFilter').addEventListener('click', event => {
    const swatch = event.target.closest('[data-filter-color]');
    if (!swatch) return;
    const paneId = state.activePaneId;
    const pane = paneById(paneId);
    if (!pane) return;
    pane.query.color = swatch.dataset.filterColor || '';
    renderColorFilter();
    renderFilterState();
    schedulePaneFilterRefresh(paneId);
  });
  $('#filterPopover').addEventListener('click', event => {
    const logic = event.target.closest('[data-logic-value]');
    if (logic) {
      const key = logic.closest('[data-filter-logic]').dataset.filterLogic;
      updateActiveQuery(query => { query[key] = logic.dataset.logicValue; });
      return;
    }
    const folder = event.target.closest('[data-filter-folder]');
    if (folder) return updateActiveQuery(query => toggleIncludeExclude(query, 'folderInclude', 'folderExclude', folder.dataset.filterFolder, false));
    const ext = event.target.closest('[data-filter-ext]');
    if (ext) return updateActiveQuery(query => toggleIncludeExclude(query, 'ext', 'extExclude', ext.dataset.filterExt, false));
    const preset = event.target.closest('[data-date-preset]');
    if (preset) {
      const key = `${preset.closest('[data-date-presets]').dataset.datePresets}Presets`;
      return updateActiveQuery(query => toggleListValue(query, key, preset.dataset.datePreset));
    }
    const month = event.target.closest('[data-filter-month]');
    if (month) {
      const key = `${month.closest('[data-month-list]').dataset.monthList}Months`;
      return updateActiveQuery(query => toggleListValue(query, key, month.dataset.filterMonth));
    }
    const comments = event.target.closest('[data-comments-state]');
    if (comments) {
      updateActiveQuery(query => { query.comments = query.comments === comments.dataset.commentsState ? '' : comments.dataset.commentsState; });
      if (state.query.comments === 'has') $('#commentsTextFilter').focus();
      return;
    }
    const shape = event.target.closest('[data-filter-shape]');
    if (shape) {
      updateActiveQuery(query => toggleListValue(query, 'shape', shape.dataset.filterShape));
      if (shape.dataset.filterShape === 'custom' && state.query.shape.includes('custom')) $('#shapeWidthFilter').focus();
      return;
    }
    const rating = event.target.closest('[data-filter-rating]');
    if (rating) return updateActiveQuery(query => toggleListValue(query, 'rating', Number(rating.dataset.filterRating)));
    // 有/没有 exclude each other; clicking the lit one clears the filter
    // (Eagle's note.has / note.no).
    const textState = event.target.closest('[data-text-state]');
    if (textState) {
      const [field, value] = textState.dataset.textState.split(':');
      updateActiveQuery(query => {
        const current = query[`${field}State`] || (String(query[field] || '').trim() ? 'has' : '');
        query[`${field}State`] = current === value ? '' : value;
        // Off clears the keywords too: on their own they would read as 有.
        if (current === value) query[field] = '';
      });
      if (state.query[`${field}State`] === 'has') $(`#${field}Filter`).focus();
    }
  });
  $('#filterPopover').addEventListener('contextmenu', event => {
    const folder = event.target.closest('[data-filter-folder]');
    const ext = event.target.closest('[data-filter-ext]');
    if (!folder && !ext) return;
    event.preventDefault();
    event.stopPropagation();
    if (folder) updateActiveQuery(query => toggleIncludeExclude(query, 'folderInclude', 'folderExclude', folder.dataset.filterFolder, true));
    else updateActiveQuery(query => toggleIncludeExclude(query, 'ext', 'extExclude', ext.dataset.filterExt, true));
  });
  $('#noTagsFilter').addEventListener('change', event => updateActiveQuery(query => { query.noTags = event.target.checked; }));
  $('#folderFilterSearch').addEventListener('input', renderFolderFilterList);
  $('#extFilterSearch').addEventListener('input', renderExtFilterList);
  // The numbers stay and are read in the new unit, as in Eagle.
  $('#durationUnitFilter').addEventListener('change', event => updateActiveQuery(query => {
    const before = durationUnitSeconds[query.durationUnit] || 1;
    const after = durationUnitSeconds[event.target.value] || 1;
    query.durationUnit = event.target.value;
    if (query.duration) {
      const scale = value => (Number.isFinite(value) ? value / before * after : null);
      query.duration = normalizeQueryRange({ min: scale(query.duration.min), max: scale(query.duration.max) });
    }
  }));
  $('#sizeSlider').addEventListener('input', event => applyThumbnailSize(event.target.value));
  $('#folderTree').addEventListener('click', event => {
    // A long-press just opened the menu; its synthetic click must not also
    // navigate away from the folder the user was acting on.
    if (Date.now() < suppressTouchClickUntil) return;
    const toggle = event.target.closest('[data-toggle-folder]');
    if (toggle) { event.stopPropagation(); toggleFolder(toggle.dataset.toggleFolder); return; }
    const row = event.target.closest('.folder-row');
    if (row) navigate(descriptorFromTarget(row));
  });
  $('.sidebar').addEventListener('contextmenu', event => {
    event.preventDefault();
    // Touch long-press menus are driven by bindTouchLongPress; swallow the
    // browser's own long-press contextmenu so it cannot double-open.
    if (touchLongPressActive || Date.now() < suppressTouchClickUntil) return;
    openSidebarContextMenu(event.target, { x: event.clientX, y: event.clientY });
  });
  // Touch has no right-click: without this, phones and tablets cannot reach
  // rename / new subfolder / delete at all — a tap just navigates.
  bindTouchLongPress($('.sidebar'), {
    selector: '.folder-row, #folderTree',
    onLongPress: (target, point) => {
      navigator.vibrate?.(10);
      openSidebarContextMenu(target, point);
    }
  });
  $('#contextMenu').addEventListener('click', event => {
    const row = event.target.closest('[data-context-action]');
    if (!row) {
      const submenu = event.target.closest('.has-submenu');
      if (submenu) {
        // Inline submenus need a way back: on a sheet the row toggles, unless
        // the tap landed inside the open submenu itself. Hover still drives
        // this on a pointer, where closing is just moving away.
        if (isCompactLayout() && !event.target.closest('.context-submenu')) {
          submenu.classList.toggle('submenu-open');
          if (submenu.classList.contains('submenu-open')) {
            requestAnimationFrame(() => submenu.scrollIntoView({ block: 'nearest' }));
          }
        } else {
          submenu.classList.add('submenu-open');
          placeContextSubmenu(submenu);
        }
        submenu.querySelector('.context-picker-search')?.focus();
      }
      return;
    }
    if (row.classList.contains('disabled')) return;
    let payload = {};
    try { payload = JSON.parse(row.dataset.contextPayload || '{}'); } catch {}
    const execution = executeContextAction(row.dataset.contextAction, payload);
    if (row.dataset.keepOpen === 'true') {
      execution.then(checked => {
        if (typeof checked !== 'boolean') return;
        row.classList.toggle('checked', checked);
        row.setAttribute('aria-checked', String(checked));
        row.querySelector('.context-menu-leading').innerHTML = checked ? '<span class="context-menu-check" aria-hidden="true">✓</span>' : '';
      }).catch(error => toast(`操作失败：${error.message}`, 4000));
      return;
    }
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
    // Only entering the row itself places its submenu. Entering something
    // inside an open submenu must not move it: a filtered picker would slide
    // away from under the pointer and the whole menu would close.
    const row = event.target.closest('.has-submenu');
    if (!row || event.target !== row) return;
    row.classList.add('submenu-open');
    placeContextSubmenu(row);
  }, true);
  $('#contextMenu').addEventListener('scroll', () => {
    for (const row of $('#contextMenu').querySelectorAll('.has-submenu.submenu-open')) placeContextSubmenu(row);
  });
  $('#contextMenu').addEventListener('mouseleave', event => {
    const row = event.target.closest('.has-submenu');
    if (row && !row.contains(event.relatedTarget)) row.classList.remove('submenu-open');
  }, true);
  document.addEventListener('click', event => {
    // The synthetic click that ends a touch long-press must not dismiss the
    // menu that same long-press just opened. Cards were exempted by selector;
    // the folder tree and the pane heading need the shared timestamp.
    if (Date.now() < suppressTouchClickUntil) return;
    // The inspector's 添加文件夹 opens the folder picker with this very click.
    if (!clickWithin(event, '#contextMenu, .item-card, #newButton, .new-window-control, [data-add-folder]')) hideContextMenu();
  });
  for (const selector of ['#itemName', '#itemURL']) {
    $(selector).addEventListener('input', markDirty);
    $(selector).addEventListener('blur', () => queueInspectorAutoSave({ immediate: true }));
  }
  for (const selector of ['#itemName', '#itemURL', '#itemAnnotation']) {
    const control = $(selector);
    control.addEventListener('compositionstart', () => {
      inspectorComposingControls.add(control);
      clearInspectorAutoSave();
      captureInspectorDraft();
    });
    control.addEventListener('compositionend', () => {
      inspectorComposingControls.delete(control);
      markDirty();
    });
  }
  $('#itemURL').addEventListener('input', updateURLActions);
  $('#openURLButton').addEventListener('click', async () => {
    // The button is disabled for non-http values and main re-checks the
    // scheme, so no third validation here.
    try {
      await window.eagleMV.openExternal($('#itemURL').value.trim());
    } catch (error) {
      toast(`打开来源失败：${error.message}`, 4000);
    }
  });
  $('#copyURLButton').addEventListener('click', async () => {
    const url = $('#itemURL').value.trim();
    if (!url) return;
    await copyTextWithFeedback(url, '已复制来源网址', 2000);
  });
  $('#itemStars').addEventListener('click', event => {
    const star = event.target.closest('[data-inspector-star]');
    if (!star) return;
    const select = $('#itemRating');
    select.value = String(nextStarRating(select.value, star.dataset.inspectorStar));
    select.dispatchEvent(new Event('change'));
  });
  $('#itemRating').addEventListener('change', () => {
    syncRatingPlaceholder();
    markDirty();
    queueInspectorAutoSave({ immediate: true });
  });
  bindCategoryInspector();
  bindCardDisplayControls();
  $('#itemAnnotation').addEventListener('input', () => { resizeAnnotation(); markDirty(); });
  $('#itemAnnotation').addEventListener('blur', () => queueInspectorAutoSave({ immediate: true }));
  $('#itemPalette').addEventListener('click', event => {
    const swatch = event.target.closest('.palette-swatch');
    if (!swatch) return;
    if (event.altKey) {
      // Eagle filters by a dominant color from the palette; plain click keeps
      // the verified copy behaviour, ⌥click applies the color filter.
      const paneId = state.activePaneId;
      const pane = paneById(paneId);
      if (!pane) return;
      pane.query.color = swatch.dataset.color;
      renderQueryControls();
      schedulePaneFilterRefresh(paneId);
      toast(`按主色筛选 ${swatch.dataset.color}`, 2200);
      return;
    }
    copyTextWithFeedback(swatch.dataset.color, `已复制颜色 ${swatch.dataset.color}`, 1600);
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
    // Judged on the loaded items: a ⌘A past the loaded range holds ids
    // whose items the grid never read (P6-02).
    const loaded = ids.map(itemById).filter(Boolean);
    const restore = loaded.length > 0 && loaded.every(item => item.isDeleted);
    setTrash(ids, !restore);
  });
  $('#sharedTagChips').addEventListener('click', event => {
    const button = event.target.closest('[data-remove-shared-tag]');
    if (button) removeTagFromSelection(button.dataset.removeSharedTag);
  });
  $('#batchStars').addEventListener('click', event => {
    const star = event.target.closest('[data-inspector-star]');
    const ids = [...state.selected];
    if (!star || ids.length < 2 || !confirmBulkEdit(ids.length)) return;
    setSelectionRating({ ids, rating: nextStarRating(event.currentTarget.dataset.rating, star.dataset.inspectorStar) });
  });
  $('#itemFolderChips').addEventListener('click', event => handleInspectorFolderClick(event));
  $('#batchFolderChips').addEventListener('click', event => handleInspectorFolderClick(event));
  $('#itemExportButton').addEventListener('click', openInspectorExportMenu);
  $('#batchExportButton').addEventListener('click', openInspectorExportMenu);
  bindInspectorSections();
  for (const [field, selector] of [['annotation', '#batchAnnotation'], ['url', '#batchURL']]) {
    const control = $(selector);
    control.addEventListener('focus', () => beginBatchFieldEdit(field, control));
    control.addEventListener('blur', () => commitBatchFieldEdit(field, control));
    control.addEventListener('keydown', event => {
      // Return applies a link; a note takes newlines like the single field.
      if (field === 'url' && event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        control.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (batchFieldEdit?.field === field) control.value = batchFieldEdit.original;
        batchFieldEdit = null;
        control.blur();
      }
    });
  }
  $('#batchAnnotation').addEventListener('input', event => resizeTextarea(event.target));
  $('#previewBox').addEventListener('click', () => { const id = [...state.selected][0]; if (id) openPreview(id); });
  $('#closePreview').addEventListener('click', closePreview);
  $('#slideshowToggle').addEventListener('click', event => {
    event.stopPropagation();
    toggleSlideshow();
  });
  $('#slideshowInterval').addEventListener('change', event => {
    state.slideshow.intervalMs = Number(event.target.value) || 4000;
    try { localStorage.setItem(SLIDESHOW_INTERVAL_KEY, String(state.slideshow.intervalMs)); } catch {}
    // Take effect on the picture currently showing, not only the next one.
    if (slideshowPlaying()) scheduleSlideshowStep();
  });
  $('#slideshowControls').addEventListener('click', event => event.stopPropagation());
  $('#previewBackground').addEventListener('click', cyclePreviewBackground);
  $('#previewGrayscale').addEventListener('click', togglePreviewGrayscale);
  $('#modalRating').addEventListener('click', event => {
    event.stopPropagation();
    const star = event.target.closest('[data-preview-rating]');
    if (!star) return;
    const value = Number(star.dataset.previewRating);
    // Clicking the star that is already lit clears the rating, as Eagle does.
    ratePreviewItem(value === Number(event.currentTarget.dataset.rating || 0) ? 0 : value);
  });
  $('#modalMedia').addEventListener('wheel', event => {
    if (!previewImage()) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    const anchor = { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 };
    changePreviewZoom(event.deltaY < 0 ? .15 : -.15, anchor);
  }, { passive: false });
  // Preview pointers: one finger/mouse pans a zoomed image, two fingers pinch
  // to zoom around their midpoint (works from fit mode too). In fit mode a
  // single finger swipes: horizontal switches items, downward closes.
  const previewPointers = new Map();
  let pinchBase = null;
  let swipeSession = null;
  let swipeClickSuppressUntil = 0;
  const settleSwipe = event => {
    const session = swipeSession;
    if (!session || event.pointerId !== session.pointerId) return;
    swipeSession = null;
    const image = previewImage();
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (Math.hypot(dx, dy) > 15) swipeClickSuppressUntil = Date.now() + 400;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      movePreview(dx < 0 ? 1 : -1);
      return;
    }
    if (dy > 90 && dy > Math.abs(dx) * 1.4) {
      closePreview();
      return;
    }
    if (image) {
      image.style.transition = 'transform .18s ease';
      image.style.transform = '';
      setTimeout(() => {
        if (image.isConnected) image.style.transition = '';
      }, 220);
    }
  };
  const pinchGeometry = () => {
    const [first, second] = [...previewPointers.values()];
    return {
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      centerX: (first.x + second.x) / 2,
      centerY: (first.y + second.y) / 2
    };
  };
  $('#previewModal').addEventListener('pointerdown', event => {
    const image = previewImage();
    // Gestures belong to whatever claims the image slot — including the
    // "file is missing" placeholder, which does not scroll. Only the visual
    // feedback needs a real image; without one the swipe still navigates.
    if (!$('#previewModal').classList.contains('image-gesture')) return;
    // The modal owns the gesture surface, but capturing the pointer here would
    // steal the tap from the controls sitting on top of it.
    if (event.target.closest('#slideshowControls, #modalRating')) return;
    if (isPreviewTouchPointer(event)) {
      previewPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      event.currentTarget.setPointerCapture(event.pointerId);
      if (previewPointers.size === 2) {
        if (!image) return;
        state.previewZoom.dragging = false;
        if (swipeSession) {
          swipeSession = null;
          image.style.transform = '';
        }
        pinchBase = { ...pinchGeometry(), scale: state.previewZoom.mode === 'fit' ? 1 : state.previewZoom.scale };
        return;
      }
      if (!image || state.previewZoom.mode === 'fit') {
        swipeSession = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
        return;
      }
    }
    if (!image || event.button !== 0) return;
    event.preventDefault();
    state.previewZoom.dragging = true;
    state.previewZoom.startX = event.clientX;
    state.previewZoom.startY = event.clientY;
    state.previewZoom.originX = state.previewZoom.x;
    state.previewZoom.originY = state.previewZoom.y;
    event.currentTarget.setPointerCapture(event.pointerId);
    renderPreviewZoom();
  });
  $('#previewModal').addEventListener('pointermove', event => {
    if (swipeSession && event.pointerId === swipeSession.pointerId && previewPointers.size === 1 && state.previewZoom.mode === 'fit') {
      previewPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const image = previewImage();
      if (image) image.style.transform = `translateX(${event.clientX - swipeSession.startX}px)`;
      return;
    }
    if (previewPointers.has(event.pointerId)) {
      previewPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (previewPointers.size === 2 && pinchBase) {
        const current = pinchGeometry();
        if (pinchBase.distance > 0 && current.distance > 0) {
          const box = $('#modalMedia').getBoundingClientRect();
          const anchor = { x: current.centerX - box.left - box.width / 2, y: current.centerY - box.top - box.height / 2 };
          const targetScale = Math.max(.25, Math.min(6, pinchBase.scale * (current.distance / pinchBase.distance)));
          changePreviewZoom(targetScale - (state.previewZoom.mode === 'fit' ? 1 : state.previewZoom.scale), anchor);
        }
        return;
      }
    }
    if (!state.previewZoom.dragging) return;
    state.previewZoom.x = state.previewZoom.originX + event.clientX - state.previewZoom.startX;
    state.previewZoom.y = state.previewZoom.originY + event.clientY - state.previewZoom.startY;
    renderPreviewZoom();
  });
  const releasePreviewPointer = event => {
    settleSwipe(event);
    if (previewPointers.delete(event.pointerId) && previewPointers.size < 2) pinchBase = null;
    if (!state.previewZoom.dragging) return;
    state.previewZoom.dragging = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    renderPreviewZoom();
  };
  $('#previewModal').addEventListener('pointerup', releasePreviewPointer);
  $('#previewModal').addEventListener('pointercancel', releasePreviewPointer);

  document.addEventListener('paste', event => {
    if (Date.now() < state.suppressPasteUntil) {
      event.preventDefault();
      return;
    }
    const editable = isEditableElement(event.target) || isEditableElement() || state.inspectorEditing;
    if (editable || blockingSurfaceOpen() || !$('#previewModal').classList.contains('hidden')) return;
    if (!hasCapability('importLocal')) return;
    const clipboardFiles = [...(event.clipboardData?.files || [])];
    const paths = clipboardFiles.map(file => window.eagleMV.pathForFile(file)).filter(Boolean);
    const clipboardText = event.clipboardData?.getData('text/plain') || '';
    if (window.eagleMV.platform === 'web') {
      // The web client can only upload files present in the browser paste
      // event; the host-clipboard fallback is meaningless remotely.
      if (!clipboardFiles.length) return;
      event.preventDefault();
      importFiles(clipboardFiles, 'paste-files');
      return;
    }
    event.preventDefault();
    importFiles(paths.length ? paths : null, paths.length ? 'paste-files' : 'clipboard', { clipboardText });
  });

  document.addEventListener('focusin', event => {
    if (isInspectorEditor(event.target)) state.inspectorEditing = true;
    else if (event.target.closest?.('#generationMetadataSection')) state.inspectorEditing = false;
    else if (!event.target.closest?.('#inspectorContent')) state.inspectorEditing = false;
  });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest?.('#inspectorContent')) state.inspectorEditing = false;
    if (!event.target.closest?.('#generationMetadataSection')) metadataViewerFocused = false;
  }, true);

  document.addEventListener('keydown', event => {
    // event.target is the most reliable source; activeElement is retained for
    // synthetic/app-menu events. inspectorEditing is a final safety net if a
    // browser or future render unexpectedly blurs the editor between keys.
    if (document.querySelector('.web-copy-dialog[open], .feature-dialog[open]')) return;
    const editable = isEditableElement(event.target) || isEditableElement() || state.inspectorEditing;
    const previewOpen = !$('#previewModal').classList.contains('hidden');
    if (!editable && !blockingSurfaceOpen() && !event.defaultPrevented &&
        event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey &&
        (event.code === 'KeyS' || event.key.toLowerCase() === 's')) {
      event.preventDefault();
      if (!event.repeat && !event.isComposing && event.keyCode !== 229) {
        setSyncPanesEnabled(!syncPanesEnabled, { notify: true });
      }
      return;
    }
    if (event.key === 'Escape') {
      // Already handled: a control's own Esc (tag suggestions, path editing),
      // an IME composition, or a native modal <dialog>'s cancel.
      if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return;
      // Esc peels off the topmost surface the way back does — dialogs and
      // menus, then the filter, library and layout popovers, the tag colour
      // manager and drawers — before it touches the preview or the selection.
      if (closeTopTransientSurface({ selection: false })) { event.preventDefault(); return; }
      if (previewOpen) { event.preventDefault(); closePreview(); return; }
      // Off Apple platforms an unconsumed Esc in a text field reaches the
      // Android shell as system Back and can close the app; leave the field
      // instead (blur also autosaves TXT), so the next Esc goes back.
      const field = isEditableElement(event.target) ? event.target : (isEditableElement() ? document.activeElement : null);
      if (field && !keyboardPlatform.apple && !event.defaultPrevented) {
        event.preventDefault();
        field.blur();
        return;
      }
      if (!editable && (state.selected.size || state.selectedFolderCard)) {
        // Consumed even when the discard prompt declines: an unconsumed Esc
        // becomes system Back in the Android shell and would also navigate.
        event.preventDefault();
        if (confirmDiscardChanges()) {
          state.selected.clear();
          state.selectedFolderCard = null;
          updateCardSelectionStyles();
          renderInspector();
        }
      }
      return;
    }
    if (!editable && (event.altKey || event.ctrlKey) && event.key === 'ArrowLeft') {
      event.preventDefault();
      requestBackAction();
      return;
    }
    if (!editable && keyboardPlatform.primaryKey(event) && event.key === '[') {
      event.preventDefault();
      requestBackAction();
      return;
    }
    // Do not let global shortcuts act on the obscured workspace. In
    // particular, a second Delete while the trash prompt is open can replace
    // its resolver and leave the first operation waiting forever.
    if (blockingSurfaceOpen()) return;
    if (!editable && keyboardPlatform.primaryKey(event) && !keyboardPlatform.otherKey(event) && !event.shiftKey && !event.altKey && !event.repeat && !event.isComposing) {
      const layout = { Digit1: 'single', Digit2: 'vertical2', Digit3: 'vertical3', Digit4: 'vertical4' }[event.code];
      if (layout) {
        event.preventDefault();
        renderPaneLayout(layout, { refresh: true });
        return;
      }
    }
    const primaryKey = event.metaKey || event.ctrlKey;
    const selectedIds = selectedActionIds();
    const activeItemId = previewOpen && state.previewId ? state.previewId : selectedIds[0];
    const deleteKey = event.key === 'Backspace' || event.key === 'Delete';
    if (!editable && hasCapability('finder') && primaryKey && !event.shiftKey && !event.altKey && event.key === 'Enter' && activeItemId) {
      event.preventDefault();
      showItemInFileManager(activeItemId);
      return;
    }
    if (!editable && hasCapability('copyPath') && primaryKey && !event.shiftKey && event.altKey && event.key.toLowerCase() === 'c' && activeItemId) {
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
    if (!editable && !previewOpen && primaryKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undoLastTrash();
      return;
    }
    if (!editable && !previewOpen && primaryKey && !event.shiftKey && !event.altKey && deleteKey && selectedIds.length) {
      event.preventDefault();
      setTrash(selectedIds, true);
      return;
    }
    if (!editable && !previewOpen && primaryKey && !event.shiftKey && !event.altKey && deleteKey && !event.repeat && requestFolderRemovalShortcut()) {
      event.preventDefault();
      return;
    }
    // In an image preview ⌘+/⌘− zoom the image and ⌘0 switches between 原始大小
    // and fit, as in Eagle (view.zoom.actual is CmdOrCtrl+0 there).
    if (!editable && previewOpen && previewImage() && primaryKey && !event.altKey) {
      if (event.code === 'Equal' || event.code === 'NumpadAdd') { event.preventDefault(); changePreviewZoom(.25); return; }
      if (event.code === 'Minus' || event.code === 'NumpadSubtract') { event.preventDefault(); changePreviewZoom(-.25); return; }
      if (event.code === 'Digit0' || event.code === 'Numpad0') { event.preventDefault(); setPreviewZoom(state.previewZoom.mode === 'actual' ? 'fit' : 'actual'); return; }
    }
    if ((!editable || metadataViewerIsFocused(event)) && (event.metaKey || event.ctrlKey) && !event.altKey) {
      if (metadataViewerIsFocused(event) && (!event.shiftKey || event.code === 'Equal' || event.code === 'NumpadAdd')) {
        if (event.code === 'Equal' || event.code === 'NumpadAdd') { event.preventDefault(); changeMetadataZoom(1); return; }
        if (event.code === 'Minus' || event.code === 'NumpadSubtract') { event.preventDefault(); changeMetadataZoom(-1); return; }
        if (event.code === 'Digit0' || event.code === 'Numpad0') { event.preventDefault(); resetMetadataZoom(); return; }
      }
      if (event.code === 'Equal' || event.code === 'NumpadAdd') { event.preventDefault(); changeThumbnailSize(1); return; }
      if (event.code === 'Minus' || event.code === 'NumpadSubtract') { event.preventDefault(); changeThumbnailSize(-1); return; }
      if (event.code === 'Digit0' || event.code === 'Numpad0') { event.preventDefault(); resetThumbnailSize(); return; }
    }
    if (!editable && !previewOpen && primaryKey && !event.shiftKey && event.altKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      requestDefaultNewWindow();
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
    if (!editable && !previewOpen && !event.shiftKey && !event.altKey &&
        ((primaryKey && event.key.toLowerCase() === 'r') ||
         (!primaryKey && event.key === 'F2'))) {
      event.preventDefault();
      requestRenameSelection().catch(error => toast(`重命名失败：${error.message}`, 4000));
      return;
    }
    if (primaryKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); $('#searchInput').focus(); }
    if (!editable && keyboardPlatform.primaryKey(event) && event.shiftKey && event.key.toLowerCase() === 'l') { event.preventDefault(); togglePanel('sidebar'); }
    if (!editable && keyboardPlatform.primaryKey(event) && event.shiftKey && event.key.toLowerCase() === 'i') { event.preventDefault(); togglePanel('inspector'); }
    if (!editable && event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); locateCurrentFolder(); }
    if (!editable && hasCapability('openDefault') && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'Enter' && (state.previewId || state.selected.size === 1)) {
      event.preventDefault();
      openWithDefault(state.previewId || [...state.selected][0]);
      return;
    }
    // Enter and Space on a keyboard-focused button or link activate it (B3-05);
    // a button that merely kept focus after a mouse click does not count, so
    // Space after clicking a toolbar button still opens or closes the preview.
    const keyboardControl = Boolean(event.target?.closest?.(KEYBOARD_ACTIVATED_CONTROLS) && event.target.matches?.(':focus-visible'));
    if (!editable && !keyboardControl && !previewOpen && !primaryKey && !event.shiftKey && !event.altKey && event.key === 'Enter' && state.selectedFolderCard) { event.preventDefault(); enterFolderFromGrid(state.selectedFolderCard); }
    else if (!editable && !keyboardControl && !previewOpen && !primaryKey && !event.shiftKey && !event.altKey && event.key === 'Enter' && state.selected.size === 1) { event.preventDefault(); openPreview([...state.selected][0]); }
    if (!editable && previewOpen && !primaryKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      toggleSlideshow();
      return;
    }
    if (!editable && previewOpen && !primaryKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      cyclePreviewBackground();
      return;
    }
    if (!editable && previewOpen && !primaryKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'g') {
      event.preventDefault();
      togglePreviewGrayscale();
      return;
    }
    if (!editable && !keyboardControl && event.code === 'Space' && previewOpen) {
      event.preventDefault();
      // Eagle: space toggles playback while a video/audio preview is open;
      // for stills it keeps closing the preview.
      const media = $('#modalMedia video, #modalMedia audio');
      if (media) media.paused ? media.play().catch(() => {}) : media.pause();
      else closePreview();
    } else if (!editable && !keyboardControl && event.code === 'Space' && state.selected.size) {
      event.preventDefault();
      const first = firstSelectedInViewOrder();
      if (first) {
        openPreview(first.id);
        broadcastPaneAction(() => {
          const siblingFirst = firstSelectedInViewOrder();
          if (siblingFirst) openPreview(siblingFirst.id);
        });
      }
    }
    if (!editable && primaryKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o' && (state.previewId || state.selected.size === 1)) {
      event.preventDefault();
      openSelectionInNewWindow([state.previewId || [...state.selected][0]]);
      return;
    }
    if (!editable && primaryKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a') {
      const selection = window.getSelection?.();
      const hasTextSelection = Boolean(selection && !selection.isCollapsed && selection.toString().length > 0);
      if (hasTextSelection || event.target?.closest?.('#generationMetadataSection, .generation-metadata')) return;
      event.preventDefault();
      selectAllItems();
    }
    // In the preview ⌘C copies the item on screen, like ⌘⌥C and ⌘Enter do:
    // Eagle's preview moves the selection along as it pages, so its ⌘C
    // always means the viewed item (B3-01).
    const copyIds = selectedActionIds({ includePreview: previewOpen });
    if (!editable && hasCapability('clipboardFiles') && !event.shiftKey && !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && copyIds.length) {
      const selection = window.getSelection?.();
      const hasTextSelection = Boolean(selection && !selection.isCollapsed && selection.toString().length > 0);
      if (!hasTextSelection) {
        event.preventDefault();
        copySelectedFiles(copyIds).catch(error => toast(`复制失败：${error.message}`, 4000));
      }
    }
    if (!editable && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && !previewOpen && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      if (event.shiftKey) {
        // ⇧← ⇧→ grow or shrink the run (P6-04); ⇧↑ ⇧↓ do the same in the
        // list layout and nothing in the grid layouts, as in Eagle.
        const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
        if (horizontal || state.viewMode === 'list') stepSelectionByKey(event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1);
      } else {
        moveCardFocus(event.key);
      }
    }
    if (!editable && (event.altKey || event.ctrlKey) && event.key === 'ArrowUp') { event.preventDefault(); navigateUp(); }
    if (!editable && (event.altKey || event.ctrlKey) && event.key === 'ArrowRight') { event.preventDefault(); navigateHistory(1); }
    if (!editable && keyboardPlatform.primaryKey(event) && event.key === ']') { event.preventDefault(); navigateHistory(1); }
    if (!editable && !previewOpen && ['PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      scrollGridByKey(event.key);
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !state.textSession && state.inspectorDirty) {
      event.preventDefault();
      saveInspector();
    }
    if (previewOpen && !editable && !primaryKey && !event.shiftKey && !event.altKey &&
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'ArrowLeft') {
        movePreview(-1);
        broadcastPaneAction(pane => { if (pane.previewId) movePreview(-1); });
      } else if (event.key === 'ArrowRight') {
        movePreview(1);
        broadcastPaneAction(pane => { if (pane.previewId) movePreview(1); });
      } else {
        movePreviewVertically(event.key);
        broadcastPaneAction(pane => { if (pane.previewId) movePreviewVertically(event.key); });
      }
      return;
    }
    if (!editable && !primaryKey && !event.altKey && !event.shiftKey && /^[0-5]$/.test(event.key) && (previewOpen || state.selected.size)) {
      event.preventDefault();
      // While previewing, the number keys rate what is on screen; the grid
      // selection is not necessarily the same item (a touch tap previews
      // without selecting).
      const rating = Number(event.key);
      if (previewOpen) {
        ratePreviewItem(rating);
      } else {
        setSelectionRating({ ids: [...state.selected], rating });
      }
      return;
    }
    if (deleteKey && !editable && !previewOpen && !primaryKey && !event.shiftKey && !event.altKey && state.selected.size) setTrash([...state.selected], true);
  });
}

// --- Web access settings (desktop only; the menu triggers command:web-access)
// What the host last reported, to tell unapplied edits apart (F-08).
let webAccessApplied = null;
function webAccessFormValues() {
  return { enabled: $('#webAccessEnabled').checked, port: String($('#webAccessPort').value).trim(), requireKey: !$('#webAccessNoKey').checked };
}

function closeWebAccessDialog() {
  const form = webAccessFormValues();
  if (webAccessApplied && !$('#webAccessDialog').classList.contains('hidden')
      && (form.enabled !== webAccessApplied.enabled || form.port !== webAccessApplied.port || form.requireKey !== webAccessApplied.requireKey)
      && !confirm('有尚未应用的修改，关闭后将放弃。仍要关闭？')) return false;
  $('#webAccessDialog').classList.add('hidden');
  return true;
}

function renderWebAccessStatus(status) {
  if (!status) {
    $('#webAccessStatus').textContent = '无法读取 Web 访问状态';
    return;
  }
  $('#webAccessEnabled').checked = Boolean(status.enabled);
  $('#webAccessPort').value = String(status.port || 41600);
  $('#webAccessKey').textContent = status.key || '启用后自动生成';
  $('#webAccessCopyKey').disabled = !status.key;
  $('#webAccessNoKey').checked = status.requireKey === false;
  webAccessApplied = webAccessFormValues();
  const addresses = $('#webAccessAddresses');
  if (status.running && status.addresses?.length) {
    addresses.innerHTML = status.addresses.map((entry, index) => `
      <div class="web-access-address-group">
        <button type="button" class="web-access-address" data-url="${escapeHTML(entry.url)}" title="点击复制地址">
          <span class="web-access-url">${escapeHTML(entry.url)}</span>
          <span class="web-access-net">${entry.tailscale ? 'Tailscale' : escapeHTML(entry.interface)}</span>
        </button>
        ${entry.qrSVG ? `<button type="button" class="web-access-qr-toggle" data-qr-index="${index}" title="显示二维码，手机扫码直达">二维码</button>` : ''}
        ${entry.qrSVG ? `<div class="web-access-qr hidden" data-qr-panel="${index}">${entry.qrSVG}</div>` : ''}
      </div>`).join('');
  } else {
    addresses.innerHTML = '';
  }
  $('#webAccessStatus').textContent = status.error
    ? `启动失败：${status.error}`
    : status.running
      ? `运行中 · 端口 ${status.port} · ${status.clientCount || 0} 个网页端连接`
      : '未运行';
}

async function openWebAccessDialog() {
  if (!hasCapability('webAccess')) return;
  $('#webAccessDialog').classList.remove('hidden');
  $('#webAccessStatus').textContent = '正在读取…';
  $('#webAccessAddresses').innerHTML = '';
  try {
    renderWebAccessStatus(await window.eagleMV.getWebAccess());
  } catch (error) {
    $('#webAccessStatus').textContent = `无法读取 Web 访问状态：${error.message}`;
  }
}

function bindWebAccessDialog() {
  $('#webAccessCloseButton').addEventListener('click', closeWebAccessDialog);
  $('#webAccessDialog').addEventListener('mousedown', event => {
    if (event.target === $('#webAccessDialog')) closeWebAccessDialog();
  });
  $('#webAccessSaveButton').addEventListener('click', async () => {
    const button = $('#webAccessSaveButton');
    const form = webAccessFormValues();
    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      toast('端口需为 1024–65535 之间的整数', 3600);
      $('#webAccessPort').focus();
      return;
    }
    if (form.enabled && !form.requireKey && webAccessApplied?.requireKey !== false
        && !confirm('免密访问后，同一网络里的任何设备都能读写整个资源库。确定开启？')) return;
    button.disabled = true;
    try {
      const status = await window.eagleMV.setWebAccess({
        enabled: form.enabled,
        port,
        requireKey: form.requireKey
      });
      renderWebAccessStatus(status);
      if (status?.error) toast(`Web 服务启动失败：${status.error}`, 4600);
      else toast(status?.enabled ? 'Web 访问已开启' : 'Web 访问已关闭');
    } catch (error) {
      toast(`保存失败：${error.message}`, 4600);
    } finally {
      button.disabled = false;
    }
  });
  $('#webAccessResetKey').addEventListener('click', async () => {
    if (!confirm('重置访问密钥？所有已登录的网页端会立即掉线，需要用新密钥重新登录。')) return;
    try {
      renderWebAccessStatus(await window.eagleMV.resetWebAccessKey());
      toast('访问密钥已重置');
    } catch (error) {
      toast(`重置失败：${error.message}`, 4600);
    }
  });
  $('#webAccessCopyKey').addEventListener('click', async () => {
    const key = $('#webAccessKey').textContent;
    if (!key || key.includes('生成')) return;
    await copyTextWithFeedback(key, '访问密钥已复制');
  });
  $('#webAccessAddresses').addEventListener('click', async event => {
    const qrToggle = event.target.closest('[data-qr-index]');
    if (qrToggle) {
      $(`[data-qr-panel="${qrToggle.dataset.qrIndex}"]`)?.classList.toggle('hidden');
      return;
    }
    const entry = event.target.closest('[data-url]');
    if (!entry) return;
    await copyTextWithFeedback(entry.dataset.url, '访问地址已复制');
  });
}

function bindHubEvents() {
  bindModalFocusBoundary();
  let approvedWindowClose = false;
  window.addEventListener('beforeunload', event => {
    captureInspectorDraft();
    for (const pane of state.panes) persistTextDraft(pane.textSession);
    if (!approvedWindowClose && (state.inspectorDirty || state.inspectorSaving || inspectorDrafts.size
      || state.panes.some(pane => pane.textSession?.dirty || pane.textSession?.saving))) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.eagleMV.onItemDragState(payload => {
    if (payload?.active) {
      state.internalDrag = payload;
      return;
    }
    // Only a different, known session's end is ignored. A failed native
    // start reports no token, and the pending local drag never got one.
    if (!state.internalDrag && !state.draggingItemIds && !state.dragSourcePaneId) return;
    const currentToken = state.internalDrag?.token;
    if (payload?.token && currentToken && payload.token !== currentToken) return;
    resetDragState();
  });
  window.eagleMV.onDragFinished(result => {
    if (!result?.ok) toast(`拖动失败：${result?.message || '无法导出素材文件'}`, 4000);
    else if (result.missing) toast(`已拖动 ${result.count} 个文件 · ${result.missing} 个原文件缺失`, 3500);
  });
  window.eagleMV.onRequestClose(async () => {
    // Answer at once so main knows this window is alive; only an actual
    // refusal below cancels the close (and with it a pending quit).
    approvedWindowClose = false;
    window.eagleMV.deferClose?.();
    const pendingOperations = blockingForegroundOperations();
    const anyTextSaving = state.panes.some(pane => pane.textSession?.saving);
    if (state.inspectorSaving || anyTextSaving || pendingOperations.length) {
      window.eagleMV.cancelClose();
      const message = anyTextSaving
        ? 'TXT 仍在保存'
        : state.inspectorSaving
          ? '素材信息仍在保存'
          : foregroundOperationSummary(pendingOperations);
      toast(`${message}，完成后才能关闭窗口`, 3600);
      return;
    }
    // Metadata is auto-saved on input/blur. A close request is the final
    // flush for a very recent edit instead of a discard prompt.
    if (state.inspectorDirty) await saveInspector();
    // A folder name or description still being typed is saved, not dropped.
    if (document.activeElement === $('#categoryName')) await commitCategoryName();
    if (document.activeElement === $('#categoryDescription')) await commitCategoryDescription();
    const failedDrafts = [...inspectorDrafts.values()].filter(draft => Object.keys(inspectorDraftPatch(draft)).length);
    const failedDraft = failedDrafts[0];
    if (failedDraft) {
      if (!failedDrafts.every(draft => persistInspectorDraft(draft))) {
        window.eagleMV.cancelClose();
        return;
      }
      if (!confirm(`有 ${failedDrafts.length} 个素材信息草稿尚未提交，已保存在本机。\n\n按“确定”保留草稿并关闭，下次打开原素材可恢复；按“取消”继续编辑。`)) {
        if (failedDraft.libraryPath === state.library?.path && paneById(failedDraft.paneId)) {
          activatePane(failedDraft.paneId);
          const pane = paneById(failedDraft.paneId);
          if (pane.items.some(item => item.id === failedDraft.id)) { pane.selected = new Set([failedDraft.id]); renderInspector(); }
        }
        window.eagleMV.cancelClose();
        return;
      }
    }
    if (!confirmTextSessionsLeave(state.panes)) {
      window.eagleMV.cancelClose();
      return;
    }
    state.inspectorDirty = false;
    saveSessionState();
    // Stays approved until the next close request; main also overrides a
    // beforeunload guard once it has allowed the close.
    approvedWindowClose = true;
    window.eagleMV.confirmClose();
  });
  window.eagleMV.onTrashSelection(whenWorkspaceFree(payload => setTrash(payload?.ids || [...state.selected], payload?.deleted ?? true)));
  window.eagleMV.onUndoDelete?.(() => routeUndoCommand());
  window.eagleMV.onPinSelection(whenWorkspaceFree(payload => setPinned(payload?.ids || [...state.selected], payload.pinned, payload?.paneId || state.activePaneId)));
  window.eagleMV.onAddToFolder(whenWorkspaceFree(payload => addSelectionToFolder(payload)));
  window.eagleMV.onMoveToFolder(whenWorkspaceFree(payload => moveSelectionToFolder(payload)));
  window.eagleMV.onRemoveFromFolder(whenWorkspaceFree(payload => removeSelectionFromFolder(payload)));
  window.eagleMV.onAddTag(whenWorkspaceFree(payload => addTagToSelection(payload)));
  window.eagleMV.onSetRating(whenWorkspaceFree(payload => setSelectionRating(payload)));
  window.eagleMV.onSetTagColor(whenWorkspaceFree(async payload => {
    const tag = String(payload?.tag || '').trim();
    if (!tag) return;
    const color = await askTagColor(tag);
    if (color !== null) updateTagColor(tag, color);
  }));
  window.eagleMV.onRenameRequest(whenWorkspaceFree(() => requestRenameSelection().catch(error => toast(`重命名失败：${error.message}`, 4000))));
  window.eagleMV.onImportRequest(whenWorkspaceFree(() => importFiles()));
  window.eagleMV.onSiteImportRequest?.(whenWorkspaceFree(() => siteFeatureUI().open()));
  window.eagleMV.onWebAccessRequest(whenWorkspaceFree(() => openWebAccessDialog()));
  window.eagleMV.onCreateFolderRequest(whenWorkspaceFree(() => {
    const paneId = state.activePaneId;
    const parentId = folderCreationParentForPane(paneId);
    createFolder(parentId, Boolean(parentId), paneId).catch(error => toast(`创建失败：${error.message}`, 4000));
  }));
  window.eagleMV.onCreateDocumentRequest(whenWorkspaceFree(payload => {
    const paneId = state.activePaneId;
    createNewDocument(payload?.type, { folderId: folderCreationParentForPane(paneId), paneId })
      .catch(error => toast(`新建文件失败：${error.message}`, 4000));
  }));
  window.eagleMV.onCreateSmartFolderRequest(whenWorkspaceFree(() => {
    createSmartFolderFromNewMenu().catch(error => toast(`智能文件夹创建失败：${error.message}`, 4200));
  }));
  window.eagleMV.onNewWindowRequest(requestDefaultNewWindow);
  window.eagleMV.onMenuCommand?.(whenWorkspaceFree(payload => runMenuCommand(payload)));
  window.eagleMV.onOpenView?.(whenWorkspaceFree(view => {
    if (!view || !state.library) return;
    if (!navigate(view, { restoreScroll: true })) toast('无法打开 MultiView 当前路径', 3200);
  }));
  window.eagleMV.onFolderUsed(payload => {
    if (!payload?.folderId || payload.libraryPath !== state.library?.path) return;
    rememberRecentFolderUsage(payload.folderId);
  });
  // Web uploads report bytes so a long upload is visibly alive.
  window.eagleMV.onUploadProgress?.(progress => {
    if (!progress || !state.importing) return;
    const percent = progress.size ? Math.min(100, Math.floor(progress.loaded / progress.size * 100)) : 0;
    setSyncStatus(`正在上传 ${progress.index + 1}/${progress.total} · ${percent}%`);
  });
  window.eagleMV.onPinsChanged(payload => {
    if (payload.libraryPath !== state.library?.path) return;
    state.localPins = payload.pins || {};
    for (const pane of state.panes) withActivePane(pane.id, () => renderGrid({ preserveScroll: true }));
    queueChangedInspectorRender(false);
  });
  window.eagleMV.onManualOrdersChanged?.(acceptManualOrders);
  window.eagleMV.onFolderCoversChanged?.(acceptFolderCovers);
  window.eagleMV.onTagDataChanged(async payload => {
    if (payload?.libraryPath !== state.library?.path) return;
    if (payload.reason === 'item-tags') {
      await refreshAvailableTags();
      return;
    }
    // A colour change carries the library's whole colour table; nothing
    // else changed, so the other six reads are not needed (H-11).
    if (payload.reason === 'tag-color' && payload.colors && typeof payload.colors === 'object') {
      state.tagColors = payload.colors;
      renderTagColors();
    } else {
      await loadLibraryExtras();
      if (payload.libraryPath !== state.library?.path) return;
    }
    // Recolor existing chips in place, keeping partially typed tag text,
    // caret positions, metadata drafts and current focus intact.
    for (const chip of document.querySelectorAll('.tag-chip')) {
      const name = chip.querySelector('span[title]')?.title;
      if (name) chip.style.setProperty('--tag-color', state.tagColors[name] || '');
    }
    renderFolderTree();
    for (const pane of state.panes) {
      if (pane.currentView.kind === 'tags') withActivePane(pane.id, () => renderGrid({ preserveScroll: true }));
    }
    queueChangedInspectorRender(false);
  });
  window.eagleMV.onTextChanged(payload => {
    if (payload.libraryPath && payload.libraryPath !== state.library?.path) return;
    for (const pane of state.panes) {
      const session = pane.textSession;
      if (!session || payload.id !== session.id) continue;
      // Our own save echoes back: same content version, or this window's save
      // still waiting for its receipt (H-07).
      if (payload.fingerprint && JSON.stringify(payload.fingerprint) === JSON.stringify(session.fingerprint)) continue;
      if (session.saving && payload.origin != null && payload.origin === state.windowId) continue;
      if (session.dirty || session.saving) {
        textSessionStatus(session, '另一个编辑会话已修改此 TXT；保存时会检查冲突');
        continue;
      }
      withActivePane(pane.id, () => openPreview(payload.id, { forceReload: true }));
    }
  });
  window.eagleMV.onStatus(payload => setConnection(payload.connected, payload.message));
  window.eagleMV.onIdentityChanged?.(windowId => { if (windowId) state.windowId = windowId; });
  window.eagleMV.onItemsChanged(payload => {
    if (payload.libraryPath && payload.libraryPath !== state.library?.path) return;
    let touchedSelection = false;
    for (const pane of state.panes) {
      for (const changed of payload.items || []) {
        const index = pane.items.findIndex(item => item.id === changed.id);
        if (index >= 0) {
          pane.items[index] = changed;
          pane.itemMap.set(changed.id, changed);
          schedulePaneGridRender(pane.id);
        }
        if (pane.id === state.activePaneId && pane.selected.has(changed.id)) touchedSelection = true;
      }
    }
    if (touchedSelection) queueChangedInspectorRender(payload.origin !== state.windowId);
    setSyncStatus(payload.source === 'multiview' ? '所有窗口已同步' : '已接收 Eagle 的外部修改');
  });
  window.eagleMV.onLibraryChanged(payload => scheduleLibraryChange(payload));
  window.eagleMV.onQueryInvalidated(payload => {
    if (payload?.libraryPath && payload.libraryPath !== state.library?.path) return;
    if (payload?.thumbnailRevision) {
      thumbnailRevision = payload.thumbnailRevision;
      if (Array.isArray(payload.thumbnailIds)) for (const id of payload.thumbnailIds) thumbnailRevisions.set(String(id), payload.thumbnailRevision);
      else allThumbnailsRevision = payload.thumbnailRevision;
    }
    // TXT saves already have their own text:changed notification. Re-querying
    // every pane here rebuilds both grids behind the editor and makes an
    // unrelated pane visibly flash after each autosave.
    if (payload?.reason === 'text-saved') return;
    categoryStatsRevision += 1;
    categoryStatsCache.clear();
    scheduleRefresh();
  });
}

function scheduleLibraryChange(payload) {
  adoptLibraryHubInstance(payload);
  if (libraryChangeIsStale(payload)) return;
  if (pendingLibraryChange) {
    const comparison = compareLibrarySnapshots(payload, pendingLibraryChange);
    if (comparison < 0) return;
    if (comparison === 0 && (librarySnapshotRevision(payload) !== null || librarySnapshotModificationTime(payload) !== null)) return;
  }
  pendingLibraryChange = payload;
  const revision = librarySnapshotRevision(payload);
  if (revision !== null) newestLibraryRevision = Math.max(newestLibraryRevision, revision);
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
      if (libraryChangeIsSuperseded(payload)) continue;
      await applyLibraryChange(payload);
    }
  } finally {
    librarySyncRunning = false;
    // A change that arrived while a failed sync was running must get its own
    // timer; rescheduling the pending payload against itself was deduplicated
    // away and left it hanging until the next event (H-06).
    const leftover = pendingLibraryChange;
    pendingLibraryChange = null;
    if (leftover) scheduleLibraryChange(leftover);
  }
}

function librarySnapshotRevision(payload) {
  const revision = Number(payload?.revision);
  return Number.isFinite(revision) && revision >= 0 ? revision : null;
}

function librarySnapshotModificationTime(payload) {
  const modificationTime = Number(payload?.library?.modificationTime);
  return Number.isFinite(modificationTime) ? modificationTime : null;
}

function compareLibrarySnapshots(left, right) {
  const leftRevision = librarySnapshotRevision(left);
  const rightRevision = librarySnapshotRevision(right);
  if (leftRevision !== null && rightRevision !== null && leftRevision !== rightRevision) return leftRevision - rightRevision;
  const leftModificationTime = librarySnapshotModificationTime(left);
  const rightModificationTime = librarySnapshotModificationTime(right);
  if (leftModificationTime !== null && rightModificationTime !== null && leftModificationTime !== rightModificationTime) {
    return leftModificationTime - rightModificationTime;
  }
  return 0;
}

// The host restarted: its revisions count from 0 again, so the counters kept
// from the previous host process say nothing about the new snapshots.
function adoptLibraryHubInstance(payload) {
  const instance = payload?.hubInstance;
  if (!instance || instance === libraryHubInstance) return;
  if (libraryHubInstance) {
    lastAppliedLibraryRevision = -1;
    newestLibraryRevision = -1;
    if (pendingLibraryChange && pendingLibraryChange.hubInstance !== instance) pendingLibraryChange = null;
  }
  libraryHubInstance = instance;
}

function libraryChangeIsStale(payload) {
  if (!payload?.library) return true;
  const revision = librarySnapshotRevision(payload);
  if (revision !== null && revision <= lastAppliedLibraryRevision) return true;
  if (state.library && compareLibrarySnapshots(payload, {
    library: state.library,
    revision: lastAppliedLibraryRevision >= 0 ? lastAppliedLibraryRevision : null
  }) < 0) return true;
  if (pendingLibraryChange && compareLibrarySnapshots(payload, pendingLibraryChange) < 0) return true;
  return false;
}

function libraryChangeIsSuperseded(payload) {
  if (pendingLibraryChange && compareLibrarySnapshots(pendingLibraryChange, payload) > 0) return true;
  const revision = librarySnapshotRevision(payload);
  return revision !== null && newestLibraryRevision > revision;
}

function recordAppliedLibrarySnapshot(payload) {
  adoptLibraryHubInstance(payload);
  const revision = librarySnapshotRevision(payload);
  if (revision === null) return;
  lastAppliedLibraryRevision = Math.max(lastAppliedLibraryRevision, revision);
  newestLibraryRevision = Math.max(newestLibraryRevision, revision);
}

function reconcileLibraryChangePanes() {
  const missingFolderIds = new Set();
  let missingSmartFolder = false;
  for (const pane of state.panes) {
    if (pane.currentView.kind === 'folder') {
      const folder = findFolder(state.library?.folders, pane.currentView.id);
      if (folder) pane.viewTitle = folder.name || '文件夹';
      else missingFolderIds.add(pane.currentView.id);
    }
    if (pane.currentView.kind === 'smart') {
      const smartFolder = findFolder(state.library?.smartFolders, pane.currentView.id);
      if (!smartFolder) {
        missingSmartFolder = true;
        withActivePane(pane.id, () => navigate({ kind: 'root' }, { record: false, refreshView: false, skipDiscard: true }));
      } else {
        pane.currentView = { ...pane.currentView, name: smartFolder.name };
        pane.viewTitle = smartFolder.name;
      }
    }
  }
  return { missingFolderIds: [...missingFolderIds], missingSmartFolder };
}

function renderReconciledLibraryPanes() {
  renderFolderTree();
  for (const pane of state.panes) {
    withActivePane(pane.id, () => {
      $('#viewTitle').textContent = pane.viewTitle;
      renderGrid({ preserveScroll: true });
      renderLocation();
    });
  }
  const active = activePane();
  // Do not redraw an item inspector during an unrelated folder update: that
  // would discard an in-progress metadata edit. A folder-card inspector is
  // safe to redraw once its ID is present in the fresh tree.
  if (active?.selectedFolderCard && findFolder(state.library?.folders, active.selectedFolderCard)) renderInspector();
  // The view inspector (no selection) shows folder names and descriptions.
  else if (active && !active.selected.size) renderInspector();
}

async function confirmMissingCurrentFolders(folderIds, payload) {
  if (!folderIds.length || libraryChangeIsSuperseded(payload)) return { superseded: true, confirmed: false, library: null, missingFolderIds: [] };
  let result;
  try {
    // This is a bounded, read-only folder/library snapshot confirmation. It
    // reuses the existing connect surface for both Electron and Web clients.
    result = await withTimeout(window.eagleMV.connect(), LIBRARY_MISSING_CONFIRM_TIMEOUT_MS, '确认文件夹状态超时');
  } catch {
    return { superseded: false, confirmed: false, library: null, missingFolderIds: [] };
  }
  if (libraryChangeIsSuperseded(payload)) return { superseded: true, confirmed: false, library: null, missingFolderIds: [] };
  const library = result?.library;
  const expectedPath = payload.library?.path;
  if (!library || (expectedPath && library.path !== expectedPath) || !Array.isArray(library.folders)) {
    return { superseded: false, confirmed: false, library: null, missingFolderIds: [] };
  }
  return {
    superseded: false,
    confirmed: true,
    library,
    missingFolderIds: folderIds.filter(id => !findFolder(library.folders, id))
  };
}

async function applyLibraryChange(payload) {
  if (!payload?.library || libraryChangeIsSuperseded(payload)) return;
  const pathChanged = state.library?.path && state.library.path !== payload.library.path;
  const hadUnsaved = state.inspectorDirty || state.panes.some(pane => pane.textSession?.dirty);
  if (pathChanged) {
    captureInspectorDraft();
    for (const pane of state.panes) persistTextDraft(pane.textSession);
  }
  // Before the tree is replaced: a folder that left a 包含子文件夹 subtree
  // keeps the sort it showed (S-09).
  if (!pathChanged && state.library?.folders && Array.isArray(payload.library.folders)) {
    sortMemory.followMovedFolders(payload.library.path, state.library.folders, payload.library.folders);
  }
  state.library = payload.library;
  recordAppliedLibrarySnapshot(payload);
  $('#windowTitle').textContent = 'Eagle MultiView';
  $('.sidebar-library-label').textContent = payload.library.name || '资源库';
  setConnection(true);
  if (pathChanged) {
    state.expandedFolders.clear();
    previewPrefetch.clear();
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
    toast(hadUnsaved ? 'Eagle 已切换资源库；旧库草稿已保留，返回原库后可继续编辑' : 'Eagle 已切换资源库，所有窗口已跟随', 4200);
    return;
  }

  let reconciliation = reconcileLibraryChangePanes();
  await loadLibraryExtras();
  if (libraryChangeIsSuperseded(payload)) return;
  reconciliation = reconcileLibraryChangePanes();
  renderReconciledLibraryPanes();

  if (reconciliation.missingFolderIds.length) {
    const confirmation = await confirmMissingCurrentFolders(reconciliation.missingFolderIds, payload);
    if (confirmation.superseded) return;
    if (confirmation.library) {
      state.library = confirmation.library;
      $('.sidebar-library-label').textContent = confirmation.library.name || '资源库';
      await loadLibraryExtras();
      if (libraryChangeIsSuperseded(payload)) return;
      reconciliation = reconcileLibraryChangePanes();
      renderReconciledLibraryPanes();
    }
    if (confirmation.confirmed && confirmation.missingFolderIds.length) {
      const deleted = new Set(confirmation.missingFolderIds);
      let deletedElsewhere = false;
      for (const pane of state.panes) {
        if (pane.currentView.kind === 'folder' && deleted.has(pane.currentView.id)) {
          // A folder this window deleted: go where Eagle goes (removeFolderById).
          const redirect = state.folderRemovalRedirects.get(pane.currentView.id);
          if (!redirect) deletedElsewhere = true;
          withActivePane(pane.id, () => (redirect && navigate(redirect, { record: false, refreshView: false, skipDiscard: true }) !== false)
            || navigate({ kind: 'root' }, { record: false, refreshView: false, skipDiscard: true }));
        } else if (pane.selectedFolderCard && deleted.has(pane.selectedFolderCard)) {
          pane.selectedFolderCard = null;
          if (pane.id === state.activePaneId) withActivePane(pane.id, () => renderInspector());
        }
      }
      reconciliation = reconcileLibraryChangePanes();
      renderReconciledLibraryPanes();
      if (deletedElsewhere) toast('当前文件夹已在 Eagle 或另一个窗口中删除，已返回资源库根目录', 4000);
    }
  }

  await refreshAllPanes({ reset: true, preserveScroll: true });
  if (reconciliation.missingSmartFolder) toast('当前智能文件夹已在 Eagle 中移除，已返回资源库根目录', 4000);
}

function loadLibraryExtras() {
  const libraryPath = state.library?.path;
  if (!libraryPath) return Promise.resolve();
  if (libraryExtrasRun?.libraryPath === libraryPath) {
    libraryExtrasRun.again = true;
    return libraryExtrasRun.promise;
  }
  const run = { libraryPath, again: false, promise: null };
  libraryExtrasRun = run;
  run.promise = (async () => {
    try {
      do { run.again = false; await readLibraryExtras(libraryPath); }
      while (run.again && state.library?.path === libraryPath);
    } finally { if (libraryExtrasRun === run) libraryExtrasRun = null; }
  })();
  return run.promise;
}

async function readLibraryExtras(libraryPath) {
  const token = ++libraryExtrasToken;
  // Reloading the same library keeps the manual orders usable meanwhile;
  // only a library switch empties them (B3-08). Dragging a sidebar folder
  // during any library change used to say the order was not ready yet.
  if (state.manualOrdersLibrary !== libraryPath) {state.localOrders={};state.manualOrdersLibrary=libraryPath;state.manualOrdersReady=false;}
  if (state.folderCoversLibrary !== libraryPath) {
    state.localFolderCovers = { revision: 0, covers: {} };
    state.folderCoversReady = false;
    state.folderCoversLibrary = libraryPath;
  }
  const [pins, tags, tagGroups, starredTags, recentFolders, tagColors, orders, covers] = await Promise.all([
    window.eagleMV.getPins({ libraryPath }).catch(() => null),
    window.eagleMV.getTags().catch(() => null),
    window.eagleMV.getTagGroups().catch(() => null),
    window.eagleMV.getStarredTags?.().catch(() => null) ?? null,
    window.eagleMV.getRecentFolders().catch(() => null),
    window.eagleMV.getTagColors({ libraryPath }).catch(() => null),
    window.eagleMV.getManualOrders?.({ libraryPath }).catch(error => {toast(`本地排序读取失败：${error.message}`,5000);return null;}) ?? null,
    window.eagleMV.getFolderCovers?.({ libraryPath }).catch(error => {toast(`封面设置读取失败：${error.message}`,5000);return null;}) ?? null
  ]);
  // A newer load supersedes this one, and its answer may already be shown.
  if (state.library?.path !== libraryPath || token !== libraryExtrasToken) return;
  // A failed read keeps what this library already showed instead of wiping
  // every pin and tag colour off screen; a new library starts empty.
  const sameLibrary = libraryExtrasLibrary === libraryPath;
  libraryExtrasLibrary = libraryPath;
  const kept = (value, current, empty) => value ?? (sameLibrary ? current : empty);
  state.localPins = kept(pins, state.localPins, {});
  if (covers) acceptFolderCovers({ libraryPath, ...covers });
  for (const [key,order] of Object.entries(orders || {})) {
    if ((state.localOrders[key]?.revision || 0) <= order.revision) state.localOrders[key]=order;
  }
  if (orders) state.manualOrdersReady = true;
  state.availableTags = kept(tags, state.availableTags, []);
  state.tagGroups = orderTagGroups(kept(tagGroups, state.tagGroups, []), libraryPath);
  state.starredTags = Array.isArray(starredTags) ? starredTags : kept(null, state.starredTags, []);
  state.recentFolders = kept(recentFolders, state.recentFolders, []);
  state.tagColors = kept(tagColors, state.tagColors, {});
  renderTagSuggestions();
  renderTagColors();
}

// An item edit added or removed tags (V-01): only the tag list and its counts
// change, so pins, orders, colours and the inspector stay as they are.
let availableTagsToken = 0;
async function refreshAvailableTags() {
  const libraryPath = state.library?.path;
  const token = ++availableTagsToken;
  const extrasToken = libraryExtrasToken;
  const tags = await window.eagleMV.getTags().catch(() => null);
  // A newer read, or a full reload that started meanwhile, has the last word.
  if (!tags || token !== availableTagsToken || extrasToken !== libraryExtrasToken || state.library?.path !== libraryPath) return;
  state.availableTags = tags;
  renderTagSuggestions();
  renderFolderTree();
  for (const pane of state.panes) {
    if (pane.currentView.kind === 'tags') withActivePane(pane.id, () => renderGrid({ preserveScroll: true }));
  }
}

async function restoreInitialWindowState() {
  const initial = await window.eagleMV.initialWindowState().catch(() => null);
  if (!initial) return null;
  const initialActivePaneId = state.activePaneId;
  for (const pane of state.panes) {
    withActivePane(pane.id, () => {
      // A new window may restore a multi-pane layout before its initial
      // location arrives.  The location belongs to every pane created for
      // that window; only the active pane receives the source query/selection
      // state, so the other panes remain independent after opening.
      if (pane.id === initialActivePaneId && initial.query) pane.query = cloneQuery(initial.query);
      if (initial.view) navigate(initial.view, { record: false, refreshView: false, skipDiscard: true });
    });
  }
  return initial;
}

// Hide entry points whose backing capability is missing on this client (the
// web shim reports false for host-bound features like Finder or host dialogs).
function applyCapabilityVisibility() {
  const hideWithout = (capability, selector) => {
    if (!hasCapability(capability)) document.querySelector(selector)?.classList.add('hidden');
  };
  hideWithout('openDefault', '#openDefaultButton');
  hideWithout('finder', '#finderButton');
  hideWithout('customThumbnail', '#customThumbnailButton');
}

// Static index.html hints are written with Mac glyphs; spell them out with
// the platform's own modifier names elsewhere.
function localizeStaticShortcutHints() {
  if (keyboardPlatform.apple) return;
  for (const node of document.querySelectorAll('[title]')) {
    const title = node.getAttribute('title');
    if (/[⌘⌃⌥⇧⌫]/.test(title)) node.setAttribute('title', keyboardPlatform.shortcutText(title));
  }
  for (const node of document.querySelectorAll('kbd')) {
    if (/[⌘⌃⌥⇧⌫]/.test(node.textContent)) node.textContent = keyboardPlatform.shortcutText(node.textContent);
  }
}

async function start() {
  installBackRouter(window.eagleMV.shellApp ? shellBackEntry : backActionRouter);
  localizeStaticShortcutHints();
  bindEvents();
  window.addEventListener('message', handleEaglePdfViewerMessage);
  bindHubEvents();
  bindWebAccessDialog();
  applyCapabilityVisibility();
  await restoreWindowChromeState();
  restorePanelSizes();
  let savedSession = null;
  try {
    savedSession = JSON.parse(localStorage.getItem('eaglemv.sessionState') || 'null');
  } catch {}
  let savedPaneLayout = 'single';
  let savedSplitRatios = null;
  if (savedSession && paneLayouts[savedSession.layout]) {
    savedPaneLayout = savedSession.layout;
    savedSplitRatios = savedSession.splitRatios;
  } else {
    try {
      if (paneLayouts[localStorage.getItem('eaglemv.paneLayout')]) savedPaneLayout = localStorage.getItem('eaglemv.paneLayout');
    } catch {}
  }
  renderPaneLayout(savedPaneLayout, { refresh: false, splitRatios: savedSplitRatios });
  try {
    const thumbnailSize = Number(localStorage.getItem('eaglemv.thumbnailSize'));
    if (Number.isFinite(thumbnailSize) && thumbnailSize > 0) applyThumbnailSize(thumbnailSize, { persist: false });
  } catch {}
  // The saved slideshow interval and preview background apply to every pane
  // restored at launch, not only the active one (B3-09).
  try {
    const interval = Number(localStorage.getItem(SLIDESHOW_INTERVAL_KEY));
    if ([...$('#slideshowInterval').options].some(option => Number(option.value) === interval)) {
      for (const pane of state.panes) pane.slideshow.intervalMs = interval;
    }
  } catch {}
  try {
    const stored = JSON.parse(localStorage.getItem(PREVIEW_VIEW_KEY) || 'null');
    for (const pane of state.panes) {
      if (PREVIEW_BACKGROUNDS.some(option => option.key === stored?.background)) pane.previewView.background = stored.background;
      pane.previewView.grayscale = Boolean(stored?.grayscale);
    }
  } catch {}
  for (const pane of state.panes) withActivePane(pane.id, () => { renderSlideshow(); renderPreviewView(); });
  renderPanels();
  renderQueryControls();
  // Only the connection is retried; a failure after it is reported as what
  // it is instead of "start Eagle", and one chained timer replaces the
  // overlapping 2.5 s interval (H-05).
  let connection;
  try {
    state.windowId = await window.eagleMV.identity();
    connection = await window.eagleMV.connect();
  } catch {
    setConnection(false, '请先启动 Eagle 4');
    $('#resultCount').textContent = '等待 Eagle 启动';
    toast('未连接 Eagle。启动 Eagle 后本窗口会自动重试。', 5000);
    const retry = () => setTimeout(async () => {
      let result;
      try {
        if (state.windowId == null) state.windowId = await window.eagleMV.identity();
        result = await window.eagleMV.connect();
      } catch { retry(); return; }
      finishStartup(result).catch(error => toast(`载入窗口失败：${error.message}`, 5000));
    }, 2500);
    retry();
    return;
  }
  await finishStartup(connection).catch(error => toast(`载入窗口失败：${error.message}`, 5000));
}

async function finishStartup({ app, library, hubInstance }) {
  state.library = library;
  recordAppliedLibrarySnapshot({ library, hubInstance });
  await loadLibraryExtras();
  $('#windowTitle').textContent = 'Eagle MultiView';
  $('.sidebar-library-label').textContent = library.name || '资源库';
  setConnection(true);
  renderFolderTree();
  const initial = await restoreInitialWindowState();
  if (!initial) restoreSavedSessionPanes();
  else renderFolderTree();
  await refreshAllPanes({ reset: true, preserveScroll: false });
  if (initial?.selectedIds?.length) {
    const missing = initial.selectedIds.filter(id => !itemById(id));
    if (missing.length) {
      const fetched = (await Promise.all(missing.map(id => window.eagleMV.getItem(id).catch(() => null)))).filter(Boolean);
      const pane = activePane();
      pane.items = [...pane.items, ...fetched];
      for (const item of fetched) pane.itemMap?.set(item.id, item);
    }
    activePane().selected = new Set(initial.selectedIds.filter(id => itemById(id)));
    renderGrid({ preserveScroll: true });
    renderInspector();
  }
  if (initial?.previewId && itemById(initial.previewId)) await openPreview(initial.previewId);
  toast(`已连接 Eagle ${app?.version || ''}`.trim());
}

start();
