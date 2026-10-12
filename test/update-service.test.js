'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const {
  SWAP_SCRIPT,
  UpdateController,
  appBundlePath,
  compareVersions,
  parseRelease,
  parseSha256Sums,
  pickMacAsset,
  stageAppFromDmg
} = require('../lib/update-service');

const FEED = 'https://api.example/releases/latest';
const DMG_URL = 'https://dl.example/Eagle-MultiView-1.9.0-arm64.dmg';
const SUMS_URL = 'https://dl.example/SHA256SUMS.txt';

function releaseJSON({ version = '1.9.0', dmgSize = 6, extraAssets = [] } = {}) {
  return {
    tag_name: `v${version}`,
    name: `Eagle MultiView ${version}`,
    body: '## 新功能\n- 检查更新',
    html_url: `https://github.com/khkjdfkjhdsfakhds/eagle-multiview/releases/tag/v${version}`,
    published_at: '2026-10-12T00:00:00Z',
    assets: [
      { name: `Eagle-MultiView-${version}-arm64.dmg`, browser_download_url: DMG_URL, size: dmgSize },
      { name: `Eagle-MultiView-${version}-android.apk`, browser_download_url: 'https://dl.example/a.apk', size: 3 },
      { name: 'SHA256SUMS.txt', browser_download_url: SUMS_URL, size: 100 },
      ...extraAssets
    ]
  };
}

function fakeFetch(routes, calls = []) {
  return async (url, options = {}) => {
    calls.push(url);
    if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (route === undefined) return new Response('missing', { status: 404 });
    if (typeof route === 'function') return route(options);
    if (Buffer.isBuffer(route)) return new Response(route, { headers: { 'content-length': String(route.length) } });
    return new Response(typeof route === 'string' ? route : JSON.stringify(route));
  };
}

async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function controller(t, workDir, overrides = {}) {
  return new UpdateController({
    currentVersion: '1.8.1',
    workDir,
    bundlePath: '/Applications/Eagle MultiView.app',
    feedURL: FEED,
    arch: 'arm64',
    canWrite: async () => true,
    ...overrides
  });
}

test('compares release versions numerically, prereleases sort below the release', () => {
  assert.equal(compareVersions('1.8.10', '1.8.9'), 1);
  assert.equal(compareVersions('v1.9.0', '1.8.1'), 1);
  assert.equal(compareVersions('1.8.1', '1.8.1'), 0);
  assert.equal(compareVersions('1.8', '1.8.0'), 0);
  assert.equal(compareVersions('1.8.0', '1.10.0'), -1);
  assert.equal(compareVersions('1.9.0-beta.2', '1.9.0'), -1);
  assert.equal(compareVersions('1.9.0-beta.10', '1.9.0-beta.2'), 1);
  assert.equal(compareVersions('garbage', '1.0.0'), 0);
});

