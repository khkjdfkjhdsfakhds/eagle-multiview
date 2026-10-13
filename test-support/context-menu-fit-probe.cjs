'use strict';
// P7-09/P7-10 at the minimum window size: the item menu, its last row and
// every submenu must lie inside the viewport and receive the pointer.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-menu-fit-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false, useContentSize: true, width: 980, height: 640,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'review-bugfixes-preload.cjs') }
  });
  await window.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 150 && document.querySelectorAll('.content-pane .item-card').length !== 6; i += 1) await wait(20);
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const card = document.querySelector('.content-pane .item-card[data-id="item-1"]');
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: innerWidth - 10, clientY: innerHeight - 10 }));
    await frame();
    const menu = document.querySelector('#contextMenu');
    const problems = [];
    const inside = (rect, label) => {
      if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) problems.push(label + ' ' + JSON.stringify({ l: rect.left, t: rect.top, r: rect.right, b: rect.bottom }));
    };
    inside(menu.getBoundingClientRect(), 'menu');
    const rows = [...menu.querySelectorAll(':scope > .context-menu-row')];
    const last = rows.at(-1);
    last.scrollIntoView({ block: 'nearest' });
    await frame();
    const lastRect = last.getBoundingClientRect();
    inside(lastRect, 'last row');
    const hit = document.elementFromPoint(lastRect.left + lastRect.width / 2, lastRect.top + lastRect.height / 2);
    if (hit?.closest('.context-menu-row') !== last) problems.push('last row not hit-testable: ' + last.textContent.trim());
    const submenus = [];
    for (const row of rows.filter(row => row.classList.contains('has-submenu'))) {
      row.scrollIntoView({ block: 'nearest' });
      row.dispatchEvent(new MouseEvent('mouseenter'));
      await frame();
      const submenu = row.querySelector(':scope > .context-submenu');
      const label = row.querySelector('.context-menu-label')?.textContent.trim();
      submenus.push(label);
      inside(submenu.getBoundingClientRect(), 'submenu ' + label);
      row.classList.remove('submenu-open');
    }
    // A picker that shrinks while it is open (search filtering) must stay
    // where it is: moving onto one of its rows must not slide it away from
    // under the pointer.
    const pickerRow = rows.filter(row => row.querySelector(':scope > .context-submenu .context-menu-row')).at(-1);
    const picker = pickerRow.querySelector(':scope > .context-submenu');
    const sample = picker.querySelector('.context-menu-row');
    // Tall enough to be pinned at the top margin, like a long tag list.
    for (let i = 0; i < 40; i += 1) sample.after(sample.cloneNode(true));
    pickerRow.scrollIntoView({ block: 'nearest' });
    pickerRow.dispatchEvent(new MouseEvent('mouseenter'));
    await frame();
    const placed = { left: picker.style.left, top: picker.style.top };
    const entries = [...picker.querySelectorAll('.context-menu-row')];
    entries.slice(1).forEach(entry => entry.remove());
    picker.dispatchEvent(new MouseEvent('mouseenter'));
    await frame();
    if (picker.style.left !== placed.left || picker.style.top !== placed.top) {
      problems.push('open submenu moved when the pointer entered it: ' + pickerRow.querySelector('.context-menu-label')?.textContent.trim() + ' ' + JSON.stringify({ placed, now: { left: picker.style.left, top: picker.style.top } }));
    }
    pickerRow.classList.remove('submenu-open');
    return { problems, submenus, last: last.textContent.trim() };
  })()`);
  console.log(`EAGLEMV_MENU_FIT ${JSON.stringify(result)}`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => app.quit());
