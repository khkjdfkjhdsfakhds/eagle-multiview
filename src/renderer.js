'use strict';

const $ = selector => document.querySelector(selector);
const state = {
  connected: false,
  library: null,
  items: [],
  total: 0,
  offset: 0,
  nextOffset: 0,
  hasMore: false,
  pageSize: 160,
  loading: false,
  refreshToken: 0,
  selected: new Set(),
  selectedBase: null,
  inspectorDirty: false,
  query: { folderId: null, smartFolderId: null, search: '', tags: [], ext: '', rating: null, unfiled: true, random: false },
  sort: 'default',
  viewTitle: '资料库',
  refreshTimer: null,
  toastTimer: null,
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
  previewToken: 0,
  availableTags: [],
  tagColors: {},
  recentFolders: [],
  draftTags: [],
  batchTags: [],
  copiedTags: [],
  contextMenu: null,
  trashDialogResolve: null,
  localPins: {},
  importing: false,
  dragDepth: 0,
  draggingItemIds: null
};

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
    export: '<path d="M10 3v9M6.5 6.5 10 3l3.5 3.5M4 12.5V17h12v-4.5"></path>'
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

function toast(message, duration = 2400) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.add('hidden'), duration);
}

function setSyncStatus(text) {
  $('#syncText').textContent = text;
}

function setConnection(connected, message) {
  state.connected = connected;
  document.body.classList.toggle('offline', !connected);
  $('#connectionDot').className = `connection-dot ${connected ? 'online' : 'offline'}`;
  $('#connectionText').textContent = connected ? (state.library?.name || '已连接 Eagle') : (message || 'Eagle 未连接');
  for (const selector of ['#importButton', '#addFolderButton', '#trashButton', '#batchTrashButton', '#batchTagButton']) {
    $(selector).disabled = !connected;
  }
  $('#pinButton').disabled = !connected || state.currentView.kind !== 'folder' || state.selected.size !== 1;
  $('#saveButton').disabled = !connected || !state.inspectorDirty;
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
  if (state.sort === 'name') items.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
  if (state.sort === 'newest') items.sort((a, b) => (b.modificationTime || 0) - (a.modificationTime || 0));
  if (state.sort === 'size') items.sort((a, b) => (b.size || 0) - (a.size || 0));
  if (state.sort === 'resolution') items.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));
  if (state.currentView.kind === 'folder') {
    items.sort((a, b) => {
      const left = pinTimestamp(a);
      const right = pinTimestamp(b);
      if (left && !right) return -1;
      if (!left && right) return 1;
      return right - left;
    });
  }
  return items;
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

function findFolder(nodes, id) {
  for (const folder of nodes || []) {
    if (folder.id === id) return folder;
    const child = findFolder(folder.children, id);
    if (child) return child;
  }
  return null;
}

function findFolderPath(nodes, id, trail = []) {
  for (const folder of nodes || []) {
    const next = [...trail, folder];
    if (folder.id === id) return next;
    const child = findFolderPath(folder.children, id, next);
    if (child) return child;
  }
  return [];
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

function confirmDiscardChanges({ includeText = true } = {}) {
  const textDirty = includeText && state.textSession?.dirty;
  if (!state.inspectorDirty && !textDirty) return true;
  const subjects = [state.inspectorDirty && '素材信息', textDirty && 'TXT 内容'].filter(Boolean).join('和');
  const discard = confirm(`${subjects}有尚未保存的修改。\n\n按“确定”放弃修改并继续；按“取消”留在当前内容。`);
  if (discard) {
    state.inspectorDirty = false;
    if (state.textSession) state.textSession.dirty = false;
  }
  return discard;
}

function filtersActive() {
  return Boolean(state.query.search.trim() || state.query.tags.length || state.query.ext || Number.isInteger(state.query.rating));
}

function renderFilterState() {
  const active = filtersActive();
  $('#clearFiltersButton').classList.toggle('hidden', !active);
  $('#filterButton').classList.toggle('active', active || !$('#filterPopover').classList.contains('hidden'));
  const count = [state.query.search.trim(), state.query.tags.length, state.query.ext, Number.isInteger(state.query.rating)].filter(value => Boolean(value)).length;
  $('#filterCount').textContent = count;
  $('#filterCount').classList.toggle('hidden', !count);
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
  chips.innerHTML = tagValues(kind).map(tag => {
    const color = state.tagColors[tag];
    return `<span class="tag-chip"${color ? ` style="--tag-color:${escapeHTML(color)}"` : ''}><span title="${escapeHTML(tag)}">${escapeHTML(tag)}</span><button type="button" data-remove-tag="${escapeHTML(tag)}" aria-label="移除 ${escapeHTML(tag)}">×</button></span>`;
  }).join('');
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
    scheduleTagFilterRefresh();
  }
}

function commitTagInput(kind) {
  const input = $(tagEditors[kind].input);
  const pending = normalizeTags(input.value.split(/[,，\n]+/));
  if (!pending.length) return false;
  setTagValues(kind, [...tagValues(kind), ...pending]);
  input.value = '';
  return true;
}

function removeTag(kind, tag) {
  setTagValues(kind, tagValues(kind).filter(value => value !== tag));
}

const scheduleTagFilterRefresh = debounce(() => refresh({ reset: true, preserveScroll: false }), 260);

