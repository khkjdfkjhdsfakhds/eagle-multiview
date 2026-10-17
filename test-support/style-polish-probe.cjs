'use strict';
// Real-renderer check for the P3 colour/style batch: no text below 10px
// (P7-05), secondary text keeps 4.5:1 against what it is drawn on (P7-23),
// keyboard focus draws a ring on buttons and selects but not on cards
// (P7-21), small controls take clicks in a 24px box (P7-24), and reduced
// motion stops transitions (P7-25).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-style-polish-')));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  await win.loadFile(path.join(process.env.EAGLEMV_TEST_SOURCE_ROOT || path.resolve(__dirname, '..'), 'src/index.html'));
  win.webContents.debugger.attach('1.3');
  // A hidden window never has focus, so :focus-visible would never match.
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const run = source => win.webContents.executeJavaScript(source);
  const report = await run(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const assert = (value, message) => { if (!value) throw Error(message); };
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    state.library.folders = [...state.library.folders, { id: 'polish-a', name: '外层文件夹', imageCount: 3, children: [{ id: 'polish-b', name: '内层', imageCount: 1, children: [] }] }];
    renderFolderTree();
    await wait(60);

    const visible = element => {
      const r = element.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) return false;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
      }
      return true;
    };
    const ownText = element => [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim());

    // P7-05: no visible text below 10px.
    const tiny = [];
    for (const element of document.querySelectorAll('body *')) {
      if (!ownText(element) || !visible(element)) continue;
      const size = parseFloat(getComputedStyle(element).fontSize);
      if (size < 10) tiny.push((element.id || element.className || element.tagName) + ' ' + size + 'px');
    }
    assert(!tiny.length, 'text below 10px: ' + tiny.slice(0, 8).join(' | '));

    // P7-23: secondary text against the first opaque background behind it,
    // with any ancestor opacity folded into the text colour.
    const parse = value => (value.match(/[\\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const blend = (top, bottom, alpha) => top.slice(0, 3).map((v, i) => v * alpha + bottom[i] * (1 - alpha));
    const background = element => {
      const layers = [];
      for (let node = element; node; node = node.parentElement) {
        const [r, g, b, a = 1] = parse(getComputedStyle(node).backgroundColor);
        if (a > 0) layers.push([r, g, b, a]);
        if (a >= 1) break;
      }
      return layers.reverse().reduce((under, [r, g, b, a]) => blend([r, g, b], under, a), [0, 0, 0]);
    };
    const contrast = element => {
      const style = getComputedStyle(element);
      let [r, g, b, a = 1] = parse(style.color);
      for (let node = element; node; node = node.parentElement) a *= Number(getComputedStyle(node).opacity);
      const bg = background(element);
      const fg = blend([r, g, b], bg, a);
      const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return (hi + .05) / (lo + .05);
    };
    const checks = ['.content-pane .heading-path-row .breadcrumb button:not(:disabled)', '.breadcrumb-current', '.statusbar', '.location-block > .muted', '.folder-count', '.sidebar-library-label'];
    const low = [];
    let measured = 0;
    for (const selector of checks) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element) || !element.textContent.trim()) continue;
        measured += 1;
        const ratio = contrast(element);
        if (ratio < 4.5) low.push(selector + ' ' + ratio.toFixed(2));
      }
    }
    assert(measured >= 4, 'only ' + measured + ' secondary-text elements measured');
    assert(!low.length, 'secondary text below 4.5:1: ' + low.join(' | '));
    const muted = getComputedStyle(document.documentElement);
    for (const name of ['--muted', '--muted-2']) {
      const probe = document.createElement('span');
      probe.textContent = 'x';
      probe.style.color = 'var(' + name + ')';
      document.querySelector('.sidebar').append(probe);
      const ratio = contrast(probe);
      probe.remove();
      assert(ratio >= 4.5, name + ' only ' + ratio.toFixed(2) + ':1 on the sidebar');
    }

    // P7-24: the disclosure arrow takes a click 11px right of its centre.
    const toggle = document.querySelector('[data-folder-id="polish-a"] .folder-toggle');
    assert(toggle && visible(toggle), 'no folder toggle');
    const box = toggle.getBoundingClientRect();
    assert(box.width < 24, 'toggle drawn wider than before: ' + box.width);
    const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    for (const [dx, dy] of [[11, 0], [-11, 0], [0, 11], [0, -11]]) {
      const hit = document.elementFromPoint(cx + dx, cy + dy);
      assert(hit?.closest('.folder-toggle') === toggle, 'toggle misses ' + dx + ',' + dy + ' → ' + (hit?.className || hit?.tagName));
    }
    return { tiny: tiny.length, measured };
  })()`);

  // P7-21: keyboard focus shows a ring on a select and a button; a card does not.
  const focus = await run(`(async () => {
    const assert = (value, message) => { if (!value) throw Error(message); };
    const ring = element => { element.focus({ focusVisible: true }); const style = getComputedStyle(element); return { visible: element.matches(':focus-visible'), style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; };
    const select = document.createElement('select');
    select.innerHTML = '<option>一</option>';
    document.querySelector('.inspector').append(select);
    const selectRing = ring(select);
    select.remove();
    const button = document.querySelector('#filterButton');
    const buttonRing = ring(button);
    const card = document.querySelector('.item-card');
    const cardRing = card ? ring(card) : null;
    button.blur();
    assert(selectRing.visible && selectRing.style === 'solid' && selectRing.width >= 2, 'select ring ' + JSON.stringify(selectRing));
    assert(buttonRing.visible && buttonRing.style === 'solid' && buttonRing.width >= 2, 'button ring ' + JSON.stringify(buttonRing));
    assert(!cardRing || cardRing.style === 'none' || cardRing.width === 0, 'card ring ' + JSON.stringify(cardRing));
    return true;
  })()`);

  // P7-25: reduced motion finishes transitions and animations at once.
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const motion = await run(`(() => {
    const assert = (value, message) => { if (!value) throw Error(message); };
    assert(matchMedia('(prefers-reduced-motion: reduce)').matches, 'emulation off');
    const seconds = value => Math.max(...value.split(',').map(part => part.trim().endsWith('ms') ? parseFloat(part) / 1000 : parseFloat(part)));
    const slow = [];
    for (const element of document.querySelectorAll('body *')) {
      const style = getComputedStyle(element);
      if (seconds(style.transitionDuration) > .001 || seconds(style.animationDuration) > .001) slow.push(element.className || element.tagName);
    }
    assert(!slow.length, 'still animating under reduced motion: ' + slow.slice(0, 6).join(' | '));
    return true;
  })()`);
  console.log('STYLE_POLISH_OK ' + JSON.stringify({ report, focus, motion }));
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
