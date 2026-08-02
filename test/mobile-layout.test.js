'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
const indexHTML = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');

// Phase 1 of web access: compact drawer layout and touch interactions.

test('compact layout turns the side panels into drawers', () => {
  assert.ok(indexHTML.includes('id="drawerBackdrop"'));
  assert.ok(indexHTML.includes('viewport-fit=cover'));
  assert.ok(renderer.includes("window.matchMedia('(max-width: 900px)')"));
  assert.ok(renderer.includes('const isCompactLayout = () => isWebClient && compactLayoutQuery.matches;'), 'desktop UI zoom must not enable web drawers');
  assert.ok(renderer.includes("document.body.classList.toggle('web-client', isWebClient);"), 'CSS receives the same host distinction');
  assert.ok(renderer.includes("state.openDrawer = state.openDrawer === panel ? null : panel;"), 'toggle buttons drive drawers in compact mode');
  assert.ok(renderer.includes("$('#drawerBackdrop').addEventListener('click', closeDrawers);"));
  assert.ok(renderer.includes('if (isCompactLayout()) closeDrawers();'), 'navigation closes the drawer');
  assert.ok(styles.includes('body.web-client.drawer-sidebar .sidebar'));
  assert.ok(styles.includes('body.web-client.drawer-inspector .inspector'));
  assert.ok(styles.includes('@media (max-width: 600px)'));
  assert.ok(styles.includes('grid-auto-rows: minmax(72vh, auto)'), 'panes stack vertically on phones');
});

test('touch pointers tap to preview, long-press to select, and never marquee', () => {
  assert.ok(renderer.includes("if (event.pointerType === 'touch') return;"), 'marquee skips touch pointers');
  assert.ok(renderer.includes('function triggerTouchLongPress(card, paneId, point)'));
  assert.ok(renderer.includes('suppressTouchClickUntil = Date.now() + 400;'), 'suppression starts at lift-off');
  assert.ok(renderer.includes('touchLongPressActive || Date.now() < suppressTouchClickUntil'), 'native contextmenu swallowed while finger is down');
  assert.ok(renderer.includes('if (Date.now() < suppressTouchClickUntil) return;'), 'click after long-press is swallowed');
  const clickHandler = renderer.slice(
    renderer.indexOf("query('#itemGrid').addEventListener('click'"),
    renderer.indexOf("query('#itemGrid').addEventListener('change'")
  );
  assert.ok(renderer.includes("query('#gridScroller').addEventListener('click'"), 'blank-space tap clearing covers the whole scroller');
  assert.ok(renderer.includes("$('#clearSelectionButton').addEventListener('click'"), 'multi-select panel offers an explicit exit for touch');
  assert.ok(clickHandler.includes('openPreview(card.dataset.id)'), 'touch tap opens the preview');
  assert.ok(clickHandler.includes('selectItem(card.dataset.id, true)'), 'tap toggles inside a live selection');
  assert.ok(clickHandler.includes("navigate({ kind: 'folder', id: folder.dataset.openFolder })"), 'touch tap enters folders directly');
});

test('preview swipes: horizontal switches, downward closes, videos play inline', () => {
  assert.ok(renderer.includes('swipeSession = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };'));
  assert.ok(renderer.includes('movePreview(dx < 0 ? 1 : -1);'), 'horizontal swipe switches items');
  assert.ok(renderer.includes('if (dy > 90 && dy > Math.abs(dx) * 1.4) {'), 'downward swipe closes');
  assert.ok(renderer.includes('controls autoplay playsinline'), 'videos stay inline on iOS');
});

