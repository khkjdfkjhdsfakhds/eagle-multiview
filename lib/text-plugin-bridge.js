'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// The Eagle service polls this loopback-only channel. No library operation is
// exposed to a browser, and no arbitrary command or target path is accepted.
function createTextPluginBridge({ directory, stagingRoot, timeoutMs = 15000 }) {
  const jobs = new Map();
  const token = crypto.randomBytes(32).toString('hex');
  const configuration = path.join(directory, 'connection.json');
  let server = null;
  let starting = null;
  let lastSeen = 0;

  function reply(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function authenticated(req) {
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(req.headers.authorization || '');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  function keepUnknown(entry, message) {
    clearTimeout(entry.timer);
    entry.pending = true;
    entry.leased = false;
    entry.leaseId = null;
    entry.nextReconcileAt = Date.now() + Math.min(1000, timeoutMs);
    entry.reject(new Error(message || 'TXT 保存结果待核对，草稿已保留；不会重放原写入'));
  }

  async function handle(req, res) {
    if (req.headers.origin) return reply(res, 403, { error: 'Browser origins are not permitted' });
    if (!authenticated(req)) return reply(res, 401, { error: 'Authentication required' });
    if (req.method === 'GET' && req.url === '/next') {
      const session = String(req.headers['x-eaglemv-session'] || 'legacy');
      if (!/^[\w-]{1,128}$/.test(session)) return reply(res, 400, { error: 'Invalid plugin session' });
      lastSeen = Date.now();
      const entry = [...jobs.values()].find(value => !value.leased && (!value.pending || value.nextReconcileAt <= Date.now()));
      if (!entry) return reply(res, 200, null);
      entry.leased = true;
      entry.leaseSession = session;
      entry.leaseId = crypto.randomUUID();
      if (entry.pending) {
        entry.timer = setTimeout(() => keepUnknown(entry, 'TXT 只读核对超时，草稿已保留'), timeoutMs);
      }
      return reply(res, 200, { ...entry.request, operation: entry.pending ? 'reconcile' : 'replace', leaseId: entry.leaseId });
    }
    if (req.method !== 'POST' || req.url !== '/result') return reply(res, 404, {});
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) return reply(res, 413, {});
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const entry = jobs.get(payload.requestId);
    if (!entry || !entry.leased || payload.leaseId !== entry.leaseId
      || String(req.headers['x-eaglemv-session'] || 'legacy') !== entry.leaseSession) return reply(res, 409, { error: 'Unknown request or stale lease' });
    clearTimeout(entry.timer);
    if (payload.result?.status === 'unknown') {
      keepUnknown(entry, String(payload.result.message || 'TXT 保存结果待核对，草稿已保留'));
      return reply(res, 200, { ok: true, pending: true });
    }
    if (entry.pending && payload.error) {
      keepUnknown(entry, String(payload.error.message || 'TXT 只读核对失败，草稿已保留'));
      return reply(res, 200, { ok: true, pending: true });
    }
    if (!payload.error && !payload.result?.conflict
      && !['saved', 'written_pending_refresh', ...(entry.pending ? ['not_committed'] : [])].includes(payload.result?.status)) {
      keepUnknown(entry, 'Eagle 后台保存回执无效，正在只读核对；草稿已保留');
      return reply(res, 200, { ok: true, pending: true });
    }
    jobs.delete(payload.requestId);
    if (payload.error) entry.reject(new Error(String(payload.error.message || 'Eagle 后台保存失败')));
    else if (payload.result && (payload.result.conflict === true || ['saved', 'written_pending_refresh'].includes(payload.result.status))) entry.resolve(payload.result);
    else if (entry.pending && payload.result?.status === 'not_committed') entry.reject(new Error('已核对上次 TXT 未提交，草稿已保留，可以重新保存'));
    else entry.reject(new Error('Eagle 后台保存回执无效，草稿已保留'));
    return reply(res, 200, { ok: true });
  }

  async function start() {
    if (starting) return starting;
    starting = (async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      server = http.createServer((req, res) => handle(req, res).catch(() => {
        if (!res.headersSent) reply(res, 400, { error: 'Invalid request' });
        else res.end();
      }));
      server.requestTimeout = 10000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const temporary = `${configuration}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, port: server.address().port, token, stagingRoot: path.resolve(stagingRoot) }), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, configuration);
      } finally { await fs.unlink(temporary).catch(() => {}); }
    })();
    try { await starting; } catch (error) { starting = null; await stop(); throw error; }
  }

  function replaceFile(request) {
    if (!server?.listening || Date.now() - lastSeen > 5000) return Promise.reject(new Error('Eagle TXT 后台插件未连接，请启用配套插件；草稿已保留'));
    if (![...jobs.values()].every(entry => entry.request.id !== request.id || entry.request.libraryPath !== request.libraryPath)) {
      return Promise.reject(new Error('上次 TXT 保存结果仍待确认，草稿已保留，请稍后重试'));
    }
    const root = `${path.resolve(stagingRoot)}${path.sep}`;
    if (!request.id || !path.isAbsolute(String(request.libraryPath || '')) || !path.resolve(request.stagedPath || '').startsWith(root)) {
      return Promise.reject(new Error('TXT 后台保存请求超出指定范围'));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const entry = { request: { ...request, requestId }, leased: false, pending: false, resolve, reject };
      entry.timer = setTimeout(() => {
        // Never replay a leased request: Eagle may already have written it.
        if (entry.leased) keepUnknown(entry, 'TXT 保存回执超时，结果待确认；草稿已保留');
        else {
          jobs.delete(requestId);
          reject(new Error('Eagle 后台插件未领取保存任务，草稿已保留'));
        }
      }, timeoutMs);
      jobs.set(requestId, entry);
    });
  }

  async function stop() {
    for (const entry of jobs.values()) { clearTimeout(entry.timer); entry.reject(new Error('TXT 后台连接已关闭，草稿已保留')); }
    jobs.clear();
    if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
    server = null;
    starting = null;
    lastSeen = 0;
    // Do not remove a new process's discovery file after a restart.
    try { if (JSON.parse(await fs.readFile(configuration, 'utf8')).token === token) await fs.unlink(configuration); } catch {}
  }

  return { start, stop, replaceFile, get connected() { return Boolean(server?.listening && Date.now() - lastSeen < 5000); } };
}

module.exports = { createTextPluginBridge };