function renderTagSuggestions() {
  $('#tagSuggestions').innerHTML = state.availableTags.slice(0, 1000).map(tag => `<option value="${escapeHTML(tag.name || tag)}"></option>`).join('');
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

async function updateTagColor(tag, color) {
  if (!tag || !/^#[0-9a-f]{6}$/i.test(color || '')) return;
  try {
    state.tagColors = await window.eagleMV.setTagColor({ libraryPath: state.library?.path, tag, color });
    renderTagColors();
    renderTagEditor('item');
    renderTagEditor('batch');
    renderTagEditor('filter');
  } catch (error) {
    toast(`标签颜色保存失败：${error.message}`, 4000);
  }
}

function clearFilters() {
  state.query.search = '';
  state.query.tags = [];
  state.query.ext = '';
  state.query.rating = null;
  $('#searchInput').value = '';
  setTagValues('filter', [], false);
  $('#extFilter').value = '';
  $('#ratingFilter').value = '';
  renderFilterState();
  refresh({ reset: true, preserveScroll: false });
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
  for (const card of document.querySelectorAll('#itemGrid .folder-card')) {
    card.classList.toggle('selected', card.dataset.openFolder === state.selectedFolderCard);
  }
  for (const card of document.querySelectorAll('#itemGrid .item-card')) {
    card.classList.toggle('selected', state.selected.has(card.dataset.id));
  }
}

function selectFolderCard(id) {
  if (!confirmDiscardChanges()) return;
  state.selectedFolderCard = id;
  state.selected.clear();
  updateCardSelectionStyles();
  renderInspector();
  requestAnimationFrame(() => document.querySelector(`.folder-card[data-open-folder="${CSS.escape(id)}"]`)?.focus());
}

function focusSelectedCard() {
  const selectedFolder = state.selectedFolderCard && document.querySelector(`.folder-card[data-open-folder="${CSS.escape(state.selectedFolderCard)}"]`);
  const selectedItemId = state.selected.size === 1 ? [...state.selected][0] : null;
  const selectedItem = selectedItemId && document.querySelector(`.item-card[data-id="${CSS.escape(selectedItemId)}"]`);
  return selectedFolder || selectedItem || document.querySelector('#itemGrid .folder-card, #itemGrid .item-card');
}

function moveCardFocus(key) {
  const cards = [...document.querySelectorAll('#itemGrid .folder-card, #itemGrid .item-card')];
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
  const items = sortedItems();
  const folders = visibleChildFolders();
  $('#emptyState').classList.toggle('hidden', items.length > 0 || folders.length > 0 || state.loading);
  const folderSection = folders.length
    ? `<div class="grid-section-heading"><span>子文件夹</span><span>${folders.length.toLocaleString()}</span></div>${folders.map(folderCardMarkup).join('')}`
    : '';
  const itemSection = items.length && folders.length
    ? `<div class="grid-section-heading"><span>文件</span><span>${state.total.toLocaleString()}</span></div>`
    : '';
  $('#itemGrid').innerHTML = `${folderSection}${itemSection}${items.map(item => {
    const ext = String(item.ext || '').trim().toLowerCase().replace(/^\./, '');
    const isGif = ext === 'gif';
    const thumbURL = `eaglemv://thumb/${encodeURIComponent(item.id)}`;
    const originalURL = `eaglemv://original/${encodeURIComponent(item.id)}`;
    return `
    <article class="item-card ${state.selected.has(item.id) ? 'selected' : ''} ${itemIsPinned(item) ? 'pinned' : ''}" data-id="${escapeHTML(item.id)}" draggable="true" tabindex="0">
      <div class="thumb-wrap">
        <img loading="lazy" src="${thumbURL}" alt="${escapeHTML(item.name)}"${isGif ? ` data-gif-static="${thumbURL}" data-gif-animated="${originalURL}"` : ''}>
        ${itemIsPinned(item) ? `<span class="pin-badge" title="已在当前文件夹置顶">${eagleIcon('ic-toolbar-pin.svg', 'pin-icon')}</span>` : ''}
        ${(isGif || (!isImageItem(item) && item.ext)) ? `<span class="format-badge${isGif ? ' gif-badge' : ''}">${escapeHTML(itemFormat(item))}</span>` : ''}
      </div>
      <div class="card-name" title="${escapeHTML(item.name)}">${escapeHTML(item.name)}</div>
      <div class="card-meta">${item.width || 0}×${item.height || 0} · ${formatBytes(item.size)}</div>
    </article>`;
  }).join('')}`;
  for (const card of document.querySelectorAll('#itemGrid .item-card')) bindGifHover(card);
  for (const image of document.querySelectorAll('.thumb-wrap img, .folder-cover img')) {
    if (image.complete) image.classList.add('loaded');
    image.addEventListener('load', () => image.classList.add('loaded'), { once: true });
  }
  scroller.scrollTop = preserveScroll ? scrollTop : 0;
  updateScrollUI();
  window.eagleMV.watchItems(items.slice(0, 300).map(item => item.id)).catch(() => {});
}

function updateScrollUI() {
  const scroller = $('#gridScroller');
  const loaded = state.items.length;
  const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const percent = maximum ? Math.max(0, Math.min(100, Math.round(scroller.scrollTop / maximum * 100))) : 0;
  $('#scrollStatus').textContent = `已载入 ${loaded.toLocaleString()} / ${state.total.toLocaleString()}${maximum ? ` · ${percent}%` : ''}`;
  $('#scrollTopButton').classList.toggle('hidden', scroller.scrollTop < Math.max(240, scroller.clientHeight * 0.6));
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
        <span class="folder-icon">${eagleIcon('ic-filter-item-folder.svg')}</span><span class="folder-name">${escapeHTML(folder.name)}</span>
        ${Number.isFinite(count) ? `<span class="folder-count">${count}</span>` : ''}
      </button>
      ${children.length && expanded ? `<div class="folder-children">${folderHTML(children)}</div>` : ''}
    </div>`;
  }).join('');
  const smartHTML = (state.library.smartFolders || []).map(folder => `
    <button class="folder-row ${state.currentView.kind === 'smart' && state.currentView.id === folder.id ? 'active' : ''}" data-smart-folder-id="${escapeHTML(folder.id)}" data-folder-name="${escapeHTML(folder.name)}">
      <span class="folder-toggle spacer"></span><span class="folder-icon smart">${uiIcon('smart')}</span><span class="folder-name">${escapeHTML(folder.name)}</span>
    </button>`).join('');
  const quickHTML = quickAccessEntries().map(folder => folder.quickType === 'smart'
    ? `<button class="folder-row ${state.currentView.kind === 'smart' && state.currentView.id === folder.id ? 'active' : ''}" data-smart-folder-id="${escapeHTML(folder.id)}" data-folder-name="${escapeHTML(folder.name)}">
      <span class="folder-toggle spacer"></span><span class="folder-icon smart">${uiIcon('smart')}</span><span class="folder-name">${escapeHTML(folder.name)}</span></button>`
    : `<button class="folder-row ${state.currentView.kind === 'folder' && state.currentView.id === folder.id ? 'active' : ''}" data-folder-id="${escapeHTML(folder.id)}" data-folder-name="${escapeHTML(folder.name)}">
      <span class="folder-toggle spacer"></span><span class="folder-icon">${eagleIcon('ic-filter-item-folder.svg')}</span><span class="folder-name">${escapeHTML(folder.name)}</span>${Number.isFinite(folder.descendantImageCount) ? `<span class="folder-count">${folder.descendantImageCount}</span>` : ''}</button>`).join('');
  tree.innerHTML = `
    <button class="folder-row ${state.currentView.kind === 'root' ? 'active' : ''}" data-special="root"><span class="folder-toggle spacer"></span><span class="folder-icon special">${uiIcon('library')}</span><span class="folder-name">资料库根目录</span></button>
    <button class="folder-row ${state.currentView.kind === 'all' ? 'active' : ''}" data-special="all"><span class="folder-toggle spacer"></span><span class="folder-icon special">${eagleIcon('ic-sidebar-all.svg')}</span><span class="folder-name">全部素材</span></button>
    <button class="folder-row ${state.currentView.kind === 'unfiled' ? 'active' : ''}" data-special="unfiled"><span class="folder-toggle spacer"></span><span class="folder-icon special">${eagleIcon('ic-sidebar-unfiled.svg')}</span><span class="folder-name">未分类</span></button>
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
    row.addEventListener('dragover', event => { event.preventDefault(); row.classList.add('drop-target'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', async event => {
      event.preventDefault();
      row.classList.remove('drop-target');
      if (!state.connected) {
        toast('Eagle 未连接，暂时无法修改归类', 3500);
        return;
      }
      try {
        let ids = JSON.parse(event.dataTransfer.getData('application/x-eagle-multiview-items') || '[]');
        if ((!Array.isArray(ids) || !ids.length) && state.draggingItemIds?.length) ids = state.draggingItemIds;
        if (!Array.isArray(ids) || !ids.length) return;
        setSyncStatus(`正在归类 ${ids.length} 个素材…`);
        await Promise.all(ids.map(id => window.eagleMV.mutateSet({
          id,
          field: 'folders',
          add: [row.dataset.folderId],
          libraryPath: state.library?.path
        })));
        toast(`已加入“${row.dataset.folderName}”`);
      } catch (error) {
        toast(`归类失败：${error.message}`, 4000);
      } finally {
        setSyncStatus('所有窗口已同步');
      }
    });
  }
}

async function refresh({ reset = true, preserveScroll = true } = {}) {
  if (state.loading && !reset) return;
  const refreshToken = ++state.refreshToken;
  state.loading = true;
  $('#loadIndicator').classList.remove('hidden');
  setSyncStatus('正在同步…');
  try {
    const selectedId = state.selected.size === 1 ? [...state.selected][0] : null;
    const selectedBefore = selectedId ? itemById(selectedId) : null;
    const offset = reset ? 0 : state.nextOffset;
    const query = structuredClone(state.query);
    const page = state.currentView.kind === 'recent'
      ? { data: [], total: 0, nextOffset: 0, hasMore: false }
      : state.currentView.kind === 'trash'
        ? await window.eagleMV.getTrashItems({ ...query, libraryPath: state.library?.path, offset, limit: state.pageSize })
        : await window.eagleMV.query({ ...query, offset, limit: state.pageSize });
    if (page.error) {
      const error = new Error(page.error.message || '读取失败');
      error.code = page.error.code;
      throw error;
    }
    if (refreshToken !== state.refreshToken) return;
    state.total = page.total || 0;
    state.nextOffset = page.nextOffset ?? (offset + (page.data || []).length);
    state.hasMore = Boolean(page.hasMore ?? (state.nextOffset < state.total));
    state.items = reset ? (page.data || []) : [...state.items, ...(page.data || []).filter(next => !state.items.some(item => item.id === next.id))];
    const childCount = visibleChildFolders().length;
    $('#resultCount').textContent = childCount
      ? `${childCount.toLocaleString()} 个文件夹 · ${page.estimated ? '约 ' : ''}${state.total.toLocaleString()} 个文件`
      : `${page.estimated ? '约 ' : ''}${state.total.toLocaleString()} 个文件`;
    $('#viewTitle').textContent = state.viewTitle;
    renderLocation();
    renderGrid({ preserveScroll: preserveScroll && reset });
    if (reset && selectedId) {
      const selectedAfter = itemById(selectedId);
      if (!selectedAfter) {
        state.selected.clear();
        renderInspector();
      } else if (!state.inspectorDirty) {
        renderInspector();
      } else if (JSON.stringify(selectedBefore) !== JSON.stringify(selectedAfter)) {
        $('#staleBanner').classList.remove('hidden');
      }
    }
    setSyncStatus(`已同步 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
    setConnection(true);
  } catch (error) {
    if (refreshToken !== state.refreshToken) return;
    if (state.currentView.kind === 'trash' && error?.code === 'TRASH_SCAN_TIMEOUT') {
      state.items = [];
      state.total = 0;
      state.nextOffset = 0;
      state.hasMore = false;
      $('#resultCount').textContent = '读取失败，请重试';
      $('#viewTitle').textContent = state.viewTitle;
      renderLocation();
      renderGrid({ preserveScroll: false });
      setConnection(true);
      setSyncStatus('回收站读取超时');
      toast(error.message, 5000);
    } else {
      setConnection(false, error.message);
      toast(`无法读取 Eagle：${error.message}`, 4000);
    }
  } finally {
    if (refreshToken === state.refreshToken) {
      state.loading = false;
      $('#loadIndicator').classList.add('hidden');
      $('#emptyState').classList.toggle('hidden', state.items.length > 0 || visibleChildFolders().length > 0);
      updateScrollUI();
      const scroller = $('#gridScroller');
      if (state.hasMore && scroller.scrollHeight <= scroller.clientHeight + 80) {
        setTimeout(() => refresh({ reset: false, preserveScroll: true }), 0);
      }
    }
  }
}

