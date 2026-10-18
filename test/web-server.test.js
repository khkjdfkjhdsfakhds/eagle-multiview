'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const {
  isAllowedHost,
  createWebServer,
  generateAccessKey,
  transformIndexHTML,
  parseRange,
  timingSafeKeyMatch,
  SESSION_COOKIE
} = require('../lib/web-server');

const ACCESS_KEY = 'ABCD-EFGH-JKMN-PQRS';

function makeFixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; img-src \'self\' eaglemv: data:; media-src \'self\' eaglemv:; style-src \'self\' \'unsafe-inline\'; script-src \'self\'">',
    '</head>',
    '<body>',
    '  <script src="renderer.js"></script>',
    '</body>',
    '</html>'
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'styles.css'), 'body { color: red; }');
  fs.writeFileSync(path.join(dir, 'web-shim.js'), '// shim');
  fs.writeFileSync(path.join(dir, 'media.bin'), Buffer.from('0123456789'));
  return dir;
}

function request(port, options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Minimal RFC 6455 client: enough to complete the handshake, read unmasked
// server frames, and send a masked close.
function connectWebSocket(port, cookie) {
  return new Promise((resolve, reject) => {
    const wsKey = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/events',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': wsKey,
        ...(cookie ? { Cookie: cookie } : {})
      }
    });
    req.on('upgrade', (res, socket, head) => {
      const expected = crypto.createHash('sha1').update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      assert.equal(res.headers['sec-websocket-accept'], expected, 'handshake accept hash must be correct');
      const messages = [];
      const waiters = [];
      // Frames that rode in on the same TCP segment as the 101 land in `head`.
      let buffer = Buffer.alloc(0);
      const consume = chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const opcode = buffer[0] & 0x0f;
          let length = buffer[1] & 0x7f;
          let offset = 2;
          if (length === 126) {
            if (buffer.length < 4) return;
            length = buffer.readUInt16BE(2);
            offset = 4;
          } else if (length === 127) {
            if (buffer.length < 10) return;
            length = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }
          if (buffer.length < offset + length) return;
          const payload = buffer.subarray(offset, offset + length);
          buffer = buffer.subarray(offset + length);
          if (opcode === 0x1) {
            const text = payload.toString('utf8');
            if (waiters.length) waiters.shift()(text);
            else messages.push(text);
          }
        }
      };
      socket.on('data', consume);
      if (head?.length) consume(head);
      resolve({
        socket,
        nextMessage(timeoutMs = 3000) {
          if (messages.length) return Promise.resolve(messages.shift());
          return new Promise((resolveMessage, rejectMessage) => {
            const timer = setTimeout(() => rejectMessage(new Error('等待 WebSocket 消息超时')), timeoutMs);
            waiters.push(text => {
              clearTimeout(timer);
              resolveMessage(text);
            });
          });
        },
        close() {
          socket.destroy();
        }
      });
    });
    req.on('response', res => resolve({ rejected: res.statusCode }));
    req.on('error', reject);
    req.end();
  });
}

