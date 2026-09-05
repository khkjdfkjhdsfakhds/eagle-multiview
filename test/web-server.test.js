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
    headers: authed
  }, 'PNGDATA');
  const body = JSON.parse(upload.body.toString());
  assert.equal(body.ok, true);
  assert.deepEqual(body.result.ids, ['NEW1']);
  assert.equal(imports[0].content, 'PNGDATA');
  assert.equal(imports[0].base, 'evil.png', 'path traversal stripped to a basename');
  assert.equal(imports[0].folderId, 'F1');
  assert.equal(imports[0].libraryPath, '/tmp/lib.library');

  const noName = await request(port, { path: '/upload?name=..%2F..%2F', method: 'POST', headers: authed }, 'x');
  assert.equal(noName.status, 400, 'unusable names are rejected');

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

test('export downloads one file directly and zips several (verified via ditto)', async () => {
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
  const prepare = selected => request(port, { path: '/export/prepare', method: 'POST', headers }, JSON.stringify({ ids: selected }));
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
  const prepare = ids => request(port, { path: '/export/prepare', method: 'POST' }, JSON.stringify({ ids, libraryPath: '/A' }));
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
  const response = await request(port, { path: '/export/prepare', method: 'POST' }, JSON.stringify({ ids: ['large'] }));
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
  const rpc = (method, args) => request(port, { path: '/rpc', method: 'POST' }, JSON.stringify({ method, args }));
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