const scheduleRefresh = debounce(() => refresh({ reset: true, preserveScroll: true }), 320);

function itemById(id) { return state.items.find(item => item.id === id); }

function selectItem(id, additive = false, range = false) {
  const staysOnSameItem = !additive && !range && state.selected.size === 1 && state.selected.has(id);
  if (staysOnSameItem) return true;
  if (!staysOnSameItem && !confirmDiscardChanges()) return false;
  state.selectedFolderCard = null;
  if (range && state.selected.size) {
    const items = sortedItems();
    const anchor = items.findIndex(item => state.selected.has(item.id));
    const target = items.findIndex(item => item.id === id);
    if (!additive) state.selected.clear();
    for (let index = Math.min(anchor, target); index <= Math.max(anchor, target); index += 1) state.selected.add(items[index].id);
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

function renderInspector() {
  const count = state.selected.size;
  $('#noSelection').classList.toggle('hidden', count !== 0);
  $('#inspectorContent').classList.toggle('hidden', count !== 1);
  $('#multiSelection').classList.toggle('hidden', count < 2);
  if (count >= 2) {
    $('#multiCount').textContent = count;
    const allDeleted = [...state.selected].every(id => itemById(id)?.isDeleted);
    $('#batchTrashButton').textContent = allDeleted ? '恢复素材' : '移入废纸篓…';
    state.selectedBase = null;
    state.inspectorDirty = false;
    return;
  }
  if (count !== 1) {
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
    return;
  }
  const id = [...state.selected][0];
  const item = itemById(id);
  if (!item) return;
  state.selectedBase = structuredClone(item);
  state.inspectorDirty = false;
  $('#staleBanner').classList.add('hidden');
  $('#itemName').value = item.name || '';
  setTagValues('item', item.tags || [], false);
  $('#itemRating').value = String(item.star || 0);
  $('#itemAnnotation').value = item.annotation || '';
  $('#itemURL').value = item.url || '';
  $('#saveButton').disabled = true;
  $('#previewBox').innerHTML = `<img src="eaglemv://thumb/${encodeURIComponent(item.id)}" alt="${escapeHTML(item.name)}">${item.ext ? `<span class="preview-format-badge">${escapeHTML(itemFormat(item))}</span>` : ''}`;
  $('#itemMeta').innerHTML = `<span>${escapeHTML(String(item.ext || '').toUpperCase())}</span><span>${formatBytes(item.size)}</span><span>${item.width || 0} × ${item.height || 0}</span><span>${new Date(item.modificationTime || 0).toLocaleDateString('zh-CN')}</span>`;
  $('#trashButton').textContent = item.isDeleted ? '恢复素材' : '移入废纸篓…';
  const canPin = state.currentView.kind === 'folder';
  $('#pinButton').disabled = !canPin || !state.connected;
  $('#pinButton').textContent = canPin && itemIsPinned(item) ? '取消置顶' : '置顶';
  $('#pinButton').title = canPin ? '在当前文件夹内置顶；会同步到所有 MultiView 窗口' : '与 Eagle 原版一致，置顶只在普通文件夹中可用';
}

function markDirty() {
  state.inspectorDirty = Object.keys(collectPatch()).length > 0;
  $('#saveButton').disabled = !state.inspectorDirty || !state.connected;
  if (!state.inspectorDirty && !$('#staleBanner').classList.contains('hidden')) renderInspector();
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

async function saveInspector(force = false) {
  const id = [...state.selected][0];
  const patch = collectPatch();
  if (!id || !Object.keys(patch).length) {
    state.inspectorDirty = false;
    $('#saveButton').disabled = true;
    return;
  }
  $('#saveButton').disabled = true;
  setSyncStatus('正在安全保存…');
  try {
    const result = await window.eagleMV.mutate({ id, patch, base: state.selectedBase, force, libraryPath: state.library?.path });
    if (result.conflict) {
      const fields = result.conflicts.map(conflict => conflict.field).join('、');
      const overwrite = confirm(`另一个窗口或 Eagle 已修改：${fields}\n\n按“确定”以当前窗口的内容覆盖这些字段；按“取消”载入最新内容。`);
      if (overwrite) return saveInspector(true);
      const index = state.items.findIndex(item => item.id === id);
      if (index >= 0) state.items[index] = result.current;
      renderGrid();
      renderInspector();
      toast('已载入另一窗口的最新内容');
      return;
    }
    const index = state.items.findIndex(item => item.id === id);
    if (index >= 0) state.items[index] = result.item;
    renderGrid();
    renderInspector();
    toast('修改已同步到所有窗口');
  } catch (error) {
    toast(`保存失败：${error.message}`, 4000);
    $('#saveButton').disabled = false;
  } finally {
    setSyncStatus('所有窗口已同步');
  }
}

async function setPinned(ids, pinned) {
  if (state.currentView.kind !== 'folder' || !ids?.length) {
    toast('置顶只在普通文件夹中可用', 3200);
    return;
  }
  try {
    state.localPins = await window.eagleMV.setPins({
      libraryPath: state.library?.path,
      folderId: state.currentView.id,
      ids,
      pinned
    });
    renderGrid();
    renderInspector();
    toast(pinned ? `已在当前文件夹置顶 ${ids.length} 个素材` : `已取消 ${ids.length} 个素材的置顶`);
  } catch (error) {
    toast(`置顶操作失败：${error.message}`, 4000);
  }
}

function closeTrashDialog(choice = null) {
  $('#trashDialog').classList.add('hidden');
  const resolve = state.trashDialogResolve;
  state.trashDialogResolve = null;
  resolve?.(choice);
}

async function canRemoveFromCurrentFolder(ids) {
  const currentFolder = state.currentView.kind === 'folder' ? state.currentView.id : null;
  if (!currentFolder) return false;
  const items = await Promise.all(ids.map(async id => itemById(id) || window.eagleMV.getItem(id).catch(() => null)));
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

async function applyTrash(ids, deleted) {
  if (!ids.length) return;
  const action = deleted ? '移入废纸篓' : '恢复';
  setSyncStatus(`正在${action}…`);
  try {
    for (const id of ids) {
      const item = itemById(id) || await window.eagleMV.getItem(id);
      const result = await window.eagleMV.mutate({
        id,
        patch: { isDeleted: deleted },
        base: item,
        libraryPath: state.library?.path
      });
      if (result.conflict) throw new Error('素材已在其他窗口发生变化，请刷新后重试');
    }
    state.selected.clear();
    renderInspector();
    await refresh({ reset: true, preserveScroll: true });
    toast(`已${action}`);
  } catch (error) {
    toast(`${action}失败：${error.message}`, 4000);
  } finally {
    setSyncStatus('所有窗口已同步');
  }
}

async function setTrash(ids, deleted) {
  if (!ids.length) return;
  if (!deleted) return applyTrash(ids, false);
  if (!(await canRemoveFromCurrentFolder(ids))) return applyTrash(ids, true);
  const choice = await chooseTrashAction(ids);
  if (choice === 'remove') return removeSelectionFromFolder({ ids, folderId: state.currentView.id });
  if (choice === 'delete') return applyTrash(ids, true);
}

async function mutateSelectionSet(ids, field, delta, message) {
  if (!ids?.length || !state.connected) return;
  setSyncStatus(message);
  try {
    await Promise.all(ids.map(id => window.eagleMV.mutateSet({
      id,
      field,
      ...delta,
      libraryPath: state.library?.path
    })));
    state.selected.clear();
    renderInspector();
    await refresh({ reset: true, preserveScroll: true });
    toast('操作已同步到所有窗口');
  } catch (error) {
    toast(`操作失败：${error.message}`, 4000);
  } finally {
    setSyncStatus('所有窗口已同步');
  }
}

function addSelectionToFolder(payload) {
  const folderId = payload?.folderId;
  if (!folderId) return;
  mutateSelectionSet(payload.ids, 'folders', { add: [folderId] }, '正在加入文件夹…');
}

function moveSelectionToFolder(payload) {
  const folderId = payload?.folderId;
  if (!folderId) return;
  const ids = payload?.ids || [...state.selected];
  if (!ids.length || !state.connected) return;
  setSyncStatus('正在移动到文件夹…');
  Promise.all(ids.map(async id => {
    const item = itemById(id) || await window.eagleMV.getItem(id);
    const remove = (item.folders || []).filter(value => value !== folderId);
    return window.eagleMV.mutateSet({ id, field: 'folders', add: [folderId], remove, libraryPath: state.library?.path });
  })).then(async () => {
    state.selected.clear();
    renderInspector();
    await refresh({ reset: true, preserveScroll: true });
    toast('已移动到目标文件夹');
  }).catch(error => toast(`移动失败：${error.message}`, 4000)).finally(() => setSyncStatus('所有窗口已同步'));
}

function removeSelectionFromFolder(payload) {
  const folderId = payload?.folderId || (state.currentView.kind === 'folder' ? state.currentView.id : null);
  if (!folderId) return;
  mutateSelectionSet(payload.ids, 'folders', { remove: [folderId] }, '正在从文件夹移除…');
}

function addTagToSelection(payload) {
  const tags = normalizeTags(Array.isArray(payload?.tag) ? payload.tag : [payload?.tag]);
  if (!tags.length) return;
  mutateSelectionSet(payload.ids, 'tags', { add: tags }, '正在添加标签…');
}

async function setSelectionRating(payload) {
  const rating = Math.max(0, Math.min(5, Number(payload?.rating) || 0));
  const ids = payload?.ids || [...state.selected];
  if (!ids.length || !state.connected) return;
  setSyncStatus('正在设置评分…');
  try {
    await Promise.all(ids.map(async id => {
      const item = itemById(id) || await window.eagleMV.getItem(id);
      return window.eagleMV.mutate({ id, patch: { star: rating }, base: item, libraryPath: state.library?.path });
    }));
    await refresh({ reset: true, preserveScroll: true });
    toast(`已设置为 ${rating ? `${rating} 星` : '未评分'}`);
  } catch (error) {
    toast(`评分失败：${error.message}`, 4000);
  } finally {
    setSyncStatus('所有窗口已同步');
  }
}

function mediaMarkup(item) {
  const url = `eaglemv://original/${encodeURIComponent(item.id)}`;
  const ext = String(item.ext || '').toLowerCase();
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv'].includes(ext)) return `<video src="${url}" controls autoplay></video>`;
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)) return `<audio src="${url}" controls autoplay></audio>`;
  if (ext === 'pdf') return `<embed src="${url}" type="application/pdf" width="100%" height="100%">`;
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif', 'bmp'].includes(ext)) return `<img src="${url}" alt="${escapeHTML(item.name)}">`;
  return `<div class="unsupported-preview"><img src="eaglemv://thumb/${encodeURIComponent(item.id)}" alt="${escapeHTML(item.name)}"><p>${escapeHTML(String(item.ext || '文件').toUpperCase())} 无法直接预览<br><span>按 ⌘O 使用默认应用打开</span></p></div>`;
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
  editor.addEventListener('input', () => {
    session.content = editor.value;
    session.dirty = session.content !== session.original;
    $('#saveTextButton').disabled = !session.dirty || !state.connected;
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
    $('#modalMedia').innerHTML = `<div class="unsupported-preview"><img src="eaglemv://thumb/${encodeURIComponent(item.id)}" alt=""><p>无法读取 TXT<br><span>${escapeHTML(error.message)} · 可按 ⌘O 用默认应用打开</span></p></div>`;
    return false;
  }
}

async function saveTextPreview(force = false) {
  const session = state.textSession;
  if (!session?.dirty) return;
  $('#saveTextButton').disabled = true;
  $('#textStatus').textContent = '正在安全保存…';
  try {
    const result = await window.eagleMV.saveText({
      id: session.id,
      libraryPath: state.library?.path,
      content: session.content,
      base: session.fingerprint,
      force
    });
    if (result.conflict) {
      const overwrite = confirm('这个 TXT 已在另一个窗口或其他应用中修改。\n\n按“确定”用当前编辑内容覆盖；按“取消”载入磁盘上的最新内容。');
      if (overwrite) return saveTextPreview(true);
      session.content = result.current.content;
      session.original = result.current.content;
      session.fingerprint = result.current.fingerprint;
      session.dirty = false;
      renderTextPreview(session);
      toast('已载入磁盘上的最新 TXT 内容');
      return;
    }
    session.fingerprint = result.fingerprint;
    session.original = session.content;
    session.dirty = false;
    $('#saveTextButton').disabled = true;
    $('#textStatus').textContent = `已保存 · ${formatBytes(result.fingerprint.size)}`;
    toast('TXT 已安全保存；原版本已备份');
  } catch (error) {
    $('#saveTextButton').disabled = false;
    $('#textStatus').textContent = '保存失败';
    toast(`TXT 保存失败：${error.message}`, 4400);
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
      const card = document.querySelector(`.item-card[data-id="${CSS.escape(finalId)}"]`);
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

function applyView(view) {
  state.currentView = { ...view };
  state.query.folderId = view.kind === 'folder' ? view.id : null;
  state.query.smartFolderId = view.kind === 'smart' ? view.id : null;
  state.query.unfiled = view.kind === 'root' || view.kind === 'unfiled';
  state.query.random = view.kind === 'random';
  if (view.kind === 'folder') {
    const folder = findFolder(state.library?.folders, view.id);
    state.viewTitle = folder?.name || '文件夹';
  } else if (view.kind === 'smart') {
    state.viewTitle = view.name || '智能文件夹';
  } else {
    state.viewTitle = ({ root: state.library?.name || '资料库', all: '全部素材', unfiled: '未分类', recent: '最近使用', random: '随机模式', trash: '回收站' })[view.kind] || '资料库';
  }
}

function navigate(view, { record = true, refreshView = true, skipDiscard = false } = {}) {
  if (!state.library) return;
  const changed = descriptorKey(view) !== descriptorKey(state.currentView);
  if (!skipDiscard && !confirmDiscardChanges()) return false;
  if (record && changed) {
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push({ ...view });
    state.historyIndex = state.history.length - 1;
  } else if (record && state.historyIndex < 0) {
    state.history = [{ ...view }];
    state.historyIndex = 0;
  }
  applyView(view);
  $('#viewTitle').textContent = state.viewTitle;
  closePreview({ commitSelection: false, skipDiscard: true });
  state.selected.clear();
  state.selectedFolderCard = null;
  if (changed) {
    state.items = [];
    state.total = 0;
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
  if (state.currentView.kind !== 'folder') return null;
  const path = findFolderPath(state.library?.folders, state.currentView.id);
  return path.length > 1 ? { kind: 'folder', id: path.at(-2).id } : { kind: 'root' };
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
  state.importing = true;
  $('#importButton').disabled = true;
  $('#importButton').textContent = '导入中…';
  setSyncStatus('正在导入到 Eagle…');
  try {
    const payload = { folderId: importTargetFolderId(), libraryPath: state.library?.path };
    const result = source === 'clipboard'
      ? await window.eagleMV.importClipboard(payload)
      : await window.eagleMV.importItems({ ...payload, ...(paths?.length ? { paths } : {}) });
    if (result.canceled) return;
    if (!result.count) {
      toast(source === 'clipboard' ? '剪贴板里没有可导入的文件或图片' : (result.rejected?.[0]?.message || '没有可导入的文件'), 3800);
      return;
    }
    await window.eagleMV.focusWindow().catch(() => {});
    await refresh({ reset: true, preserveScroll: true });
    const pending = Math.max(0, result.count - result.ready);
    const rejected = result.rejected?.length || 0;
    toast(`已接收 ${result.count} 个素材${pending ? ` · ${pending} 个仍由 Eagle 后台处理` : ''}${rejected ? ` · 跳过 ${rejected} 个` : ''}`, 4200);
    if (pending) {
      setTimeout(() => refresh({ reset: true, preserveScroll: true }), 1600);
      setTimeout(() => refresh({ reset: true, preserveScroll: true }), 4200);
    }
  } catch (error) {
    toast(`导入失败：${error.message}`, 4600);
  } finally {
    state.importing = false;
    $('#importButton').disabled = !state.connected;
    $('#importButton').textContent = '导入';
    setSyncStatus('所有窗口已同步');
  }
}

function bindTagEditor(kind) {
  const config = tagEditors[kind];
  const input = $(config.input);
  const chips = $(config.chips);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
      event.preventDefault();
      commitTagInput(kind);
    } else if (event.key === 'Backspace' && !input.value && tagValues(kind).length) {
      removeTag(kind, tagValues(kind).at(-1));
    }
  });
  input.addEventListener('blur', () => commitTagInput(kind));
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
  input.closest('.tag-editor').addEventListener('click', event => {
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

function contextFolderEntries(action) {
  const entries = [];
  const visit = (nodes, depth = 0) => (nodes || []).forEach(folder => {
    if (entries.length >= 80) return;
    if (folder.id !== state.contextMenu?.folderId) entries.push(contextMenuRow({ icon: 'folder', label: `${'  '.repeat(Math.min(depth, 3))}${folder.name}`, action, payload: { folderId: folder.id } }));
    visit(folder.children, depth + 1);
  });
  visit(state.library?.folders);
  return entries.join('') || contextMenuRow({ label: '没有可用文件夹', disabled: true });
}

function contextTagEntries(action = 'add-tag') {
  const tags = (state.availableTags || []).map(tag => typeof tag === 'string' ? tag : tag?.name).filter(Boolean).slice(0, 30);
  return tags.length
    ? tags.map(tag => contextMenuRow({ icon: 'tag', label: tag, action, payload: { tag } })).join('')
    : contextMenuRow({ label: '暂无已有标签', disabled: true });
}

function contextMenuMarkup(data) {
  const one = data.ids.length === 1;
  const currentFolder = state.currentView.kind === 'folder' ? state.currentView.id : null;
  const folderEntries = contextFolderEntries('add-folder');
  const moveEntries = contextFolderEntries('move-folder');
  const ratingEntries = [0, 1, 2, 3, 4, 5].map(rating => contextMenuRow({ icon: 'more', label: rating ? `${'★'.repeat(rating)}（${rating} 星）` : '未评分', action: 'rating', payload: { rating } })).join('');
  const moreEntries = [
    contextMenuRow({ icon: 'rename', label: '重命名', shortcut: '⌘ R', action: 'rename', disabled: !one }),
    contextMenuRow({ icon: 'copy', label: one ? '复制素材名称' : `复制 ${data.ids.length} 个素材名称`, action: 'copy-name' }),
    contextMenuRow({ icon: 'copy', label: '复制标签', shortcut: '⌘ ⇧ C', action: 'copy-tags' }),
    contextMenuRow({ icon: 'tag', label: '粘贴标签', shortcut: '⌘ ⇧ V', action: 'paste-tags' }),
    contextMenuRow({ icon: 'more', label: '设置评分', submenu: ratingEntries }),
    contextMenuRow({ icon: 'tag', label: '标签颜色', submenu: contextTagEntries('tag-color') })
  ].join('');
  return [
    contextMenuRow({ icon: 'window', label: '在新窗口打开', shortcut: '⌘ O', action: 'open-window' }),
    contextMenuRow({ icon: 'open', label: '在默认应用打开', shortcut: '⇧ Enter', action: 'open-default', disabled: !one }),
    contextMenuRow({ icon: 'open', label: '在其它应用打开', submenu: contextMenuRow({ label: '暂未提供其它应用列表', disabled: true }) }),
    contextMenuRow({ icon: 'finder', label: '在 Finder 中显示', shortcut: '⌘ Enter', action: 'finder' }),
    contextMenuRow({ icon: 'path', label: '打开文件所在的位置', submenu: contextMenuRow({ label: '在 Finder 中显示', action: 'finder' }) }),
    '<div class="context-menu-separator"></div>',
    contextMenuRow({ icon: 'folder', label: '添加至上次使用的文件夹…', shortcut: '⇧ D', action: 'last-folder', disabled: !state.recentFolders?.length }),
    contextMenuRow({ icon: 'folder', label: '添加至文件夹…', shortcut: '⌘ ⇧ J', submenu: folderEntries }),
    contextMenuRow({ icon: 'folder', label: '移动到文件夹…', submenu: moveEntries }),
    contextMenuRow({ icon: 'export', label: '导出', submenu: contextMenuRow({ label: '导出功能暂未提供', disabled: true }) }),
    contextMenuRow({ icon: 'share', label: '分享', disabled: true }),
    '<div class="context-menu-separator"></div>',
    contextMenuRow({ icon: 'pin', label: data.allPinned ? '取消置顶' : '置顶', action: 'pin', disabled: !currentFolder }),
    contextMenuRow({ icon: 'copy', label: one ? '复制文件' : `复制 ${data.ids.length} 个文件`, shortcut: '⌘ C', action: 'copy-files' }),
    contextMenuRow({ icon: 'path', label: '复制文件路径', shortcut: '⌘ ⌥ C', action: 'copy-path', disabled: !one }),
    contextMenuRow({ icon: 'copy', label: '复制…', submenu: contextMenuRow({ label: '复制到其它位置暂未提供', disabled: true }) }),
    contextMenuRow({ icon: 'copy', label: '创建副本', shortcut: '⌘ D', disabled: true }),
    contextMenuRow({ icon: 'more', label: '更多', submenu: moreEntries }),
    '<div class="context-menu-separator"></div>',
    ...(currentFolder ? [contextMenuRow({ icon: 'remove', label: '从文件夹中移除', shortcut: '⌘ ⇧ ⌫', action: 'remove-folder' })] : []),
    contextMenuRow({ icon: 'trashMenu', label: data.allDeleted ? '恢复素材' : '丢到回收站…', shortcut: '⌘ ⌫', action: 'trash', danger: !data.allDeleted })
  ].join('');
}

function hideContextMenu() {
  state.contextMenu = null;
  $('#contextMenu').classList.add('hidden');
  $('#contextMenu').innerHTML = '';
}

function showContextMenu(event, data) {
  state.contextMenu = { ...data, x: event.clientX, y: event.clientY };
  const menu = $('#contextMenu');
  menu.innerHTML = contextMenuMarkup(state.contextMenu);
  menu.classList.remove('hidden');
  menu.style.left = `${Math.max(8, event.clientX)}px`;
  menu.style.top = `${Math.max(8, event.clientY)}px`;
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
  });
}

async function executeContextAction(action, payload) {
  const data = state.contextMenu;
  if (!data) return;
  const ids = data.ids;
  const firstId = ids[0];
  if (action === 'open-window') return window.eagleMV.newWindow();
  if (action === 'open-default') return openWithDefault(firstId);
  if (action === 'finder') return window.eagleMV.showInFinder(firstId).then(ok => { if (!ok) toast('找不到素材原文件', 3500); });
  if (action === 'copy-files') return copySelectedFiles(ids);
  if (action === 'copy-name') return window.eagleMV.copyText(ids.map(id => itemById(id)?.name || '').filter(Boolean).join('\n'));
  if (action === 'copy-path') {
    const filePath = await window.eagleMV.filePath(firstId);
    if (filePath) await window.eagleMV.copyText(filePath);
    else toast('找不到素材原文件', 3500);
    return;
  }
  if (action === 'copy-tags') {
    state.copiedTags = normalizeTags(ids.flatMap(id => itemById(id)?.tags || []));
    toast(state.copiedTags.length ? `已复制 ${state.copiedTags.length} 个标签` : '所选素材没有标签');
    return;
  }
  if (action === 'paste-tags') return addTagToSelection({ ids, tag: state.copiedTags });
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
    selectItem(firstId);
    requestAnimationFrame(() => $('#itemName').focus());
    return;
  }
  if (action === 'trash') return setTrash(ids, !data.allDeleted);
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

function bindEvents() {
  $('#newWindowButton').addEventListener('click', () => window.eagleMV.newWindow().catch(error => toast(`无法新建窗口：${error.message}`, 4000)));
  $('#toggleSidebarButton').addEventListener('click', () => togglePanel('sidebar'));
  $('#toggleInspectorButton').addEventListener('click', () => togglePanel('inspector'));
  $('#clearFiltersButton').addEventListener('click', clearFilters);
  $('#filterButton').addEventListener('click', () => {
    $('#filterPopover').classList.toggle('hidden');
    renderFilterState();
  });
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
  });
  $('#backButton').addEventListener('click', () => navigateHistory(-1));
  $('#forwardButton').addEventListener('click', () => navigateHistory(1));
  $('#upButton').addEventListener('click', navigateUp);
  $('#breadcrumb').addEventListener('click', event => {
    const button = event.target.closest('[data-crumb-index]');
    if (button) navigate($('#breadcrumb')._crumbs[Number(button.dataset.crumbIndex)].view);
  });
  $('#refreshButton').addEventListener('click', () => refresh({ reset: true, preserveScroll: true }));
  $('#importButton').addEventListener('click', () => importFiles());
  $('#trashRemoveButton').addEventListener('click', () => closeTrashDialog('remove'));
  $('#trashDeleteButton').addEventListener('click', () => closeTrashDialog('delete'));
  $('#trashCancelButton').addEventListener('click', () => closeTrashDialog());
  $('#trashDialog').addEventListener('click', event => {
    if (event.target === event.currentTarget) closeTrashDialog();
  });
  $('#addFolderButton').addEventListener('click', async () => {
    const name = prompt('新文件夹名称');
    if (!name?.trim()) return;
    try {
      await window.eagleMV.createFolder({ name: name.trim(), parent: state.query.folderId, libraryPath: state.library?.path });
      toast('文件夹已创建');
    } catch (error) {
      toast(`创建失败：${error.message}`, 4000);
    }
  });
  $('#searchInput').addEventListener('input', debounce(event => { state.query.search = event.target.value; renderFilterState(); refresh({ reset: true, preserveScroll: false }); }, 280));
  for (const kind of Object.keys(tagEditors)) bindTagEditor(kind);
  $('#extFilter').addEventListener('change', event => { state.query.ext = event.target.value; renderFilterState(); refresh({ reset: true, preserveScroll: false }); });
  $('#ratingFilter').addEventListener('change', event => { state.query.rating = event.target.value === '' ? null : Number(event.target.value); renderFilterState(); refresh({ reset: true, preserveScroll: false }); });
  $('#sortSelect').addEventListener('change', event => { state.sort = event.target.value; renderGrid(); });
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
  $('#itemGrid').addEventListener('click', event => {
    const folder = event.target.closest('.folder-card');
    if (folder) {
      selectFolderCard(folder.dataset.openFolder);
      return;
    }
    const card = event.target.closest('.item-card');
    if (card) selectItem(card.dataset.id, event.metaKey || event.ctrlKey, event.shiftKey);
  });
  $('#itemGrid').addEventListener('dblclick', event => {
    const folder = event.target.closest('.folder-card');
    if (folder) { navigate({ kind: 'folder', id: folder.dataset.openFolder }); return; }
    const card = event.target.closest('.item-card');
    if (card) openPreview(card.dataset.id);
  });
  $('#itemGrid').addEventListener('dragstart', event => {
    const card = event.target.closest('.item-card');
    if (!card) return;
    if (!state.selected.has(card.dataset.id)) selectItem(card.dataset.id);
    const ids = [...state.selected];
    state.draggingItemIds = ids;
    event.dataTransfer.setData('application/x-eagle-multiview-items', JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'copy';
    window.eagleMV.startDrag(ids);
    event.preventDefault();
  });
  $('#itemGrid').addEventListener('contextmenu', event => {
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
  $('#contextMenu').addEventListener('click', event => {
    const row = event.target.closest('[data-context-action]');
    if (!row || row.classList.contains('disabled')) return;
    let payload = {};
    try { payload = JSON.parse(row.dataset.contextPayload || '{}'); } catch {}
    const execution = executeContextAction(row.dataset.contextAction, payload);
    hideContextMenu();
    execution.catch(error => toast(`操作失败：${error.message}`, 4000));
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
    if (!event.target.closest('#contextMenu') && !event.target.closest('.item-card')) hideContextMenu();
  });
  $('#gridScroller').addEventListener('scroll', event => {
    const element = event.currentTarget;
    updateScrollUI();
    if (!state.loading && state.hasMore && element.scrollTop + element.clientHeight > element.scrollHeight - 500) refresh({ reset: false, preserveScroll: true });
  });
  $('#scrollTopButton').addEventListener('click', () => $('#gridScroller').scrollTo({ top: 0, behavior: 'smooth' }));
  for (const selector of ['#itemName', '#itemRating', '#itemAnnotation', '#itemURL']) $(selector).addEventListener('input', markDirty);
  $('#saveButton').addEventListener('click', () => saveInspector());
  $('#pinButton').addEventListener('click', () => {
    const item = itemById([...state.selected][0]);
    if (item) setPinned([item.id], !itemIsPinned(item));
  });
  $('#openDefaultButton').addEventListener('click', () => { const id = [...state.selected][0]; if (id) openWithDefault(id); });
  $('#finderButton').addEventListener('click', async () => {
    const id = [...state.selected][0];
    if (!id) return;
    try {
      if (!await window.eagleMV.showInFinder(id)) toast('找不到素材原文件', 3500);
    } catch (error) {
      toast(`无法在 Finder 中显示：${error.message}`, 4000);
    }
  });
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
    setSyncStatus('正在合并标签…');
    try {
      await Promise.all([...state.selected].map(id => window.eagleMV.mutateSet({
        id,
        field: 'tags',
        add: tags,
        libraryPath: state.library?.path
      })));
      $('#batchTagInput').value = '';
      setTagValues('batch', [], false);
      toast(`已为 ${state.selected.size} 个素材添加标签`);
    } catch (error) {
      toast(`添加标签失败：${error.message}`, 4000);
    } finally {
      setSyncStatus('所有窗口已同步');
    }
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

  const scroller = $('#gridScroller');
  scroller.addEventListener('dragenter', event => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    state.dragDepth += 1;
    $('#dropOverlay').classList.remove('hidden');
  });
  scroller.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  scroller.addEventListener('dragleave', () => {
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth) $('#dropOverlay').classList.add('hidden');
  });
  scroller.addEventListener('drop', event => {
    state.dragDepth = 0;
    $('#dropOverlay').classList.add('hidden');
    if (state.draggingItemIds?.length) return;
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    const paths = [...event.dataTransfer.files].map(file => window.eagleMV.pathForFile(file)).filter(Boolean);
    if (paths.length) importFiles(paths, 'drop');
  });
  document.addEventListener('paste', event => {
    const editable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (editable) return;
    const paths = [...(event.clipboardData?.files || [])].map(file => window.eagleMV.pathForFile(file)).filter(Boolean);
    event.preventDefault();
    importFiles(paths.length ? paths : null, paths.length ? 'paste-files' : 'clipboard');
  });

  document.addEventListener('keydown', event => {
    const editable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    const previewOpen = !$('#previewModal').classList.contains('hidden');
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); $('#searchInput').focus(); }
    if (!editable && event.metaKey && event.shiftKey && event.key.toLowerCase() === 'l') { event.preventDefault(); togglePanel('sidebar'); }
    if (!editable && event.metaKey && event.shiftKey && event.key.toLowerCase() === 'i') { event.preventDefault(); togglePanel('inspector'); }
    if (!editable && event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); locateCurrentFolder(); }
    if (!editable && !previewOpen && event.key === 'Enter' && state.selectedFolderCard) { event.preventDefault(); navigate({ kind: 'folder', id: state.selectedFolderCard }); }
    else if (!editable && !previewOpen && event.key === 'Enter' && state.selected.size === 1) { event.preventDefault(); openPreview([...state.selected][0]); }
    if (!editable && event.code === 'Space' && previewOpen) { event.preventDefault(); closePreview(); }
    else if (!editable && event.code === 'Space' && state.selected.size === 1) { event.preventDefault(); openPreview([...state.selected][0]); }
    if (!editable && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o' && (state.previewId || state.selected.size === 1)) {
      event.preventDefault();
      openWithDefault(state.previewId || [...state.selected][0]);
    }
    if (!editable && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
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
    if (event.key === 'Escape') {
      if (!$('#trashDialog').classList.contains('hidden')) { event.preventDefault(); closeTrashDialog(); return; }
      if (!$('#contextMenu').classList.contains('hidden')) { hideContextMenu(); return; }
      if (!$('#previewModal').classList.contains('hidden')) closePreview();
      else if (!editable && (state.selected.size || state.selectedFolderCard) && confirmDiscardChanges()) {
        state.selected.clear();
        state.selectedFolderCard = null;
        updateCardSelectionStyles();
        renderInspector();
      }
    }
    if (previewOpen && !editable && event.key === 'ArrowLeft') { event.preventDefault(); movePreview(-1); }
    if (previewOpen && !editable && event.key === 'ArrowRight') { event.preventDefault(); movePreview(1); }
    if ((event.key === 'Backspace' || event.key === 'Delete') && !editable && !previewOpen && state.selected.size) setTrash([...state.selected], true);
  });
}

function bindHubEvents() {
  window.eagleMV.onDragFinished(result => {
    state.draggingItemIds = null;
    if (!result?.ok) toast(`拖动失败：${result?.message || '无法导出素材文件'}`, 4000);
    else if (result.missing) toast(`已拖动 ${result.count} 个文件 · ${result.missing} 个原文件缺失`, 3500);
  });
  window.eagleMV.onRequestClose(() => {
    const hasUnsaved = state.inspectorDirty || state.textSession?.dirty;
    if (hasUnsaved && !confirm('当前窗口有尚未保存的素材信息或 TXT 内容。\n\n按“确定”放弃修改并关闭窗口；按“取消”继续编辑。')) {
      window.eagleMV.cancelClose();
      return;
    }
    state.inspectorDirty = false;
    if (state.textSession) state.textSession.dirty = false;
    window.eagleMV.confirmClose();
  });
  window.eagleMV.onTrashSelection(payload => setTrash(payload?.ids || [...state.selected], payload?.deleted ?? true));
  window.eagleMV.onPinSelection(payload => setPinned(payload?.ids || [...state.selected], payload.pinned));
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
  window.eagleMV.onImportRequest(() => importFiles());
  window.eagleMV.onPinsChanged(payload => {
    if (payload.libraryPath !== state.library?.path) return;
    state.localPins = payload.pins || {};
    renderGrid();
    renderInspector();
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
    for (const changed of payload.items || []) {
      const index = state.items.findIndex(item => item.id === changed.id);
      if (index >= 0) state.items[index] = changed;
      if (state.selected.has(changed.id)) touchedSelection = true;
    }
    renderGrid();
    if (touchedSelection) {
      if (state.inspectorDirty && payload.origin !== state.windowId) $('#staleBanner').classList.remove('hidden');
      else renderInspector();
    }
    setSyncStatus(payload.source === 'multiview' ? '所有窗口已同步' : '已接收 Eagle 的外部修改');
  });
  window.eagleMV.onLibraryChanged(async payload => {
    const pathChanged = state.library?.path && state.library.path !== payload.library.path;
    const hadUnsaved = state.inspectorDirty || state.textSession?.dirty;
    state.library = payload.library;
    $('#windowTitle').textContent = `Eagle MultiView — ${payload.library.name}`;
    setConnection(true);
    if (pathChanged) {
      state.query = { folderId: null, smartFolderId: null, search: '', tags: [], ext: '', rating: null, unfiled: true, random: false };
      state.expandedFolders.clear();
      state.history = [];
      state.historyIndex = -1;
      state.selected.clear();
      state.selectedFolderCard = null;
      state.inspectorDirty = false;
      if (state.textSession) state.textSession.dirty = false;
      closePreview({ commitSelection: false, skipDiscard: true });
      $('#searchInput').value = '';
      setTagValues('filter', [], false);
      $('#extFilter').value = '';
      $('#ratingFilter').value = '';
      await loadLibraryExtras();
      renderFilterState();
      navigate({ kind: 'root' });
      toast(hadUnsaved ? 'Eagle 已切换资料库；旧资料库的未保存修改已取消' : 'Eagle 已切换资料库，所有窗口已跟随', 4200);
    } else {
      await loadLibraryExtras();
      if (state.currentView.kind === 'folder' && !findFolder(state.library.folders, state.currentView.id)) {
        if (confirmDiscardChanges()) {
          navigate({ kind: 'root' });
          toast('当前文件夹已在 Eagle 中删除，已返回资料库根目录');
        } else {
          renderFolderTree();
          toast('当前文件夹已被删除；请先处理未保存修改', 4000);
        }
        return;
      }
      renderFolderTree();
      renderGrid();
      renderLocation();
      scheduleRefresh();
    }
  });
  window.eagleMV.onQueryInvalidated(() => scheduleRefresh());
}

async function loadLibraryExtras() {
  const libraryPath = state.library?.path;
  if (!libraryPath) return;
  const [pins, tags, recentFolders, tagColors] = await Promise.all([
    window.eagleMV.getPins({ libraryPath }).catch(() => ({})),
    window.eagleMV.getTags().catch(() => []),
    window.eagleMV.getRecentFolders().catch(() => []),
    window.eagleMV.getTagColors({ libraryPath }).catch(() => ({}))
  ]);
  if (state.library?.path !== libraryPath) return;
  state.localPins = pins || {};
  state.availableTags = tags || [];
  state.recentFolders = recentFolders || [];
  state.tagColors = tagColors || {};
  renderTagSuggestions();
  renderTagColors();
}

async function start() {
  bindEvents();
  bindHubEvents();
  try {
    const thumbnailSize = Number(localStorage.getItem('eaglemv.thumbnailSize'));
    if (thumbnailSize >= 110 && thumbnailSize <= 260) {
      $('#sizeSlider').value = String(thumbnailSize);
      document.documentElement.style.setProperty('--thumb', `${thumbnailSize}px`);
    }
  } catch {}
  renderPanels();
  renderFilterState();
  try {
    state.windowId = await window.eagleMV.identity();
    const { app, library } = await window.eagleMV.connect();
    state.library = library;
    await loadLibraryExtras();
    $('#windowTitle').textContent = `Eagle MultiView — ${library.name}`;
    setConnection(true);
    navigate({ kind: 'root' }, { refreshView: false });
    await refresh({ reset: true, preserveScroll: false });
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
        navigate({ kind: 'root' });
      } catch {}
    }, 2500);
  }
}

start();
