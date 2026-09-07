'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-metadata-characters-'));
app.setPath('userData', profile);
app.on('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1000, height: 820, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  const root = process.env.EAGLEMV_UI_SOURCE_ROOT || path.resolve(__dirname, '..');
  await win.loadFile(path.join(root, 'src/index.html'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let n = 0; n < 150 && !state.connected; n++) await wait(20);
    const assert = (value, message) => { if (!value) throw Error(message); };
    const panel = document.querySelector('#generationMetadata');
    const section = document.querySelector('#generationMetadataSection');
    const metadata = { format: 'NovelAI', positive: 'two travelers, mountain landscape', negative: 'blurry',
      characters: [{ index: 1, positive: 'blue jacket, standing <tag> & detail' },
        { index: 2, positive: 'red hat, sitting, ' + 'long-unbroken-caption'.repeat(20) }], params: { Steps: '28' } };
    renderGenerationMetadata(metadata);
    const labels = [...panel.querySelectorAll('.metadata-block-heading .metadata-label')].map(el => el.textContent);
    assert(JSON.stringify(labels) === JSON.stringify(['正向提示词', '角色 1 提示词', '角色 2 提示词', '负向提示词']), 'character order or labels changed');
    assert(!panel.querySelector('tag'), 'prompt was treated as HTML');
    const copies = [];
    window.eagleMV.copyText = async text => { copies.push(text); return true; };
    for (const button of panel.querySelectorAll('[data-metadata-copy]')) { button.click(); await wait(10); }
    assert(JSON.stringify(copies) === JSON.stringify([metadata.positive, ...metadata.characters.map(c => c.positive), metadata.negative]), 'copy selected the wrong prompt');
    document.querySelector('#noSelection').classList.add('hidden');
    document.querySelector('#inspectorContent').classList.remove('hidden');
    for (const child of document.querySelector('#inspectorContent').children) {
      if (child !== section) child.classList.add('hidden');
    }
    document.documentElement.style.setProperty('--inspector-width', '240px');
    await wait(80);
    renderGenerationMetadata(metadata);
    for (const block of panel.querySelectorAll('.metadata-block')) {
      assert(block.clientWidth > 0 && block.scrollWidth <= block.clientWidth + 1, 'narrow prompt block overflows: ' + JSON.stringify({ width: block.clientWidth, scroll: block.scrollWidth, body: document.body.className, hidden: document.querySelector('#inspectorContent').className }));
      const heading = block.querySelector('.metadata-block-heading');
      if (heading) assert(heading.firstElementChild.getBoundingClientRect().right <= heading.lastElementChild.getBoundingClientRect().left, 'copy overlaps prompt label');
    }
    renderGenerationMetadata({ format: 'Automatic1111', positive: 'next image', negative: 'next negative' });
    assert(!panel.textContent.includes('角色') && !panel.textContent.includes('blue jacket'), 'character content leaked to next image');
    renderGenerationMetadata(null);
    assert(section.classList.contains('hidden') && panel.childElementCount === 0, 'empty metadata retains stale prompts');
    renderGenerationMetadata(metadata);
    return { labels, copies: copies.length, narrowLayout: true, switching: true };
  })()`);
  console.log('METADATA_CHARACTERS_RESULT ' + JSON.stringify(result));
  if (process.env.EAGLEMV_METADATA_SCREENSHOT) fs.writeFileSync(process.env.EAGLEMV_METADATA_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  win.destroy();
  app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
