'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-ui-test-'));
app.setPath('userData', userData);

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
  await window.loadFile(path.join(__dirname, '../src/index.html'));
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

    document.querySelector('#paneLayoutButton').click();
    document.querySelector('[data-layout="vertical2"]').click();
    await until(() => document.querySelectorAll('.content-pane').length === 2);
    const secondPane = document.querySelectorAll('.content-pane')[1];
    secondPane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.querySelector('[data-folder-id="mv-folder"]').click();
    await wait(30);
    assert(secondPane.classList.contains('active'), 'the second pane should be active');

    mainButton.click();
    await wait(10);
    assert(window.__uiTestCalls.at(-1)?.data?.view?.id === 'mv-folder', 'main button did not use the latest active pane');

    menuButton.click();
    assert(menuButton.getAttribute('aria-expanded') === 'true', 'chevron did not expand');
    assert(!menu.classList.contains('hidden'), 'location menu did not open');
    assert(menu.getAttribute('aria-label') === '新窗口位置', 'location menu has the wrong accessible name');
    const labels = [...menu.querySelectorAll('.context-menu-label')].map(node => node.textContent.trim());
    assert(JSON.stringify(labels) === JSON.stringify(['新建在根目录', '新建在当前 Eagle 路径', '新建在当前 MultiView 路径（默认）']), 'location menu labels are wrong');
    menuButton.click();
    assert(menu.classList.contains('hidden'), 'second chevron click did not collapse the menu');

    menuButton.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert(menu.classList.contains('hidden'), 'Escape did not close the location menu');
    menuButton.click();
    document.querySelector('.search-box').click();
    assert(menu.classList.contains('hidden'), 'outside click did not close the location menu');

    for (const action of ['new-window-root', 'new-window-eagle', 'new-window-multiview']) {
      menuButton.click();
      menu.querySelector('[data-context-action="' + action + '"]').click();
      await wait(15);
    }
    const recent = window.__uiTestCalls.slice(-3).map(call => call.data.view);
    assert(recent[0].kind === 'root', 'root menu action failed');
    assert(recent[1].kind === 'folder' && recent[1].id === 'eagle-folder', 'Eagle menu action failed');
    assert(recent[2].kind === 'folder' && recent[2].id === 'mv-folder', 'MultiView menu action failed');

    document.querySelector('#currentEaglePathButton').click();
    await until(() => secondPane.querySelector('#breadcrumb').textContent.includes('Eagle 文件夹'));

    return { labels, recent };
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
        const mainButton = document.querySelector('#newWindowButton');
        const menuButton = document.querySelector('#newWindowMenuButton');
        const toolbarRect = toolbar.getBoundingClientRect();
        const sliderRect = slider.getBoundingClientRect();
        const eagleRect = eagleButton.getBoundingClientRect();
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
        if (visible(mainButton) && eagleRect.left < menuButton.getBoundingClientRect().right) throw new Error('Eagle path button is not to the right at ${width}px');
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
