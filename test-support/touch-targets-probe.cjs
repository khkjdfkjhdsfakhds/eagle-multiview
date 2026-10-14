'use strict';
// Real-renderer check for W-07 under touch emulation (pointer: coarse): the
// small icon controls answer a tap anywhere in a 44px square around their
// centre (unless the point is on a neighbouring control's own box), the path
// crumbs take the full 40px row, and a tap anywhere in the search box focuses
// its input.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-touch-targets-')));
const TARGETS = '.panel-button, .nav-button, .view-mode-button, .popover-close, .color-filter-swatch, .small-action, .comment-action, .sort-select-button';
const check = width => `(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (value, message) => { if (!value) throw Error(message); };
  assert(matchMedia('(pointer: coarse)').matches, 'touch emulation off');
  const controls = 'button, select, input, [role="menuitem"], .item-card, .folder-card';
  const ownBox = (element, x, y) => { const r = element.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
  const visible = element => element.offsetParent && element.getBoundingClientRect().width > 0 && !element.disabled && getComputedStyle(element).visibility !== 'hidden';
  const failures = [];
  let checked = 0;
  for (const element of document.querySelectorAll(${JSON.stringify(TARGETS)})) {
    if (!visible(element)) continue;
    const r = element.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (const [dx, dy] of [[-20, 0], [20, 0], [0, -20], [0, 20]]) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (element.contains(hit)) continue;
      const neighbour = [...document.querySelectorAll(controls)].find(other => other !== element && !other.contains(element) && !element.contains(other) && visible(other) && ownBox(other, x, y));
      if (neighbour) continue;
      // Where two enlarged areas overlap, either control may take the tap.
      const other = hit?.closest(${JSON.stringify(TARGETS)});
      if (other && other !== element) continue;
      // Something non-interactive drawn on top (a modal, a sheet) is fine.
      if (hit && !hit.closest('.content-pane, .toolbar, .sidebar, .inspector, .filter-popover, .statusbar')) continue;
      failures.push((element.id || element.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' misses ' + dx + ',' + dy + ' → ' + (hit?.id || hit?.className || hit?.tagName));
    }
    checked += 1;
  }
  assert(checked >= 6, '${width}px: only ' + checked + ' controls checked');
  assert(!failures.length, '${width}px: ' + failures.slice(0, 6).join(' | '));
  for (const crumb of document.querySelectorAll('.content-pane .heading-path-row .breadcrumb button')) {
    if (visible(crumb)) assert(crumb.getBoundingClientRect().height >= 39, '${width}px: crumb only ' + crumb.getBoundingClientRect().height + 'px tall');
  }
  return checked;
})()`;
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 390, height: 844, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'web-mobile-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    state.currentView = { kind: 'folder', id: 'mv-folder' };
    await refresh({ reset: true });
    // Let the closed drawers finish sliding off screen.
    await wait(700);
  })()`);
  // Phone: heading controls, then the filter sheet's close button and swatches.
  await win.webContents.executeJavaScript(check(390));
  await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('#filterButton').click();
    await new Promise(resolve => setTimeout(resolve, 60));
  })()`);
  await win.webContents.executeJavaScript(check(390));
  // Search box: a tap beside the input focuses it.
  await win.webContents.executeJavaScript(`(async () => {
    const assert = (value, message) => { if (!value) throw Error(message); };
    document.querySelector('#filterPopover').classList.add('hidden');
    document.activeElement?.blur();
    const icon = document.querySelector('.search-box .search-icon');
    icon.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' }));
    assert(document.activeElement?.id === 'searchInput', 'search box tap did not focus the input: ' + document.activeElement?.id);
  })()`);
  // Tablet landscape: the inspector's small actions are on screen.
  win.setContentSize(1180, 820);
  await new Promise(resolve => setTimeout(resolve, 150));
  await win.webContents.executeJavaScript(`(async () => {
    selectItem('i-0');
    await new Promise(resolve => setTimeout(resolve, 80));
  })()`);
  await win.webContents.executeJavaScript(check(1180));
  console.log('TOUCH_TARGETS_OK');
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
