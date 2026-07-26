'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    const loginPage = await request(port, { path: '/login' });
    assert.equal(loginPage.status, 200);
    assert.ok(loginPage.body.toString().includes('访问密钥'));

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
  fs.rmSync(srcDir, { recursive: true, force: true });
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
