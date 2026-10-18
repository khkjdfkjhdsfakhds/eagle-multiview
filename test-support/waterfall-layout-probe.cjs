'use strict';
// Real-renderer check for D-10 / T-07: 瀑布流 reads row by row with every card
// in the shortest column like Eagle's GridLayout, a lazy-load page leaves the
// cards above where they were, and a narrower pane or another thumbnail size
// lays the cards out again without overlap. Box selection still hits the
// placed cards.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setPath('userData', require('./temp-userdata.cjs').tempUserData('eaglemv-waterfall-'));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'waterfall-layout-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const pane = state.panes[0];
    pane.currentView = { kind: 'folder', id: 'mv-folder' };
    setPaneViewMode('waterfall', pane.id);
    await refresh({ reset: true, preserveScroll: false, paneId: pane.id });
    await frame();
    const grid = () => paneQuery(pane.id, '.asset-grid.waterfall');
    const boxes = () => [...grid().children].map(card => ({ id: card.dataset.id, left: card.offsetLeft, top: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight }));
    const check = (label) => {
      const list = boxes();
      const lefts = [...new Set(list.map(box => box.left))].sort((a, b) => a - b);
      const width = grid().clientWidth;
      assert(lefts.length > 1, label + ': one column only');
      const columnWidth = list[0].width;
      assert(list.every(box => Math.abs(box.width - columnWidth) <= 1), label + ': unequal card widths');
      assert(lefts.at(-1) + columnWidth <= width + 1, label + ': last column overflows ' + (lefts.at(-1) + columnWidth) + ' > ' + width);
      // First row: one card per column, left to right.
      list.slice(0, lefts.length).forEach((box, index) => {
        assert(box.top === 0 && box.left === lefts[index], label + ': first row not in order at ' + index);
      });
      // Every later card sits under the shortest column of the cards before it.
      const bottoms = new Map(lefts.map(left => [left, 0]));
      for (const box of list) {
        const shortest = Math.min(...bottoms.values());
        const column = lefts.find(left => bottoms.get(left) === shortest);
        assert(box.left === column, label + ': ' + box.id + ' not in the shortest column');
        assert(box.top >= bottoms.get(column), label + ': ' + box.id + ' overlaps the card above');
        bottoms.set(column, box.top + box.height + 12);
      }
      const height = grid().offsetHeight;
      assert(Math.abs(height - (Math.max(...bottoms.values()) - 12)) <= 1, label + ': grid height ' + height + ' does not enclose the cards');
      return { columns: lefts.length, count: list.length };
    };

    const first = check('first page');
    assert(first.count === 160, 'first page rendered ' + first.count);

    // A lazy-load page appends without moving the cards already shown.
    const before = boxes();
    const appendedGrid = grid();
    await refresh({ reset: false, preserveScroll: true, paneId: pane.id });
    await frame();
    assert(grid() === appendedGrid, 'the page rebuilt the grid instead of appending');
    const after = boxes();
    assert(after.length === 320, 'second page rendered ' + after.length);
    before.forEach((box, index) => {
      const now = after[index];
      assert(now.id === box.id && now.left === box.left && now.top === box.top, 'card ' + box.id + ' moved when a page was appended');
    });
    check('after append');

    // Box selection hits the placed cards.
    const scroller = paneQuery(pane.id, '#gridScroller');
    scroller.scrollTop = 0;
    const target = grid().children[1].getBoundingClientRect();
    const sbox = scroller.getBoundingClientRect();
    const down = new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, pointerId: 7, clientX: target.left + 4, clientY: sbox.top + 2 });
    const empty = document.elementFromPoint(target.left + 4, sbox.top + 2);
    (empty || scroller).dispatchEvent(down);
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, pointerId: 7, clientX: target.left + 10, clientY: target.top + 10 }));
    scroller.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, pointerId: 7, clientX: target.left + 10, clientY: target.top + 10 }));
    await frame();
    const marqueeSelected = [...state.selected];
    assert(marqueeSelected.length === 1 && marqueeSelected[0] === 'w-1', 'box selection missed the placed card: ' + marqueeSelected.join(','));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientX: target.left + 10, clientY: target.top + 10 }));
    scroller.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientX: target.left + 10, clientY: target.top + 10 }));

    // A larger thumbnail size means fewer columns, laid out again.
    applyThumbnailSize(320, { persist: false });
    await frame();
    const bigger = check('thumbnail 320');
    assert(bigger.columns < first.columns, 'columns did not follow the thumbnail size: ' + bigger.columns + ' vs ' + first.columns);
    applyThumbnailSize(168, { persist: false });
    await frame();
    return { first, bigger, marqueeSelected };
  })()`);
  // A narrower window lays the cards out again (resize observer).
  win.setContentSize(760, 800);
  await new Promise(resolve => setTimeout(resolve, 300));
  const narrow = await win.webContents.executeJavaScript(`(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const grid = paneQuery(state.panes[0].id, '.asset-grid.waterfall');
    const cards = [...grid.children];
    const lefts = [...new Set(cards.map(card => card.offsetLeft))];
    const right = Math.max(...cards.map(card => card.offsetLeft + card.offsetWidth));
    return { columns: lefts.length, right, width: grid.clientWidth };
  })()`);
  if (!(narrow.columns < result.first.columns)) throw Error('narrow window kept ' + narrow.columns + ' columns');
  if (narrow.right > narrow.width + 1) throw Error('narrow window overflows: ' + narrow.right + ' > ' + narrow.width);
  console.log('WATERFALL_OK ' + JSON.stringify({ ...result, narrow }));
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
