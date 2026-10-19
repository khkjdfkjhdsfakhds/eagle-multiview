'use strict';

// Software update: GitHub Releases is the feed, the arm64 DMG is the payload,
// SHA256SUMS.txt is the integrity anchor. The app is ad-hoc signed, so
// Squirrel/electron-updater cannot verify a new build; instead the verified
// DMG is copied out, checked (bundle id, version, codesign) and swapped into
// place by a detached script once this process has exited.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFile, spawn } = require('node:child_process');

const RELEASE_FEED = 'https://api.github.com/repos/khkjdfkjhdsfakhds/eagle-multiview/releases/latest';
const BUNDLE_ID = 'local.eagle.multiview';
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;

function versionParts(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)], pre: match[4] || '' };
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre.localeCompare(right.pre, 'en', { numeric: true }) > 0 ? 1 : -1;
}

function parseRelease(json) {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) return null;
  const version = String(json.tag_name || '').replace(/^v/i, '');
  if (!versionParts(version)) return null;
  const assets = (Array.isArray(json.assets) ? json.assets : [])
    .filter(asset => asset && asset.name && asset.browser_download_url)
    .map(asset => ({ name: String(asset.name), url: String(asset.browser_download_url), size: Number(asset.size) || 0 }));
  return {
    version,
    name: String(json.name || `v${version}`),
    notes: String(json.body || ''),
    url: String(json.html_url || ''),
    publishedAt: String(json.published_at || ''),
    assets
  };
}

function pickMacAsset(release, arch = process.arch) {
  if (!release) return null;
  const suffix = `-${arch}.dmg`;
  return release.assets.find(asset => asset.name.toLowerCase().endsWith(suffix)) || null;
}

function pickChecksumAsset(release) {
  return release?.assets.find(asset => /^sha256sums(\.txt)?$/i.test(asset.name)) || null;
}

function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match) sums.set(path.basename(match[2].trim()), match[1].toLowerCase());
  }
  return sums;
}

// <bundle>.app from <bundle>.app/Contents/MacOS/<exe>; null when not running
// from an app bundle (development runs through the electron binary).
function appBundlePath(exePath) {
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const index = String(exePath || '').lastIndexOf(marker);
  if (index < 0) return null;
  const bundle = exePath.slice(0, index);
  return bundle.endsWith('.app') ? bundle : null;
}

function describeError(error) {
  const message = String(error?.message || error || '未知错误');
  if (/net::ERR_|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message)) {
    return `无法连接到 GitHub，请检查网络或代理设置（${message}）`;
  }
  return message;
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${path.basename(file)} ${args[0] || ''} 失败：${String(stderr || error.message).trim()}`;
        reject(error);
      } else {
        resolve(String(stdout));
      }
    });
  });
}

async function readPlistValue(plist, key) {
  return (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).trim();
}

// Mounts the DMG read-only, copies its single app bundle to `destination`,
// and checks the copy is a signed Eagle MultiView of the expected version.
async function stageAppFromDmg({ dmgPath, destination, expectedVersion, bundleId = BUNDLE_ID }) {
  const mountPoint = await fsp.mkdtemp(path.join(path.dirname(destination), 'mount-'));
  let mounted = false;
  try {
    await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-noverify', '-mountpoint', mountPoint, dmgPath]);
    mounted = true;
    const apps = (await fsp.readdir(mountPoint)).filter(name => name.endsWith('.app') && !name.startsWith('.'));
    if (apps.length !== 1) throw new Error(`安装包内应只有一个 App，实际找到 ${apps.length} 个`);
    await fsp.rm(destination, { recursive: true, force: true });
    await run('/usr/bin/ditto', [path.join(mountPoint, apps[0]), destination]);
  } finally {
    if (mounted) await run('/usr/bin/hdiutil', ['detach', mountPoint, '-force']).catch(() => {});
    await fsp.rm(mountPoint, { recursive: true, force: true }).catch(() => {});
  }
  const plist = path.join(destination, 'Contents', 'Info.plist');
  const foundId = await readPlistValue(plist, 'CFBundleIdentifier');
  if (foundId !== bundleId) throw new Error(`安装包标识不符（${foundId}）`);
  const foundVersion = await readPlistValue(plist, 'CFBundleShortVersionString');
  if (compareVersions(foundVersion, expectedVersion) !== 0) throw new Error(`安装包版本不符（${foundVersion}，应为 ${expectedVersion}）`);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination]);
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', destination]).catch(() => {});
  return destination;
}

// Runs detached after the app quits: waits for the old process, swaps the
// staged bundle into place (restoring the old one on failure), deletes the
// old bundle so no stale copy is left behind, and optionally relaunches.
const SWAP_SCRIPT = `#!/bin/bash
set -u
PID="$1"; TARGET="$2"; STAGED="$3"; WORK="$4"; RELAUNCH="$5"
exec >>"$WORK/install.log" 2>&1
echo "$(date '+%F %T') install start pid=$PID"
for _ in $(seq 1 1200); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$PID" 2>/dev/null; then echo "app still running, abort"; exit 1; fi
if [ ! -d "$STAGED" ]; then echo "staged app missing"; exit 1; fi
BACKUP="$WORK/previous.app"
rm -rf "$BACKUP"
if ! mv "$TARGET" "$BACKUP"; then echo "cannot move current app"; [ "$RELAUNCH" = 1 ] && open "$TARGET"; exit 1; fi
if ! mv "$STAGED" "$TARGET"; then
  echo "cannot move new app, restoring"
  mv "$BACKUP" "$TARGET"
  [ "$RELAUNCH" = 1 ] && open "$TARGET"
  exit 1
