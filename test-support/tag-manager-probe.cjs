'use strict';
// Real-renderer check for the Eagle-style tag manager (group 6 F): sidebar
// entries and counts, sections by initial or by group, search, sort, chip
// selection, the tag and group menus, drag to a group, and group notes.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-tag-manager-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1280, height: 820,
    webPreferences: { contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'tag-manager-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (predicate, label) => { for (let i = 0; i < 250; i += 1) { if (predicate()) return; await wait(20); } throw new Error('timed out: ' + label); };
    const $ = selector => document.querySelector(selector);
    const pane = () => document.querySelector('.content-pane');
    const inPane = selector => pane().querySelector(selector);
    const mouse = (target, type, init = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...init }));
    const chip = name => inPane('[data-tm-tag="' + name + '"]');
    const sections = () => [...pane().querySelectorAll('.tm-section')].map(section => section.querySelector('.tm-section-title span').textContent + ':' + [...section.querySelectorAll('[data-tm-tag]')].map(node => node.dataset.tmTag).join(','));
    const menu = () => [...document.querySelectorAll('#contextMenu > .context-menu-row')].map(row => row.querySelector('.context-menu-label').textContent + (row.classList.contains('disabled') ? '(off)' : ''));
    const choose = label => { const row = [...document.querySelectorAll('#contextMenu .context-menu-row')].find(node => node.querySelector(':scope > .context-menu-label').textContent === label && node.dataset.contextAction); mouse(row, 'click'); };
    const calls = () => window.__tagCalls;
    const out = {};
    await until(() => state.connected && state.availableTags.length === 6 && state.starredTags.length === 1, 'library');
    navigate({ kind: 'tags' });
    await until(() => inPane('.tag-manager'), 'tag manager');

    out.nav = [...pane().querySelectorAll('.tm-nav')].map(nav => nav.querySelector('.tm-nav-name').textContent + '=' + nav.querySelector('.tm-nav-count').textContent);
    out.byInitial = sections();
    out.groupDot = inPane('[data-tm-group="g-animals"] .tm-group-dot')?.style.background || '';

    mouse(inPane('[data-tm-sort-menu]'), 'click');
    await until(() => !$('#contextMenu').classList.contains('hidden'), 'sort menu');
    out.sortMenu = menu();
    choose('数量（多→少）');
    await until(() => sections()[0] !== out.byInitial[0] || inPane('[data-tm-sort-menu]').textContent.includes('数量'), 'count sort');
    out.byCountFirst = sections().find(section => section.startsWith('G:'));
    mouse(inPane('.tm-main'), 'contextmenu');
    choose('A > Z');
    mouse(inPane('.tm-main'), 'contextmenu');
    const groupBy = [...document.querySelectorAll('#contextMenu .context-menu-row')].find(row => row.textContent.includes('标签群组') && row.dataset.contextAction === 'tm-group-by');
    mouse(groupBy, 'click');
    await until(() => sections()[0]?.startsWith('动物'), 'group sections');
    out.byGroup = sections();
    mouse(inPane('.tm-main'), 'contextmenu');
    mouse([...document.querySelectorAll('#contextMenu .context-menu-row')].find(row => row.dataset.contextAction === 'tm-group-by' && row.textContent.includes('字母')), 'click');
    await until(() => sections()[0]?.startsWith('A'), 'back to initials');

    const search = inPane('.tm-search');
    search.focus(); search.value = 'an';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => sections().join('|') === 'B:Banana', 'search');
    out.highlight = chip('Banana').querySelector('mark')?.textContent;
    out.searchKeepsFocus = document.activeElement === search;
    search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));

    mouse(inPane('[data-tm-mode="unfiled"]'), 'click');
    await until(() => inPane('.tm-title').textContent === '未分类', 'unfiled');
    out.unfiled = sections();
    mouse(inPane('[data-tm-mode="starred"]'), 'click');
    await until(() => inPane('.tm-title').textContent === '常用标签', 'starred');
    out.starred = sections();
    mouse(inPane('[data-tm-group="g-animals"]'), 'click');
    await until(() => inPane('.tm-title').textContent === '动物', 'group view');
    out.groupView = sections();
    out.description = inPane('[data-tm-description]')?.value;

    mouse(chip('猫'), 'click');
    mouse(chip('狗'), 'click', { metaKey: true });
    out.selected = [...pane().querySelectorAll('.tm-tag.selected')].map(node => node.dataset.tmTag);
    mouse(chip('狗'), 'contextmenu');
    await until(() => !$('#contextMenu').classList.contains('hidden'), 'tag menu');
    out.tagMenu = menu();
    choose('从标签群组移除');
    await until(() => calls().some(call => call.kind === 'remove'), 'remove from group');

    mouse(inPane('[data-tm-mode="all"]'), 'click');
    await until(() => inPane('.tm-title').textContent === '全部标签', 'all');
    mouse(chip('风景'), 'click');
    mouse(chip('风景'), 'contextmenu');
    const moveRow = [...document.querySelectorAll('#contextMenu .context-menu-row')].find(row => row.querySelector(':scope > .context-menu-label').textContent === '移动至群组...');
    mouse([...moveRow.querySelectorAll('[data-context-action="tm-move-group"]')].find(row => row.textContent.includes('水果')), 'click');
    await until(() => calls().filter(call => call.kind === 'add').length === 1, 'move');

    mouse(chip('apple'), 'click');
    mouse(chip('Banana'), 'click', { shiftKey: true });
    out.rangeSelected = [...pane().querySelectorAll('.tm-tag.selected')].map(node => node.dataset.tmTag);
    mouse(chip('Banana'), 'contextmenu');
    choose('合并 2 个标签');
    await until(() => !$('#folderDialog').classList.contains('hidden'), 'merge dialog');
    $('#folderNameInput').value = '水果合集';
    mouse($('#folderDialogCreateButton'), 'click');
    await until(() => calls().some(call => call.kind === 'merge'), 'merge');

    const transfer = new DataTransfer();
    mouse(chip('3D'), 'click');
    chip('3D').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const target = inPane('[data-tm-group="g-animals"]');
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    out.dropHighlight = target.classList.contains('drop-target');
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    await until(() => calls().filter(call => call.kind === 'add').length === 2, 'drop add');

    mouse(inPane('[data-tm-group="g-fruit"]'), 'click');
    await until(() => inPane('.tm-title').textContent === '水果', 'fruit');
    const note = inPane('[data-tm-description]');
    note.focus(); note.value = '季节水果';
    note.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await until(() => calls().some(call => call.kind === 'update-group'), 'description');

    mouse(inPane('[data-tm-group="g-fruit"]'), 'contextmenu');
    out.groupMenu = menu();
    $('#contextMenu').classList.add('hidden');

    mouse(inPane('[data-tm-mode="all"]'), 'click');
    await until(() => chip('猫'), 'all again');
    mouse(chip('猫'), 'dblclick');
    await until(() => state.currentView.kind === 'all', 'open tag');
    out.openedQuery = { tags: state.query.tags, logic: state.query.tagLogic };
    out.calls = calls().map(call => { const { libraryPath, ...rest } = call; return rest; });
    return out;
  })()`);
  console.log(`EAGLEMV_TAG_MANAGER ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
