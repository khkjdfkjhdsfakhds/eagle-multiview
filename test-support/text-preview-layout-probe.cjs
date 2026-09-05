'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = process.env.EAGLEMV_LAYOUT_SOURCE_ROOT || path.resolve(__dirname, '..');
const { TextDraftStore } = require(path.join(root, 'lib/text-draft-store'));
const { createWebServer } = require(path.join(root, 'lib/web-server'));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-txt-layout-'));
app.setPath('userData', data);
app.on('window-all-closed', () => {});
const library = { path: '/mock/txt-layout.library', name: 'TXT layout fixture', folders: [], smartFolders: [] };
const item = { id: 'text-1', name: 'TXT layout fixture', ext: 'txt', size: 8, tags: [], folders: [], annotation: '', star: 0 };
const fingerprint = { size: 8, mtimeMs: 1 };
const longError = 'TXT 后台插件尚未连接；请在 Eagle 插件中启用 MultiView Review TXT 后台保存后重试。草稿保留在当前窗口，不会覆盖资料库原文。';
let store;
const invoke = async (method, [payload] = []) => {
  if (method.startsWith('text-draft:')) return store[method.split(':')[1]](payload);
  if (method === 'hub:connect') return { app: { version: 'fixture' }, library };
  if (method === 'hub:query') return { data: [item], total: 1, hasMore: false, nextOffset: 1 };
  if (method === 'hub:get-item') return item;
  if (method === 'text:read') return { content: 'original', fingerprint };
  if (method === 'text:save') throw new Error(longError);
  if (['hub:tags', 'hub:tag-groups', 'hub:recent-folders', 'item:comments'].includes(method)) return [];
  if (method === 'window:eagle-state') return { view: { kind: 'all' } };
  return {};
};
ipcMain.handle('txt-layout:invoke', (_event, method, args) => invoke(method, args));
const server = createWebServer({ srcDir: path.join(root, 'src'), requireKey: false,
  accessKey: 'synthetic-layout-key', resolveMediaPath: async () => null, invoke });
const sizes = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'desktop-narrow', width: 1000, height: 800 },
  { name: 'desktop-two-panes', width: 1280, height: 800, split: true },
  { name: 'desktop-narrow-two-panes', width: 1000, height: 800, split: true },
  { name: 'desktop-zoom', width: 1280, height: 900, zoom: 1.4 },
  { name: 'desktop-two-panes-zoom', width: 1440, height: 1000, split: true, zoom: 1.2 },
  { name: 'web-phone', width: 390, height: 844, web: true },
  { name: 'web-small-phone', width: 320, height: 740, web: true },
  { name: 'web-landscape', width: 844, height: 430, web: true }
];
const scenarios = sizes.flatMap(size => [
  { ...size, name: size.name + '-plain' },
  { ...size, name: size.name + '-recovery', recovery: true },
  { ...size, name: size.name + '-recovery-error', recovery: true, error: true }
]);
async function run() {
  await app.whenReady();
  const address = await server.start(0, '127.0.0.1');
  for (const config of scenarios) {
    store = new TextDraftStore(path.join(data, config.name, 'drafts'));
    if (config.recovery) await store.put({ libraryPath: library.path, id: item.id,
      draftId: 'another-window-draft', revision: 1, content: '需要恢复的中文草稿正文', base: fingerprint });
    const win = new BrowserWindow({ show: false, width: config.width, height: config.height,
      webPreferences: { contextIsolation: Boolean(config.web), nodeIntegration: false,
        partition: `txt-layout-${config.name}`, backgroundThrottling: false,
        ...(!config.web ? { preload: path.join(__dirname, 'text-preview-layout-preload.cjs') } : {}) } });
    if (config.web) await win.loadURL(`http://127.0.0.1:${address.port}/#state=${encodeURIComponent(JSON.stringify({ view: { kind: 'all' } }))}`);
    else await win.loadFile(path.join(root, 'src/index.html'));
    if (config.zoom) win.webContents.setZoomFactor(config.zoom);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const config = ${JSON.stringify(config)};
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const until = async fn => { for (let n = 0; n < 250; n++) { if (fn()) return; await wait(20); } throw new Error('TXT layout readiness timed out'); };
      await until(() => window.state?.connected && window.state.items.length && !window.state.loading);
      if (config.split) {
        document.querySelector('#paneLayoutButton').click();
        document.querySelector('#paneLayoutPopover [data-layout="vertical2"]').click();
        await until(() => window.state.panes.length === 2 && window.state.panes.every(p => p.items.length && !p.loading));
      }
      const pane = document.querySelector('.content-pane');
      const card = pane.querySelector('[data-id="text-1"]');
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await until(() => pane.querySelector('#textEditor'));
      let restored = false;
      let initialSelectFits = true;
      if (config.recovery) {
        const select = pane.querySelector('#textDraftSelect');
        initialSelectFits = select.scrollWidth <= select.clientWidth + 1;
        select.value = '0';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        pane.querySelector('#restoreTextDraft').click();
        restored = pane.querySelector('#textEditor').value === '需要恢复的中文草稿正文';
      }
      if (config.error) {
        const editor = pane.querySelector('#textEditor');
        editor.value = '尚未保存的布局验收草稿';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await until(() => pane.querySelector('#textStatus').title.includes('尚未保存'));
      }
      await wait(80);
      const preview = pane.querySelector('.text-preview');
      const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const controls = [...preview.querySelectorAll('button, select')].map(el => {
        const r = rect(el); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { id: el.id, tag: el.tagName, rect: r, hit: hit === el || el.contains(hit), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
          scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      });
      const result = { name: config.name, config, restored, initialSelectFits, platform: window.eagleMV.platform,
        viewport: { width: innerWidth, height: innerHeight }, preview: rect(preview),
        toolbars: [...preview.querySelectorAll('.text-toolbar')].map(rect),
        editor: rect(pane.querySelector('#textEditor')), controls,
        status: { text: pane.querySelector('#textStatus').textContent, rect: rect(pane.querySelector('#textStatus')),
          scrollWidth: pane.querySelector('#textStatus').scrollWidth, clientWidth: pane.querySelector('#textStatus').clientWidth },
        overflow: { scrollWidth: preview.scrollWidth, clientWidth: preview.clientWidth, scrollHeight: preview.scrollHeight, clientHeight: preview.clientHeight } };
      return result;
    })()`, true);
    result.zoomFactor = win.webContents.getZoomFactor();
    process.stdout.write('TXT_LAYOUT ' + JSON.stringify(result) + '\n');
    win.destroy();
  }
  await server.stop();
  fs.rmSync(data, { recursive: true, force: true });
  app.quit();
}
run().catch(async error => {
  process.stderr.write(`${error.stack || error}\n`);
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  await server.stop();
  fs.rmSync(data, { recursive: true, force: true });
  app.exit(1);
});