test('access keys are grouped, unambiguous, and constant-time comparable', () => {
  const key = generateAccessKey();
  assert.match(key, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(!/[01OIL]/.test(key), 'lookalike characters are excluded');
  assert.notEqual(generateAccessKey(), key);
  assert.ok(timingSafeKeyMatch(key, key));
  assert.ok(!timingSafeKeyMatch('nope', key));
  assert.ok(!timingSafeKeyMatch('', key));
});

test('transformIndexHTML injects the shim before renderer scripts and rewrites the CSP', () => {
  const html = fs.readFileSync(path.join(makeFixtureDir(), 'index.html'), 'utf8');
  const transformed = transformIndexHTML(html);
  const shimIndex = transformed.indexOf('web-shim.js');
  const rendererIndex = transformed.indexOf('renderer.js');
  assert.ok(shimIndex >= 0 && rendererIndex >= 0 && shimIndex < rendererIndex, 'shim loads first');
  assert.ok(!transformed.includes('eaglemv:'), 'protocol scheme leaves the CSP');
  assert.ok(transformed.includes("connect-src 'self' ws: wss:"), 'websocket connections allowed');
});

test('parseRange handles full, open, suffix, and invalid ranges', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-3', 100), { start: 0, end: 3 });
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=-5', 100), { start: 95, end: 99 });
  assert.deepEqual(parseRange('bytes=0-9999', 100), { start: 0, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('bytes=5-2', 100), 'invalid');
  assert.equal(parseRange('bytes=-', 100), 'invalid');
  assert.equal(parseRange('bytes=0-0', 0), 'invalid');
});

test('web server: auth, static serving, rpc bridge, media ranges, websocket events', async () => {
  const srcDir = makeFixtureDir();
  const invoked = [];
  const gone = [];
  const server = createWebServer({
    srcDir,
    invoke: async (method, args, sender) => {
      invoked.push({ method, args, senderId: sender.id });
      if (method === 'test:boom') throw new Error('爆炸了');
      return { echoed: args, senderId: sender.id };
    },
    resolveMediaPath: async (kind, id) => (kind === 'thumb' && id === 'item 1' ? path.join(srcDir, 'media.bin') : null),
    accessKey: ACCESS_KEY,
    onClientGone: id => gone.push(id),
    loginFailureDelayMs: 0
  });
  const { port } = await server.start(0, '127.0.0.1');

  try {
    // --- authentication gate ---
    const anonymousHome = await request(port, { path: '/' });
    assert.equal(anonymousHome.status, 302);
    assert.equal(anonymousHome.headers.location, '/login');
    assert.equal((await request(port, { path: '/styles.css' })).status, 401);
    assert.equal((await request(port, { path: '/rpc', method: 'POST' }, '{}')).status, 401);
    const anonymousHealth = await request(port, { path: '/health/session' });
    assert.equal(anonymousHealth.status, 401);
    assert.deepEqual(JSON.parse(anonymousHealth.body.toString()), {
      ok: true,
      online: true,
      authenticated: false
    });
    assert.equal(anonymousHealth.headers['cache-control'], 'no-store');
    const loginPage = await request(port, { path: '/login' });
    assert.equal(loginPage.status, 200);
    const loginHTML = loginPage.body.toString();
    assert.ok(loginHTML.includes('访问密钥'));
    const loginScript = loginHTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(loginScript, 'real login page exposes an executable script');
    const loginWindow = {};
    vm.runInNewContext(loginScript, {
      window: loginWindow,
      document: {
        getElementById() {
          return { addEventListener() {} };
        }
      }
    });
    assert.deepEqual(
      JSON.parse(JSON.stringify(loginWindow.EagleMVBack.request())),
      { status: 'exit', handled: false, blocked: false, exit: true, action: 'host' }
    );
    assert.equal(Object.getOwnPropertyDescriptor(loginWindow, 'EagleMVBack').writable, false);

    const badLogin = await request(port, { path: '/login', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ key: 'WRONG-KEY' }));
    assert.equal(badLogin.status, 401);
    assert.ok(!badLogin.headers['set-cookie']);

    const login = await request(port, { path: '/login', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ key: ACCESS_KEY }));
    assert.equal(login.status, 200);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`));
    const authed = { Cookie: cookie };
    const authenticatedHealth = await request(port, { path: '/health/session', headers: authed });
    assert.equal(authenticatedHealth.status, 200);
    assert.deepEqual(JSON.parse(authenticatedHealth.body.toString()), {
      ok: true,
      online: true,
      authenticated: true
    });

    // --- static + injection ---
    const home = await request(port, { path: '/', headers: authed });
    assert.equal(home.status, 200);
    assert.ok(home.body.toString().includes('<script src="web-shim.js"></script>'));
    assert.ok(home.body.toString().includes("connect-src 'self' ws: wss:"));
    const css = await request(port, { path: '/styles.css', headers: authed });
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
    // Path traversal keeps every answer inside src/.
    for (const evil of ['/..%2f..%2fetc%2fpasswd', '/%2e%2e/main.js', '/a/../../main.js']) {
      assert.equal((await request(port, { path: evil, headers: authed })).status, 404, evil);
    }

    // --- rpc bridge ---
    const echo = await request(port, {
      path: '/rpc',
      method: 'POST',
      headers: { ...authed, 'Content-Type': 'application/json', 'x-eaglemv-client': '-7' }
    }, JSON.stringify({ method: 'test:echo', args: [1, 'two'] }));
    assert.equal(echo.status, 200);
    assert.deepEqual(JSON.parse(echo.body.toString()), { ok: true, result: { echoed: [1, 'two'], senderId: -7 } });
    assert.deepEqual(invoked.at(-1), { method: 'test:echo', args: [1, 'two'], senderId: -7 });
    const boom = await request(port, { path: '/rpc', method: 'POST', headers: { ...authed, 'Content-Type': 'application/json' } },
      JSON.stringify({ method: 'test:boom', args: [] }));
    assert.deepEqual(JSON.parse(boom.body.toString()), { ok: false, message: '爆炸了' });

    // --- media with ranges ---
    const mediaPath = `/media/thumb/${encodeURIComponent('item 1')}`;
    const full = await request(port, { path: mediaPath, headers: authed });
    assert.equal(full.status, 200);
    assert.equal(full.body.toString(), '0123456789');
    assert.equal(full.headers['accept-ranges'], 'bytes');
    const etag = full.headers.etag;
    assert.ok(etag);
    const cached = await request(port, { path: mediaPath, headers: { ...authed, 'If-None-Match': etag } });
    assert.equal(cached.status, 304);
    const partial = await request(port, { path: mediaPath, headers: { ...authed, Range: 'bytes=2-5' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.body.toString(), '2345');
    assert.equal(partial.headers['content-range'], 'bytes 2-5/10');
    const unsatisfiable = await request(port, { path: mediaPath, headers: { ...authed, Range: 'bytes=99-' } });
    assert.equal(unsatisfiable.status, 416);
    assert.equal((await request(port, { path: '/media/thumb/missing', headers: authed })).status, 404);
    assert.equal((await request(port, { path: '/media/evil/item%201', headers: authed })).status, 404, 'unknown media kind');

    // --- websocket events ---
    const rejected = await connectWebSocket(port, null);
    assert.equal(rejected.rejected, 401, 'unauthenticated upgrade is refused');
    const ws = await connectWebSocket(port, cookie);
    const hello = JSON.parse(await ws.nextMessage());
    assert.equal(hello.channel, 'web:hello');
    assert.ok(hello.payload.clientId < 0, 'web client ids stay clear of webContents ids');
    server.broadcast('hub:items-changed', { items: [{ id: 'a' }] });
    const event = JSON.parse(await ws.nextMessage());
    assert.deepEqual(event, { channel: 'hub:items-changed', payload: { items: [{ id: 'a' }] } });
    ws.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(gone.includes(hello.payload.clientId), 'disconnect reports the client id for watcher cleanup');

    // --- key reset invalidates sessions ---
    server.setAccessKey('QQQQ-WWWW-EEEE-RRRR');
    assert.equal((await request(port, { path: '/', headers: authed })).status, 302, 'old session dies with the key');
  } finally {
    await server.stop();
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
});

test('web server refuses to start without an access key', async () => {
  const srcDir = makeFixtureDir();
  const server = createWebServer({
    srcDir,
    invoke: async () => null,
    resolveMediaPath: async () => null,
    accessKey: ''
  });
  await assert.rejects(() => server.start(0, '127.0.0.1'), /访问密钥/);
  await server.stop();
  fs.rmSync(srcDir, { recursive: true, force: true });
});

test('sessions derive from the key: they survive restarts and die on key reset', async () => {
  const srcDir = makeFixtureDir();
  const makeServer = () => createWebServer({
    srcDir,
    invoke: async () => null,
    resolveMediaPath: async () => null,
    accessKey: ACCESS_KEY,
    loginFailureDelayMs: 0
  });
  try {
    const first = makeServer();
    const { port } = await first.start(0, '127.0.0.1');
    const login = await request(port, { path: '/login', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ key: ACCESS_KEY }));
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    assert.match(String(login.headers['set-cookie'][0]), /Max-Age=31536000/, 'one login lasts a year');
    assert.equal((await request(port, { path: '/', headers: { Cookie: cookie } })).status, 200);
    await first.stop();

    // A brand-new server instance (an app restart) accepts the same cookie.
    const second = makeServer();
    const { port: port2 } = await second.start(0, '127.0.0.1');
    assert.equal((await request(port2, { path: '/', headers: { Cookie: cookie } })).status, 200, 'cookie survives restart');
    second.setAccessKey('QQQQ-WWWW-EEEE-RRRR');
    assert.equal((await request(port2, { path: '/', headers: { Cookie: cookie } })).status, 302, 'key reset kills the cookie');
    await second.stop();
  } finally {
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
});

test('requireKey:false serves everything without a login', async () => {
  const srcDir = makeFixtureDir();
  const server = createWebServer({
    srcDir,
    invoke: async () => ({ ok: true }),
    resolveMediaPath: async () => null,
    accessKey: ACCESS_KEY,
    requireKey: false,
    loginFailureDelayMs: 0
  });
  const { port } = await server.start(0, '127.0.0.1');
  assert.equal((await request(port, { path: '/' })).status, 200, 'index without cookie');
  assert.equal((await request(port, { path: '/styles.css' })).status, 200);
  const health = await request(port, { path: '/health/session' });
  assert.equal(health.status, 200, 'health endpoint follows disabled authentication');
  assert.equal(JSON.parse(health.body).authenticated, true);
  const rpc = await request(port, { path: '/rpc', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ method: 'x', args: [] }));
  assert.equal(rpc.status, 200);
  const loginPage = await request(port, { path: '/login' });
  assert.equal(loginPage.status, 302, 'login page redirects straight in');
  server.setRequireKey(true);
  assert.equal((await request(port, { path: '/' })).status, 302, 'flipping the switch locks it again');
  await server.stop();
  fs.rmSync(srcDir, { recursive: true, force: true });
});

test('uploads stream to staging, run the import pipeline, and sanitize names', async () => {
  const srcDir = makeFixtureDir();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-upload-'));
  const imports = [];
  const server = createWebServer({
    srcDir,
    invoke: async () => null,
    resolveMediaPath: async () => null,
    accessKey: ACCESS_KEY,
    uploadImport: async ({ paths, folderId, libraryPath }) => {
      imports.push({ content: fs.readFileSync(paths[0], 'utf8'), base: path.basename(paths[0]), folderId, libraryPath });
      return { count: 1, ready: 1, ids: ['NEW1'], rejected: [] };
    },
    uploadDir,
    loginFailureDelayMs: 0
  });
  const { port } = await server.start(0, '127.0.0.1');
  const login = await request(port, { path: '/login', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ key: ACCESS_KEY }));
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
  const authed = { Cookie: cookie };

  assert.equal((await request(port, { path: '/upload?name=a.png', method: 'POST' }, 'x')).status, 401, 'auth required');

  const upload = await request(port, {
    path: `/upload?${new URLSearchParams({ name: '../../evil.png', folderId: 'F1', libraryPath: '/tmp/lib.library' })}`,
    method: 'POST',
    headers: { ...authed, 'x-eaglemv-client': '1' }
  }, 'PNGDATA');
  const body = JSON.parse(upload.body.toString());
  assert.equal(body.ok, true);
  assert.deepEqual(body.result.ids, ['NEW1']);
  assert.equal(imports[0].content, 'PNGDATA');
  assert.equal(imports[0].base, 'evil.png', 'path traversal stripped to a basename');
  assert.equal(imports[0].folderId, 'F1');
  assert.equal(imports[0].libraryPath, '/tmp/lib.library');

  const noName = await request(port, { path: '/upload?name=..%2F..%2F', method: 'POST', headers: { ...authed, 'x-eaglemv-client': '1' } }, 'x');
  assert.equal(noName.status, 400, 'unusable names are rejected');

  await server.stop();
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

// H-08: a duplicate upload waits on the host for the uploading device's choice.
test('duplicate uploads are staged until the device picks keep-both, use-existing or cancel', async () => {
  const srcDir = makeFixtureDir();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-upload-dup-'));
  const calls = [];
  const server = createWebServer({
    srcDir,
    invoke: async () => null,
    resolveMediaPath: async () => null,
    accessKey: ACCESS_KEY,
    uploadImport: async ({ paths, folderId, duplicateChoice }) => {
      calls.push({ paths: [...paths], folderId, duplicateChoice, exists: paths.map(file => fs.existsSync(file)) });
      if (!duplicateChoice) return { canceled: false, needsDuplicateDecision: true, paths, duplicates: [{ path: paths[0], id: 'OLD1', name: 'old', ext: 'png' }], rejected: [] };
      if (duplicateChoice === 'use-existing') return { canceled: false, count: 1, ready: 1, ids: ['OLD1'], rejected: [], duplicateCount: 1 };
      return { canceled: false, count: 1, ready: 1, ids: ['NEW1'], rejected: [] };
    },
    uploadDir,
    loginFailureDelayMs: 0
  });
  const { port } = await server.start(0, '127.0.0.1');
  const login = await request(port, { path: '/login', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ key: ACCESS_KEY }));
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
  const headers = { Cookie: cookie, 'x-eaglemv-client': '3' };
  const upload = async name => JSON.parse((await request(port, { path: `/upload?name=${name}&folderId=F9`, method: 'POST', headers }, 'SAME')).body.toString());
  const resolve = (tokens, choice, extra = {}) => request(port, { path: '/upload/resolve', method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', ...extra } }, JSON.stringify({ tokens, choice }));

  const first = await upload('dup.png');
  assert.equal(first.result.needsDuplicateDecision, true);
  assert.match(first.result.uploadToken, /^[0-9a-f]{32}$/);
  assert.deepEqual(first.result.duplicates, [{ name: 'dup.png', id: 'OLD1', existingName: 'old', ext: 'png' }]);
  assert.ok(!JSON.stringify(first).includes(uploadDir), 'host staging paths never reach the device');

  assert.equal((await resolve([first.result.uploadToken], 'keep-both', { 'x-eaglemv-client': '' })).status, 403, 'client header required');
  assert.equal((await request(port, { path: '/upload/resolve', method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' } }, '{}')).status, 415, 'JSON required');
  assert.equal((await resolve([first.result.uploadToken], 'delete-all')).status, 400, 'unknown choices rejected');

  const kept = JSON.parse((await resolve([first.result.uploadToken], 'keep-both')).body.toString());
  assert.deepEqual(kept.result.ids, ['NEW1']);
  assert.equal(calls[1].duplicateChoice, 'keep-both');
  assert.equal(calls[1].folderId, 'F9', 'the staged upload keeps its target folder');
  assert.deepEqual(calls[1].paths, calls[0].paths, 'the staged file is imported, not re-uploaded');
  assert.deepEqual(calls[1].exists, [true]);
  const replay = JSON.parse((await resolve([first.result.uploadToken], 'keep-both')).body.toString());
  assert.equal(replay.result.count, 0, 'tokens are single-use');
  assert.equal(replay.result.rejected.length, 1);

  const second = await upload('dup2.png');
  const existing = JSON.parse((await resolve([second.result.uploadToken], 'use-existing')).body.toString());
  assert.deepEqual(existing.result.ids, ['OLD1']);
  assert.equal(existing.result.duplicateCount, 1);

  const third = await upload('dup3.png');
  const stagedDir = path.dirname(calls.at(-1).paths[0]);
  const canceled = JSON.parse((await resolve([third.result.uploadToken], 'cancel')).body.toString());
  assert.equal(canceled.result.canceled, true);
  assert.equal(calls.at(-1).duplicateChoice, undefined, 'cancel imports nothing');
  for (let n = 0; n < 50 && fs.existsSync(stagedDir); n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(fs.existsSync(stagedDir), false, 'a canceled upload is removed from staging');

  await server.stop();
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

test('staged duplicate uploads expire', async () => {
  const srcDir = makeFixtureDir();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-upload-exp-'));
  let stagedPath = null;
  const server = createWebServer({
    srcDir, invoke: async () => null, resolveMediaPath: async () => null, accessKey: ACCESS_KEY,
    uploadImport: async ({ paths }) => { stagedPath = paths[0]; return { needsDuplicateDecision: true, paths, duplicates: [{ path: paths[0], id: 'X' }] }; },
    uploadDir, loginFailureDelayMs: 0, pendingUploadTtlMs: 50
  });
  const { port } = await server.start(0, '127.0.0.1');
  const login = await request(port, { path: '/login', method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ key: ACCESS_KEY }));
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
  const body = JSON.parse((await request(port, { path: '/upload?name=a.png', method: 'POST', headers: { Cookie: cookie, 'x-eaglemv-client': '1' } }, 'A')).body.toString());
  assert.ok(fs.existsSync(stagedPath));
  for (let n = 0; n < 50 && fs.existsSync(stagedPath); n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(fs.existsSync(stagedPath), false, 'an unanswered duplicate is cleaned up');
  const late = JSON.parse((await request(port, { path: '/upload/resolve', method: 'POST', headers: { Cookie: cookie, 'x-eaglemv-client': '1', 'Content-Type': 'application/json' } },
    JSON.stringify({ tokens: [body.result.uploadToken], choice: 'keep-both' }))).body.toString());
  assert.equal(late.result.count, 0);
  assert.match(late.result.rejected[0].message, /过期/);
  await server.stop();
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

// W-02: uploads end when they stall, not after a fixed total time.
test('uploads time out when idle, not while bytes keep arriving', async () => {
  const srcDir = makeFixtureDir();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-upload-idle-'));
  const imports = [];
  const server = createWebServer({
    srcDir,
    invoke: async () => null,
    resolveMediaPath: async () => null,
    accessKey: ACCESS_KEY,
    uploadImport: async ({ paths }) => {
      imports.push(fs.readFileSync(paths[0], 'utf8'));
      return { count: 1, ready: 1, ids: ['NEW'], rejected: [] };
    },
    uploadDir,
    loginFailureDelayMs: 0,
    uploadIdleTimeoutMs: 300
  });
  const { port } = await server.start(0, '127.0.0.1');
  const login = await request(port, { path: '/login', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ key: ACCESS_KEY }));
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const upload = (name, chunks, gapMs, { endAfter = true } = {}) => new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: `/upload?name=${name}`, method: 'POST',
      headers: { Cookie: cookie, 'x-eaglemv-client': '1', 'Transfer-Encoding': 'chunked' } }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString() }));
    });
    req.on('error', error => resolve({ error: error.code || error.message }));
    (async () => {
      for (const chunk of chunks) { req.write(chunk); await wait(gapMs); }
      if (endAfter) req.end();
    })();
  });
  // Eight chunks 150 ms apart run well past the 300 ms idle limit in total.
  const slow = await upload('slow.bin', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 150);
  assert.equal(JSON.parse(slow.body).ok, true, 'a slow upload that keeps moving completes');
  assert.deepEqual(imports, ['abcdefgh']);
  const stalled = await upload('stalled.bin', ['x'], 0, { endAfter: false });
  assert.ok(stalled.error || JSON.parse(stalled.body).ok === false, 'a stalled upload is cut off');
  assert.deepEqual(imports, ['abcdefgh'], 'a stalled upload is never imported');
  await server.stop();
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

test('transformIndexHTML adds PWA tags for the web build only', () => {
  const html = '<head>\n<meta http-equiv="Content-Security-Policy" content="x">\n</head>\n<body><script src="renderer.js"></script></body>';
  const transformed = require('../lib/web-server').transformIndexHTML(html);
  assert.ok(transformed.includes('rel="manifest"'));
  // Manifests are fetched with credentials omitted by default, so behind the
  // access key the request 401s and installing to the home screen silently
  // does nothing. Measured against the live server before this attribute.
  assert.ok(transformed.includes('<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">'));
  assert.ok(transformed.includes('apple-mobile-web-app-capable'));
  assert.ok(transformed.includes('apple-touch-icon'));
  // Without an explicit icon the browser probes /favicon.ico, which 404s.
  assert.ok(transformed.includes('<link rel="icon" href="brand-icon.png">'));
});

test('export downloads one file directly and zips several (verified via ditto)', { skip: process.platform !== 'darwin' && 'unzips with /usr/bin/ditto, which only macOS has' }, async () => {
  const { execFile } = require('node:child_process');
  const srcDir = makeFixtureDir();
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-export-'));
  fs.writeFileSync(path.join(mediaDir, '图片一.png'), 'AAAA-content-1');
  fs.writeFileSync(path.join(mediaDir, 'photo2.jpg'), 'BBBB-content-22');
  const byId = { one: path.join(mediaDir, '图片一.png'), two: path.join(mediaDir, 'photo2.jpg') };
  const server = createWebServer({
    srcDir,
    invoke: async () => null,
    resolveMediaPath: async (kind, id) => (kind === 'original' ? byId[id] || null : null),
    accessKey: ACCESS_KEY,
    loginFailureDelayMs: 0
  });
  const { port } = await server.start(0, '127.0.0.1');
  const login = await request(port, { path: '/login', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ key: ACCESS_KEY }));
  const authed = { Cookie: String(login.headers['set-cookie'][0]).split(';')[0] };

  assert.equal((await request(port, { path: '/export?ids=one' })).status, 401, 'auth required');

  const single = await request(port, { path: '/export?ids=one', headers: authed });
  assert.equal(single.status, 200);
  assert.equal(single.body.toString(), 'AAAA-content-1');
  assert.match(String(single.headers['content-disposition']), /attachment/);
  assert.match(String(single.headers['content-disposition']), new RegExp(encodeURIComponent('图片一.png')));

  const missing = await request(port, { path: '/export?ids=one,two,missing', headers: authed });
  assert.equal(missing.status, 404, 'do not silently omit missing files');
  const multi = await request(port, { path: '/export?ids=one,two', headers: authed });
  assert.equal(multi.status, 200);
  assert.equal(multi.headers['content-type'], 'application/zip');
  const zipPath = path.join(mediaDir, 'out.zip');
  fs.writeFileSync(zipPath, multi.body);
  const extractDir = path.join(mediaDir, 'extracted');
  fs.mkdirSync(extractDir);
  await new Promise((resolve, reject) => {
    execFile('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir], error => (error ? reject(error) : resolve()));
  });
  assert.equal(fs.readFileSync(path.join(extractDir, '图片一.png'), 'utf8'), 'AAAA-content-1');
  assert.equal(fs.readFileSync(path.join(extractDir, 'photo2.jpg'), 'utf8'), 'BBBB-content-22');

  assert.equal((await request(port, { path: '/export?ids=missing', headers: authed })).status, 404);
  await server.stop();
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.rmSync(mediaDir, { recursive: true, force: true });
});

test('UW-03: exports reject 501 items explicitly and prepare a verified unique manifest', async t => {
  const srcDir = makeFixtureDir();
  const resolved = [];
  const server = createWebServer({ srcDir, invoke: async () => null,
    resolveMediaPath: async (_kind, id) => { resolved.push(id); return id === 'missing' ? null : path.join(srcDir, 'media.bin'); },
    accessKey: ACCESS_KEY, loginFailureDelayMs: 0 });
  const { port } = await server.start(0, '127.0.0.1');
  t.after(async () => { await server.stop(); fs.rmSync(srcDir, { recursive: true, force: true }); });
  const login = await request(port, { path: '/login', method: 'POST' }, JSON.stringify({ key: ACCESS_KEY }));
  const headers = { Cookie: String(login.headers['set-cookie'][0]).split(';')[0] };
  const ids = Array.from({ length: 501 }, (_, i) => `item-${i}`);
  const excess = await request(port, { path: `/export?ids=${ids.join(',')}`, headers });
  assert.equal(excess.status, 400);
  assert.match(JSON.parse(excess.body).message, /500/);
  assert.equal(resolved.length, 0, 'an oversized request must not resolve a truncated subset');
  const prepare = selected => request(port, { path: '/export/prepare', method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' } }, JSON.stringify({ ids: selected }));
  assert.equal((await request(port, { path: '/export/prepare', method: 'POST' }, JSON.stringify({ ids: ['one'] }))).status, 401);
  for (const count of [499, 500]) {
    const prepared = await prepare(ids.slice(0, count).concat(ids[0]));
    assert.equal(prepared.status, 200);
    const plan = JSON.parse(prepared.body);
    assert.equal(plan.count, count);
    const download = await request(port, { path: plan.url, headers });
    assert.equal(download.status, 200);
    assert.equal(download.body.readUInt16LE(download.body.length - 12), count, 'ZIP central-directory count matches preparation');
  }
  const partial = await prepare(['one', 'missing']);
  assert.equal(partial.status, 404);
  assert.deepEqual(JSON.parse(partial.body).missingIds, ['missing']);
  assert.equal((await prepare(['missing'])).status, 404);
  assert.equal((await prepare(ids)).status, 400);
});

test('UW-03: export preparation stops on library changes and frozen downloads do not resolve IDs again', async t => {
  const srcDir = makeFixtureDir();
  let library = '/A';
  let switchOnResolve = false;
  const resolved = [];
  const server = createWebServer({ srcDir, invoke: async () => null,
    ensureLibraryPath: async expected => { if (expected && expected !== library) throw new Error('资料库已切换'); },
    resolveMediaPath: async (_kind, id) => { resolved.push(id); if (switchOnResolve) library = '/B'; return path.join(srcDir, 'media.bin'); },
    accessKey: ACCESS_KEY, requireKey: false });
  const { port } = await server.start(0, '127.0.0.1');
  t.after(async () => { await server.stop(); fs.rmSync(srcDir, { recursive: true, force: true }); });
  const prepare = ids => request(port, { path: '/export/prepare', method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ ids, libraryPath: '/A' }));
  for (const ids of [['one', 'two'], ['last']]) {
    library = '/A'; switchOnResolve = true; resolved.length = 0;
    const stopped = await prepare(ids);
    assert.notEqual(stopped.status, 200);
    assert.match(JSON.parse(stopped.body).message, /资料库已切换/);
    assert.equal(resolved.length, 1);
  }
  library = '/A'; switchOnResolve = false;
  const plan = JSON.parse((await prepare(['one'])).body);
  resolved.length = 0;
  assert.equal((await request(port, { path: plan.url })).body.toString(), '0123456789');
  assert.equal(resolved.length, 0, 'download uses the prepared paths, not another active-library ID lookup');
  fs.writeFileSync(path.join(srcDir, 'media.bin'), 'changed');
  assert.equal((await request(port, { path: plan.url })).status, 409, 'changed source is not mislabeled as the prepared export');
});

test('UW-03: oversized bytes are rejected before streaming', async t => {
  const srcDir = makeFixtureDir();
  const sparse = path.join(srcDir, 'oversized.bin');
  const fd = fs.openSync(sparse, 'w');
  fs.ftruncateSync(fd, 4 * 1024 * 1024 * 1024); fs.closeSync(fd);
  const server = createWebServer({ srcDir, invoke: async () => null,
    resolveMediaPath: async () => sparse, accessKey: ACCESS_KEY, requireKey: false });
  const { port } = await server.start(0, '127.0.0.1');
  t.after(async () => { await server.stop(); fs.rmSync(srcDir, { recursive: true, force: true }); });
  const response = await request(port, { path: '/export/prepare', method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ ids: ['large'] }));
  assert.equal(response.status, 400);
  assert.match(JSON.parse(response.body).message, /3\.5GB/);
  assert.ok(response.body.length < 1000, 'no file payload is streamed');
});

test('TXT Web draft transport accepts a 5 MB body after worst-case JSON escaping, without enlarging other RPCs', async t => {
  const { TextDraftStore } = require('../lib/text-draft-store');
  const srcDir = makeFixtureDir();
  const store = new TextDraftStore(path.join(srcDir, 'drafts'));
  const calls = [];
  const server = createWebServer({ srcDir, accessKey: ACCESS_KEY, requireKey: false, resolveMediaPath: async () => null,
    invoke: async (method, [data]) => {
      calls.push(method);
      if (method === 'text-draft:put') {
        const saved = await store.put(data);
        return { bytes: Buffer.byteLength(saved.content) };
      }
      if (method === 'text:save') return { bytes: Buffer.byteLength(data.content) };
      return true;
    } });
  const { port } = await server.start(0, '127.0.0.1');
  t.after(async () => { await server.stop(); fs.rmSync(srcDir, { recursive: true, force: true }); });
  const content = '\u0001'.repeat(5 * 1024 * 1024);
  const data = { libraryPath: path.join(srcDir, 'fixture.library'), id: 'TXT', draftId: 'WINDOW', revision: 1, content };
  const rpc = (method, args) => request(port, { path: '/rpc', method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ method, args }));
  for (const method of ['text-draft:put', 'text:save']) {
    const response = await rpc(method, [data]);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true, result: { bytes: 5 * 1024 * 1024 } });
  }
  assert.equal((await store.get(data)).content, content);
  const oversized = await rpc('text-draft:put', [{ ...data, revision: 2, content: content + 'x' }]);
  assert.equal(JSON.parse(oversized.body).ok, false, 'decoded 5 MB store limit is still enforced');
  const other = await rpc('test:other', ['x'.repeat(9 * 1024 * 1024)]);
  assert.equal(other.status, 413);
  assert.ok(!calls.includes('test:other'), 'non-text requests retain their original 8 MB boundary');
});

test('P5-03: only IP, localhost and private LAN host names are served', () => {
  for (const host of ['127.0.0.1:41600', '192.168.1.20', '[::1]:41600', 'localhost:41600', 'macbook', 'macbook.local:41600',
    'mac.lan', 'probe.test', 'nas.home.arpa', 'mac.tailnet-1.ts.net']) assert.equal(isAllowedHost(host), true, host);
  for (const host of ['', 'evil.com', 'rebind.attacker.example.com:41600', '127.0.0.1.nip.io', 'mac.local.evil.com', 'a b'])
    assert.equal(isAllowedHost(host), false, host);
});

test('P5-03/W-04: foreign hosts, cross-site origins and simple-request writes are refused', async t => {
  const srcDir = makeFixtureDir();
  const calls = [];
  const server = createWebServer({ srcDir, invoke: async method => { calls.push(method); return { ok: true }; },
    resolveMediaPath: async () => null, accessKey: ACCESS_KEY, requireKey: false });
  const { port } = await server.start(0, '127.0.0.1');
  t.after(async () => { await server.stop(); fs.rmSync(srcDir, { recursive: true, force: true }); });
  const json = { 'Content-Type': 'application/json' };
  const body = JSON.stringify({ method: 'tags:get', args: [] });
  assert.equal((await request(port, { path: '/', headers: { Host: 'rebind.attacker.com:' + port } })).status, 403, 'DNS-rebound host');
  assert.equal((await request(port, { path: '/rpc', method: 'POST', headers: { ...json, Host: 'rebind.attacker.com' } }, body)).status, 403);
  assert.equal((await request(port, { path: '/rpc', method: 'POST', headers: { ...json, Origin: 'http://127.0.0.1:9999' } }, body)).status, 403, 'other port');
  assert.equal((await request(port, { path: '/rpc', method: 'POST', headers: { ...json, Origin: 'null' } }, body)).status, 403, 'opaque origin');
  assert.equal((await request(port, { path: '/rpc', method: 'POST', headers: { 'Content-Type': 'text/plain' } }, body)).status, 415, 'form-style post');
  assert.equal((await request(port, { path: '/upload?name=a.png', method: 'POST' }, 'x')).status, 403, 'upload without client header');
  assert.deepEqual(calls, []);
  const same = await request(port, { path: '/rpc', method: 'POST', headers: { ...json, Origin: `http://127.0.0.1:${port}` } }, body);
  assert.equal(same.status, 200);
  assert.deepEqual(calls, ['tags:get']);
});

