'use strict';
// BUG-02: comment and tag-colour entries must ask through the in-app dialog,
// because Electron's window.prompt() never shows anything. Tag colours are
// picked from Eagle's palette there and in the colour manager.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-ask-text-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'ask-text-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (predicate, label) => { for (let i = 0; i < 150; i += 1) { if (predicate()) return; await wait(20); } throw new Error('timeout: ' + label); };
    await until(() => document.querySelectorAll('.content-pane .item-card').length === 6, 'items');
    document.querySelector('.content-pane .item-card[data-id="item-1"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const dialog = document.querySelector('#folderDialog');
    const input = document.querySelector('#folderNameInput');
    const answer = async value => {
      await until(() => !dialog.classList.contains('hidden'), 'dialog shown');
      const asked = { title: document.querySelector('#folderDialogTitle').textContent, initial: input.value };
      input.value = value;
      document.querySelector('#folderDialogForm').requestSubmit();
      await wait(30);
      return asked;
    };
    // Picks a palette swatch in the dialog: '' is 无.
    const pick = async color => {
      await until(() => !dialog.classList.contains('hidden'), 'palette shown');
      const palette = document.querySelector('#folderDialogPalette');
      const swatches = [...palette.querySelectorAll('[data-tag-palette-color]')];
      const asked = {
        title: document.querySelector('#folderDialogTitle').textContent,
        field: getComputedStyle(document.querySelector('.folder-dialog-field')).display,
        submit: getComputedStyle(document.querySelector('#folderDialogCreateButton')).display,
        colors: swatches.map(node => node.dataset.tagPaletteColor),
        checked: swatches.filter(node => node.getAttribute('aria-checked') === 'true').map(node => node.dataset.tagPaletteColor)
      };
      swatches.find(node => node.dataset.tagPaletteColor === color).click();
      await wait(30);
      asked.paletteLeft = palette.children.length;
      asked.modeLeft = dialog.classList.contains('palette-mode');
      return asked;
    };
    window.state.contextMenu = { ids: ['item-1'] };
    const colour = executeContextAction('tag-color', { tag: 'alpha' });
    const colourAsked = await pick('#e5484d');
    await colour;
    // Cancel leaves the colour alone.
    window.state.contextMenu = { ids: ['item-1'] };
    const cancelled = executeContextAction('tag-color', { tag: 'alpha' });
    await until(() => !dialog.classList.contains('hidden'), 'palette shown again');
    document.querySelector('#folderDialogCancelButton').click();
    await cancelled;
    const comment = addCommentToSelected();
    const commentAsked = await answer('好图');
    const rectAsked = await answer('');
    await comment;
    const hidden = dialog.classList.contains('hidden');
    const calls = [...window.__askText];
    // B1-07: the colour manager searches every tag, shows uncoloured tags as
    // hollow swatches and can clear a colour; an empty answer clears it too.
    state.availableTags = ['alpha', ...Array.from({ length: 250 }, (_, index) => 't' + index)].map(name => ({ name }));
    state.tagColors = { alpha: '#ff0000' };
    document.querySelector('#filterPopover').classList.remove('hidden');
    const manager = document.querySelector('#tagColorManager');
    manager.classList.remove('hidden');
    renderTagColors();
    const managerState = () => ({
      rows: manager.querySelectorAll('.tag-color-row').length,
      unset: manager.querySelectorAll('.tag-color-swatch.unset').length,
      clears: [...manager.querySelectorAll('[data-tag-color-clear]')].map(node => node.dataset.tagColorClear),
      more: manager.querySelector('.tag-color-more')?.textContent || '',
      pickers: manager.querySelectorAll('input[type="color"]').length,
      palettes: manager.querySelectorAll('.tag-color-palette').length
    });
    const initial = managerState();
    // A row opens the palette under it; a swatch applies and closes it.
    manager.querySelector('[data-tag-color-open="t0"]').click();
    const opened = { ...managerState(), colors: [...manager.querySelectorAll('.tag-color-palette [data-tag-palette-color]')].map(node => node.dataset.tagPaletteColor), popover: !document.querySelector('#filterPopover').classList.contains('hidden') };
    manager.querySelector('.tag-color-palette [data-tag-palette-color="#46a758"]').click();
    await wait(30);
    const picked = { ...managerState(), color: state.tagColors.t0 };
    // The preload's setTagColor answers with the one tag only.
    state.tagColors = { alpha: '#ff0000', t0: '#46a758' };
    renderTagColors();
    const search = manager.querySelector('[data-tag-color-search]');
    search.focus(); search.value = 't24';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const searched = { ...managerState(), focused: document.activeElement === manager.querySelector('[data-tag-color-search]') };
    window.__askText.length = 0;
    const research = manager.querySelector('[data-tag-color-search]');
    research.value = 'alpha'; research.dispatchEvent(new Event('input', { bubbles: true }));
    manager.querySelector('[data-tag-color-clear="alpha"]').click();
    await wait(30);
    const afterClear = managerState();
    document.querySelector('#filterPopover').classList.add('hidden');
    state.tagColors.t1 = '#123456';
    window.state.contextMenu = { ids: ['item-1'] };
    const contextClear = executeContextAction('tag-color', { tag: 't1' });
    const clearAsked = await pick('');
    await contextClear;
    return { colourAsked, commentAsked, rectAsked, calls, hidden, manager: { initial, opened, picked, searched, afterClear, clearAsked, clearCalls: window.__askText } };
  })()`);
  console.log(`EAGLEMV_ASK_TEXT ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
