'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-path-bar-ui-test-'));
app.setPath('userData', userData);
app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      preload: path.join(__dirname, 'path-bar-ui-preload.cjs')
    }
  });
  ipcMain.handle('path-bar-ui-resize', (_event, { width, height }) => {
    window.setSize(Number(width), Number(height));
    return true;
  });
  await window.loadFile(path.join(__dirname, '../src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async predicate => {
      for (let index = 0; index < 120; index += 1) {
        if (predicate()) return;
        await wait(20);
      }
      throw new Error('renderer did not become ready');
    };
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const platform = window.eagleMV.platform;
    const visible = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const breadcrumbButtons = breadcrumb => [...breadcrumb.querySelectorAll('[data-crumb-index]')]
      .filter(button => visible(button.closest('.breadcrumb-track')));
    const paneSnapshot = pane => {
      const breadcrumb = pane.querySelector('#breadcrumb');
      const buttons = breadcrumbButtons(breadcrumb);
      const current = buttons.find(button => button.disabled && button.getAttribute('aria-current') === 'page');
      const currentIndex = current ? Number(current.dataset.crumbIndex) : -1;
      const previous = currentIndex > 0
        ? buttons.find(button => Number(button.dataset.crumbIndex) === currentIndex - 1)
        : null;
      const currentRect = current?.getBoundingClientRect();
      const previousRect = previous?.getBoundingClientRect();
      const breadcrumbRect = breadcrumb.getBoundingClientRect();
      const titleRect = pane.querySelector('#viewTitle')?.getBoundingClientRect();
      const countRect = pane.querySelector('#resultCount')?.getBoundingClientRect();
      const navigationRect = pane.querySelector('.navigation-controls')?.getBoundingClientRect();
      const sortRect = pane.querySelector('.sort-controls')?.getBoundingClientRect();
      const pathRow = pane.querySelector('.heading-path-row');
      const pathRowRect = pathRow?.getBoundingClientRect();
      const dividerStyle = pathRow ? getComputedStyle(pathRow) : null;
      const full = breadcrumb.querySelector('.breadcrumb-full');
      const fullStyle = full ? {
        display: full.style.display,
        width: full.style.width,
        maxWidth: full.style.maxWidth,
        flex: full.style.flex
      } : null;
      let fullNaturalWidth = 0;
      if (full) {
        full.style.display = 'flex';
        full.style.width = 'max-content';
        full.style.maxWidth = 'none';
        full.style.flex = '0 0 auto';
        fullNaturalWidth = Math.round(full.getBoundingClientRect().width);
        full.style.display = fullStyle.display;
        full.style.width = fullStyle.width;
        full.style.maxWidth = fullStyle.maxWidth;
        full.style.flex = fullStyle.flex;
      }
      let currentTextGap = 0;
      if (current && current.firstChild) {
        const range = document.createRange();
        range.selectNodeContents(current);
        currentTextGap = Math.round(range.getBoundingClientRect().left - currentRect.left);
      }
      return {
        labels: buttons.map(button => button.textContent.trim()),
        indexes: buttons.map(button => Number(button.dataset.crumbIndex)),
        current: current?.textContent.trim() || '',
        currentVisible: Boolean(current && visible(current)),
        compact: breadcrumb.classList.contains('is-compact'),
        hasEllipsis: Boolean(breadcrumb.querySelector('.breadcrumb-collapsed [data-crumb-expand]')),
        noAbsolutePath: !breadcrumb.textContent.includes('/tmp/'),
        breadcrumbWidth: Math.round(breadcrumbRect.width),
        breadcrumbLeftGap: navigationRect ? Math.round(breadcrumbRect.left - navigationRect.left) : 0,
        currentGap: currentRect && previousRect ? Math.round(currentRect.left - previousRect.right) : 0,
        currentTextGap,
        fullNaturalWidth,
        fontSize: Number.parseFloat(getComputedStyle(breadcrumb).fontSize),
        pathTextToDividerGap: pathRowRect ? Math.round(pathRowRect.bottom - breadcrumbRect.bottom) : 0,
        dividerToTitleGap: pathRowRect && titleRect ? Math.round(titleRect.top - pathRowRect.bottom) : 0,
        breadcrumbToTitleGap: titleRect ? Math.round(titleRect.top - breadcrumbRect.bottom) : 0,
        navigationToTitleGap: titleRect && navigationRect
          ? Math.round(titleRect.left - navigationRect.right)
          : 0,
        sortToDetailsDelta: titleRect && countRect && sortRect
          ? Math.round(sortRect.top + sortRect.height / 2 - ((titleRect.top + countRect.bottom) / 2))
          : 0,
        dividerVisible: Boolean(dividerStyle && dividerStyle.borderBottomStyle !== 'none' && dividerStyle.borderBottomWidth !== '0px'),
        navigationToDetailsDelta: titleRect && countRect && navigationRect
          ? Math.round(navigationRect.top + navigationRect.height / 2 - ((titleRect.top + countRect.bottom) / 2))
          : 0
      };
    };
    const panes = () => [...document.querySelectorAll('.content-pane')];
    const go = (paneId, view) => withActivePane(paneId, () => navigate(view, { refreshView: false }));
    const singleOption = document.querySelector('#paneLayoutPopover [data-layout="single"]');
    assert(singleOption && singleOption.getAttribute('aria-label') === '单栏', '工具栏分栏布局弹层缺少单栏选项');
    const checkResponsive = label => {
      const documentWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      assert(documentWidth <= innerWidth + 1, label + ' 页面出现横向溢出: ' + documentWidth + ' > ' + innerWidth);
      for (const pane of panes()) {
        const heading = pane.querySelector('.content-heading');
        const headingRect = heading.getBoundingClientRect();
        assert(heading.scrollWidth <= heading.clientWidth + 1, label + ' 标题行横向溢出');
        assert(headingRect.left >= pane.getBoundingClientRect().left - 1 && headingRect.right <= pane.getBoundingClientRect().right + 1, label + ' 标题行离开当前栏');
        const breadcrumb = pane.querySelector('#breadcrumb');
        const breadcrumbRect = breadcrumb.getBoundingClientRect();
        assert(breadcrumb.scrollWidth <= breadcrumb.clientWidth + 1, label + ' 路径栏横向溢出');
        const current = breadcrumbButtons(breadcrumb).find(button => button.disabled && button.getAttribute('aria-current') === 'page');
        assert(current && visible(current), label + ' 当前路径节点不可见');
        const currentRect = current.getBoundingClientRect();
        assert(currentRect.right <= breadcrumbRect.right + 1 && currentRect.left >= breadcrumbRect.left - 1, label + ' 当前路径节点离开路径栏');
      }
    };

    await until(() => document.body.classList.contains('offline') === false && state.library && document.querySelector('.content-pane'));
    const firstPaneId = state.panes[0].id;
    go(firstPaneId, { kind: 'folder', id: 'delta-folder' });
    await until(() => paneSnapshot(panes()[0]).current === 'Delta');
    const deep = paneSnapshot(panes()[0]);
    assert(JSON.stringify(deep.labels) === JSON.stringify(['路径测试资料库', 'Alpha', 'Beta', 'Gamma', 'Delta']), '深层路径顺序错误: ' + JSON.stringify(deep));
    assert(deep.indexes.at(-1) === 4 && deep.currentVisible && deep.noAbsolutePath, '深层路径当前节点或逻辑路径错误: ' + JSON.stringify(deep));
    assert(panes()[0].querySelector('.breadcrumb-full [data-crumb-index="4"]').disabled, '当前节点必须不可重复导航');

    const beginPathEdit = pane => {
      const current = pane.querySelector('.breadcrumb-full [data-crumb-index]:disabled[aria-current="page"]');
      assert(current, '当前路径节点缺少编辑入口');
      current.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      const input = pane.querySelector('.breadcrumb-input');
      assert(input, '点击当前路径没有进入编辑态');
      return input;
    };
    const firstPaneState = state.panes.find(pane => pane.id === firstPaneId);
    const historyBeforePathNavigation = firstPaneState.history.length;
    firstPaneState.query.search = 'keep-search';
    let pathInput = beginPathEdit(panes()[0]);
    assert(pathInput.value === 'Alpha / Beta / Gamma / Delta', '编辑态没有显示 Eagle 逻辑路径: ' + pathInput.value);
    pathInput.value = 'Alpha / Beta';
    pathInput.dispatchEvent(new Event('input', { bubbles: true }));
    pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => paneSnapshot(panes()[0]).current === 'Beta');
    assert(firstPaneState.query.search === 'keep-search', '路径导航丢失当前分栏搜索状态');
    assert(firstPaneState.history.length > historyBeforePathNavigation, '路径导航没有记录历史');

    go(firstPaneId, { kind: 'folder', id: 'delta-folder' });
    await until(() => paneSnapshot(panes()[0]).current === 'Delta');
    pathInput = beginPathEdit(panes()[0]);
    pathInput.value = '/Users/example/Library.library/images';
    pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await wait(30);
    assert(firstPaneState.currentView.id === 'delta-folder', '本机绝对路径改变了当前视图: ' + JSON.stringify({ current: paneSnapshot(panes()[0]), view: firstPaneState.currentView, input: pathInput.value }));
    assert(pathInput.isConnected && pathInput.getAttribute('aria-invalid') === 'true', '无效本机路径没有保留编辑态');
    assert(document.querySelector('#toast').textContent.includes('Eagle'), '无效路径没有显示 Eagle 路径提示');
    pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await until(() => !panes()[0].querySelector('.breadcrumb-input'));
    assert(paneSnapshot(panes()[0]).current === 'Delta', 'Escape 没有恢复原路径');

    const pathRowElement = panes()[0].querySelector('.heading-path-row');
    pathRowElement.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    const rowInput = panes()[0].querySelector('.breadcrumb-input');
    assert(rowInput, '点击路径栏空白处没有进入编辑态');
    rowInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await until(() => !panes()[0].querySelector('.breadcrumb-input'));

    pathInput = beginPathEdit(panes()[0]);
    pathInput.value = '';
    pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => paneSnapshot(panes()[0]).current === '路径测试资料库');
    assert(firstPaneState.currentView.kind === 'root', '空 Eagle 路径没有回到根目录');

    pathInput = beginPathEdit(panes()[0]);
    pathInput.value = 'Other / Shared';
    pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => paneSnapshot(panes()[0]).current === 'Shared');
    assert(firstPaneState.currentView.id === 'other-shared-folder', '重复名称路径没有按完整 Eagle 路径解析');

    go(firstPaneId, { kind: 'all' });
    await until(() => paneSnapshot(panes()[0]).current === '全部素材');
    const virtual = paneSnapshot(panes()[0]);
    assert(JSON.stringify(virtual.labels) === JSON.stringify(['路径测试资料库', '全部素材']), '虚拟视图路径错误: ' + JSON.stringify(virtual));
    assert(virtual.currentVisible && virtual.noAbsolutePath, '虚拟视图当前节点不可见或泄露绝对路径');
    go(firstPaneId, { kind: 'smart', id: 'smart-folder' });
    await until(() => paneSnapshot(panes()[0]).current === '精选智能视图');
    const smart = paneSnapshot(panes()[0]);
    assert(JSON.stringify(smart.labels) === JSON.stringify(['路径测试资料库', '精选智能视图']), '智能视图路径错误: ' + JSON.stringify(smart));
    assert(smart.currentVisible && smart.noAbsolutePath, '智能视图当前节点不可见或泄露绝对路径');
    go(firstPaneId, { kind: 'folder', id: 'delta-folder' });
    await until(() => paneSnapshot(panes()[0]).current === 'Delta');

    document.querySelector('#paneLayoutButton').click();
    document.querySelector('#paneLayoutPopover [data-layout="vertical2"]').click();
    await until(() => panes().length === 2);
    const secondPaneId = state.panes.find(pane => pane.id !== firstPaneId).id;
    go(secondPaneId, { kind: 'folder', id: 'other-folder' });
    await until(() => paneSnapshot(panes().find(pane => pane.dataset.paneId === secondPaneId)).current === 'Other');

    const firstPane = panes().find(pane => pane.dataset.paneId === firstPaneId);
    const secondPane = panes().find(pane => pane.dataset.paneId === secondPaneId);
    const switchingInput = beginPathEdit(firstPane);
    secondPane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    await wait(20);
    assert(!firstPane.querySelector('.breadcrumb-input'), '切换分栏后旧栏仍保留路径编辑态');
    assert(!secondPane.querySelector('.breadcrumb-input'), '切换分栏错误复用了路径编辑态');
    assert(switchingInput.value === 'Alpha / Beta / Gamma / Delta', '路径编辑态的旧输入被意外改写');
    const betaAncestor = firstPane.querySelector('.breadcrumb-full [data-crumb-index="2"]');
    assert(betaAncestor && !betaAncestor.disabled, '深层祖先必须是可点击节点');
    betaAncestor.click();
    await until(() => paneSnapshot(firstPane).current === 'Beta');
    assert(paneSnapshot(secondPane).current === 'Other', '祖先点击串联到了另一栏');
    assert(state.activePaneId === firstPaneId, '路径点击没有激活所属栏');

    go(firstPaneId, { kind: 'folder', id: 'delta-folder' });
    await until(() => paneSnapshot(firstPane).current === 'Delta');

    let fitPath = null;
    if (platform !== 'web') {
      document.querySelector('#paneLayoutButton').click();
      document.querySelector('#paneLayoutPopover [data-layout="single"]').click();
      await until(() => panes().length === 1);
      await window.eagleMV.resizeWindow(1200, 820);
      await wait(140);
      fitPath = paneSnapshot(panes()[0]);
      assert(fitPath.fullNaturalWidth <= fitPath.breadcrumbWidth + 1, '测试路径在当前宽度本应完整放下: ' + JSON.stringify(fitPath));
      document.querySelector('#paneLayoutButton').click();
      document.querySelector('#paneLayoutPopover [data-layout="vertical2"]').click();
      await until(() => panes().length === 2);
    }

    if (platform === 'web') {
      for (const width of [390, 375, 320]) {
        await window.eagleMV.resizeWindow(width, 760);
        await wait(140);
        const narrowInput = beginPathEdit(panes()[0]);
        const narrowBreadcrumb = panes()[0].querySelector('#breadcrumb');
        const narrowRect = narrowInput.getBoundingClientRect();
        assert(Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth + 1, width + 'px 编辑态路径输入造成页面横向溢出');
        assert(narrowRect.left >= narrowBreadcrumb.getBoundingClientRect().left - 1 && narrowRect.right <= narrowBreadcrumb.getBoundingClientRect().right + 1, width + 'px 编辑态路径输入离开路径栏');
        narrowInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await until(() => !panes()[0].querySelector('.breadcrumb-input'));
        const current = paneSnapshot(panes()[0]);
        assert(current.compact === (current.fullNaturalWidth > current.breadcrumbWidth + 1), width + 'px 手机路径折叠状态与真实宽度不符: ' + JSON.stringify(current));
        assert(current.current === 'Delta' && current.currentVisible, width + 'px 手机当前节点不可见: ' + JSON.stringify(current));
        checkResponsive(width + 'px 手机');
      }

      for (const width of [601, 768, 820, 900]) {
        await window.eagleMV.resizeWindow(width, 820);
        await wait(140);
        assert(getComputedStyle(document.querySelector('.sidebar')).position === 'fixed', width + 'px Web 平板未进入文件夹抽屉');
        assert(getComputedStyle(document.querySelector('.inspector')).position === 'fixed', width + 'px Web 平板未进入检查器抽屉');
        checkResponsive(width + 'px Web 平板');
      }

      await window.eagleMV.resizeWindow(820, 820);
      await wait(100);
      const headingTarget = document.querySelector('.content-pane .content-heading .location-block');
      const touchPoint = { bubbles: true, pointerType: 'touch', clientX: 40, clientY: 80 };
      headingTarget.dispatchEvent(new PointerEvent('pointerdown', touchPoint));
      await wait(540);
      const menu = document.querySelector('#contextMenu');
      assert(!menu.classList.contains('hidden'), 'Web 触摸工作区菜单未打开');
      const layoutRow = [...menu.querySelectorAll('.context-menu-row')]
        .find(row => row.querySelector('.context-menu-label')?.textContent.trim() === '分栏布局');
      assert(layoutRow, 'Web 工作区菜单没有分栏布局入口');
      const singleOption = menu.querySelector('[data-context-action="set-pane-layout"][data-context-payload*="single"]');
      assert(singleOption, 'Web 触摸分栏布局子菜单没有单栏选项');
      headingTarget.dispatchEvent(new PointerEvent('pointerup', touchPoint));
      layoutRow.click();
      await wait(20);
      const horizontalOption = menu.querySelector('[data-context-action="set-pane-layout"][data-context-payload*="horizontal2"]');
      assert(horizontalOption, '触摸分栏布局子菜单没有上下两栏');
      horizontalOption.click();
      await until(() => document.querySelector('#paneLayout').dataset.layout === 'horizontal2');
      assert(panes().length === 2, '触摸布局入口改变了栏数量');
      checkResponsive('Web 平板上下堆叠');

      await window.eagleMV.resizeWindow(1200, 820);
      await until(() => !document.body.classList.contains('compact-layout'));
      await wait(40);
      assert(innerWidth >= 1100 && !document.body.classList.contains('compact-layout'), 'Web 桌面错误使用抽屉布局');
      assert(getComputedStyle(document.querySelector('.pane-layout-control')).display !== 'none', 'Web 桌面布局按钮被隐藏');
      checkResponsive('Web 桌面');
      return { platform, mobile: true, panes: panes().length, layout: document.querySelector('#paneLayout').dataset.layout, deepPath: deep };
    }

    await window.eagleMV.resizeWindow(613, 820);
    await wait(140);
    assert(!document.body.classList.contains('compact-layout'), 'Electron 窄窗口错误启用 Web 抽屉');
    assert(getComputedStyle(document.querySelector('.sidebar')).position !== 'fixed', 'Electron 窄窗口把侧栏变成了 Web 抽屉');
    await until(() => paneSnapshot(panes()[0]).compact);
    const electronNarrowInput = beginPathEdit(panes()[0]);
    const electronBreadcrumb = panes()[0].querySelector('#breadcrumb');
    const electronInputRect = electronNarrowInput.getBoundingClientRect();
    assert(Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth + 1, 'Electron 窄窗口编辑态路径输入造成页面横向溢出');
    assert(electronInputRect.left >= electronBreadcrumb.getBoundingClientRect().left - 1 && electronInputRect.right <= electronBreadcrumb.getBoundingClientRect().right + 1, 'Electron 窄窗口编辑态路径输入离开路径栏');
    electronNarrowInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await until(() => !panes()[0].querySelector('.breadcrumb-input'));
    await wait(40);
    checkResponsive('Electron 窄窗口');
    return { platform, mobile: false, panes: panes().length, layout: document.querySelector('#paneLayout').dataset.layout, deepPath: deep, fitPath };
  })()`);
  process.stdout.write(`EAGLEMV_PATH_BAR_RESULT ${JSON.stringify(result)}\n`);
  window.destroy();
  app.quit();
}

run().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
}).finally(() => {
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
});
