'use strict';

// Embedded HTTP server for the optional web client. It serves the same src/
// renderer the Electron windows load (index.html gains web-shim.js at serve
// time), bridges window.eagleMV calls to the shared RPC registry over
// POST /rpc, streams library media with Range support over /media, and pushes
// hub broadcasts to browsers over a dependency-free RFC 6455 WebSocket at
// /events. Everything sits behind an access key: login page + HttpOnly
// session cookie, constant-time comparison, no key → server refuses to start.

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { mimeForPath } = require('./media-mime');

const SESSION_COOKIE = 'eaglemv_session';
const SESSION_LIMIT = 200;
const RPC_BODY_LIMIT = 8 * 1024 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_MAX_FRAME = 1024 * 1024;
const WS_PING_INTERVAL_MS = 30000;
const WS_IDLE_TIMEOUT_MS = 75000;
const LOGIN_FAILURE_DELAY_MS = 800;

const staticMimeByExtension = Object.freeze({
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8'
});

// The access key a person types on their phone: 16 random letters/digits in
// groups of four, skipping lookalikes (0/O, 1/I/L).
function generateAccessKey() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  const chars = [...bytes].map(byte => alphabet[byte % alphabet.length]);
  return [0, 4, 8, 12].map(offset => chars.slice(offset, offset + 4).join('')).join('-');
}