test('a compact selection shows the bottom strip and a single way to clear', () => {
  assert.ok(indexHTML.includes('id="selectionBar"'));
  assert.ok(indexHTML.includes('id="selectionBarPreview"'));
  assert.ok(indexHTML.includes('id="selectionBarDetails"'));
  assert.ok(renderer.includes('function renderSelectionBar()'));
  assert.ok(renderer.includes('const visible = isCompactLayout() && count > 0;'), 'the strip is compact-only');
  assert.ok(renderer.includes('function renderInspector() {\n  renderSelectionBar();'), 'every selection change repaints it');
  assert.ok(renderer.includes('  renderSelectionBar();'), 'so does rotating in or out of compact mode');
  assert.ok(renderer.includes('  updateToolbarWrapState();\n}'), 'panel visibility changes resync the toolbar wrap state');
  assert.ok(renderer.includes("$('#selectionBarDetails').addEventListener('click', () => {\n    state.openDrawer = 'inspector';"));
  assert.ok(styles.includes('body.web-client.selection-bar-open .grid-scroller'), 'the grid clears the strip');
  assert.match(styles, /\.selection-bar \{[^}]*display: none;/, 'the strip is hidden by default on desktop');
  assert.ok(styles.includes('body.web-client .selection-bar { display: flex; }'), 'only a compact web client shows it');
  // Clearing a selection lives in one place, used by the panel button, the
  // strip button and the blank-space tap.
  assert.ok(renderer.includes('function clearSelection() {'));
  assert.ok(renderer.includes("$('#clearSelectionButton').addEventListener('click', clearSelection);"));
  assert.ok(renderer.includes("$('#selectionBarClear').addEventListener('click', clearSelection);"));
  assert.ok(renderer.includes('    clearSelection();\n  });'), 'the blank-space tap routes through it too');
});

