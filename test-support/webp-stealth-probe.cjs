'use strict';
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-webp-stealth-'));
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([
  { scheme: 'eaglemv', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
]);
app.on('will-quit', () => fs.rmSync(profile, { recursive: true, force: true }));
(async () => {
  await app.whenReady();
  const extension = process.env.EAGLEMV_STEALTH_EXT === 'png' ? 'png' : 'webp';
  let fixture;
  const sample = process.env.EAGLEMV_WEBP_SAMPLE
    ? 'data:image/webp;base64,' + fs.readFileSync(process.env.EAGLEMV_WEBP_SAMPLE).toString('base64') : null;
  const sampleCases = process.env.EAGLEMV_METADATA_SAMPLES
    ? JSON.parse(fs.readFileSync(process.env.EAGLEMV_METADATA_SAMPLES, 'utf8')) : [];
  const sampleBytes = sampleCases.map(entry => fs.readFileSync(entry.path));
  protocol.handle('eaglemv', request => {
    const caseMatch = new URL(request.url).pathname.match(/^\/case-(\d+)$/);
    if (caseMatch) {
      const index = Number(caseMatch[1]);
      return new Response(sampleBytes[index], { headers: { 'Content-Type': 'image/' + sampleCases[index].ext, 'Access-Control-Allow-Origin': '*' } });
    }
    const url = request.url.includes('sample') && sample ? sample : fixture;
    return new Response(Buffer.from(url.split(',')[1], 'base64'), { headers: {
      'Content-Type': 'image/' + extension, 'Access-Control-Allow-Origin': '*'
    } });
  });
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: {
    sandbox: false, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'renderer-ui-preload.cjs')
  } });
  const root = process.env.EAGLEMV_UI_SOURCE_ROOT || path.resolve(__dirname, '..');
  await win.loadFile(path.join(root, 'src/index.html'));
  const bundle = { Software: 'NovelAI', Description: 'WebP hidden prompt', Comment: JSON.stringify({
    uc: 'hidden negative', steps: 28, seed: 42, v4_prompt: { caption: { char_captions: [{ char_caption: 'blue jacket' }] } }
  }) };
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(bundle)));
  const length = Buffer.alloc(4); length.writeUInt32BE(payload.length * 8);
  const encoded = Buffer.concat([Buffer.from('stealth_pngcomp'), length, payload]);
  fixture = await win.webContents.executeJavaScript(`(() => {
    const bytes = ${JSON.stringify([...encoded])};
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 96;
    const ctx = canvas.getContext('2d'); const pixels = ctx.createImageData(96, 96);
    pixels.data.fill(255);
    bytes.forEach((byte, index) => { for (let bit = 0; bit < 8; bit++) {
      const n = index * 8 + bit, x = Math.floor(n / 96), y = n % 96;
      pixels.data[(y * 96 + x) * 4 + 3] = 254 | ((byte >> (7 - bit)) & 1);
    } });
    ctx.putImageData(pixels, 0, 0);
    const url = canvas.toDataURL('image/${extension}', 0.9);
    return url;
  })()`);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let n = 0; n < 150 && !document.querySelector('#toast').textContent.includes('已连接 Eagle'); n++) await wait(20);
    // Let the initial empty-query inspector debounce finish before selecting the fixture.
    await wait(100);
    const assert = (value, message) => { if (!value) throw Error(message); };
    const url = ${JSON.stringify(fixture)};
    assert(url.startsWith('data:image/${extension}'), 'Fixture must use the tested image format');
    window.eagleMV.mediaURL = (kind, id) => 'eaglemv://' + kind + '/' + id;
    window.eagleMV.readMetadata = async () => ({ metadata: null });
    const item = { id: 'stealth-${extension}', ext: '${extension}', name: 'Hidden metadata fixture', size: 500 };
    state.items = [item]; state.itemMap.set(item.id, item); state.selected = new Set([item.id]);
    await loadGenerationMetadata(item);
    const section = document.querySelector('#generationMetadataSection');
    const panel = document.querySelector('#generationMetadata');
    assert(!section.classList.contains('hidden'), 'Metadata Viewer hides alpha-embedded WebP metadata');
    assert(section.dataset.positive === 'WebP hidden prompt', 'Hidden WebP prompt is incorrect');
    assert(panel.textContent.includes('blue jacket') && panel.textContent.includes('hidden negative'), 'Hidden WebP character or negative prompt missing');
    const copies = []; window.eagleMV.copyText = async text => { copies.push(text); };
    panel.querySelector('[data-metadata-copy="positive"]').click(); await wait(10);
    assert(copies[0] === 'WebP hidden prompt', 'Hidden WebP prompt cannot be copied');
    let sampleResult = null;
    const sample = ${JSON.stringify(sample)};
    if (sample) {
      window.eagleMV.mediaURL = () => 'eaglemv://original/sample';
      item.modificationTime = 2;
      await loadGenerationMetadata(item);
      assert(!section.classList.contains('hidden') && section.dataset.positive.length > 1000, 'Attached WebP did not display generation metadata');
      sampleResult = { positiveLength: section.dataset.positive.length, negativeLength: section.dataset.negative.length,
        characterBlocks: panel.querySelectorAll('[data-metadata-copy="character"]').length };
    }
    // A late decode must not overwrite the newly selected image's metadata.
    const readImage = EagleMVStealthMetadata.readImage;
    let release, pendingSignal;
    EagleMVStealthMetadata.readImage = (_url, options) => { pendingSignal = options.signal; return new Promise(resolve => { release = resolve; }); };
    item.modificationTime = 3;
    const pending = loadGenerationMetadata(item); await wait(0);
    const next = { id: 'next', ext: 'jpg' }; state.selected = new Set([next.id]);
    window.eagleMV.readMetadata = async () => ({ metadata: { format: 'NovelAI', positive: 'next prompt' } });
    await loadGenerationMetadata(next);
    assert(pendingSignal.aborted, 'Previous decode was not cancelled');
    release(JSON.stringify(${JSON.stringify(bundle)})); await pending;
    assert(section.dataset.positive === 'next prompt', 'Previous WebP overwrote the new selection');
    EagleMVStealthMetadata.readImage = readImage;
    window.eagleMV.readMetadata = async () => ({ metadata: null });
    await loadGenerationMetadata(next);
    assert(section.classList.contains('hidden') && !panel.childElementCount, 'Image without metadata retained previous prompts');
    const cases = ${JSON.stringify(sampleCases.map(({ ext, expected }) => ({ ext, expected })))};
    const caseResults = [];
    window.eagleMV.mediaURL = (kind, id) => 'eaglemv://' + kind + '/' + id;
    for (let index = 0; index < cases.length; index++) {
      const entry = cases[index];
      const sampleItem = { id: 'case-' + index, ext: entry.ext, size: index + 1 };
      state.items = [sampleItem]; state.itemMap = new Map([[sampleItem.id, sampleItem]]);
      state.selected = new Set([sampleItem.id]);
      await loadGenerationMetadata(sampleItem);
      const visible = !section.classList.contains('hidden');
      assert(visible === Boolean(entry.expected), 'Unexpected metadata visibility in supplied sample ' + (index + 1));
      if (entry.expected) {
        assert(section.dataset.positive.length === entry.expected.positiveLength, 'Wrong positive prompt in sample ' + (index + 1));
        assert(section.dataset.negative.length === entry.expected.negativeLength, 'Wrong negative prompt in sample ' + (index + 1));
        assert(panel.querySelectorAll('[data-metadata-copy="character"]').length === entry.expected.characters, 'Wrong character count in sample ' + (index + 1));
        for (const button of panel.querySelectorAll('[data-metadata-copy]')) {
          button.click(); await wait(0);
          assert(copies.at(-1) === button.closest('.metadata-block').querySelector('pre').textContent, 'Sample copy differs from displayed prompt');
        }
      } else assert(!panel.childElementCount, 'No-metadata sample retained previous prompt');
      caseResults.push({ sample: index + 1, visible, ...entry.expected });
    }
    if (sample) {
      state.selected = new Set([item.id]); await loadGenerationMetadata(item);
      document.querySelector('#noSelection').classList.add('hidden');
      document.querySelector('#inspectorContent').classList.remove('hidden');
      for (const child of document.querySelector('#inspectorContent').children) if (child !== section) child.classList.add('hidden');
      document.documentElement.style.setProperty('--inspector-width', '360px');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      assert(!section.classList.contains('hidden') && section.getBoundingClientRect().height > 0, 'Sample metadata is not visibly laid out');
    }
    return { displayed: true, copied: true, switching: true, sample: sampleResult, cases: caseResults };
  })()`);
  console.log('WEBP_STEALTH_RESULT ' + JSON.stringify(result));
  if (process.env.EAGLEMV_METADATA_SCREENSHOT) fs.writeFileSync(process.env.EAGLEMV_METADATA_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  win.destroy(); app.quit();
})().catch(error => { console.error(error.stack || error); app.exit(1); });