function timingSafeKeyMatch(candidate, accessKey) {
  const a = crypto.createHash('sha256').update(String(candidate || '')).digest();
  const b = crypto.createHash('sha256').update(String(accessKey || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

// Serve-time rewrite of the desktop index.html: load web-shim.js before every
// renderer script so window.eagleMV exists, and swap the eaglemv: CSP entries
// for same-origin /media plus WebSocket connections.
function transformIndexHTML(html) {
  const csp = "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:";
  return String(html)
    .replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")/, `$1${csp}$2`)
    .replace(/(\s*)(<script src=)/, `$1<script src="web-shim.js"></script>$1$2`);
}

// Range: bytes=a-b | a- | -suffix. Returns {start,end}, null to serve the
// whole file, or 'invalid' for an unsatisfiable/malformed header (416).
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return match ? 'invalid' : null;
  let start;
  let end;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    const suffix = Math.min(Number(match[2]), size);
    start = size - suffix;
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

const loginPageHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Eagle MultiView · Web 访问</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #111317; color: #e8eaed; font: 15px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .card { width: min(340px, calc(100vw - 48px)); background: #1a1d23; border: 1px solid #2a2e37;
          border-radius: 14px; padding: 28px; box-shadow: 0 18px 48px rgba(0,0,0,.4); }
  h1 { margin: 0 0 6px; font-size: 19px; }
  p { margin: 0 0 18px; color: #9aa1ac; font-size: 13px; }
  input { width: 100%; box-sizing: border-box; background: #111317; color: #e8eaed; border: 1px solid #2f3440;
          border-radius: 8px; padding: 10px 12px; font-size: 15px; letter-spacing: .08em; outline: none; }
  input:focus { border-color: #0072ef; }
  button { width: 100%; margin-top: 14px; background: #0072ef; border: none; color: #fff; border-radius: 8px;
           padding: 10px 12px; font-size: 15px; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .error { color: #ff6b6b; font-size: 13px; min-height: 20px; margin-top: 10px; }
</style>
</head>
<body>
<form class="card" id="loginForm">
  <h1>Eagle MultiView</h1>
  <p>输入访问密钥连接到主机资料库。密钥在桌面版「显示 › Web 访问…」中查看。</p>
  <input id="keyInput" autocomplete="current-password" type="password" placeholder="XXXX-XXXX-XXXX-XXXX" autofocus>
  <button id="submitButton" type="submit">连接</button>
  <div class="error" id="errorText"></div>
</form>
<script>
document.getElementById('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('submitButton');
  const errorText = document.getElementById('errorText');
  button.disabled = true;
  errorText.textContent = '';
  try {
    const response = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: document.getElementById('keyInput').value.trim() })
    });
    const body = await response.json().catch(() => ({}));
    if (body.ok) { location.replace('/'); return; }
    errorText.textContent = body.message || '密钥不正确';
  } catch {
    errorText.textContent = '无法连接主机，请稍后重试';
  }
  button.disabled = false;
});
</script>
</body>
</html>`;

function createWebServer({ srcDir, invoke, resolveMediaPath, accessKey, onClientGone, logError, loginFailureDelayMs = LOGIN_FAILURE_DELAY_MS }) {
  if (!srcDir || !invoke || !resolveMediaPath) throw new Error('createWebServer 缺少必要依赖');
  let currentKey = String(accessKey || '');
  const sessions = new Map();
  const clients = new Map();
  const sockets = new Set();
  let nextClientId = -1;
  let indexCache = null;
  let pingTimer = null;
  let listening = false;

  const log = (message, detail) => {
    try {
      logError?.(message, detail);
    } catch {}
  };

  function issueSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { createdAt: Date.now() });
    while (sessions.size > SESSION_LIMIT) sessions.delete(sessions.keys().next().value);
    return token;
  }

  function clearSessions() {
    sessions.clear();
    for (const client of clients.values()) client.destroy();
  }

  function isAuthenticated(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return Boolean(token && sessions.has(token));
  }

  function safeSrcPath(urlPath) {
    let decoded;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('..')) return null;
    const resolved = path.normalize(path.join(srcDir, decoded.replace(/^\/+/, '')));
    if (resolved !== srcDir && !resolved.startsWith(srcDir + path.sep)) return null;
    return resolved;
  }

  function sendJSON(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function sendHTML(res, status, html, extraHeaders = {}) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders });
    res.end(html);
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function serveIndex(res) {
    const indexPath = path.join(srcDir, 'index.html');
    // Cache keyed on mtime: packaged builds never change, dev edits show up
    // without restarting the app.
    const stat = await fsp.stat(indexPath);
    if (!indexCache || indexCache.mtimeMs !== stat.mtimeMs) {
      indexCache = { mtimeMs: stat.mtimeMs, html: transformIndexHTML(await fsp.readFile(indexPath, 'utf8')) };
    }
    sendHTML(res, 200, indexCache.html, { 'Cache-Control': 'no-store' });
  }

  async function serveStatic(res, urlPath) {
    const filePath = safeSrcPath(urlPath);
    if (!filePath) return sendJSON(res, 404, { ok: false, message: 'Not found' });
    let content;
    try {
      content = await fsp.readFile(filePath);
    } catch {
      return sendJSON(res, 404, { ok: false, message: 'Not found' });
    }
    const extension = filePath.split('.').pop().toLowerCase();
    res.writeHead(200, {
      'Content-Type': staticMimeByExtension[extension] || mimeForPath(filePath) || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  }

  async function serveMedia(req, res, kind, encodedId) {
    let id;
    try {
      id = decodeURIComponent(encodedId);
    } catch {
      return sendJSON(res, 400, { ok: false, message: '无效的素材地址' });
    }
    const filePath = await resolveMediaPath(kind, id);
    const stat = filePath ? await fsp.stat(filePath).catch(() => null) : null;
    if (!stat?.isFile()) return sendJSON(res, 404, { ok: false, message: '找不到素材文件' });
    const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    const headers = {
      'Content-Type': mimeForPath(filePath) || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Cache-Control': 'private, max-age=60'
    };
    const range = parseRange(req.headers.range, stat.size);
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    const status = range ? 206 : 200;
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
      headers['Content-Length'] = range.end - range.start + 1;
    } else {
      headers['Content-Length'] = stat.size;
    }
    if (req.method === 'HEAD') {
      res.writeHead(status, headers);
      return res.end();
    }
    res.writeHead(status, headers);
    const stream = fs.createReadStream(filePath, range ? { start: range.start, end: range.end } : undefined);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  async function handleLogin(req, res) {
    let key = '';
    try {
      const body = await readBody(req, 64 * 1024);
      key = String(JSON.parse(body.toString('utf8') || '{}').key || '');
    } catch {}
    if (currentKey && key && timingSafeKeyMatch(key, currentKey)) {
      const token = issueSession();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // One shared brake on brute force: every failed attempt waits before the
    // 401, which caps guessing at ~75 keys/minute per connection pool.
    await new Promise(resolve => setTimeout(resolve, loginFailureDelayMs));
    sendJSON(res, 401, { ok: false, message: '密钥不正确' });
  }

  async function handleRPC(req, res) {
    let payload;
    try {
      const body = await readBody(req, RPC_BODY_LIMIT);
      payload = JSON.parse(body.toString('utf8'));
    } catch (error) {
      return sendJSON(res, 400, { ok: false, message: `无法解析请求：${error.message}` });
    }
    const method = String(payload?.method || '');
    const args = Array.isArray(payload?.args) ? payload.args : [];
    const senderId = Number(req.headers['x-eaglemv-client']) || 0;
    try {
      const result = await invoke(method, args, { id: senderId, send: () => {} });
      sendJSON(res, 200, { ok: true, result: result === undefined ? null : result });
    } catch (error) {
      sendJSON(res, 200, { ok: false, message: error?.message || 'RPC 调用失败' });
    }
  }

  // --- RFC 6455 framing -----------------------------------------------------

  function encodeFrame(opcode, payload = Buffer.alloc(0)) {
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    return Buffer.concat([header, payload]);
  }

  function createClient(socket) {
    const clientId = nextClientId--;
    let buffer = Buffer.alloc(0);
    let closed = false;
    const client = {
      id: clientId,
      lastSeen: Date.now(),
      sendText(text) {
        if (!closed && socket.writable) socket.write(encodeFrame(0x1, Buffer.from(String(text), 'utf8')));
      },
      ping() {
        if (!closed && socket.writable) socket.write(encodeFrame(0x9));
      },
      destroy() {
        if (closed) return;
        closed = true;
        try {
          if (socket.writable) socket.write(encodeFrame(0x8, Buffer.from([0x03, 0xe8])));
        } catch {}
        socket.destroy();
        clients.delete(clientId);
        try {
          onClientGone?.(clientId);
        } catch {}
      }
    };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const big = buffer.readBigUInt64BE(2);
          if (big > BigInt(WS_MAX_FRAME)) return client.destroy();
          length = Number(big);
          offset = 10;
        }
        if (length > WS_MAX_FRAME || !masked || !fin) return client.destroy();
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = buffer.subarray(offset + 4, offset + 4 + length);
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
        buffer = buffer.subarray(offset + 4 + length);
        client.lastSeen = Date.now();
        if (opcode === 0x8) return client.destroy();
        if (opcode === 0x9 && socket.writable) socket.write(encodeFrame(0xa, payload));
        // 0xA pong refreshes lastSeen above; text/binary payloads are ignored
        // in phase 0 (browsers only listen on this channel).
      }
    });
    socket.on('error', () => client.destroy());
    socket.on('close', () => client.destroy());
    // http.Server upgrade sockets allow half-open: a client FIN only fires
    // 'end', so treat it as a full disconnect or the client entry leaks.
    socket.on('end', () => client.destroy());
    return client;
  }

  function handleUpgrade(req, socket) {
    if (req.url !== '/events' || !isAuthenticated(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const wsKey = req.headers['sec-websocket-key'];
    if (!wsKey || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(wsKey + WS_GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n'));
    socket.setNoDelay(true);
    const client = createClient(socket);
    clients.set(client.id, client);
    client.sendText(JSON.stringify({ channel: 'web:hello', payload: { clientId: client.id } }));
  }

  // --- routing --------------------------------------------------------------

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const urlPath = url.pathname;
    if (urlPath === '/login') {
      if (req.method === 'POST') return handleLogin(req, res);
      if (isAuthenticated(req)) {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      return sendHTML(res, 200, loginPageHTML, { 'Cache-Control': 'no-store' });
    }
    if (!isAuthenticated(req)) {
      if (urlPath === '/' || urlPath === '/index.html') {
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      return sendJSON(res, 401, { ok: false, message: '未登录' });
    }
    if (urlPath === '/rpc' && req.method === 'POST') return handleRPC(req, res);
    const mediaMatch = /^\/media\/(thumb|original|preview|folder)\/(.+)$/.exec(urlPath);
    if (mediaMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveMedia(req, res, mediaMatch[1], mediaMatch[2]);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { ok: false, message: 'Method not allowed' });
    if (urlPath === '/' || urlPath === '/index.html') return serveIndex(res);
    return serveStatic(res, urlPath);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      log(`Web 请求处理失败：${req.method} ${req.url}`, error);
      if (!res.headersSent) sendJSON(res, 500, { ok: false, message: error?.message || '服务器内部错误' });
      else res.destroy();
    });
  });
  server.on('upgrade', (req, socket) => {
    try {
      handleUpgrade(req, socket);
    } catch (error) {
      log('WebSocket 升级失败', error);
      socket.destroy();
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    get listening() {
      return listening;
    },
    get clientCount() {
      return clients.size;
    },
    setAccessKey(nextKey) {
      currentKey = String(nextKey || '');
      clearSessions();
    },
    broadcast(channel, payload) {
      if (!clients.size) return;
      const message = JSON.stringify({ channel, payload });
      for (const client of clients.values()) client.sendText(message);
    },
    start(port, host = '0.0.0.0') {
      if (!currentKey) return Promise.reject(new Error('未设置访问密钥，Web 服务拒绝启动'));
      return new Promise((resolve, reject) => {
        const onError = error => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.removeListener('error', onError);
          listening = true;
          pingTimer = setInterval(() => {
            const now = Date.now();
            for (const client of clients.values()) {
              if (now - client.lastSeen > WS_IDLE_TIMEOUT_MS) client.destroy();
              else client.ping();
            }
          }, WS_PING_INTERVAL_MS);
          pingTimer.unref?.();
          resolve(server.address());
        });
      });
    },
    stop() {
      listening = false;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      for (const client of clients.values()) client.destroy();
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => server.close(() => resolve()));
    }
  };
}

module.exports = {
  createWebServer,
  generateAccessKey,
  transformIndexHTML,
  parseRange,
  timingSafeKeyMatch,
  SESSION_COOKIE
};