test('touch reaches folder actions and the arrows are big enough to hit', () => {
  // One long-press implementation, shared by the grid and the folder tree.
  assert.ok(renderer.includes('function bindTouchLongPress(element, { selector, ignore, onLongPress }) {'));
  assert.ok(renderer.includes('const TOUCH_LONG_PRESS_MS = 480;'));
  assert.ok(renderer.includes('const TOUCH_LONG_PRESS_SLOP = 12;'));
  assert.ok(renderer.includes("bindTouchLongPress(query('#itemGrid'), {"), 'the grid uses it');
  assert.ok(renderer.includes("bindTouchLongPress($('.sidebar'), {"), 'so does the sidebar');
  assert.ok(renderer.includes('bindTouchLongPress(scroller, workspaceLongPress);'), 'and blank grid space');
  // Right-click and long-press open the same menu.
  assert.ok(renderer.includes('function openSidebarContextMenu(target, point) {'));
  assert.strictEqual((renderer.match(/openSidebarContextMenu\(/g) || []).length, 3);
  // The long-press must not also navigate via the synthetic click.
  const treeClick = renderer.slice(
    renderer.indexOf("$('#folderTree').addEventListener('click'"),
    renderer.indexOf("$('.sidebar').addEventListener('contextmenu'")
  );
  assert.ok(treeClick.includes('if (Date.now() < suppressTouchClickUntil) return;'));
  // A 12x20 arrow is not a touch target.
  assert.ok(styles.includes('.folder-toggle:not(.spacer)::after'));
  assert.match(styles, /\.folder-toggle:not\(\.spacer\)::after \{[^}]*width: 40px/);
  assert.ok(styles.includes('.context-menu-row { min-height: 38px; }'));
});

test('the toast clears the selection strip instead of overlapping it', () => {
  assert.ok(styles.includes('body.selection-bar-open .toast { bottom: calc(70px + env(safe-area-inset-bottom)); }'));
});

test('narrow screens get chrome that fits them', () => {
  const compact = styles.slice(styles.indexOf('@media (max-width: 900px) {'), styles.indexOf('@media (max-width: 600px) {'));
  // A 286px popover anchored two thirds across the toolbar runs off a phone.
  assert.match(compact, /\.filter-popover \{[^}]*position: fixed/);
  assert.match(compact, /\.filter-popover \{[^}]*left: 8px/);
  assert.ok(compact.includes('.pane-badge { display: none; }'), 'one pane down here, so no "栏 N"');
  // Phone-only: a 768px tablet is wide enough for the desktop default.
  assert.ok(!compact.includes(':root { --thumb: 132px; }'));
  const phone = styles.slice(styles.indexOf('@media (max-width: 600px) {'));
  assert.ok(phone.slice(0, 700).includes('body.web-client { --thumb: 132px; }'), 'a smaller base size fits more per row');
  assert.ok(compact.includes('body.web-client.selection-bar-open .inspector'), 'the drawer clears the strip too');
  // The desktop caption cap goes negative below 460px and collapses to zero.
  const coarse = styles.slice(styles.indexOf('@media (pointer: coarse) {\n  .modal-close'));
  assert.match(coarse, /\.modal-caption \{[^}]*max-width: none/);
  assert.ok(renderer.includes("$('#searchInput').placeholder = compact ? '搜索…'"));
  // Pinch has to start from the size actually in effect, not the slider's.
  assert.ok(renderer.includes("parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thumb'))"));
  assert.ok(renderer.includes("window.matchMedia('(pointer: coarse)').matches && position"), 'touch has no hover for the file name');
  // A fixed 360px assumed the field hugged the left edge: measured overflow was
  // 73px past a 1280px window in the inspector and 10px past a 390px phone.
  assert.match(styles, /^\.tag-suggestion-popover \{[^}]*right: -1px;\n  left: -1px;\n  width: auto;/m);
  assert.ok(!styles.includes('width: min(360px, calc(100vw - 38px))'), 'the viewport-relative guess is gone');
});

test('the layout switcher stays reachable on a phone', () => {
  // The container query hides .view-mode-group under 460px of pane width,
  // which on a phone is always. Compact layouts wrap the row instead.
  assert.match(styles, /@container \(max-width: 460px\) \{\s*\.content-heading \.view-mode-group \{ display: none; \}/);
  const compact = styles.slice(styles.indexOf('@media (max-width: 900px) {'), styles.indexOf('@media (max-width: 600px) {'));
  assert.ok(compact.includes('.content-pane .content-heading { flex-wrap: wrap; row-gap: 7px; }'));
  // Re-shown only where the pane can hold it: a compact window split four ways
  // leaves ~224px panes, where forcing it back overflowed the window by 23px.
  assert.ok(styles.includes('@container (min-width: 340px) {\n  body.compact-layout .content-heading .view-mode-group { display: inline-flex; }\n}'));
  assert.ok(!compact.includes('.view-mode-group { display: inline-flex; }'), 'the media query must not force it unconditionally');
  // No forced 100% basis: the row wraps only when it has to, so a phone in
  // landscape keeps a single-row header.
  assert.ok(compact.includes('.content-pane .content-heading .location-block { flex: 1 1 210px; }'));
  assert.ok(!compact.includes('flex: 1 1 100%'), 'the controls must not be forced onto their own row');
});

test('preview modal supports two-finger pinch zoom', () => {
  assert.ok(renderer.includes('const previewPointers = new Map();'));
  assert.ok(renderer.includes('pinchBase = { ...pinchGeometry()'));
  assert.ok(renderer.includes('pinchBase.scale * (current.distance / pinchBase.distance)'));
  assert.ok(styles.includes('.modal-media { touch-action: none; }'));
});

test('touch can reach the workspace menu and 全选', () => {
  // ⌘A and right-click both need a keyboard/mouse; long-pressing blank grid
  // space is the only route on a phone.
  assert.ok(renderer.includes('const openWorkspaceMenu = point => {'));
  assert.ok(renderer.includes("    ignore: '.item-card, .folder-card, button, input, select, textarea, a, [data-tag-action]',"),
    'cards keep their own long-press');
  assert.ok(renderer.includes('      openWorkspaceMenu(point);'));
  assert.ok(renderer.includes('function bindTouchLongPress(element, { selector, ignore, onLongPress })'));
  // The grid is nearly wall-to-wall cards at phone width, so the heading is
  // the reliable entry point; both carry the same press.
  assert.ok(renderer.includes('bindTouchLongPress(heading, workspaceLongPress);'));
  assert.ok(renderer.includes('bindTouchLongPress(scroller, workspaceLongPress);'));
  // The synthetic click ending the press must not dismiss the menu it opened.
  assert.ok(renderer.includes("document.addEventListener('click', event => {\n    // The synthetic click that ends a touch long-press must not dismiss the"));
  // The browser's own long-press menu must not double up.
  const contextHandler = renderer.slice(renderer.indexOf("scroller.addEventListener('contextmenu'"), renderer.indexOf('bindTouchLongPress(scroller, {'));
  assert.ok(contextHandler.includes('if (touchLongPressActive || Date.now() < suppressTouchClickUntil) return;'));
  // 全选 lives in the menu now, sharing one implementation with ⌘A.
  assert.ok(renderer.includes("label: '全选', shortcut: '⌘ A', action: 'select-all'"));
  assert.ok(renderer.includes("if (action === 'select-all') { selectAllItems(); return; }"));
  assert.ok(renderer.includes("if (action === 'clear-selection') { clearSelection(); return; }"));
  assert.ok(renderer.includes('function selectAllItems() {'));
  const shortcut = renderer.split('\n').find(text => text.includes("event.key.toLowerCase() === 'a'") && text.includes('primaryKey'));
  assert.ok(shortcut, 'the ⌘A binding still exists');
  assert.ok(renderer.includes('      selectAllItems();\n    }'), '⌘A routes through the same function');
});

test('context menus become bottom sheets on narrow screens', () => {
  // Measured at 390px before this: an open submenu started 253px past the
  // right edge, so 添加标签 / 移动到文件夹 / 设置评分 were all unreachable.
  assert.ok(renderer.includes('const sheet = isCompactLayout();'));
  assert.ok(renderer.includes("menu.classList.toggle('context-menu-sheet', sheet);"));
  assert.ok(renderer.includes("menu.style.left = '';"), 'the sheet drops the cursor anchoring');
  const compact = styles.slice(styles.indexOf('@media (max-width: 900px) {\n  body.web-client .context-menu.context-menu-sheet'));
  assert.match(compact, /body\.web-client \.context-menu\.context-menu-sheet \{[^}]*overflow-y: auto/);
  assert.match(compact, /body\.web-client \.context-menu-sheet \.context-submenu \{[^}]*position: static/);
  assert.match(compact, /body\.web-client \.context-menu-sheet \.context-submenu \{[^}]*grid-column: 1 \/ -1/);
  // Hover cannot close an inline submenu, so the row toggles instead.
  assert.ok(renderer.includes("if (isCompactLayout() && !event.target.closest('.context-submenu')) {"));
  assert.ok(renderer.includes("submenu.classList.toggle('submenu-open');"));
  assert.ok(compact.includes('.context-menu-sheet .context-menu-row:hover > .context-submenu { display: none; }'));
});

test('a narrow client says when the host is gone', () => {
  // The status bar is 9px and sits under the home indicator on a phone, so a
  // dropped host was invisible while every action failed silently.
  assert.ok(indexHTML.includes('id="offlineBanner"'));
  assert.ok(renderer.includes("banner.classList.toggle('hidden', connected);"));
  assert.ok(renderer.includes("document.body.classList.toggle('host-offline', !connected);"));
  assert.ok(renderer.includes("banner.textContent = window.eagleMV.platform === 'web' ? `${status} · 正在重连主机…` : status;"),
    'the web client is the one that reconnects on its own');
  // It is driven from setConnection, which is the single place connection
  // state changes (hub status events land there too).
  const setConnection = renderer.slice(renderer.indexOf('function setConnection('), renderer.indexOf('function formatBytes('));
  assert.ok(setConnection.includes("$('#offlineBanner')"));
  assert.ok(renderer.includes('window.eagleMV.onStatus(payload => setConnection(payload.connected, payload.message));'));
  const compact = styles.slice(styles.indexOf('@media (max-width: 900px) {\n  body.web-client .offline-banner'));
  assert.match(compact, /body\.web-client \.offline-banner \{[^}]*position: fixed/);
  // It pushes the workspace down instead of covering the search box, because
  // an outage can last a while.
  assert.ok(compact.includes('body.web-client.host-offline .workspace { top: calc(24px + max(6px, env(safe-area-inset-top))); }'));
  assert.ok(styles.includes('.offline-banner { display: none; }'), 'wide windows keep the status bar and skip the banner');
});

test('primary workspace surfaces scroll vertically only', () => {
  assert.match(styles, /\.grid-scroller\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.sidebar\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.inspector\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s);
});