test('parses the GitHub release, picks the arch DMG and reads SHA256SUMS', () => {
  const release = parseRelease(releaseJSON());
  assert.equal(release.version, '1.9.0');
  assert.equal(pickMacAsset(release, 'arm64').name, 'Eagle-MultiView-1.9.0-arm64.dmg');
  assert.equal(pickMacAsset(release, 'x64'), null);
  assert.equal(parseRelease({ ...releaseJSON(), draft: true }), null);
  assert.equal(parseRelease({ ...releaseJSON(), tag_name: 'nightly' }), null);
  const sums = parseSha256Sums(`${'a'.repeat(64)}  Eagle-MultiView-1.9.0-arm64.dmg\n${'B'.repeat(64)} *dir/x.apk\nnot a line\n`);
  assert.equal(sums.get('Eagle-MultiView-1.9.0-arm64.dmg'), 'a'.repeat(64));
  assert.equal(sums.get('x.apk'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

test('finds the app bundle only when running from one', () => {
  assert.equal(appBundlePath('/Applications/Eagle MultiView.app/Contents/MacOS/Eagle MultiView'), '/Applications/Eagle MultiView.app');
  assert.equal(appBundlePath('/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), '/repo/node_modules/electron/dist/Electron.app');
  assert.equal(appBundlePath('/usr/local/bin/electron'), null);
});

test('manual check reports latest; auto check stays silent and records the check time', async t => {
  const workDir = await tempDir(t, 'eaglemv-update-');
  const updates = controller(t, workDir, { fetch: fakeFetch({ [FEED]: releaseJSON({ version: '1.8.1' }) }), now: () => 5000 });
  const states = [];
  updates.on('state', state => states.push(state.phase));
  assert.equal((await updates.check({ manual: true })).phase, 'latest');
  assert.deepEqual(states.filter(phase => phase !== 'latest' && phase !== 'checking'), []);
  assert.ok(states.includes('checking'));
  assert.equal((await updates.check()).phase, 'idle');
  assert.equal(JSON.parse(await fs.readFile(path.join(workDir, 'update.json'), 'utf8')).lastCheckAt, 5000);
});

test('a newer release becomes available; skipping hides it from auto checks only', async t => {
  const workDir = await tempDir(t, 'eaglemv-update-');
  const updates = controller(t, workDir, { fetch: fakeFetch({ [FEED]: releaseJSON() }) });
  const available = await updates.check();
  assert.equal(available.phase, 'available');
  assert.equal(available.version, '1.9.0');
  assert.equal(available.size, 6);
  assert.equal(available.manualOnly, false);
  await updates.skip();
  assert.equal((await updates.check()).phase, 'idle');
  assert.equal((await updates.check({ manual: true })).phase, 'available');
  const reloaded = controller(t, workDir, { fetch: fakeFetch({ [FEED]: releaseJSON() }) });
  await reloaded.loadSettings();
  assert.equal(reloaded.settings.skipVersion, '1.9.0');
  assert.equal((await reloaded.check()).phase, 'idle');
});

test('falls back to the download page when the app cannot replace itself', async t => {
  const workDir = await tempDir(t, 'eaglemv-update-');
  const dev = controller(t, workDir, { bundlePath: null, fetch: fakeFetch({ [FEED]: releaseJSON() }) });
  assert.deepEqual(
    (({ manualOnly, manualReason }) => ({ manualOnly, manualReason }))(await dev.check({ manual: true })),
    { manualOnly: true, manualReason: '开发版不能自动安装更新' }
  );
  const readOnly = controller(t, workDir, { canWrite: async () => false, fetch: fakeFetch({ [FEED]: releaseJSON() }) });
  assert.match((await readOnly.check({ manual: true })).manualReason, /没有权限替换/);
  const intel = controller(t, workDir, { arch: 'x64', fetch: fakeFetch({ [FEED]: releaseJSON() }) });
  assert.match((await intel.check({ manual: true })).manualReason, /没有适用于本机/);
});

test('network failure is an error only for manual checks', async t => {
  const workDir = await tempDir(t, 'eaglemv-update-');
  const faults = [];
  const updates = controller(t, workDir, { fetch: fakeFetch({ [FEED]: new Error('net::ERR_CONNECTION_REFUSED') }), logFault: (...args) => faults.push(args) });
  assert.equal((await updates.check()).phase, 'idle');
  const manual = await updates.check({ manual: true });
  assert.equal(manual.phase, 'error');
  assert.equal(manual.message, '无法连接到 GitHub，请检查网络或代理设置（net::ERR_CONNECTION_REFUSED）');
  assert.equal(manual.retry, 'check');
  assert.equal(faults.length, 2);
});

test('downloads, verifies the checksum, stages and arms the install', async t => {
  const workDir = await tempDir(t, 'eaglemv-update-');
  const payload = Buffer.from('dmg!!!');
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  const staged = [];
  const spawned = [];
  const updates = controller(t, workDir, {
    fetch: fakeFetch({ [FEED]: releaseJSON(), [SUMS_URL]: `${hash}  Eagle-MultiView-1.9.0-arm64.dmg\n`, [DMG_URL]: payload }),
    stageApp: async options => {
      assert.equal(await fs.readFile(options.dmgPath, 'utf8'), 'dmg!!!');
      staged.push(options);
      await fs.mkdir(options.destination, { recursive: true });
    },
    spawnDetached: (file, args) => spawned.push([file, args])
  });
  const phases = [];
  updates.on('state', state => phases.push(state.phase));
  await updates.check({ manual: true });
  const ready = await updates.downloadAndPrepare();
  assert.equal(ready.phase, 'ready');
  assert.ok(phases.includes('downloading') && phases.includes('preparing'));
  assert.equal(staged[0].expectedVersion, '1.9.0');
  assert.equal(staged[0].destination, path.join(workDir, 'staged', 'Eagle MultiView.app'));
  await assert.rejects(fs.stat(path.join(workDir, '1.9.0')), /ENOENT/, 'downloaded DMG is removed after staging');

  assert.equal(updates.runPendingInstall(), false, 'nothing runs before an install is requested');
  updates.requestInstall({ relaunch: true });
  assert.equal(updates.state.phase, 'installing');
  updates.quitCancelled();
  assert.equal(updates.state.phase, 'ready');
  assert.equal(updates.runPendingInstall(4242), true);
  assert.equal(spawned.length, 1);
  const [file, args] = spawned[0];
  assert.equal(file, '/bin/bash');
  assert.deepEqual(args.slice(1), ['4242', '/Applications/Eagle MultiView.app', staged[0].destination, workDir, '0']);
  assert.equal(await fs.readFile(args[0], 'utf8'), SWAP_SCRIPT);
  assert.equal(updates.runPendingInstall(), false, 'the install is spawned once');
});

test('a checksum mismatch discards the download and nothing is staged', async t => {
  const workDir = await tempDir(t, 'eaglemv-update-');
  let stagedCalls = 0;
  const updates = controller(t, workDir, {
    fetch: fakeFetch({ [FEED]: releaseJSON(), [SUMS_URL]: `${'0'.repeat(64)}  Eagle-MultiView-1.9.0-arm64.dmg\n`, [DMG_URL]: Buffer.from('dmg!!!') }),
    stageApp: async () => { stagedCalls += 1; },
    logFault: () => {}
  });
  await updates.check({ manual: true });
  const result = await updates.downloadAndPrepare();
  assert.equal(result.phase, 'error');
  assert.match(result.message, /校验失败/);
  assert.equal(result.retry, 'download');
  assert.equal(stagedCalls, 0);
  assert.equal(updates.requestInstall({ relaunch: true }), false);
  assert.deepEqual((await fs.readdir(workDir)).sort(), ['update.json']);
});

test('cancelling a download returns to the offer without an error', async t => {
  const workDir = await tempDir(t, 'eaglemv-update-');
  let updates;
  const slowBody = options => new Response(new ReadableStream({
    start(streamController) {
      streamController.enqueue(new Uint8Array([1, 2, 3]));
      setTimeout(() => updates.cancelDownload(), 20);
      options.signal.addEventListener('abort', () => streamController.error(new DOMException('aborted', 'AbortError')));
    }
  }));
  updates = controller(t, workDir, {
    fetch: fakeFetch({ [FEED]: releaseJSON(), [SUMS_URL]: `${'0'.repeat(64)}  Eagle-MultiView-1.9.0-arm64.dmg\n`, [DMG_URL]: slowBody }),
    logFault: () => { throw new Error('cancel must not log a fault'); }
  });
  await updates.check({ manual: true });
  const result = await updates.downloadAndPrepare();
  assert.equal(result.phase, 'available');
  assert.equal(result.version, '1.9.0');
  assert.deepEqual((await fs.readdir(workDir)).sort(), ['update.json']);
});

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const TEST_BUNDLE_ID = 'local.eagle.multiview.updatetest';

// Fake bundles get registered with LaunchServices (the swap script runs
// lsregister -f); drop them again so no stale app entries are left behind.
function unregisterAfter(t, ...apps) {
  t.after(() => {
    for (const app of apps) spawnSync(LSREGISTER, ['-u', app]);
  });
}

async function makeFakeApp(root, { id = TEST_BUNDLE_ID, version = '1.9.0', marker = 'new' } = {}) {
  const app = path.join(root, 'Eagle MultiView.app');
  await fs.mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  await fs.writeFile(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>Eagle MultiView</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
  await fs.writeFile(path.join(app, 'Contents', 'MacOS', 'Eagle MultiView'), `#!/bin/sh\necho ${marker}\n`, { mode: 0o755 });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  return app;
}

test('stages the app out of a real DMG and rejects a wrong bundle', { skip: process.platform !== 'darwin', timeout: 60000 }, async t => {
  const root = await tempDir(t, 'eaglemv-dmg-');
  const source = path.join(root, 'src');
  await makeFakeApp(source);
  const dmgPath = path.join(root, 'test.dmg');
  execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-srcfolder', source, '-volname', 'EMV Test', '-format', 'UDZO', dmgPath]);
  const work = path.join(root, 'work');
  await fs.mkdir(work);
  const destination = path.join(work, 'staged', 'Eagle MultiView.app');
  unregisterAfter(t, path.join(source, 'Eagle MultiView.app'), destination);
  await fs.mkdir(path.dirname(destination));
  await stageAppFromDmg({ dmgPath, destination, expectedVersion: '1.9.0', bundleId: TEST_BUNDLE_ID });
  assert.equal(execFileSync(path.join(destination, 'Contents', 'MacOS', 'Eagle MultiView'), { encoding: 'utf8' }).trim(), 'new');
  assert.deepEqual(await fs.readdir(path.dirname(destination)), ['Eagle MultiView.app'], 'mount point is cleaned up');
  await assert.rejects(stageAppFromDmg({ dmgPath, destination, expectedVersion: '2.0.0', bundleId: TEST_BUNDLE_ID }), /版本不符/);
  await assert.rejects(stageAppFromDmg({ dmgPath, destination, expectedVersion: '1.9.0' }), /标识不符/);
});

test('the swap script waits for the app to exit, replaces it and leaves no old copy', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const root = await tempDir(t, 'eaglemv-swap-');
  const installed = path.join(root, 'Applications');
  const target = await makeFakeApp(installed, { version: '1.8.1', marker: 'old' });
  const work = path.join(root, 'Updates');
  const staged = await makeFakeApp(path.join(work, 'staged'), { marker: 'new' });
  unregisterAfter(t, target, staged);
  const script = path.join(work, 'install-update.sh');
  await fs.writeFile(script, SWAP_SCRIPT, { mode: 0o755 });
  // Orphaned to launchd so it is reaped on exit (a child of this blocked
  // process would linger as a zombie and still answer kill -0).
  const pid = execFileSync('/bin/bash', ['-c', 'sleep 0.6 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).trim();
  const startedAt = Date.now();
  const result = spawnSync('/bin/bash', [script, pid, target, staged, work, '0'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, await fs.readFile(path.join(work, 'install.log'), 'utf8'));
  assert.ok(Date.now() - startedAt >= 400, 'waited for the old process');
  assert.equal(execFileSync(path.join(target, 'Contents', 'MacOS', 'Eagle MultiView'), { encoding: 'utf8' }).trim(), 'new');
  assert.deepEqual((await fs.readdir(installed)), ['Eagle MultiView.app']);
  assert.deepEqual((await fs.readdir(work)).sort(), ['install-update.sh', 'install.log', 'staged']);
  assert.deepEqual(await fs.readdir(path.join(work, 'staged')), []);
});

test('the swap script keeps the current app when the staged copy is missing', { skip: process.platform !== 'darwin' }, async t => {
  const root = await tempDir(t, 'eaglemv-swap-');
  const target = await makeFakeApp(path.join(root, 'Applications'), { marker: 'old' });
  unregisterAfter(t, target);
  const work = path.join(root, 'Updates');
  await fs.mkdir(work);
  const script = path.join(work, 'install-update.sh');
  await fs.writeFile(script, SWAP_SCRIPT, { mode: 0o755 });
  const result = spawnSync('/bin/bash', [script, '999999', target, path.join(work, 'nope.app'), work, '0'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 1);
  assert.equal(execFileSync(path.join(target, 'Contents', 'MacOS', 'Eagle MultiView'), { encoding: 'utf8' }).trim(), 'old');
});
