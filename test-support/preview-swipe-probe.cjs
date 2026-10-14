'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-swipe-'));
app.setPath('userData', userData); app.setPath('cache', path.join(userData, 'cache'));
async function run() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, 'sync-panes-preload.cjs') } });
  await window.loadFile(path.join(__dirname, '../src/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const until = async p => { for (let i=0;i<160;i+=1){ if (p()) return; await wait(20);} throw new Error('not ready'); };
    await until(() => document.body.classList.contains('offline') === false && document.querySelector('.content-pane .item-card'));
    const pane = document.querySelector('.content-pane');
    const modal = pane.querySelector('#previewModal');
    const media = pane.querySelector('#modalMedia');
    const preview = () => window.state.panes[0].previewId;
    // The fixture images never decode; stand in an image so the swipe engages.
    const standIn = async () => {
      await wait(80);
      media.innerHTML = '<img class="preview-image" alt="">';
      modal.classList.add('image-gesture');
      return media.querySelector('img');
    };
    const open = async id => {
      pane.querySelector('.item-card[data-id="' + id + '"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await until(() => preview() === id);
      return standIn();
    };
    // Pen pointer events; the mouse is pointer 1, so capturing it is valid.
    const y = () => modal.getBoundingClientRect().top + 200;
    const fire = (type, x) => media.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'pen', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y()
    }));
    const peek = () => modal.querySelector('.preview-swipe-peek');
    const peekState = () => peek() ? { src: peek().querySelector('img').getAttribute('src'), transform: peek().style.transform } : null;
    // Dragging shows the neighbour on the side being dragged towards.
    let image = await open('item-3');
    const out = { width: media.getBoundingClientRect().width };
    fire('pointerdown', 700);
    fire('pointermove', 600);
    out.dragLeft = { image: image.style.transform, peek: peekState() };
    fire('pointermove', 800);
    out.dragRight = { image: image.style.transform, peek: peekState() };
    // A short, slow drag springs back.
    fire('pointermove', 650);
    await wait(150);
    fire('pointerup', 650);
    await wait(450);
    out.springBack = { preview: preview(), image: image.style.transform, peek: Boolean(peek()) };

    // A short quick flick turns the page; both layers slide before it switches.
    fire('pointerdown', 700);
    fire('pointermove', 690);
    await wait(30);
    fire('pointermove', 660);
    fire('pointerup', 660);
    await wait(40);
    out.flickMid = { preview: preview(), peek: Boolean(peek()), animations: image.getAnimations().length };
    await until(() => preview() === 'item-4' && !peek());
    out.flick = preview();

    // A long slow drag turns the page too.
    image = await standIn();
    fire('pointerdown', 900);
    fire('pointermove', 600);
    fire('pointermove', 400);
    await wait(150);
    fire('pointerup', 400);
    await until(() => preview() === 'item-5' && !peek());
    await wait(100);
    out.far = preview();

    // A frozen animation clock (backgrounded app) must not strand the turn.
    image = await standIn();
    fire('pointerdown', 900);
    fire('pointermove', 400);
    await wait(150);
    fire('pointerup', 400);
    for (const animation of document.getAnimations()) animation.pause();
    await wait(600);
    out.frozen = { preview: preview(), peek: Boolean(peek()) };

    // Past the last item the drag rubber-bands and nothing turns.
    image = await open('item-6');
    fire('pointerdown', 700);
    fire('pointermove', 500);
    out.endDrag = { image: image.style.transform, peek: Boolean(peek()) };
    await wait(150);
    fire('pointerup', 500);
    await wait(450);
    out.end = { preview: preview(), image: image.style.transform };
    return out;
  })()`);
  process.stdout.write(`EAGLEMV_SWIPE ${JSON.stringify(result)}\n`);
  window.destroy(); app.quit();
}
run().catch(e => { console.error(e); app.exit(1); });
