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
  searchFolders
} = window.EagleMVFolderNavigation;
const { formatEaglePath, resolveEaglePath } = window.EagleMVLogicalPath;
const { paneLayoutPopoverPosition } = window.EagleMVLayoutPopover;
const {
  hasType: dragHasType,
  readItemIds,
  isInternalItemDrag,
  classifyDrop,
  shouldShowImportOverlay
} = window.EagleMVDragDrop;
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
  selectRange,
  normalizeRange: normalizeQueryRange,
  effectiveSortDir,
  compareBySort: compareItemsBySort,
  sharedTags: computeSharedTags,
  appendableTailCount,
  paneLayoutSpecs,
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
  const cascadeCheck = $('#sortCascadeCheck');
  if (cascadeCheck) cascadeCheck.checked = sortCascadeEnabled;
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
    const cascadeCheck = $('#sortCascadeCheck');
    if (cascadeCheck) cascadeCheck.checked = sortCascadeEnabled;
  }
});
const { createOperationTracker } = window.EagleMVOperationState;
// Single choke point for media addresses: the Electron preload mints
// eaglemv:// protocol URLs, the web shim mints same-origin /media/ paths.
const mediaURL = (kind, id) => window.eagleMV.mediaURL(kind, id);
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
  '#previewModal', '#modalMedia', '#closePreview', '#prevPreview', '#nextPreview', '#slideshowControls', '#slideshowToggle', '#slideshowInterval',
  '#previewBackground', '#previewGrayscale', '#modalRating', '#modalCaption', '#textEditor', '#textStatus', '#reloadTextButton', '#saveTextButton'
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
  viewTitle: '资料库',
  currentView: { kind: 'root' },
  history: [],
  historyIndex: -1,
  selectedFolderCard: null,
  dragDepth: 0,
  draggingItemIds: null,
  scrollTop: 0,
  query: createQuery(),
  localPins: {},
  expandedFolders: new Set(),
  availableTags: [],
  tagGroups: [],
  recentFolders: [],
  tagColors: {},
  viewMemory: new Map(),
  restoreScroll: null,
  activePaneId: 'pane-1',
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
  trashDialogResolve: null,
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
  'items', 'itemMap', 'total', 'totalCount', 'estimatedTotal', 'offset', 'nextOffset', 'hasMore', 'loading', 'refreshToken', 'errorMessage', 'selected', 'selectedBase',
  'sort', 'sortDir', 'randomSeed', 'viewMode', 'viewTitle', 'currentView', 'history', 'historyIndex', 'selectedFolderCard', 'dragDepth', 'scrollTop', 'query', 'sortCascade',
  'viewMemory', 'restoreScroll',
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

