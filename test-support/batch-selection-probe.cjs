'use strict';
// B2-01: a batch write must not pull the selection back to its starting items
// when the user picked something else meanwhile, must not hold its lock while
// the view refreshes, and rapid ratings of the same item must all apply.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-batch-selection-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'batch-selection-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && !(window.state?.connected && state.items.length === 3); i += 1) await wait(20);
    if (state.items.length !== 3) throw new Error('fixture items not loaded');
    const toasts = [];
    new MutationObserver(() => toasts.push($('#toast').textContent)).observe($('#toast'), { childList: true, characterData: true, subtree: true });
    const gates = window.__batchGates;
    const selected = () => [...state.selected].sort();
    const star = id => window.__batchItems.find(item => item.id === id).star;
    const out = {};

    // 1. Rate A, move to B while the write is in flight, rate B while the
    //    view is still refreshing.
    selectItem('a');
    gates.mutate = true;
    const first = setSelectionRating({ ids: ['a'], rating: 3 });
    await wait(30);
    selectItem('b');
    gates.query = true;
    window.__batchRelease('mutate');
    await wait(60);
    const second = setSelectionRating({ ids: ['b'], rating: 4 });
    await wait(60);
    out.secondStartedDuringRefresh = window.__batchCalls.some(call => call.id === 'b' && call.patch?.star === 4);
    window.__batchRelease('query');
    await Promise.all([first, second]);
    await wait(30);
    out.ratingSelection = selected();
    out.ratingStars = { a: star('a'), b: star('b') };

    // 2. Two ratings of the same item in quick succession.
    selectItem('c');
    gates.mutate = true;
    const r1 = setSelectionRating({ ids: ['c'], rating: 2 });
    const r2 = setSelectionRating({ ids: ['c'], rating: 5 });
    await wait(30);
    window.__batchRelease('mutate');
    for (let i = 0; i < 20 && window.__batchCalls.filter(call => call.id === 'c').length < 2; i += 1) await wait(20);
    window.__batchRelease('mutate');
    await Promise.all([r1, r2]);
    out.repeatStar = star('c');
    out.repeatWrites = window.__batchCalls.filter(call => call.id === 'c').map(call => call.patch.star);

    // 3. Add a tag to A, pick C while the write is in flight.
    selectItem('a');
    gates.mutate = true;
    const tagged = addTagToSelection({ ids: ['a'], tag: 'x' });
    await wait(30);
    selectItem('c');
    window.__batchRelease('mutate');
    await tagged;
    out.tagSelection = selected();

    // 4. Trash B, pick A while the write is in flight.
    selectItem('b');
    gates.mutate = true;
    const trashed = applyTrash(['b'], true);
    await wait(30);
    selectItem('a');
    window.__batchRelease('mutate');
    await trashed;
    out.trashSelection = selected();

    out.rejected = toasts.filter(text => /请勿重复操作|其他窗口发生变化/.test(text));
    return out;
  })()`);
  console.log(`EAGLEMV_BATCH_SELECTION ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
