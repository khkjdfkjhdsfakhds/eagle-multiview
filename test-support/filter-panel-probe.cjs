'use strict';
// Real-renderer check for the filter panel (group 6 C, step 1): folder and
// format lists with counts, include / exclude, the rule switch, quick dates,
// 标注, the duration unit, and a panel that stays open while it is used.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = require('./temp-userdata.cjs').tempUserData('eaglemv-filter-panel-');
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 980, height: 640,
    webPreferences: { contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'filter-panel-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (predicate, label) => { for (let i = 0; i < 250; i += 1) { if (predicate()) return; await wait(20); } throw new Error('timed out: ' + label); };
    const $ = selector => document.querySelector(selector);
    const press = target => target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    const rightClick = target => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, button: 2 }));
    const cards = () => [...document.querySelectorAll('.content-pane .item-card')].map(card => card.dataset.id).sort();
    const rows = selector => [...document.querySelectorAll(selector + ' .filter-check-row')].map(row => [row.querySelector('.filter-check-name').textContent, row.querySelector('.filter-check-count')?.textContent ?? null, row.classList.contains('checked') ? '+' : row.classList.contains('excluded') ? '-' : '']);
    const settle = async (expected, label) => { await until(() => JSON.stringify(cards()) === JSON.stringify(expected), label + ' ' + JSON.stringify(cards())); };
    const out = {};
    await until(() => cards().length >= 1, 'root cards');
    navigate({ kind: 'all' });
    await until(() => cards().length === 4, 'all cards');

    press($('#filterButton'));
    await until(() => document.querySelector('#extFilterList .filter-check-count'), 'facets');
    out.folders = rows('#folderFilterList');
    out.exts = rows('#extFilterList');
    out.presets = [...document.querySelectorAll('[data-date-presets="added"] .filter-preset')].map(button => button.textContent);
    out.logic = [...document.querySelectorAll('[data-filter-logic="tagLogic"] .filter-logic-option')].map(button => button.textContent + (button.classList.contains('active') ? '*' : ''));

    press(document.querySelector('#folderFilterList [data-filter-folder="folder-a"]'));
    await settle(['item-1', 'item-2'], 'folder include');
    out.folderChecked = rows('#folderFilterList').find(row => row[0] === '甲')[2];
    out.openAfterClick = !$('#filterPopover').classList.contains('hidden');
    rightClick(document.querySelector('#folderFilterList [data-filter-folder="folder-b"]'));
    // Eagle's 任意 is a union: in 甲, or outside 乙.
    await settle(['item-1', 'item-2', 'item-3', 'item-4'], 'folder exclude under OR widens');
    press(document.querySelector('[data-filter-logic="folderLogic"] [data-logic-value="AND"]'));
    await settle(['item-1'], 'in 甲 and not in 乙');
    out.folderMarks = rows('#folderFilterList').map(row => row[0] + row[2]);
    press(document.querySelector('#folderFilterList [data-filter-folder="folder-a"]'));
    rightClick(document.querySelector('#folderFilterList [data-filter-folder="folder-b"]'));
    press(document.querySelector('[data-filter-logic="folderLogic"] [data-logic-value="OR"]'));
    await settle(['item-1', 'item-2', 'item-3', 'item-4'], 'folders cleared');

    rightClick(document.querySelector('#extFilterList [data-filter-ext="png"]'));
    await settle(['item-2', 'item-3'], 'format exclude');
    out.extExcluded = rows('#extFilterList').find(row => row[0] === 'PNG')[2];
    rightClick(document.querySelector('#extFilterList [data-filter-ext="png"]'));
    press(document.querySelector('#extFilterList [data-filter-ext="png"]'));
    press(document.querySelector('#extFilterList [data-filter-ext="jpg"]'));
    await settle(['item-1', 'item-2', 'item-4'], 'two formats');
    press(document.querySelector('#extFilterList [data-filter-ext="png"]'));
    press(document.querySelector('#extFilterList [data-filter-ext="jpg"]'));
    await settle(['item-1', 'item-2', 'item-3', 'item-4'], 'formats cleared');

    const tagInput = $('#filterTagInput');
    tagInput.focus(); tagInput.value = '白, 狗';
    tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle(['item-1', 'item-4'], 'tags OR');
    press(document.querySelector('[data-filter-logic="tagLogic"] [data-logic-value="AND"]'));
    await settle([], 'tags AND');
    press(document.querySelector('[data-filter-logic="tagLogic"] [data-logic-value="OR"]'));
    const chip = [...document.querySelectorAll('#filterTagChips .tag-chip')].find(node => node.textContent.includes('狗'));
    rightClick(chip);
    await settle(['item-1', 'item-2', 'item-3'], 'excluded tag under OR');
    out.excludedChip = Boolean(document.querySelector('#filterTagChips .tag-chip.excluded'));
    out.badgeTags = $('#filterCount').textContent;
    for (let button; (button = document.querySelector('#filterTagChips [data-remove-tag], #filterTagChips [data-remove-excluded-tag]'));) press(button);
    await settle(['item-1', 'item-2', 'item-3', 'item-4'], 'tags cleared');
    $('#noTagsFilter').click();
    await settle(['item-3'], '未标签');
    $('#noTagsFilter').click();

    press(document.querySelector('[data-date-presets="added"] [data-date-preset="today"]'));
    await settle(['item-1'], 'today');
    press(document.querySelector('[data-date-presets="added"] [data-date-preset="last7"]'));
    await settle(['item-1', 'item-3'], 'today or last 7');
    for (const name of ['today', 'last7']) press(document.querySelector('[data-date-presets="added"] [data-date-preset="' + name + '"]'));
    $('[data-date-months="added"]').open = true;
    out.months = rows('[data-month-list="added"]').length;
    press(document.querySelector('[data-month-list="added"] .filter-check-row'));
    await until(() => cards().length >= 1 && cards().length < 4, 'month');
    press(document.querySelector('[data-month-list="added"] .filter-check-row'));
    await settle(['item-1', 'item-2', 'item-3', 'item-4'], 'dates cleared');

    press(document.querySelector('[data-comments-state="has"]'));
    await settle(['item-1'], '有标注');
    out.commentsTextEnabled = !$('#commentsTextFilter').disabled;
    press(document.querySelector('[data-comments-state="none"]'));
    await settle(['item-2', 'item-3', 'item-4'], '没有标注');
    press(document.querySelector('[data-comments-state="none"]'));

    const unit = $('#durationUnitFilter');
    unit.value = 'm'; unit.dispatchEvent(new Event('change', { bubbles: true }));
    const min = $('#durationMinFilter');
    min.value = '1'; min.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(['item-3'], 'duration ≥ 1 min');
    out.durationStored = state.query.duration;
    min.value = '2'; min.dispatchEvent(new Event('input', { bubbles: true }));
    await settle([], 'duration ≥ 2 min');
    min.value = ''; min.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(['item-1', 'item-2', 'item-3', 'item-4'], 'duration cleared');

    const popover = $('#filterPopover');
    out.stillOpen = !popover.classList.contains('hidden');
    const box = popover.getBoundingClientRect();
    out.popoverFits = box.right <= window.innerWidth && box.bottom <= window.innerHeight;
    // Nothing (the column resizers) may sit over the open panel.
    out.panelOnTop = [0.25, 0.5, 0.75].every(fraction => {
      for (let x = box.left + 4; x < box.right - 4; x += 3) {
        if (!popover.contains(document.elementFromPoint(x, box.top + box.height * fraction))) return false;
      }
      return true;
    });
    out.noOverflow = popover.scrollWidth <= popover.clientWidth + 1 && getComputedStyle(popover).overflowX === "hidden" && [...popover.querySelectorAll('.filter-section, .filter-check-list, .filter-presets, .filter-section-head')].every(node => node.scrollWidth <= node.clientWidth + 1);
    out.lastQueryHasNoFilter = !window.EagleMVQuerySpec.filtersActive(state.query);
    return out;
  })()`);
  console.log(`EAGLEMV_FILTER_PANEL ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
