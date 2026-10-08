'use strict';

// Node networking avoids browser Origin/CORS and never opens an Eagle item.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const profile = path.join(os.homedir(), 'Library', 'Application Support', 'eagle-multiview');
const connectionFile = path.join(profile, 'TXT Bridge', 'connection.json');
const stagingRoot = path.join(profile, 'Text Backups', 'staging');
let save;
const sessionId = crypto.randomUUID();
let stopped = false;
let active = false;
let timer;
const requests = new Set();

async function openMultiViewCurrentView() {
  const status = document.querySelector('#status');
  try {
    const config = JSON.parse(await fs.readFile(connectionFile, 'utf8'));
    const result = await request(config, '/open-current', {});
    if (!result?.ok) throw new Error(result?.error || 'MultiView 当前界面不可用');
    status.textContent = '已打开 MultiView 当前界面';
    await eagle.window.hide();
  } catch (error) {
    status.textContent = error.message || '无法连接 MultiView';
  }
}

// Reverse of MultiView's own "Eagle 路径" button: Eagle follows the folder the
// foreground MultiView pane shows. Only ordinary folders and the library root
// can be located; Eagle's plugin API has no way to open smart folders, tags or
// the trash.
async function openMultiViewFolderInEagle() {
  const status = document.querySelector('#status');
  try {
    const config = JSON.parse(await fs.readFile(connectionFile, 'utf8'));
    const result = await request(config, '/current-view');
    if (!result?.ok) throw new Error(result?.error || 'MultiView 当前界面不可用');
    const view = result.view || {};
    if (view.kind === 'folder' && typeof view.id === 'string' && view.id) {
      if (!(await eagle.folder.open(view.id))) throw new Error('Eagle 未确认打开该文件夹，请刷新后重试');
      status.textContent = '已在 Eagle 打开 MultiView 当前文件夹';
      await eagle.window.hide();
      return;
    }
    if (view.kind === 'root') {
      status.textContent = 'MultiView 当前在资料库根目录；Eagle 插件无法回到根目录，请在 Eagle 中点击资料库。';
      return;
    }
    status.textContent = 'MultiView 当前界面不是普通文件夹，无法在 Eagle 中打开。';
  } catch (error) {
    status.textContent = error.message || '无法连接 MultiView';
  }
}

function request(config, route, body) {
  return new Promise((resolve, reject) => {
    if (stopped) return reject(new Error('Plugin stopped'));
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: config.port, path: route, method: payload ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${config.token}`, 'x-eaglemv-session': sessionId, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) }
    }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) req.destroy(new Error('Reply too large')); else chunks.push(chunk); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Bridge response ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    requests.add(req);
    req.once('close', () => requests.delete(req));
    req.setTimeout(2500, () => req.destroy(new Error('Bridge connection timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function tick() {
  if (stopped || active) return;
  active = true;
  try {
    const config = JSON.parse(await fs.readFile(connectionFile, 'utf8'));
    if (stopped) return;
    if (config.version !== 1 || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535
      || !/^[a-f0-9]{64}$/.test(config.token || '') || path.resolve(config.stagingRoot || '.') !== stagingRoot) return;
    const job = await request(config, '/next');
    if (stopped || !job) return;
    let reply;
    try { reply = { requestId: job.requestId, leaseId: job.leaseId, result: await save(job) }; }
    catch (error) { reply = { requestId: job.requestId, leaseId: job.leaseId, error: { message: error.message || 'Eagle TXT 保存失败' } }; }
    // Retry only a result receipt, never execute the save job twice.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (stopped) break;
      try { await request(config, '/result', reply); break; }
      catch { if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250)); }
    }
  } catch {
    // MultiView not running/disconnected: keep quiet, no modal or window focus.
  } finally {
    active = false;
    if (!stopped) timer = setTimeout(tick, 250);
  }
}

eagle.onPluginCreate(plugin => {
  if (stopped || save) return;
  try {
    // Eagle's global require resolves relative names from its SDK, not this
    // script. Initialize only after plugin-create supplies the plugin identity.
    if (!plugin || typeof plugin.path !== 'string' || !path.isAbsolute(plugin.path)) throw new Error('Invalid plugin identity');
    const { createSaveHandler } = require(path.join(plugin.path, 'save-handler.js'));
    save = createSaveHandler({ eagle, stagingRoot });
    return tick();
  } catch {
    // No path, token, modal or foreground activation in startup diagnostics.
    const message = 'MultiView Review TXT 后台保存初始化失败，请重新加载插件。';
    try { eagle.log.error(message); } catch { console.error(message); }
  }
});

if (typeof document !== 'undefined') document.querySelector('#openMultiView')?.addEventListener('click', openMultiViewCurrentView);
if (typeof document !== 'undefined') document.querySelector('#openInEagle')?.addEventListener('click', openMultiViewFolderInEagle);
window.addEventListener('beforeunload', () => {
  stopped = true;
  clearTimeout(timer);
  for (const req of requests) req.destroy(new Error('Plugin stopped'));
});
