'use strict';
// Real-renderer check for the Eagle-parity inspector (group 6 B): section
// order, folder chips, stars, and the multi-select panel's batch edits.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-inspector-parity-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1280, height: 860,
    webPreferences: { contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'inspector-parity-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (predicate, label) => { for (let i = 0; i < 200; i += 1) { if (predicate()) return; await wait(20); } throw new Error('timed out: ' + label); };
    const $ = selector => document.querySelector(selector);
    const press = target => target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    const calls = () => window.__inspectorCalls;
    await until(() => document.querySelectorAll('.content-pane .item-card').length === 3, 'cards');
    const pane = document.querySelector('.content-pane');
    const card = id => pane.querySelector('.item-card[data-id="' + id + '"]');
    const out = {};

    press(card('item-1'));
    await until(() => !$('#inspectorContent').classList.contains('hidden') && $('#itemFolderChips .folder-chip'), 'single inspector');
    const content = $('#inspectorContent');
    const top = selector => content.querySelector(selector).getBoundingClientRect().top;
    out.singleOrder = ['#itemName', '#itemAnnotation', '#itemURL', '#itemTagInput', '#itemFolderChips', '#itemCommentsSection', '#itemStars', '#itemMeta']
      .map(top).every((value, index, list) => index === 0 || value > list[index - 1]);
    out.ratingSelectHidden = getComputedStyle($('#itemRating')).display === 'none';
    out.folderChips = [...document.querySelectorAll('#itemFolderChips .folder-chip')].map(chip => ({ name: chip.textContent.replace('×', ''), title: chip.title, color: chip.style.getPropertyValue('--tag-color') }));
    out.addButton = $('#itemFolderChips [data-add-folder]')?.textContent;
    out.litStars = document.querySelectorAll('#itemStars .inspector-star.filled').length;
    out.metaLabels = [...document.querySelectorAll('#itemMeta em')].map(em => em.textContent);

    press($('#itemStars [data-inspector-star="4"]'));
    await until(() => calls().some(call => call.kind === 'mutate' && call.patch.star === 4), 'star 4 saved');
    await until(() => document.querySelectorAll('#itemStars .inspector-star.filled').length === 4 && !state.inspectorSaving, 'stars show 4');
    press($('#itemStars [data-inspector-star="4"]'));
    await until(() => calls().some(call => call.kind === 'mutate' && call.patch.star === 0), 'lit star clears');
    out.starWrites = calls().filter(call => call.kind === 'mutate').map(call => call.patch.star);
    await until(() => !state.inspectorSaving && !state.operationTracker.size, 'save settled');

    press($('#itemFolderChips [data-remove-folder="folder-b"]'));
    await until(() => calls().some(call => call.kind === 'mutate-set' && call.field === 'folders'), 'folder removal');
    out.folderRemoval = calls().filter(call => call.kind === 'mutate-set' && call.field === 'folders');
    await until(() => document.querySelectorAll('#itemFolderChips .folder-chip').length === 1, 'chip gone');
    out.selectedAfterRemoval = [...state.selected];

    press(card('item-3'));
    await until(() => [...state.selected][0] === 'item-3' && $('#itemFolderChips [data-add-folder]'), 'audio item');
    out.audioMeta = [...document.querySelectorAll('#itemMeta span')].map(span => span.textContent);
    out.emptyFolderButton = $('#itemFolderChips [data-add-folder]').textContent;

    calls().length = 0;
    press(card('item-1'));
    card('item-2').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    await until(() => !$('#multiSelection').classList.contains('hidden'), 'multi panel');
    out.multi = {
      count: $('#multiCountLine').textContent.replace(/\\s+/g, ' ').trim(),
      thumbs: document.querySelectorAll('#multiPreview img').length,
      annotation: $('#batchAnnotation').value,
      url: $('#batchURL').value,
      urlPlaceholder: $('#batchURL').placeholder,
      sharedTags: [...document.querySelectorAll('#sharedTagChips .tag-chip')].map(chip => chip.firstElementChild.textContent),
      sharedFolders: [...document.querySelectorAll('#batchFolderChips .folder-chip')].map(chip => chip.textContent.replace('×', '')),
      litStars: document.querySelectorAll('#batchStars .inspector-star.filled').length,
      meta: $('#batchMeta').textContent
    };

    // A hidden window gets no focus events from focus()/blur(); send them.
    const focusOn = field => field.dispatchEvent(new FocusEvent('focus'));
    const blurOff = field => field.dispatchEvent(new FocusEvent('blur'));
    const note = $('#batchAnnotation');
    focusOn(note); note.value = '批量注释'; note.dispatchEvent(new Event('input', { bubbles: true })); blurOff(note);
    await until(() => calls().filter(call => call.kind === 'mutate' && call.patch.annotation === '批量注释').length === 2, 'batch note');
    await until(() => !state.operationTracker.size, 'note settled');
    const link = $('#batchURL');
    focusOn(link); blurOff(link);
    await wait(150);
    out.untouchedLinkWrites = calls().filter(call => call.kind === 'mutate' && 'url' in call.patch).length;

    press($('#batchStars [data-inspector-star="3"]'));
    await until(() => calls().filter(call => call.kind === 'mutate' && call.patch.star === 3).length === 2, 'batch star');
    await until(() => !state.operationTracker.size, 'star settled');

    const tagInput = $('#batchTagInput');
    tagInput.focus(); tagInput.value = '批量标签';
    tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => calls().filter(call => call.kind === 'mutate-set' && call.field === 'tags' && call.add.includes('批量标签')).length === 2, 'batch tag');
    await until(() => !state.operationTracker.size && [...document.querySelectorAll('#sharedTagChips .tag-chip')].some(chip => chip.textContent.includes('批量标签')), 'tag settled');
    out.selectionAfterBatch = [...state.selected].sort();

    press($('#batchFolderChips [data-add-folder]'));
    await until(() => !$('#contextMenu').classList.contains('hidden'), 'folder picker');
    out.pickerOpen = Boolean($('#contextMenu .context-folder-search'));
    out.batchWrites = calls().map(call => call.kind === 'mutate' ? { id: call.id, patch: call.patch } : { id: call.id, field: call.field, add: call.add, remove: call.remove });
    return out;
  })()`);
  console.log(`EAGLEMV_INSPECTOR_PARITY ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