function setSyncPanesEnabled(enabled) {
  syncPanesEnabled = Boolean(enabled);
  try {
    localStorage.setItem('eaglemv.syncPanes', String(syncPanesEnabled));
  } catch {}
  const checkbox = $('#syncPanesCheckbox');
  if (checkbox) checkbox.checked = syncPanesEnabled;
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
    root: state.library?.name || '资料库',
    all: '全部素材',
    unfiled: '未分类',
    untagged: '未加标签',
    recent: '最近使用',
    random: '随机模式',
    trash: '回收站',
    tags: '标签管理'
  })[view?.kind] || '资料库';
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
    sort: fresh ? 'default' : (source.sort || 'default'),
    sortDir: source.sortDir || 'auto',
    sortCascade: sortCascadeEnabled,
    randomSeed: source.randomSeed || nextRandomSeed(),
    viewMode: fresh ? 'justified' : (paneViewModes.has(storedPaneViewModes()[id]) ? storedPaneViewModes()[id] : (source.viewMode || 'justified')),
    sortCapNoticeKey: '',
    // The new pane gets a display label derived from the inherited path, not
    // another pane's mutable presentation state.
    viewTitle: fresh ? paneTitleForView(currentView) : (source.viewTitle || '资料库'),
    currentView,
    history: fresh ? [] : [...(source.history || [])],
    historyIndex: fresh ? -1 : (Number.isInteger(source.historyIndex) ? source.historyIndex : -1),
    selectedFolderCard: fresh ? null : (source.selectedFolderCard || null),
    dragDepth: 0,
    draggingItemIds: null,
    scrollTop: fresh ? 0 : (Number(source.scrollTop) || 0),
    query: fresh ? createQuery() : cloneQuery(source.query),
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
    pane.sortDir = 'auto';
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
let newestLibraryRevision = -1;
let visibleItemWatchQueued = false;
let activeMarquee = null;
// Touch long-press bookkeeping: while the finger is still down the browser
// may fire its own contextmenu, and right after lift-off it fires a synthetic
// click — both must be swallowed without eating the user's next real tap.
let suppressTouchClickUntil = 0;
let touchLongPressActive = false;
const TOUCH_LONG_PRESS_MS = 480;
const TOUCH_LONG_PRESS_SLOP = 12;

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
  if (!state.selected.size) {
    if (selectItem(id)) toast('已选中，轻点其它素材可多选', 2400);
    return;
  }
  if (!state.selected.has(id) && !selectItem(id, true)) return;
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
  state.activePaneId = id;
  try { return callback(); } finally { state.activePaneId = previous; }
}
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
  const editing = state.inspectorEditing || isInspectorEditor();
  if (state.inspectorDirty || state.inspectorSaving || editing) {
    if (external) $('#staleBanner').classList.remove('hidden');
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
          <button id="backButton" class="nav-button" title="返回（⌥← / ⌃←）" disabled aria-label="返回"><img class="nav-image-icon" src="eagle-assets/ic-modal-back.svg" alt=""></button>
          <button id="forwardButton" class="nav-button" title="前进（⌥→ / ⌃→）" disabled aria-label="前进"><img class="nav-image-icon mirror-x" src="eagle-assets/ic-modal-back.svg" alt=""></button>
          <button id="upButton" class="nav-button up" title="上一级（⌥↑ / ⌃↑）" disabled aria-label="上一级"><img class="nav-image-icon" src="eagle-assets/ic-arrow-up.svg" alt=""></button>
        </div>
        <div class="location-block">
          <h1 id="viewTitle">资料库</h1>
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
              <span id="sortSelectLabel" class="sort-select-label">Eagle 顺序</span>
              <svg class="sort-select-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8.5 4 4 4-4"></path></svg>
            </button>
            <select id="sortSelect" class="sort-select hidden-accessible" aria-label="当前栏排序" tabindex="-1">
              <option value="default">Eagle 顺序</option>
              <option value="name">名称</option>
              <option value="added">添加日期</option>
              <option value="newest">最近修改</option>
              <option value="size">文件大小</option>
              <option value="resolution">分辨率</option>
              <option value="rating">评分</option>
              <option value="type">文件类型</option>
              <option value="random">随机</option>
            </select>
            <div id="sortPopover" class="sort-popover hidden" role="menu" aria-label="排序选项">
              <div class="sort-popover-options">
                <button type="button" class="sort-popover-option" data-sort="default">Eagle 顺序</button>
                <button type="button" class="sort-popover-option" data-sort="name">名称</button>
                <button type="button" class="sort-popover-option" data-sort="added">添加日期</button>
                <button type="button" class="sort-popover-option" data-sort="newest">最近修改</button>
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
                <span>包含子文件夹</span>
              </label>
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
        <h2>这里还没有素材</h2>
        <p>可以调整筛选条件，或将文件导入当前文件夹。</p>
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
          <option value="4000">4 秒</option>
          <option value="6000">6 秒</option>
          <option value="10000">10 秒</option>
        </select>
        <button id="previewBackground" class="slideshow-button preview-view-button" type="button" aria-label="透明区域背景"><span class="preview-bg-chip" aria-hidden="true"></span></button>
        <button id="previewGrayscale" class="slideshow-button preview-view-button" type="button" title="灰度查看（G）" aria-label="灰度查看" aria-pressed="false">灰</button>
      </div>
      <button id="closePreview" class="modal-close" type="button" aria-label="关闭预览">×</button>
      <button id="prevPreview" class="modal-nav prev" type="button" aria-label="上一个">‹</button>
      <div id="modalMedia" class="modal-media"></div>
      <div id="modalRating" class="modal-rating" role="group" aria-label="评分（按 0-5）"></div>
      <div id="modalCaption" class="modal-caption"></div>
      <button id="nextPreview" class="modal-nav next" type="button" aria-label="下一个">›</button>
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
    if (session.activePaneId && state.panes.some(p => p.id === session.activePaneId)) {
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
  state.panes = plan.panes;
  state.activePaneId = plan.activePaneId || state.panes[0]?.id;
  layoutRoot.dataset.layout = layout;
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
// Originals Chromium cannot decode whose preview rides Eagle's generated
// .info image (eaglemv://preview): design formats plus camera RAW.
const previewStandInExtensions = new Set(['psd', 'tif', 'tiff', 'heic', 'heif', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'raf', 'rw2']);
function itemFormat(item) { return String(item?.ext || '').trim().toUpperCase(); }

function compareItemsForView(a, b) {
  if (state.currentView.kind === 'folder') {
    const left = pinTimestamp(a);
    const right = pinTimestamp(b);
    if (left && !right) return -1;
    if (!left && right) return 1;
    if (left !== right) return right - left;
  }
  return compareItemsBySort(state.sort, state.sortDir, a, b, { seed: state.randomSeed });
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
}

const sortOptionLabels = {
  default: 'Eagle 顺序',
  name: '名称',
  added: '添加日期',
  newest: '最近修改',
  size: '文件大小',
  resolution: '分辨率',
  rating: '评分',
  type: '文件类型',
  random: '随机'
};

function renderSortControls() {
  renderViewModeControls();
  const sortKey = state.sort || 'default';
  const select = $('#sortSelect');
  if (select) select.value = sortKey;
  const label = $('#sortSelectLabel');
  if (label) label.textContent = sortOptionLabels[sortKey] || 'Eagle 顺序';
  const popover = $('#sortPopover');
  if (popover) {
    for (const btn of popover.querySelectorAll('[data-sort]')) {
      btn.classList.toggle('active', btn.dataset.sort === sortKey);
    }
    const sortable = Boolean(state.sort) && state.sort !== 'default' && state.sort !== 'random';
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
    if (cascadeCheck) cascadeCheck.checked = Boolean(state.sortCascade);
  }
}

// Persist the active pane's sort choice for its current view, then re-render.
function commitSortChange() {
  sortMemory.remember(state.library?.path, descriptorKey(state.currentView), state.sort, state.sortDir, Date.now());
  renderSortControls();
  renderGrid({ preserveScroll: true });
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

// Range filters are stored as one {min, max} query key but edited through two
// inputs, so a binding names which end it drives and how the panel's unit maps
// to the stored one (MB and megapixels to raw counts, dates to timestamps).
const MEGABYTE = 1024 * 1024;
const MEGAPIXEL = 1e6;
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
    return end ? date.getTime() + 86399999 : date.getTime();
  },
  toInput: value => {
    if (!Number.isFinite(value)) return '';
    const date = new Date(value);
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
});

// Simple-value filter inputs bind declaratively; tags (chip editor) and
// color (swatch row) keep their bespoke widgets.
const filterInputBindings = [
  { key: 'search', selector: '#searchInput', event: 'input' },
  { key: 'searchScope', selector: '#searchScopeFilter', event: 'change' },
  { key: 'ext', selector: '#extFilter', event: 'input', parse: value => normalizeExtension(value) },
  { key: 'rating', selector: '#ratingFilter', event: 'change', parse: value => value === '' ? null : Number(value), toInput: value => Number.isInteger(value) ? String(value) : '' },
  { key: 'shape', selector: '#shapeFilter', event: 'change' },
  { key: 'annotation', selector: '#annotationFilter', event: 'input' },
  { key: 'url', selector: '#urlFilter', event: 'input' },
  { key: 'size', part: 'min', selector: '#sizeMinFilter', event: 'input', ...scaledRange(MEGABYTE) },
  { key: 'size', part: 'max', selector: '#sizeMaxFilter', event: 'input', ...scaledRange(MEGABYTE) },
  { key: 'pixels', part: 'min', selector: '#pixelsMinFilter', event: 'input', ...scaledRange(MEGAPIXEL) },
  { key: 'pixels', part: 'max', selector: '#pixelsMaxFilter', event: 'input', ...scaledRange(MEGAPIXEL) },
  { key: 'added', part: 'min', selector: '#addedFromFilter', event: 'change', ...dateRange(false) },
  { key: 'added', part: 'max', selector: '#addedToFilter', event: 'change', ...dateRange(true) }
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

function tagChipHTML(tag, { removeAttr = 'data-remove-tag', removeLabel = `移除 ${tag}`, disabled = false } = {}) {
  const color = state.tagColors[tag];
  return `<span class="tag-chip"${color ? ` style="--tag-color:${escapeHTML(color)}"` : ''}><span title="${escapeHTML(tag)}">${escapeHTML(tag)}</span><button type="button" ${removeAttr}="${escapeHTML(tag)}" aria-label="${escapeHTML(removeLabel)}"${disabled ? ' disabled' : ''}>×</button></span>`;
}

function renderTagEditor(kind) {
  const config = tagEditors[kind];
  const chips = $(config.chips);
  if (!chips) return;
  chips.innerHTML = tagValues(kind).map(tag => tagChipHTML(tag)).join('');
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
  state.query = createQuery();
  renderQueryControls();
  refresh({ reset: true, preserveScroll: false, paneId: state.activePaneId });
}

function libraryDisplayName(libraryPath) {
  return String(libraryPath || '').split('/').filter(Boolean).pop()?.replace(/\.library$/i, '') || '资料库';
}

function renderLibraryList(entries) {
  const box = $('#libraryList');
  const known = [...entries];
  // Eagle's history may omit the currently open library; keep it visible.
  if (state.library?.path && !known.some(entry => entry.path === state.library.path)) {
    known.unshift({ path: state.library.path, name: state.library.name || libraryDisplayName(state.library.path), exists: true });
  }
  if (!known.length) {
    box.innerHTML = '<span class="muted">Eagle 没有返回资料库历史</span>';
    return;
  }
  box.innerHTML = known.map(entry => {
    const current = state.library?.path === entry.path;
    return `<button type="button" class="library-row${current ? ' current' : ''}" data-library-path="${escapeHTML(entry.path)}" data-library-name="${escapeHTML(entry.name)}" title="${escapeHTML(entry.path)}"${entry.exists ? '' : ' disabled'}>
      <span class="library-row-name">${escapeHTML(entry.name)}${entry.exists ? '' : '（找不到文件）'}</span>
      <span class="library-row-path">&lrm;${escapeHTML(entry.path)}&lrm;</span>
      ${current ? '<span class="library-row-check" aria-label="当前资料库">✓</span>' : ''}
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
  $('#libraryList').innerHTML = '<span class="muted">正在读取资料库列表…</span>';
  try {
    renderLibraryList(await window.eagleMV.getLibraryHistory());
  } catch (error) {
    $('#libraryList').innerHTML = `<span class="muted">读取失败：${escapeHTML(error.message)}</span>`;
  }
}

function closeLibraryPopover() {
  $('#libraryPopover').classList.add('hidden');
  $('#libraryButton').setAttribute('aria-expanded', 'false');
}

async function switchToLibrary(libraryPath, name) {
  closeLibraryPopover();
  if (state.library?.path === libraryPath) {
    toast('已经是当前资料库', 2200);
    return;
  }
  if (!state.connected) {
    toast('Eagle 未连接，暂时无法切换资料库', 3200);
    return;
  }
  if (!confirmDiscardChanges()) return;
  try {
    // Success feedback arrives through the library-changed broadcast
    // ("Eagle 已切换资料库，所有窗口已跟随"), same as an Eagle-side switch.
    await runForegroundOperation(`正在切换到「${name}」…`, { key: 'library-switch' }, async () => {
      await window.eagleMV.switchLibrary({ libraryPath });
    });
  } catch (error) {
    toast(`切换资料库失败：${error.message}`, 4600);
  }
}

function normalizeExtension(value) {
  return String(value || '').trim().toLowerCase().replace(/^\.+/, '');
}

// Only the web client turns narrow side panels into overlay drawers. Desktop
// windows keep their columns even when UI zoom shrinks the CSS viewport.
const compactLayoutQuery = window.matchMedia('(max-width: 900px)');
const isCompactLayout = () => isWebClient && compactLayoutQuery.matches;
const isTouchEvent = event => event.pointerType === 'touch' ||
  (event.pointerType === undefined && window.matchMedia('(pointer: coarse)').matches);

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
  $('#searchInput').placeholder = compact ? '搜索…' : '搜索名称、标签、备注…';
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
  return true;
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

function folderCardMarkup(folder) {
  const childCount = (folder.children || []).length;
  const directCount = Number(folder.imageCount) || 0;
  return `<article class="folder-card ${state.selectedFolderCard === folder.id ? 'selected' : ''}" data-open-folder="${escapeHTML(folder.id)}" tabindex="0">
    <div class="folder-thumbnail">
      <span class="folder-sheet folder-sheet-back" aria-hidden="true"></span>
      <span class="folder-sheet folder-sheet-middle" aria-hidden="true"></span>
      <div class="folder-cover">
        ${folder.covers?.length ? `<img loading="lazy" src="${mediaURL('folder', folder.id)}" alt="">` : ''}
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
  // Every layout carries its own class (including the default) so the CSS can
  // target one mode instead of excluding all the others.
  const viewModeClass = ` ${paneViewModes.has(state.viewMode) ? state.viewMode : 'justified'}`;
  const headingHTML = items.length && folders.length
    ? `<div class="grid-section-heading"><span>文件</span><span>${state.estimatedTotal ? '≥ ' : ''}${state.total.toLocaleString()}</span></div>`
    : '';
  const gridPrefixHTML = folderSection + headingHTML;
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
    state.scrollTop = scrollTop;
    if (updateSharedFooter) updateScrollUI();
    scheduleVisibleItemWatch();
    return;
  }
  const itemSection = items.length ? `${headingHTML}<div class="asset-grid${viewModeClass}">${items.map(itemCardMarkup).join('')}</div>` : '';
  itemGrid.innerHTML = `${folderSection}${itemSection}`;
  itemGrid._gridPrefix = gridPrefixHTML;
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

function itemCardMarkup(item) {
  const ext = String(item.ext || '').trim().toLowerCase().replace(/^\./, '');
  const isGif = ext === 'gif';
  const thumbURL = mediaURL('thumb', item.id);
  const originalURL = mediaURL('original', item.id);
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
      ${state.viewMode === 'list' ? listRowColumns(item) : ''}
      <div class="card-meta">${item.width || 0}×${item.height || 0} · ${formatBytes(item.size)}</div>
    </article>`;
}

// The list is for triage, so it earns the columns a grid cannot show: tags,
// rating and the date the item entered the library. Rendered only in list
// mode — the other layouts would carry three dead nodes per card, and the grid
// holds thousands.
function listRowColumns(item) {
  const tags = (item.tags || []).map(String).filter(Boolean);
  const rating = Math.max(0, Math.min(5, Number(item.star) || 0));
  const added = Number(item.btime) || 0;
  return `<div class="card-list-tags" title="${escapeHTML(tags.join('、'))}">${tags.map(tag => `<span class="card-list-tag">${escapeHTML(tag)}</span>`).join('')}</div>
      <div class="card-list-rating"${rating ? ` title="${rating} 星"` : ''}>${rating ? '★'.repeat(rating) : ''}</div>
      <div class="card-list-date" title="添加日期">${added ? new Date(added).toLocaleDateString('zh-CN') : ''}</div>`;
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
// presets (eagleNamedFolderColors, declared with the filter choices); unset
// folders have no color field at all.
function folderColorValue(folder) {
  const raw = String(folder?.color || '').trim();
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

function handleFolderTargetDragOver(event, targetElement) {
  const dropKind = classifyDrop(event.dataTransfer, activeDraggedItemIds());
  if (dropKind === 'unsupported') return false;
  event.preventDefault();
  const sourceFolderId = state.internalDrag?.sourceFolderId || null;
  event.dataTransfer.dropEffect = dropKind === 'internal-items' && (sourceFolderId || event.altKey) ? 'move' : 'copy';
  targetElement.classList.add('drop-target');
  return true;
}

function attachFolderDragTargets() {
  for (const row of document.querySelectorAll('[data-folder-id]')) {
    row.addEventListener('dragover', event => {
      handleFolderTargetDragOver(event, row);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', event => {
      const dropKind = classifyDrop(event.dataTransfer, activeDraggedItemIds());
      if (dropKind === 'unsupported') return;
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove('drop-target');
      const folderId = row.dataset.folderId;
      if (dropKind === 'external-files') {
        scheduleExternalFolderImport(event.dataTransfer, folderId, state.activePaneId);
        return;
      }
      const ids = readItemIds(event.dataTransfer, activeDraggedItemIds());
      if (!ids.length) {
        toast('无法识别拖入的素材，请重新拖动', 3500);
        clearDragUI();
        return;
      }
      const libraryPath = state.internalDrag?.libraryPath || state.library?.path;
      const folderName = row.dataset.folderName;
      const sourceFolderId = state.internalDrag?.sourceFolderId || null;
      const move = Boolean(sourceFolderId || event.altKey);
      const sourcePaneId = state.internalDrag?.sourcePaneId || state.dragSourcePaneId || null;
      scheduleDropTask(() => addItemsToFolder(ids, folderId, folderName, libraryPath, { move, sourceFolderId, sourcePaneId }));
    });
  }
}

async function refresh({ reset = true, preserveScroll = true, paneId = state.activePaneId, quiet = false } = {}) {
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
      if (reset) {
        state.items = page.data || [];
        state.itemMap = new Map((state.items || []).filter(item => item?.id).map(item => [item.id, item]));
      } else {
        const knownIds = new Set(state.items.map(item => item.id));
        const additions = (page.data || []).filter(next => !knownIds.has(next.id));
        state.items = [...state.items, ...additions];
        for (const item of additions) if (item?.id) state.itemMap?.set(item.id, item);
      }
      if (currentView.kind === 'folder') reconcileLocalFolderCount(currentView.id, state.total);
      renderResultCount();
      $('#viewTitle').textContent = state.viewTitle;
      renderLocation();
      // Quiet pages belong to a sort backfill: skip the grid rebuild per page
      // and render once when the backfill settles (in the finally block).
      // Append pages must keep the scroll position (`preserveScroll && reset`
      // used to reset it, teleporting scroll-driven paging back to the top)
      // — with it preserved, renderGrid can take the append fast path.
      if (!quiet) renderGrid({ preserveScroll });
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
        const continueBackfill = sortBackfillActive && state.items.length < SORT_FETCH_CAP;
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
    return `<button type="button" class="palette-swatch" style="background:rgb(${rgb.join(',')})" data-color="${hex}" title="${hex} · ${pct}% · 点击复制，⌥点击筛选同色" aria-label="主色 ${hex}"></button>`;
  }).join('');
  box.classList.toggle('hidden', !box.innerHTML);
}

function renderSharedTags() {
  const section = $('#sharedTagsSection');
  const chips = $('#sharedTagChips');
  if (!section || !chips) return;
  const selectedItems = state.items.filter(item => state.selected.has(item.id));
  const tags = computeSharedTags(selectedItems);
  section.classList.toggle('hidden', !tags.length);
  chips.innerHTML = tags.map(tag => tagChipHTML(tag, {
    removeAttr: 'data-remove-shared-tag',
    removeLabel: `从所选素材移除 ${tag}`
  })).join('');
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
  const visible = isCompactLayout() && count > 0;
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
    state.inspectorEditing = false;
    clearInspectorAutoSave();
    return;
  }
  const id = [...state.selected][0];
  const item = itemById(id);
  if (!item) return;
  if (state.selectedBase?.id !== id) {
    clearInspectorAutoSave();
    state.inspectorEditing = false;
  }
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
  $('#previewBox').innerHTML = `<img src="${mediaURL('thumb', item.id)}" alt="${escapeHTML(item.name)}">${item.ext ? `<span class="preview-format-badge">${escapeHTML(itemFormat(item))}</span>` : ''}`;
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
  state.commentsToken = (Number.isFinite(state.commentsToken) ? state.commentsToken : 0) + 1;
  const token = state.commentsToken;
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
  state.metadataToken = (Number.isFinite(state.metadataToken) ? state.metadataToken : 0) + 1;
  const token = state.metadataToken;
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
  // Auto-save must stay invisible to the editor. Disabling a focused control
  // makes Chromium blur it immediately, and the next Backspace then falls
  // through to the workspace trash shortcut. Keep the live form editable;
  // saveInspector owns an immutable patch and queues anything typed in-flight.
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
  let queueFollowUp = false;
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
      const contextStillActive = state.activePaneId === paneId
        && pane.selected.size === 1
        && pane.selected.has(id)
        && state.library?.path === libraryPath;
      if (contextStillActive) {
        pane.selectedBase = structuredClone(result.item);
        state.inspectorDirty = Object.keys(collectPatch()).length > 0;
        queueFollowUp = state.inspectorDirty;
        renderGrid();
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
    if (queueFollowUp) queueInspectorAutoSave();
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
  return ['#folderDialog', '#trashDialog', '#duplicateDialog', '#contextMenu', '#webAccessDialog']
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

async function mutateSelectionSet(ids, field, delta, message, paneId = state.activePaneId, { keepSelection = false, successMessage = null } = {}) {
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
    pane.selected = new Set(outcome.failed.length || !keepSelection ? outcome.failed : ids);
    if (state.activePaneId === paneId) renderInspector();
    await refresh({ reset: true, preserveScroll: true, paneId });
    if (keepSelection && !outcome.failed.length) {
      const visibleIds = new Set(pane.items.map(item => item.id));
      pane.selected = new Set(ids.filter(id => visibleIds.has(id)));
      if (state.activePaneId === paneId) withActivePane(paneId, () => {
        updateCardSelectionStyles();
        renderInspector();
      });
    }
    toast(outcome.failed.length
      ? `已完成 ${outcome.succeeded.length} 个素材 · ${outcome.failed.length} 个失败并保持选中`
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
  return mutateSelectionSet(payload.ids, 'tags', { add: tags }, '正在添加标签…', payload?.paneId || state.activePaneId, {
    keepSelection: true,
    successMessage: tags.length === 1 ? `已添加标签「${tags[0]}」` : `已添加 ${tags.length} 个标签`
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
    // Rating never removes anything from the view, so the selection survives —
    // Eagle keeps it too, and dropping it after every keystroke made rating a
    // run of items needlessly awkward. Failures stay selected on their own.
    pane.selected = new Set(outcome.failed.length
      ? outcome.failed
      : ids.filter(id => pane.items.some(item => item.id === id)));
    if (state.activePaneId === paneId) renderInspector();
    await refresh({ reset: true, preserveScroll: true, paneId });
    if (state.previewId) updatePreviewChrome(itemById(state.previewId) || { id: state.previewId, name: '', ext: '' });
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

function removeTagFromSelection(tag) {
  if (!tag) return false;
  // Keeps the multi-selection on success so several shared tags can be
  // removed in a row; everything else rides the shared batch pipeline.
  return mutateSelectionSet([...state.selected], 'tags', { remove: [tag] }, '正在移除标签…', state.activePaneId, {
    keepSelection: true,
    successMessage: `已从所选素材移除「${tag}」`
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

function mediaMarkup(item) {
  const url = mediaURL('original', item.id);
  const ext = String(item.ext || '').toLowerCase();
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv'].includes(ext)) return `<video src="${url}" controls autoplay playsinline></video>`;
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)) return `<audio src="${url}" controls autoplay></audio>`;
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
  image.style.maxWidth = '100%';
  image.style.maxHeight = '100%';
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

function setupPreviewMedia() {
  const image = $('#modalMedia img');
  // Image previews own the whole modal as a gesture surface (swipe/pinch);
  // text/PDF previews keep native touch behavior for their scrollables.
  $('#previewModal').classList.toggle('image-gesture', Boolean(image));
  if (image) {
    image.setAttribute('draggable', 'false');
    image.addEventListener('dragstart', event => event.preventDefault());
    image.classList.add('preview-image');
    image.addEventListener('load', () => renderPreviewZoom(), { once: true });
    // Eagle can hold an index entry whose file is gone (or a type with no
    // generated preview). A broken-image glyph in the middle of the modal is
    // worse than saying so.
    const token = state.previewToken;
    image.addEventListener('error', () => {
      if (token !== state.previewToken || !image.isConnected) return;
      const item = itemById(state.previewId);
      $('#modalMedia').innerHTML = `<div class="unsupported-preview"><p>无法读取这个素材的图像<br><span>${escapeHTML(String(item?.ext || '文件').toUpperCase())} · 原文件可能已被移动或删除</span></p></div>`;
    }, { once: true });
  }
  const pdfEmbed = $('#modalMedia embed[data-pdf-item]');
  if (pdfEmbed) {
    const token = state.previewToken;
    window.eagleMV.fileURL(pdfEmbed.dataset.pdfItem).then(fileURL => {
      if (!fileURL || token !== state.previewToken || !pdfEmbed.isConnected) return;
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
  $('#prevPreview').disabled = index <= 0;
  $('#nextPreview').disabled = index < 0 || (index >= items.length - 1 && !state.hasMore);
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
    prefetchPreviewNeighbours(id);
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
    $('#modalMedia').innerHTML = `<div class="unsupported-preview"><img src="${mediaURL('thumb', item.id)}" alt=""><p>无法读取 TXT<br><span>${escapeHTML(error.message)}${hasCapability('openDefault') ? ' · 可按 ⇧Enter 用默认应用打开' : ''}</span></p></div>`;
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

function closePreview({ commitSelection = true, skipDiscard = false, syncBroadcast = true } = {}) {
  if (!skipDiscard && state.textSession?.dirty && !confirmDiscardChanges()) return false;
  stopSlideshow();
  const finalId = state.previewId;
  ++state.previewToken;
  state.previewId = null;
  state.textSession = null;
  $('#previewModal').classList.add('hidden');
  $('#modalMedia').innerHTML = '';
  if (finalId && itemById(finalId)) {
    // Collapse the selection onto the final preview item only when the
    // preview was entered with a selection. A touch tap previews without
    // selecting; committing here would turn the next tap into toggle-select
    // instead of another preview.
    if (commitSelection && state.selected.size) {
      state.selectedFolderCard = null;
      state.selected = new Set([finalId]);
      updateCardSelectionStyles();
      renderInspector();
    }
    requestAnimationFrame(() => {
      const card = paneRoot()?.querySelector(`.item-card[data-id="${CSS.escape(finalId)}"]`);
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
  let items = sortedItems();
  let index = items.findIndex(item => item.id === state.previewId);
  let next = items[index + delta];
  if (!next && delta > 0 && state.hasMore) {
    await refresh({ reset: false, preserveScroll: true });
    items = sortedItems();
    index = items.findIndex(item => item.id === state.previewId);
    next = items[index + delta];
  }
  const before = state.previewId;
  if (next) await openPreview(next.id);
  // Stepping by hand during a slideshow restarts the dwell, so the picture you
  // just asked for gets its full turn rather than a leftover sliver of one.
  if (!fromSlideshow && slideshowPlaying()) scheduleSlideshowStep();
  // Report whether the preview actually moved, not merely whether a neighbour
  // existed: openPreview can be refused (an unsaved TXT prompts first), and a
  // slideshow that treated that as success would reopen the same prompt every
  // few seconds.
  return Boolean(next) && state.previewId !== before;
}

function previewDirectionalItemId(key) {
  const root = paneRoot();
  const current = root?.querySelector(`#itemGrid .item-card[data-id="${CSS.escape(state.previewId)}"]`);
  const cards = [...(root?.querySelectorAll('#itemGrid .item-card') || [])];
  return directionalCard(cards, current, key)?.dataset.id || null;
}

async function movePreviewVertically(key) {
  let nextId = previewDirectionalItemId(key);
  if (!nextId && key === 'ArrowDown' && state.hasMore) {
    await refresh({ reset: false, preserveScroll: true });
    nextId = previewDirectionalItemId(key);
  }
  const before = state.previewId;
  if (nextId) await openPreview(nextId);
  if (slideshowPlaying()) scheduleSlideshowStep();
  return Boolean(nextId) && state.previewId !== before;
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
  $('#previewModal').classList.toggle('slideshow-playing', playing);
}

function stopSlideshow() {
  if (state.slideshow.timer) clearTimeout(state.slideshow.timer);
  state.slideshow.timer = null;
  renderSlideshow();
}

function scheduleSlideshowStep() {
  if (state.slideshow.timer) clearTimeout(state.slideshow.timer);
  state.slideshow.timer = setTimeout(async () => {
    state.slideshow.timer = null;
    if (!state.previewId) return renderSlideshow();
    const advanced = await advanceSlideshow();
    if (advanced && state.previewId) scheduleSlideshowStep();
    else stopSlideshow();
  }, state.slideshow.intervalMs);
  renderSlideshow();
}

// Forward one, wrapping to the first item once the list (and its remaining
// pages) run out. A single-item view has nowhere to go and ends the show.
async function advanceSlideshow() {
  const before = state.previewId;
  if (await movePreview(1, { fromSlideshow: true })) return true;
  const items = sortedItems();
  if (items.length < 2 || items[0].id === before) return false;
  return openPreview(items[0].id);
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
  state.currentView = view;
  if (view.kind === 'folder') {
    const folder = findFolder(state.library?.folders, view.id);
    state.viewTitle = folder?.name || '文件夹';
  } else if (view.kind === 'smart') {
    state.viewTitle = view.name || findFolder(state.library?.smartFolders, view.id)?.name || '智能文件夹';
  } else {
    state.viewTitle = ({ root: state.library?.name || '资料库', all: '全部素材', unfiled: '未分类', untagged: '未加标签', recent: '最近使用', random: '随机模式', trash: '回收站', tags: '标签管理' })[view.kind] || '资料库';
  }
  // Eagle remembers the sort per folder. Restoring here — the one place the
  // current view is assigned — covers every navigation path, including the
  // startup root view and library switches.
  const remembered = view.kind === 'folder'
    ? sortMemory.recallFolderSort(state.library?.path, view.id, state.library?.folders, Boolean(state.sortCascade || sortCascadeEnabled))
    : sortMemory.recall(state.library?.path, descriptorKey(view));
  state.sort = remembered?.sort || 'default';
  state.sortDir = remembered?.sortDir || 'auto';
  renderSortControls();
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

function navigate(view, { record = true, refreshView = true, skipDiscard = false, restoreScroll = true, exitSearch = false } = {}) {
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
  const nextQuery = exitSearch && view.kind === 'folder' && currentQuery.search
    ? queryWithoutSearch(currentQuery)
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
  renderQueryControls();
  if (changed) rememberViewPosition();
  state.restoreScroll = changed && restoreScroll ? state.viewMemory.get(descriptorKey(view)) || null : null;
  applyView(view);
  if (view.kind === 'folder') revealFolderPath(view.id);
  $('#viewTitle').textContent = state.viewTitle;
  closePreview({ commitSelection: false, skipDiscard: true });
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
  renderInspector();
  renderFolderTree();
  renderLocation();
  if (refreshView) refresh({ reset: true, preserveScroll: false, quiet: restoring });
  // Picking a destination from the drawer should reveal the result.
  if (isCompactLayout()) closeDrawers();
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
  const previousQuery = state.query;
  state.query = target.hasQuery ? cloneQuery(target.query) : createQuery();
  state.historyIndex = next;
  if (!navigate(target.view, { record: false, skipDiscard: true, restoreScroll: true })) {
    state.historyIndex -= delta;
    state.query = previousQuery;
    renderQueryControls();
    return { status: BACK_STATUS.BLOCKED, action: BACK_ACTION.HISTORY, reason: 'navigation-refused' };
  }
  return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.HISTORY };
}

function closeTopTransientSurface() {
  if (activeMarquee?.started) {
    cancelMarquee({ restoreSelection: true });
    return { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: 'marquee' };
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

function requestBackAction() {
  return window.EagleMVBack.request();
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
  return `<button type="button" class="${classes}" data-crumb-index="${index}" title="${escapeHTML(crumb.label)}"${current ? ' disabled aria-current="page"' : ''}>${escapeHTML(crumb.label)}</button>`;
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
  let crumbs = [{ label: state.library.name || '资料库', view: { kind: 'root' } }];
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
    const payload = { folderId, libraryPath };
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
    // Phones have no menu bar and no right-click: this row is the touch
    // entry point for imports (desktop keeps it too — same pipeline).
    ...(hasCapability('importLocal') ? [contextMenuRow({ icon: 'import', label: state.importing ? '正在导入…' : '导入文件…', shortcut: '⌘ ⇧ O', action: 'import', disabled: !state.connected || state.importing })] : []),
    contextMenuRow({ icon: 'window', label: '新建窗口', shortcut: '⌘ ⌥ N', action: 'new-window' })
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
  if (data.kind === 'new-window-menu') return newWindowMenuMarkup();
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
      contextMenuRow({ icon: 'all', label: '全选', shortcut: '⌘ A', action: 'select-all', disabled: !state.items.length }),
      ...(state.selected.size ? [contextMenuRow({ icon: 'remove', label: '取消选择', action: 'clear-selection' })] : []),
      '<div class="context-menu-separator"></div>',
      newCreationMenuMarkup({ folderId: data.folderId, paneId: data.paneId }),
      '<div class="context-menu-separator"></div>',
      ...(hasCapability('importLocal') ? [contextMenuRow({ icon: 'import', label: state.importing ? '正在导入…' : '导入文件…', action: 'import', disabled: !state.connected || state.importing })] : []),
      contextMenuRow({ icon: 'refresh', label: '刷新所有分栏', action: 'refresh-all', disabled: !state.connected }),
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
    ...(hasCapability('openDefault') ? [contextMenuRow({ icon: 'open', label: '在默认应用打开', shortcut: '⇧ Enter', action: 'open-default', disabled: !one })] : []),
    ...(hasCapability('openOther') ? [contextMenuRow({ icon: 'open', label: '在其它应用打开…', action: 'open-other', disabled: !one })] : []),
    ...(hasCapability('finder') ? [
      contextMenuRow({ icon: 'finder', label: finderLabel, shortcut: '⌘ Enter', action: 'finder' }),
      contextMenuRow({ icon: 'path', label: '打开文件所在的位置', submenu: contextMenuRow({ label: finderLabel, action: 'finder' }) })
    ] : []),
    '<div class="context-menu-separator"></div>',
    contextMenuRow({ icon: 'folder', label: '添加至上次使用的文件夹…', shortcut: '⇧ D', action: 'last-folder', disabled: !state.recentFolders?.length }),
    contextMenuRow({ icon: 'folder', label: '添加至文件夹…', shortcut: '⌘ ⇧ J', submenu: folderEntries }),
    ...(currentFolder ? [contextMenuRow({ icon: 'folder', label: '移动到文件夹…', submenu: moveEntries })] : []),
    ...(hasCapability('export') ? [contextMenuRow({ icon: 'export', label: window.eagleMV.platform === 'web' ? '下载到此设备' : '导出', action: 'export' })] : []),
    ...(hasCapability('share') ? [contextMenuRow({ icon: 'share', label: '分享', action: 'share' })] : []),
    '<div class="context-menu-separator"></div>',
    contextMenuRow({ icon: 'pin', label: data.allPinned ? '取消置顶' : '置顶', action: 'pin', disabled: !currentFolder }),
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

function openNewWindowAt(target = 'multiview') {
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
  if (kind === 'new-menu') return '新建项目';
  return '素材操作菜单';
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
  menu.setAttribute('aria-label', contextMenuAriaLabel(data.kind));
  menu.innerHTML = contextMenuMarkup(state.contextMenu);
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
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  });
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
  if (action === 'import') return importFiles();
  if (action === 'refresh-all') return refreshAllPanes({ reset: true, preserveScroll: true });
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
      toast(result?.downloaded
        ? `已开始下载 ${result?.count || 0} 个文件${(result?.count || 0) > 1 ? '（打包为 zip）' : ''}`
        : `已导出 ${result?.count || 0} 个文件${result?.missing ? ` · ${result.missing} 个原文件缺失` : ''}`, 4000);
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
    if (state.selectedFolderCard === folder.id) renderInspector();
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

function externalDropImportables(dataTransfer) {
  const files = [...(dataTransfer?.files || [])];
  const paths = files.map(file => window.eagleMV.pathForFile(file)).filter(Boolean);
  return paths.length ? paths : (window.eagleMV.platform === 'web' ? files : []);
}

function scheduleExternalFolderImport(dataTransfer, folderId, paneId = state.activePaneId) {
  const importable = externalDropImportables(dataTransfer);
  if (!importable.length) {
    clearDragUI();
    return false;
  }
  const libraryPath = state.library?.path;
  scheduleDropTask(() => importFiles(importable, 'drop', { folderId, libraryPath, paneId }));
  return true;
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

async function addItemsToFolder(ids, folderId, folderName = '目标文件夹', libraryPath = state.library?.path, { move = false, sourceFolderId = null, sourcePaneId = null } = {}) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  if (!uniqueIds.length || !folderId) return false;
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
  const delta = folderMoveDelta(move ? sourceFolderId : null, folderId);
  const moving = delta.remove.length > 0;
  const verb = moving ? '移动' : '归类';
  const operationToken = beginForegroundOperation(`正在${verb} ${uniqueIds.length} 个素材…`, { key: `folder-${moving ? 'move' : 'add'}:${libraryPath}:${folderId}` });
  if (!operationToken) return true;
  setSyncStatus(`正在${verb} ${uniqueIds.length} 个素材…`);
  try {
    const results = await settleWithConcurrency(uniqueIds, id => withTimeout(
      window.eagleMV.mutateSet({
        id,
        field: 'folders',
        ...delta,
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
        if (pane.currentView.kind === 'folder' && pane.currentView.id === sourceFolderId) {
          pane.items = pane.items.filter(item => !movedIds.has(item.id));
          movedIds.forEach(id => { pane.itemMap?.delete(id); });
          pane.total = Math.max(0, (Number(pane.total) || 0) - movedIds.size);
          if ('totalCount' in pane) pane.totalCount = pane.total;
          movedIds.forEach(id => pane.selected.delete(id));
          if (movedIds.has(pane.selectedBase)) pane.selectedBase = null;
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

function paneItemDropContext(targetPaneId, event) {
  const targetPane = paneById(targetPaneId);
  const internalDrag = state.internalDrag;
  const ids = readItemIds(event.dataTransfer, activeDraggedItemIds());
  if (!targetPane || !ids.length) return null;
  let sourcePaneId = state.dragSourcePaneId || internalDrag?.sourcePaneId || null;
  try { sourcePaneId = event.dataTransfer.getData('application/x-eagle-multiview-source-pane') || sourcePaneId; } catch {}
  const sourceIsThisWindow = !internalDrag?.sourceWindowId || internalDrag.sourceWindowId === state.windowId;
  const sourcePane = sourceIsThisWindow && sourcePaneId ? paneById(sourcePaneId) : null;
  const sourceFolderId = sourcePane?.currentView.kind === 'folder'
    ? sourcePane.currentView.id
    : (internalDrag?.sourceFolderId || null);
  return {
    targetPaneId,
    ids,
    libraryPath: internalDrag?.libraryPath || state.library?.path,
    targetFolderId: targetPane.currentView.kind === 'folder' ? targetPane.currentView.id : null,
    sourceFolderId,
    sourcePaneId,
    move: Boolean(sourceFolderId || event.altKey)
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

    if (move && sourceFolderId) {
      const movedIds = new Set();
      results.forEach((res, idx) => { if (res?.ok) movedIds.add(ids[idx]); });
      for (const pane of state.panes) {
        if (pane.currentView.kind === 'folder' && pane.currentView.id === sourceFolderId) {
          pane.items = pane.items.filter(item => !movedIds.has(item.id));
          movedIds.forEach(id => { pane.itemMap?.delete(id); });
          pane.total = Math.max(0, (Number(pane.total) || 0) - movedIds.size);
          if ('totalCount' in pane) pane.totalCount = pane.total;
          movedIds.forEach(id => pane.selected.delete(id));
          if (movedIds.has(pane.selectedBase)) pane.selectedBase = null;
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
  const cardRects = () => {
    const cards = [];
    for (const card of scroller.querySelectorAll('#itemGrid .item-card')) {
      cards.push({
        id: card.dataset.id,
        left: card.offsetLeft,
        top: card.offsetTop,
        right: card.offsetLeft + card.offsetWidth,
        bottom: card.offsetTop + card.offsetHeight
      });
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
    if (event.target.closest('.item-card, .folder-card, button, input, select, textarea, a')) return;
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
  query('#backButton').addEventListener('click', () => { activatePane(paneId); requestBackAction(); });
  query('#forwardButton').addEventListener('click', () => { activatePane(paneId); navigateHistory(1); });
  query('#upButton').addEventListener('click', () => { activatePane(paneId); navigateUp(); });
  const pathRow = root.querySelector('.heading-path-row');
  const breadcrumb = query('#breadcrumb');
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
    if (!button || button.disabled) {
      beginBreadcrumbEdit(breadcrumb, paneId);
      return;
    }
    const crumb = breadcrumb._crumbs?.[Number(button.dataset.crumbIndex)];
    if (crumb) navigate(crumb.view, { restoreScroll: true });
  });
  query('#sortSelectButton')?.addEventListener('click', event => {
    event.stopPropagation();
    activatePane(paneId);
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
      popover.classList.remove('hidden');
      query('#sortSelectButton')?.setAttribute('aria-expanded', 'true');
    }
  });
  query('#sortPopover')?.addEventListener('click', event => {
    const optionBtn = event.target.closest('[data-sort]');
    if (optionBtn) {
      activatePane(paneId);
      const targetSort = optionBtn.dataset.sort;
      if (targetSort === 'random' && state.sort === 'random') {
        state.randomSeed = nextRandomSeed();
        commitSortChange();
      } else {
        const select = query('#sortSelect');
        if (select) {
          select.value = targetSort;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      query('#sortPopover')?.classList.add('hidden');
      query('#sortSelectButton')?.setAttribute('aria-expanded', 'false');
      return;
    }
    const dirBtn = event.target.closest('[data-sort-dir]');
    if (dirBtn && !dirBtn.disabled) {
      activatePane(paneId);
      const targetDir = dirBtn.dataset.sortDir;
      if (targetDir === 'asc' || targetDir === 'desc') {
        state.sortDir = targetDir;
        if (state.sortCascade && state.currentView?.kind === 'folder') {
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
        query('#sortPopover')?.classList.add('hidden');
        query('#sortSelectButton')?.setAttribute('aria-expanded', 'false');
      }
    }
  });
  query('#sortCascadeCheck')?.addEventListener('change', event => {
    activatePane(paneId);
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
    activatePane(paneId);
    state.sort = event.target.value;
    state.sortDir = 'auto';
    // Picking 随机 deals a new order; re-picking it from the dropdown fires no
    // change event, which is why the direction button doubles as reshuffle.
    if (state.sort === 'random') state.randomSeed = nextRandomSeed();
    if (state.sortCascade && state.currentView?.kind === 'folder') {
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
    if (state.sort !== 'default' && state.hasMore) refresh({ reset: false, preserveScroll: true, paneId });
  });
  query('#viewModeGroup').addEventListener('click', event => {
    const button = event.target.closest('[data-view-mode]');
    if (!button) return;
    activatePane(paneId);
    setPaneViewMode(button.dataset.viewMode, paneId);
  });
  query('#itemGrid').addEventListener('click', event => {
    activatePane(paneId);
    if (Date.now() < suppressTouchClickUntil) return;
    const tagAction = event.target.closest('[data-tag-action]');
    if (tagAction) {
      executeTagManagerAction(tagAction.dataset.tagAction, {
        tagName: tagAction.dataset.tagName,
        groupId: tagAction.dataset.tagGroupId
      }).catch(error => toast(`标签操作失败：${error.message}`, 4200));
      return;
    }
    const touch = isTouchEvent(event);
    const folder = event.target.closest('.folder-card');
    if (folder) {
      const folderId = folder.dataset.openFolder;
      // Touch: a tap enters the folder directly (no double-tap on phones).
      if (touch && !state.selected.size) { enterFolderFromGrid(folderId); return; }
      selectFolderCard(folderId);
      return;
    }
    const card = event.target.closest('.item-card');
    if (card) {
      const id = card.dataset.id;
      if (touch) {
        // Touch: tap previews; with a selection active it toggles instead.
        if (state.selected.size) {
          selectItem(id, true);
        } else {
          openPreview(id);
          broadcastPaneAction(() => {
            if (itemById(id)) openPreview(id);
          });
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
    const dropKind = classifyDrop(event.dataTransfer, activeDraggedItemIds());
    if (dropKind === 'unsupported') return;
    event.preventDefault();
    event.stopPropagation();
    folder.classList.remove('drop-target');
    if (dropKind === 'external-files') {
      scheduleExternalFolderImport(event.dataTransfer, folder.dataset.openFolder, paneId);
      return;
    }
    const ids = readItemIds(event.dataTransfer, activeDraggedItemIds());
    if (!ids.length) {
      toast('无法识别拖入的素材，请重新拖动', 3500);
      clearDragUI();
      return;
    }
    const target = findFolder(state.library?.folders, folder.dataset.openFolder);
    const libraryPath = state.internalDrag?.libraryPath || state.library?.path;
    const sourceFolderId = state.internalDrag?.sourceFolderId || null;
    const move = Boolean(sourceFolderId || event.altKey);
    const sourcePaneId = state.internalDrag?.sourcePaneId || state.dragSourcePaneId || paneId;
    scheduleDropTask(() => addItemsToFolder(ids, folder.dataset.openFolder, target?.name, libraryPath, { move, sourceFolderId, sourcePaneId }));
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
    if (classifyDrop(event.dataTransfer, fallbackIds) === 'unsupported') return;
    event.preventDefault();
    if (!activatePane(paneId)) {
      clearDragUI();
      return;
    }
    if (!hasCapability('importLocal') || !shouldShowImportOverlay(event.dataTransfer, fallbackIds)) return;
    state.dragDepth += 1;
    $('#dropOverlay').classList.remove('hidden');
  });
  scroller.addEventListener('dragover', event => {
    const fallbackIds = activeDraggedItemIds();
    const dropKind = classifyDrop(event.dataTransfer, fallbackIds);
    if (dropKind === 'unsupported') return;
    event.preventDefault();
    event.dataTransfer.dropEffect = dropKind === 'internal-items' ? (event.altKey ? 'move' : 'copy') : 'copy';
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
    if (classifyDrop(event.dataTransfer, fallbackIds) === 'internal-items') {
      const context = paneItemDropContext(paneId, event);
      if (!context) {
        toast('无法识别拖入的素材，请重新拖动', 3500);
        clearDragUI();
        return;
      }
      scheduleDropTask(() => handlePaneItemDrop(context));
      return;
    }
    const importable = externalDropImportables(event.dataTransfer);
    if (!importable.length) {
      clearDragUI();
      return;
    }
    const targetPane = paneById(paneId);
    const target = {
      paneId,
      libraryPath: state.library?.path,
      folderId: targetPane?.currentView.kind === 'folder' ? targetPane.currentView.id : null
    };
    scheduleDropTask(() => importFiles(importable, 'drop', target));
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
    query('#prevPreview')?.addEventListener('click', () => {
      activatePane(paneId);
      withActivePane(paneId, () => movePreview(-1));
      broadcastPaneAction(pane => {
        if (pane.previewId) movePreview(-1);
      });
    });
    query('#nextPreview')?.addEventListener('click', () => {
      activatePane(paneId);
      withActivePane(paneId, () => movePreview(1));
      broadcastPaneAction(pane => {
        if (pane.previewId) movePreview(1);
      });
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
      activatePane(paneId);
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
    const settleSwipe = event => {
      const session = swipeSession;
      if (!session || event.pointerId !== session.pointerId) return;
      swipeSession = null;
      const image = paneQuery(paneId, '#modalMedia img.preview-image');
      const dx = event.clientX - session.startX;
      const dy = event.clientY - session.startY;
      if (Math.hypot(dx, dy) > 15) swipeClickSuppressUntil = Date.now() + 400;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        withActivePane(paneId, () => movePreview(dx < 0 ? 1 : -1));
        broadcastPaneAction(pane => {
          if (pane.previewId) movePreview(dx < 0 ? 1 : -1);
        });
        return;
      }
      if (dy > 90 && dy > Math.abs(dx) * 1.4) {
        withActivePane(paneId, () => closePreview());
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
    previewModal.addEventListener('pointerdown', event => {
      const image = paneQuery(paneId, '#modalMedia img.preview-image');
      if (!previewModal.classList.contains('image-gesture')) return;
      if (event.target.closest('#slideshowControls, #modalRating')) return;
      const pane = paneById(paneId);
      if (!pane) return;
      if (event.pointerType === 'touch') {
        previewPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture(event.pointerId);
        if (previewPointers.size === 2) {
          if (!image) return;
          pane.previewZoom.dragging = false;
          if (swipeSession) {
            swipeSession = null;
            image.style.transform = '';
          }
          pinchBase = { ...pinchGeometry(), scale: pane.previewZoom.mode === 'fit' ? 1 : pane.previewZoom.scale };
          return;
        }
        if (!image || pane.previewZoom.mode === 'fit') {
          swipeSession = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
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
      if (swipeSession && event.pointerId === swipeSession.pointerId && previewPointers.size === 1) {
        previewPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const image = paneQuery(paneId, '#modalMedia img.preview-image');
        if (image) image.style.transform = `translateX(${event.clientX - swipeSession.startX}px)`;
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
  }
}

function bindEvents() {
  bindWorkspaceResizers();
  bindToolbarWrapState();
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
  $('#newWindowButton').addEventListener('click', requestDefaultNewWindow);
  $('#newWindowMenuButton').addEventListener('click', event => {
    event.stopPropagation();
    if (!$('#contextMenu').classList.contains('hidden') && state.contextMenu?.kind === 'new-window-menu') {
      hideContextMenu();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setAttribute('aria-expanded', 'true');
    showContextMenuAt(rect.right - 294, rect.bottom + 6, { kind: 'new-window-menu' });
  });
  $('#currentEaglePathButton').addEventListener('click', navigateToCurrentEaglePath);
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
    if (!event.target.closest('#libraryButton, #libraryPopover')) closeLibraryPopover();
    if (!event.target.closest('.sort-select-control')) {
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
    setSyncPanesEnabled(event.target.checked);
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
        }
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
    // The synthetic click that ends a touch long-press must not dismiss the
    // menu that same long-press just opened. Cards were exempted by selector;
    // the folder tree and the pane heading need the shared timestamp.
    if (Date.now() < suppressTouchClickUntil) return;
    if (!event.target.closest('#contextMenu') && !event.target.closest('.item-card') && !event.target.closest('#newButton') && !event.target.closest('.new-window-control')) hideContextMenu();
  });
  for (const selector of ['#itemName', '#itemURL']) {
    $(selector).addEventListener('input', markDirty);
    $(selector).addEventListener('blur', () => queueInspectorAutoSave({ immediate: true }));
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
      // Adding a tag keeps the selection, the way removing one already does
      // (removeTagFromSelection passes keepSelection) — the items are all
      // still on screen, and losing them after one tag makes the second tag a
      // re-selection chore.
      pane.selected = new Set(outcome.failed.length
        ? outcome.failed
        : ids.filter(id => pane.items.some(item => item.id === id)));
      $('#batchTagInput').value = '';
      setTagValues('batch', [], false);
      await refresh({ reset: true, preserveScroll: true, paneId });
      if (state.activePaneId === paneId) withActivePane(paneId, () => {
        updateCardSelectionStyles();
        renderInspector();
      });
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
  $('#prevPreview').addEventListener('click', () => movePreview(-1));
  $('#nextPreview').addEventListener('click', () => movePreview(1));
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
    if (event.pointerType === 'touch') {
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
    if (swipeSession && event.pointerId === swipeSession.pointerId && previewPointers.size === 1) {
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
    if (window.eagleMV.platform === 'web') {
      // The web client can only upload files present in the browser paste
      // event; the host-clipboard fallback is meaningless remotely.
      if (!clipboardFiles.length) return;
      event.preventDefault();
      importFiles(clipboardFiles, 'paste-files');
      return;
    }
    event.preventDefault();
    importFiles(paths.length ? paths : null, paths.length ? 'paste-files' : 'clipboard');
  });

  document.addEventListener('focusin', event => {
    if (isInspectorEditor(event.target)) state.inspectorEditing = true;
    else if (!event.target.closest?.('#inspectorContent')) state.inspectorEditing = false;
  });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest?.('#inspectorContent')) state.inspectorEditing = false;
  }, true);

  document.addEventListener('keydown', event => {
    // event.target is the most reliable source; activeElement is retained for
    // synthetic/app-menu events. inspectorEditing is a final safety net if a
    // browser or future render unexpectedly blurs the editor between keys.
    const editable = isEditableElement(event.target) || isEditableElement() || state.inspectorEditing;
    const previewOpen = !$('#previewModal').classList.contains('hidden');
    if (event.key === 'Escape') {
      if (activeMarquee?.started) { event.preventDefault(); cancelMarquee({ restoreSelection: true }); return; }
      if (!$('#folderDialog').classList.contains('hidden')) { event.preventDefault(); closeFolderDialog(); return; }
      if (!$('#webAccessDialog').classList.contains('hidden')) { event.preventDefault(); closeWebAccessDialog(); return; }
      if (!$('#trashDialog').classList.contains('hidden')) { event.preventDefault(); closeTrashDialog(); return; }
      if (!$('#duplicateDialog').classList.contains('hidden')) { event.preventDefault(); closeDuplicateDialog('cancel'); return; }
      if (!$('#contextMenu').classList.contains('hidden')) { event.preventDefault(); hideContextMenu(); return; }
      if (document.querySelector('.sort-popover:not(.hidden)')) {
        event.preventDefault();
        for (const p of document.querySelectorAll('.sort-popover:not(.hidden)')) p.classList.add('hidden');
        for (const b of document.querySelectorAll('.sort-select-button[aria-expanded="true"]')) b.setAttribute('aria-expanded', 'false');
        return;
      }
      if (previewOpen) { event.preventDefault(); closePreview(); return; }
      if (!editable && (state.selected.size || state.selectedFolderCard) && confirmDiscardChanges()) {
        state.selected.clear();
        state.selectedFolderCard = null;
        updateCardSelectionStyles();
        renderInspector();
      }
      return;
    }
    if (!editable && (event.altKey || event.ctrlKey) && event.key === 'ArrowLeft') {
      event.preventDefault();
      requestBackAction();
      return;
    }
    if (!editable && event.metaKey && event.key === '[') {
      event.preventDefault();
      requestBackAction();
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
    if (!editable && !previewOpen && primaryKey && !event.shiftKey && !event.altKey && deleteKey && selectedIds.length) {
      event.preventDefault();
      setTrash(selectedIds, true);
      return;
    }
    if (!editable && (event.metaKey || event.ctrlKey) && !event.altKey) {
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
         (!primaryKey && event.key === 'F2' && state.selected.size === 1))) {
      event.preventDefault();
      requestRenameSelection().catch(error => toast(`重命名失败：${error.message}`, 4000));
      return;
    }
    if (primaryKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); $('#searchInput').focus(); }
    if (!editable && event.metaKey && event.shiftKey && event.key.toLowerCase() === 'l') { event.preventDefault(); togglePanel('sidebar'); }
    if (!editable && event.metaKey && event.shiftKey && event.key.toLowerCase() === 'i') { event.preventDefault(); togglePanel('inspector'); }
    if (!editable && event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); locateCurrentFolder(); }
    if (!editable && hasCapability('openDefault') && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'Enter' && (state.previewId || state.selected.size === 1)) {
      event.preventDefault();
      openWithDefault(state.previewId || [...state.selected][0]);
      return;
    }
    if (!editable && !previewOpen && !primaryKey && !event.shiftKey && !event.altKey && event.key === 'Enter' && state.selectedFolderCard) { event.preventDefault(); enterFolderFromGrid(state.selectedFolderCard); }
    else if (!editable && !previewOpen && !primaryKey && !event.shiftKey && !event.altKey && event.key === 'Enter' && state.selected.size === 1) { event.preventDefault(); openPreview([...state.selected][0]); }
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
    if (!editable && event.code === 'Space' && previewOpen) {
      event.preventDefault();
      // Eagle: space toggles playback while a video/audio preview is open;
      // for stills it keeps closing the preview.
      const media = $('#modalMedia video, #modalMedia audio');
      if (media) media.paused ? media.play().catch(() => {}) : media.pause();
      else closePreview();
    } else if (!editable && event.code === 'Space' && state.selected.size) {
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
    if (!editable && hasCapability('clipboardFiles') && !event.shiftKey && !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && state.selected.size) {
      const selection = window.getSelection?.();
      const hasTextSelection = Boolean(selection && !selection.isCollapsed && selection.toString().length > 0);
      if (!hasTextSelection) {
        event.preventDefault();
        copySelectedFiles([...state.selected]).catch(error => toast(`复制失败：${error.message}`, 4000));
      }
    }
    if (!editable && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && !previewOpen && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      moveCardFocus(event.key);
    }
    if (!editable && (event.altKey || event.ctrlKey) && event.key === 'ArrowUp') { event.preventDefault(); navigateUp(); }
    if (!editable && (event.altKey || event.ctrlKey) && event.key === 'ArrowRight') { event.preventDefault(); navigateHistory(1); }
    if (!editable && event.metaKey && event.key === ']') { event.preventDefault(); navigateHistory(1); }
    if (!editable && !previewOpen && ['PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const scrollGrid = key => {
        const grid = $('#gridScroller');
        if (!grid) return;
        const top = key === 'Home' ? 0 : key === 'End' ? grid.scrollHeight : grid.scrollTop + (key === 'PageDown' ? 1 : -1) * grid.clientHeight * .86;
        grid.scrollTo({ top, behavior: key.startsWith('Page') ? 'smooth' : 'auto' });
      };
      scrollGrid(event.key);
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
function closeWebAccessDialog() {
  $('#webAccessDialog').classList.add('hidden');
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
    button.disabled = true;
    try {
      const status = await window.eagleMV.setWebAccess({
        enabled: $('#webAccessEnabled').checked,
        port: Number($('#webAccessPort').value) || 41600,
        requireKey: !$('#webAccessNoKey').checked
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
    await window.eagleMV.copyText(key);
    toast('访问密钥已复制');
  });
  $('#webAccessAddresses').addEventListener('click', async event => {
    const qrToggle = event.target.closest('[data-qr-index]');
    if (qrToggle) {
      $(`[data-qr-panel="${qrToggle.dataset.qrIndex}"]`)?.classList.toggle('hidden');
      return;
    }
    const entry = event.target.closest('[data-url]');
    if (!entry) return;
    await window.eagleMV.copyText(entry.dataset.url);
    toast('访问地址已复制');
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
    saveSessionState();
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
  window.eagleMV.onWebAccessRequest(() => openWebAccessDialog());
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
  window.eagleMV.onNewWindowRequest(requestDefaultNewWindow);
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
    if (pendingLibraryChange) scheduleLibraryChange(pendingLibraryChange);
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
  const hadUnsaved = state.inspectorDirty || state.textSession?.dirty;
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
    toast(hadUnsaved ? 'Eagle 已切换资料库；旧资料库的未保存修改已取消' : 'Eagle 已切换资料库，所有窗口已跟随', 4200);
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
      for (const pane of state.panes) {
        if (pane.currentView.kind === 'folder' && deleted.has(pane.currentView.id)) {
          withActivePane(pane.id, () => navigate({ kind: 'root' }, { record: false, refreshView: false, skipDiscard: true }));
        } else if (pane.selectedFolderCard && deleted.has(pane.selectedFolderCard)) {
          pane.selectedFolderCard = null;
          if (pane.id === state.activePaneId) withActivePane(pane.id, () => renderInspector());
        }
      }
      reconciliation = reconcileLibraryChangePanes();
      renderReconciledLibraryPanes();
      toast('当前文件夹已在 Eagle 中删除，已返回资料库根目录', 4000);
    }
  }

  await refreshAllPanes({ reset: true, preserveScroll: true });
  if (reconciliation.missingSmartFolder) toast('当前智能文件夹已在 Eagle 中移除，已返回资料库根目录', 4000);
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

async function start() {
  installBackRouter(backActionRouter);
  bindEvents();
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
  try {
    const interval = Number(localStorage.getItem(SLIDESHOW_INTERVAL_KEY));
    if ([...$('#slideshowInterval').options].some(option => Number(option.value) === interval)) {
      state.slideshow.intervalMs = interval;
    }
  } catch {}
  $('#slideshowInterval').value = String(state.slideshow.intervalMs);
  renderSlideshow();
  try {
    const stored = JSON.parse(localStorage.getItem(PREVIEW_VIEW_KEY) || 'null');
    if (PREVIEW_BACKGROUNDS.some(option => option.key === stored?.background)) state.previewView.background = stored.background;
    state.previewView.grayscale = Boolean(stored?.grayscale);
  } catch {}
  renderPreviewView();
  renderPanels();
  renderQueryControls();
  try {
    state.windowId = await window.eagleMV.identity();
    const { app, library } = await window.eagleMV.connect();
    state.library = library;
    recordAppliedLibrarySnapshot({ library });
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
        recordAppliedLibrarySnapshot({ library: result.library });
        await loadLibraryExtras();
        setConnection(true);
        renderFolderTree();
        const initial = await restoreInitialWindowState();
        if (!initial) restoreSavedSessionPanes();
        else renderFolderTree();
        await refreshAllPanes({ reset: true, preserveScroll: false });
      } catch {}
    }, 2500);
  }
}

start();