test('W-01/S-11: library media is never sniffed, and HTML/SVG open sandboxed', async t => {
  const srcDir = makeFixtureDir();
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-media-csp-'));
  for (const name of ['a.svg', 'a.html', 'a.png', 'a.pdf']) fs.writeFileSync(path.join(mediaDir, name), '<svg onload="fetch(`/rpc`)"/>');
  const server = createWebServer({ srcDir, invoke: async () => null,
    resolveMediaPath: async (_kind, id) => path.join(mediaDir, id), accessKey: ACCESS_KEY, requireKey: false });
  const { port } = await server.start(0, '127.0.0.1');
  t.after(async () => { await server.stop(); fs.rmSync(srcDir, { recursive: true, force: true }); fs.rmSync(mediaDir, { recursive: true, force: true }); });
  for (const name of ['a.svg', 'a.html', 'a.png', 'a.pdf']) {
    const response = await request(port, { path: `/media/original/${name}` });
    assert.equal(response.status, 200, name);
    assert.equal(response.headers['x-content-type-options'], 'nosniff', name);
    const sandboxed = /^sandbox;/.test(response.headers['content-security-policy'] || '');
    assert.equal(sandboxed, name === 'a.svg' || name === 'a.html', name);
  }
});

// W-10: a single-file download resumes with Range, a zip announces its length,
// and a started download keeps its token past the two-minute start window.
test('W-10: exports resume single files, size zips exactly and keep a started token alive', async t => {
  const srcDir = makeFixtureDir();
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-export-resume-'));
  t.after(() => { fs.rmSync(srcDir, { recursive: true, force: true }); fs.rmSync(mediaDir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(mediaDir, 'a.bin'), '0123456789');
  fs.writeFileSync(path.join(mediaDir, '图.bin'), 'abc');
  const byId = { a: path.join(mediaDir, 'a.bin'), b: path.join(mediaDir, '图.bin') };
  const server = createWebServer({ srcDir, invoke: async () => null, resolveMediaPath: async (_kind, id) => byId[id] || null, accessKey: ACCESS_KEY, requireKey: false, loginFailureDelayMs: 0 });
  const { port } = await server.start(0, '127.0.0.1');
  t.after(() => server.stop());
  const prepare = async ids => JSON.parse((await request(port, { path: '/export/prepare', method: 'POST', headers: { 'Content-Type': 'application/json' } }, JSON.stringify({ ids }))).body.toString()).url;

  const url = await prepare(['a']);
  const full = await request(port, { path: url });
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.ok(full.headers.etag);
  const part = await request(port, { path: url, headers: { Range: 'bytes=4-', 'If-Range': full.headers.etag } });
  assert.equal(part.status, 206);
  assert.equal(part.body.toString(), '456789');
  assert.equal(part.headers['content-range'], 'bytes 4-9/10');
  const stale = await request(port, { path: url, headers: { Range: 'bytes=4-', 'If-Range': '"other"' } });
  assert.equal(stale.status, 200, 'a resume against another version starts over');
  assert.equal(stale.body.toString(), '0123456789');
  assert.equal((await request(port, { path: url, headers: { Range: 'bytes=20-' } })).status, 416);

  const zipURL = await prepare(['a', 'b']);
  const zip = await request(port, { path: zipURL });
  assert.equal(zip.status, 200);
  assert.equal(Number(zip.headers['content-length']), zip.body.length, 'Content-Length matches the streamed zip');

  // Two minutes to start; once started the token outlives that window.
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  const started = await prepare(['a']);
  await request(port, { path: started });
  const unused = await prepare(['a']);
  Date.now = () => realNow() + 5 * 60 * 1000;
  assert.equal((await request(port, { path: started, headers: { Range: 'bytes=0-1' } })).status, 206);
  assert.equal((await request(port, { path: unused })).status, 410, 'an unstarted export still expires');
});