fi
rm -rf "$BACKUP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$TARGET" >/dev/null 2>&1 || true
echo "$(date '+%F %T') installed"
if [ "$RELAUNCH" = 1 ]; then open "$TARGET"; fi
exit 0
`;

class UpdateController extends EventEmitter {
  constructor({
    currentVersion,
    workDir,
    bundlePath = null,
    fetch,
    feedURL = RELEASE_FEED,
    arch = process.arch,
    now = () => Date.now(),
    logFault = () => {},
    spawnDetached = (file, args) => spawn(file, args, { detached: true, stdio: 'ignore' }).unref(),
    stageApp = stageAppFromDmg,
    canWrite = target => fsp.access(path.dirname(target), fs.constants.W_OK).then(() => fsp.access(target, fs.constants.W_OK)).then(() => true, () => false)
  }) {
    super();
    this.currentVersion = currentVersion;
    this.workDir = workDir;
    this.bundlePath = bundlePath;
    this.fetch = fetch;
    this.feedURL = feedURL;
    this.arch = arch;
    this.now = now;
    this.logFault = logFault;
    this.spawnDetached = spawnDetached;
    this.stageApp = stageApp;
    this.canWrite = canWrite;
    this.settings = { autoCheck: true, lastCheckAt: 0, skipVersion: '' };
    this.state = { phase: 'idle' };
    this.release = null;
    this.download = null;
    this.staged = null;
    this.pendingInstall = null;
    this.checking = null;
    this.checkController = null;
  }

  get settingsFile() { return path.join(this.workDir, 'update.json'); }

  // A bundle staged by an earlier session that never quit through the
  // installer is not trusted across launches; it is simply re-downloaded.
  async cleanupLeftovers() {
    await fsp.rm(path.join(this.workDir, 'staged'), { recursive: true, force: true }).catch(() => {});
  }

  async loadSettings() {
    try {
      const saved = JSON.parse(await fsp.readFile(this.settingsFile, 'utf8'));
      this.settings = {
        autoCheck: saved.autoCheck !== false,
        lastCheckAt: Number(saved.lastCheckAt) || 0,
        skipVersion: String(saved.skipVersion || '')
      };
    } catch {}
    return this.settings;
  }

  async saveSettings(patch = {}) {
    Object.assign(this.settings, patch);
    await fsp.mkdir(this.workDir, { recursive: true });
    await fsp.writeFile(this.settingsFile, `${JSON.stringify(this.settings, null, 2)}\n`);
    this.emitState();
  }

  snapshot() {
    return { ...this.state, currentVersion: this.currentVersion, autoCheck: this.settings.autoCheck };
  }

  setState(state) {
    this.state = state;
    this.emitState();
  }

  emitState() { this.emit('state', this.snapshot()); }

  isBusy() { return ['checking', 'downloading', 'preparing', 'installing'].includes(this.state.phase); }

  dueForAutoCheck() {
    return this.settings.autoCheck && this.now() - this.settings.lastCheckAt >= CHECK_INTERVAL;
  }

  async installBlocker() {
    if (!this.bundlePath) return '开发版不能自动安装更新';
    if (!(await this.canWrite(this.bundlePath))) return `没有权限替换 ${this.bundlePath}`;
    return null;
  }

  async fetchJSON(url, { signal } = {}) {
    const response = await this.fetch(url, { signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': `EagleMultiView/${this.currentVersion}` } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`更新服务器返回 ${response.status}`);
    return response.json();
  }

  // manual: user asked from the menu, so report "latest" and ignore skipVersion.
  async check({ manual = false } = {}) {
    if (this.checking) return this.checking;
    if (['downloading', 'preparing', 'installing'].includes(this.state.phase)) return this.snapshot();
    if (this.state.phase === 'ready' && this.staged) { this.emitState(); return this.snapshot(); }
    const controller = new AbortController();
    this.checkController = controller;
    this.checking = (async () => {
      if (manual) this.setState({ phase: 'checking' });
      try {
        const release = parseRelease(await this.fetchJSON(this.feedURL, { signal: controller.signal }));
        if (controller.signal.aborted) throw controller.signal.reason;
        await this.saveSettings({ lastCheckAt: this.now() });
        if (!release || compareVersions(release.version, this.currentVersion) <= 0) {
          this.release = null;
          this.setState(manual ? { phase: 'latest' } : { phase: 'idle' });
          return this.snapshot();
        }
        if (!manual && release.version === this.settings.skipVersion) {
          this.setState({ phase: 'idle' });
          return this.snapshot();
        }
        this.release = release;
        const asset = pickMacAsset(release, this.arch);
        const checksum = pickChecksumAsset(release);
        const blocker = !asset ? '这个版本没有适用于本机的安装包'
          : !checksum ? '这个版本缺少校验文件，不能自动安装'
            : await this.installBlocker();
        this.setState({
          phase: 'available',
          version: release.version,
          notes: release.notes,
          releaseURL: release.url,
          publishedAt: release.publishedAt,
          size: asset?.size || 0,
          manualOnly: Boolean(blocker),
          manualReason: blocker || ''
        });
        return this.snapshot();
      } catch (error) {
        if (controller.signal.aborted) {
          this.setState({ phase: 'idle' });
          return this.snapshot();
        }
        this.logFault('update', `检查更新失败：${error.message}`, error);
        this.setState(manual ? { phase: 'error', message: describeError(error), retry: 'check' } : { phase: 'idle' });
        return this.snapshot();
      }
    })().finally(() => {
      this.checking = null;
      if (this.checkController === controller) this.checkController = null;
    });
    return this.checking;
  }

  // 取消 while checking stops the request instead of only hiding the window (F-09).
  cancelCheck() {
    this.checkController?.abort(Object.assign(new Error('已取消检查更新'), { name: 'AbortError' }));
  }

  async skip() {
    if (this.release) await this.saveSettings({ skipVersion: this.release.version });
    this.setState({ phase: 'idle' });
  }

  async setAutoCheck(enabled) { await this.saveSettings({ autoCheck: Boolean(enabled) }); }

  cancelDownload() {
    this.download?.abort();
  }

  async downloadAndPrepare() {
    const release = this.release;
    const asset = pickMacAsset(release, this.arch);
    const checksum = pickChecksumAsset(release);
    // `download` is claimed before the first await, so a second click that
    // arrives while installBlocker() runs is ignored (F-10).
    if (!release || !asset || !checksum || this.isBusy() || this.download) return this.snapshot();
    const controller = new AbortController();
    this.download = controller;
    const blocker = await this.installBlocker().catch(error => { this.download = null; throw error; });
    if (blocker) {
      this.download = null;
      this.setState({ phase: 'error', message: blocker, releaseURL: release.url });
      return this.snapshot();
    }
    const versionDir = path.join(this.workDir, release.version);
    const dmgPath = path.join(versionDir, asset.name);
    const base = { version: release.version, releaseURL: release.url, notes: release.notes };
    try {
      await fsp.rm(path.join(this.workDir, 'staged'), { recursive: true, force: true });
      await fsp.rm(versionDir, { recursive: true, force: true });
      await fsp.mkdir(versionDir, { recursive: true });
      this.setState({ ...base, phase: 'downloading', received: 0, total: asset.size });
      const sums = parseSha256Sums(await (await this.fetchOK(checksum.url, controller.signal)).text());
      const expected = sums.get(asset.name);
      if (!expected) throw new Error('校验文件里没有这个安装包');
      const actual = await this.downloadFile(asset, dmgPath, controller.signal, (received, total) => {
        this.setState({ ...base, phase: 'downloading', received, total });
      });
      if (actual !== expected) throw new Error('安装包校验失败（SHA-256 不一致），已丢弃');
      this.setState({ ...base, phase: 'preparing' });
      const destination = path.join(this.workDir, 'staged', path.basename(this.bundlePath));
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await this.stageApp({ dmgPath, destination, expectedVersion: release.version });
      this.staged = { version: release.version, path: destination };
      this.setState({ ...base, phase: 'ready' });
    } catch (error) {
      if (controller.signal.aborted) {
        this.setState({ ...base, phase: 'available', notes: release.notes, publishedAt: release.publishedAt, size: asset.size, manualOnly: false, manualReason: '' });
      } else {
        this.logFault('update', `下载更新失败：${error.message}`, error);
        this.setState({ ...base, phase: 'error', message: describeError(error), retry: 'download' });
      }
      await fsp.rm(path.join(this.workDir, 'staged'), { recursive: true, force: true }).catch(() => {});
    } finally {
      this.download = null;
      await fsp.rm(versionDir, { recursive: true, force: true }).catch(() => {});
    }
    return this.snapshot();
  }

  async fetchOK(url, signal) {
    const response = await this.fetch(url, { signal, headers: { 'User-Agent': `EagleMultiView/${this.currentVersion}` } });
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
    return response;
  }

  async downloadFile(asset, destination, signal, onProgress) {
    const response = await this.fetchOK(asset.url, signal);
    const total = Number(response.headers.get('content-length')) || asset.size || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(destination);
    let received = 0;
    let lastReport = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.length;
        if (!out.write(value)) await new Promise(resolve => out.once('drain', resolve));
        if (this.now() - lastReport > 120) {
          lastReport = this.now();
          onProgress(received, total);
        }
      }
      onProgress(received, total);
    } finally {
      await new Promise(resolve => out.end(resolve));
    }
    if (asset.size && received !== asset.size) throw new Error('安装包下载不完整');
    return hash.digest('hex');
  }

  // Arms the swap; it runs from `will-quit` so a cancelled quit (unsaved TXT
  // prompt) does not swap the bundle under a still-running app.
  requestInstall({ relaunch }) {
    if (!this.staged || !this.bundlePath) return false;
    this.pendingInstall = { relaunch: Boolean(relaunch) };
    if (relaunch) this.setState({ ...this.state, phase: 'installing' });
    return true;
  }

  quitCancelled() {
    if (!this.pendingInstall) return;
    this.pendingInstall.relaunch = false;
    if (this.state.phase === 'installing') this.setState({ ...this.state, phase: 'ready' });
  }

  // Synchronous: called from will-quit, after which the process is gone.
  runPendingInstall(pid = process.pid) {
    if (!this.pendingInstall || !this.staged) return false;
    const { relaunch } = this.pendingInstall;
    this.pendingInstall = null;
    const script = path.join(this.workDir, 'install-update.sh');
    fs.mkdirSync(this.workDir, { recursive: true });
    fs.writeFileSync(script, SWAP_SCRIPT, { mode: 0o755 });
    this.spawnDetached('/bin/bash', [script, String(pid), this.bundlePath, this.staged.path, this.workDir, relaunch ? '1' : '0']);
    return true;
  }
}

module.exports = {
  RELEASE_FEED,
  SWAP_SCRIPT,
  UpdateController,
  appBundlePath,
  compareVersions,
  parseRelease,
  parseSha256Sums,
  pickChecksumAsset,
  pickMacAsset,
  stageAppFromDmg
};
