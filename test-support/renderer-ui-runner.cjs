'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-ui-test-'));
app.setPath('userData', userData);
app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      preload: path.join(__dirname, 'renderer-ui-preload.cjs')
    }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_UI_SOURCE_ROOT || path.join(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async predicate => {
      for (let index = 0; index < 100; index += 1) {
        if (predicate()) return;
        await wait(20);
      }
      throw new Error('renderer did not become ready');
    };
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const menu = document.querySelector('#contextMenu');
    const mainButton = document.querySelector('#newWindowButton');
    const menuButton = document.querySelector('#newWindowMenuButton');

    await until(() => document.body.classList.contains('offline') === false && document.querySelector('.content-pane'));

    const searchInput = document.querySelector('#searchInput');
    searchInput.value = 'Locked';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(360);
    const lockedFolder = document.querySelector('.folder-card[data-open-folder="locked-folder"]');
    assert(lockedFolder, 'the encrypted folder should stay reachable in search results');
    const lockedTouchClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(lockedTouchClick, 'pointerType', { value: 'touch' });
    lockedFolder.dispatchEvent(lockedTouchClick);
    await wait(30);
    assert(searchInput.value === 'Locked', 'blocked folder entry must not clear the text search');

    searchInput.value = 'Multi';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(360);
    const searchFolder = document.querySelector('.folder-card[data-open-folder="mv-folder"]');
    assert(searchFolder, 'the matching folder should stay reachable in search results');
    const touchClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(touchClick, 'pointerType', { value: 'touch' });
    const originalConfirm = window.confirm;
    let discardPrompted = false;
    window.confirm = () => {
      discardPrompted = true;
      return false;
    };
    state.textSession = { dirty: true };
    searchFolder.dispatchEvent(touchClick);
    await wait(30);
    assert(discardPrompted, 'dirty TXT entry should request discard confirmation');
    assert(searchInput.value === 'Multi', 'cancelled folder entry must not clear the text search');
    assert(document.querySelector('#viewTitle').textContent !== 'MultiView 文件夹', 'cancelled folder entry must keep the current view');
    state.textSession = null;
    window.confirm = originalConfirm;
    const confirmedTouchClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(confirmedTouchClick, 'pointerType', { value: 'touch' });
    searchFolder.dispatchEvent(confirmedTouchClick);
    await until(() => document.querySelector('#viewTitle').textContent === 'MultiView 文件夹');
    assert(searchInput.value === '', 'touch entry should clear the text search');
    const searchExited = searchInput.value === '';

    document.querySelector('#paneLayoutButton').click();
    document.querySelector('[data-layout="vertical2"]').click();
    await until(() => document.querySelectorAll('.content-pane').length === 2);
    const secondPane = document.querySelectorAll('.content-pane')[1];
    secondPane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.querySelector('[data-folder-id="mv-folder"]').click();
    await wait(30);
    assert(secondPane.classList.contains('active'), 'the second pane should be active');

    window.__uiTestEmitFolderRename('重命名后文件夹');
    await until(() => state.panes.find(pane => pane.id === state.activePaneId)?.viewTitle === '重命名后文件夹');
    const renamedPane = state.panes.find(pane => pane.id === state.activePaneId);
    assert(renamedPane.currentView.kind === 'folder' && renamedPane.currentView.id === 'mv-folder', '同 ID 重命名不应离开当前文件夹');
    assert(document.querySelector('.content-pane.active #breadcrumb').textContent.includes('重命名后文件夹'), '路径栏没有显示重命名后的文件夹');
    assert([...document.querySelectorAll('.folder-row')].some(row => row.textContent.includes('重命名后文件夹')), '文件夹树没有显示重命名后的文件夹');
    const renamePreserved = { viewId: renamedPane.currentView.id, title: renamedPane.viewTitle };

    assert(!mainButton && !menuButton, 'new-window toolbar controls must be removed');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, altKey: true, bubbles: true, cancelable: true }));
    await wait(15);
    assert(window.__uiTestCalls.at(-1)?.data?.view?.id === 'mv-folder', 'new-window shortcut must use the latest active pane');

    // Keep exercising the existing window target actions without the removed toolbar.
    for (const target of ['root', 'eagle', 'multiview']) await openNewWindowAt(target);
    const recent = window.__uiTestCalls.slice(-3).map(call => call.data.view);
    assert(recent[0].kind === 'root', 'root window action failed');
    assert(recent[1].id === 'eagle-folder', 'Eagle window action failed');
    assert(recent[2].id === 'mv-folder', 'MultiView window action failed');

    document.querySelector('#currentEaglePathButton').click();
    await until(() => secondPane.querySelector('#breadcrumb').textContent.includes('Eagle 文件夹'));

    const layoutButton = document.querySelector('#paneLayoutButton');
    const options = [...document.querySelectorAll('.pane-layout-option')];
    for (const option of options) {
      layoutButton.click();
      option.click();
      const layout = option.dataset.layout;
      assert(document.querySelector('#paneLayout').dataset.layout === layout, 'layout not applied: ' + layout);
      assert(layoutButton.dataset.layout === layout, 'button did not follow layout: ' + layout);
      assert(layoutButton.querySelector('svg').outerHTML === option.querySelector('svg').outerHTML, 'button and option icons differ: ' + layout);
      assert(option.querySelectorAll('rect').length === 1, 'layout icon has nested borders: ' + layout);
      assert(layoutButton.getAttribute('aria-label').includes(option.getAttribute('aria-label')), 'layout accessible name is stale');
    }
    state.inspectorSaving = true;
    assert(!renderPaneLayout('single'), 'saving should block layout changes');
    assert(layoutButton.dataset.layout === 'horizontal4', 'blocked layout changed the button');
    state.inspectorSaving = false;
    renderPaneLayout('vertical2', { refresh: false });
    await until(() => !state.panes.some(pane => pane.loading));
    const refreshButton = document.querySelector('#refreshAllPanesButton');
    const originalQuery = window.eagleMV.query;
    const pending = [];
    window.eagleMV.query = query => new Promise((resolve, reject) => pending.push({ query, resolve, reject }));
    const activeBefore = state.activePaneId;
    const viewsBefore = JSON.stringify(state.panes.map(pane => ({ view: pane.currentView, query: pane.query })));
    state.panes[0].textSession = { dirty: true, value: 'unsaved draft' };
    refreshButton.click();
    refreshButton.click();
    assert(pending.length === 2, 'refresh must query both panes once despite repeated clicks');
    assert(refreshButton.disabled && refreshButton.getAttribute('aria-busy') === 'true', 'refresh has no busy feedback');
    pending[0].resolve({ data: [], total: 0, hasMore: false });
    await wait(30);
    assert(refreshButton.disabled, 'refresh stopped waiting for the slower pane');
    pending[1].reject(new Error('test offline pane'));
    await until(() => !refreshButton.disabled);
    assert(state.panes[1].errorMessage, 'failed pane should expose its error');
    assert(state.activePaneId === activeBefore, 'refresh changed the active pane');
    assert(JSON.stringify(state.panes.map(pane => ({ view: pane.currentView, query: pane.query }))) === viewsBefore, 'refresh changed pane locations or filters');
    assert(state.panes[0].textSession.value === 'unsaved draft', 'refresh discarded the TXT draft');
    window.eagleMV.query = originalQuery;
    refreshButton.click();
    await until(() => !refreshButton.disabled);
    assert(!state.panes[1].errorMessage && refreshButton.getAttribute('aria-busy') === 'false', 'retry failed to recover');
    state.panes[0].textSession = null;
    return { layoutCount: options.length, refreshRecovered: true, recent, searchExited, renamePreserved };
  })()`);
  window.setSize(820, 820);
  await new Promise(resolve => setTimeout(resolve, 100));
  result.desktopNarrow = await window.webContents.executeJavaScript(`(() => {
    const sidebar = document.querySelector('.sidebar');
    const inspector = document.querySelector('.inspector');
    const search = document.querySelector('.search-box');
    const sidebarRect = sidebar.getBoundingClientRect();
    const inspectorRect = inspector.getBoundingClientRect();
    const searchRect = search.getBoundingClientRect();
    const sidebarPosition = getComputedStyle(sidebar).position;
    const inspectorPosition = getComputedStyle(inspector).position;
    return {
      sidebarPosition,
      inspectorPosition,
      sidebarRight: Math.round(sidebarRect.right),
      inspectorLeft: Math.round(inspectorRect.left),
      viewportWidth: innerWidth,
      searchLeft: Math.round(searchRect.left)
    };
  })()`);
  if (result.desktopNarrow.sidebarPosition === 'fixed' || result.desktopNarrow.sidebarRight <= 0) {
    throw new Error(`desktop sidebar collapsed into the compact drawer at 820px: ${JSON.stringify(result.desktopNarrow)}`);
  }
  if (result.desktopNarrow.inspectorPosition === 'fixed' || result.desktopNarrow.inspectorLeft >= result.desktopNarrow.viewportWidth) {
    throw new Error(`desktop inspector collapsed into the compact drawer at 820px: ${JSON.stringify(result.desktopNarrow)}`);
  }
  if (result.desktopNarrow.searchLeft < 80) {
    throw new Error(`desktop search overlaps the macOS traffic-light area at 820px: ${JSON.stringify(result.desktopNarrow)}`);
  }
  await window.webContents.executeJavaScript(`document.querySelector('#toggleSidebarButton').click(); true`);
  await new Promise(resolve => setTimeout(resolve, 30));
  const sidebarHidden = await window.webContents.executeJavaScript("document.body.classList.contains('sidebar-hidden')");
  const sidebarHiddenSearchLeft = await window.webContents.executeJavaScript("Math.round(document.querySelector('.search-box').getBoundingClientRect().left)");
  result.desktopSidebarHidden = { sidebarHidden, searchLeft: sidebarHiddenSearchLeft };
  if (!result.desktopSidebarHidden.sidebarHidden) {
    throw new Error(`desktop sidebar toggle did not hide the sidebar: ${JSON.stringify(result.desktopSidebarHidden)}`);
  }
  if (result.desktopSidebarHidden.searchLeft < 80) {
    throw new Error(`desktop search overlaps the macOS traffic-light area when the sidebar is hidden: ${JSON.stringify(result.desktopSidebarHidden)}`);
  }
  await window.webContents.executeJavaScript(`document.querySelector('#toggleSidebarButton').click(); true`);
  result.layouts = [];
  // 613px is the smallest effective CSS viewport reachable from the real
  // 980px desktop window at the supported 160% UI zoom.
  for (const width of [1440, 1200, 1120, 1000, 920, 700, 620, 613]) {
    window.setSize(width, 820);
    await new Promise(resolve => setTimeout(resolve, 100));
    const layout = await window.webContents.executeJavaScript(`(() => {
      try {
        const visible = element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const toolbar = document.querySelector('.toolbar');
        const cluster = document.querySelector('.toolbar-cluster');
        const slider = document.querySelector('.size-control');
        const eagleButton = document.querySelector('#currentEaglePathButton');
        const refreshButton = document.querySelector('#refreshAllPanesButton');
        const toolbarRect = toolbar.getBoundingClientRect();
        const sliderRect = slider.getBoundingClientRect();
        const eagleRect = eagleButton.getBoundingClientRect();
        for (const heading of document.querySelectorAll('.content-pane .content-heading')) {
          const headingRect = heading.getBoundingClientRect();
          if (heading.scrollWidth > heading.clientWidth + 1) {
            throw new Error('content heading overflows at ${width}px');
          }
        const visibleGroups = [...heading.children]
          .filter(visible)
          .filter(element => !element.classList.contains('location-block'));
          for (let leftIndex = 0; leftIndex < visibleGroups.length; leftIndex += 1) {
            const left = visibleGroups[leftIndex].getBoundingClientRect();
            if (left.left < headingRect.left - 1 || left.right > headingRect.right + 1) {
              throw new Error('content heading control leaves its pane at ${width}px');
            }
            for (let rightIndex = leftIndex + 1; rightIndex < visibleGroups.length; rightIndex += 1) {
              const right = visibleGroups[rightIndex].getBoundingClientRect();
              const overlaps = left.left < right.right - 1 && left.right > right.left + 1 &&
                left.top < right.bottom - 1 && left.bottom > right.top + 1;
              if (overlaps) throw new Error('content heading controls overlap at ${width}px');
            }
          }
        }
        if (toolbar.scrollWidth > toolbar.clientWidth + 1) {
          throw new Error('toolbar overflows at ${width}px: ' + JSON.stringify({
            toolbarClient: toolbar.clientWidth,
            toolbarScroll: toolbar.scrollWidth,
            clusterWidth: Math.round(cluster.getBoundingClientRect().width),
            clusterScroll: cluster.scrollWidth,
            centerWidth: Math.round(document.querySelector('.toolbar-center').getBoundingClientRect().width),
            centerScroll: document.querySelector('.toolbar-center').scrollWidth,
            sliderWidth: Math.round(sliderRect.width)
          }));
        }
        if (!visible(slider)) throw new Error('thumbnail slider disappeared at ${width}px');
        if (sliderRect.right > toolbarRect.right + 1) throw new Error('thumbnail slider leaves toolbar at ${width}px');
        if (!visible(eagleButton)) throw new Error('Eagle path button disappeared at ${width}px');
        if (eagleRect.right > toolbarRect.right + 1) throw new Error('Eagle path button leaves toolbar at ${width}px');
        const refreshRect = refreshButton.getBoundingClientRect();
        if (!visible(refreshButton) || refreshRect.right > toolbarRect.right + 1 || refreshRect.left < eagleRect.right) throw new Error('refresh button is misplaced at ${width}px');
        if (Math.abs(refreshRect.top + refreshRect.height / 2 - eagleRect.top - eagleRect.height / 2) > 1) throw new Error('toolbar icons are not vertically aligned at ${width}px');
        return {
          width: ${width},
          wrapped: toolbar.classList.contains('wrapped'),
          clusterTop: Math.round(cluster.getBoundingClientRect().top),
          sliderTop: Math.round(sliderRect.top)
        };
      } catch (error) {
        return { width: ${width}, error: error.message };
      }
    })()`);
    if (layout.error) throw new Error(layout.error);
    result.layouts.push(layout);
  }
  if (!result.layouts.some(layout => layout.wrapped)) throw new Error(`narrow layouts never exercised toolbar wrapping: ${JSON.stringify(result.layouts)}`);
  for (const layout of result.layouts.filter(entry => entry.wrapped)) {
    if (Math.abs(layout.clusterTop - layout.sliderTop) > 10) throw new Error(`slider detached from wrapped toolbar cluster at ${layout.width}px`);
  }
  const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload();
  await reloaded;
  result.restoredLayout = await window.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('#paneLayout');
    const button = document.querySelector('#paneLayoutButton');
    if (root.dataset.layout !== 'vertical2' || button.dataset.layout !== root.dataset.layout) throw new Error('restored layout icon is stale');
    return button.dataset.layout;
  })()`);
  if (process.env.EAGLEMV_UI_SCREENSHOT_DIR) {
    window.setSize(1280, 820);
    await window.webContents.executeJavaScript(`document.querySelector('#paneLayoutButton').click(); true`);
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.mkdirSync(process.env.EAGLEMV_UI_SCREENSHOT_DIR, { recursive: true });
    const screenshot = await window.webContents.capturePage();
    fs.writeFileSync(path.join(process.env.EAGLEMV_UI_SCREENSHOT_DIR, 'toolbar-layout.png'), screenshot.toPNG());
  }
  process.stdout.write(`EAGLEMV_UI_RESULT ${JSON.stringify(result)}\n`);
  window.destroy();
  app.quit();
}

run().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
}).finally(() => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});
