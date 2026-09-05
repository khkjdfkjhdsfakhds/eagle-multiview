'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const saveQueues = new Map();
const MAX_RECOVERY_VERSIONS = 20;

async function pruneRecoveryVersions(directory, keep) {
  // Only files created by this service qualify. A user-added file is retained.
  const entries = (await fs.readdir(directory)).filter(name => /^[a-f0-9]{64}-.+\.txt$/i.test(name));
  const versions = await Promise.all(entries.map(async name => ({ name, modified: (await fs.stat(path.join(directory, name))).mtimeMs })));
  versions.sort((a, b) => Number(b.name === keep) - Number(a.name === keep) || b.modified - a.modified);
  for (const entry of versions.slice(MAX_RECOVERY_VERSIONS)) await fs.unlink(path.join(directory, entry.name));
}

function fingerprint(buffer, stat) {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    hash: crypto.createHash('sha256').update(buffer).digest('hex')
  };
}

function sameFingerprint(left, right) {
  return Boolean(left && right && left.size === right.size && left.hash === right.hash);
}

function validateTextPath({ filePath, libraryPath, item }) {
  if (String(item?.ext || '').toLowerCase() !== 'txt') throw new Error('仅支持编辑 TXT 文件');
  if (!filePath || !libraryPath) throw new Error('找不到 TXT 原文件或资料库');
  const resolvedFile = path.resolve(filePath);
  const imagesRoot = `${path.resolve(libraryPath, 'images')}${path.sep}`;
  if (!resolvedFile.startsWith(imagesRoot)) throw new Error('TXT 文件不在当前 Eagle 资料库内');
  return resolvedFile;
}

async function readText({ filePath, libraryPath, item, maxBytes = DEFAULT_MAX_BYTES }) {
  const resolvedFile = validateTextPath({ filePath, libraryPath, item });
  const [actualFile, actualLibrary] = await Promise.all([fs.realpath(resolvedFile), fs.realpath(libraryPath)]);
  if (!actualFile.startsWith(`${path.join(actualLibrary, 'images')}${path.sep}`)) throw new Error('TXT 文件不在当前 Eagle 资料库内');
  const stat = await fs.stat(resolvedFile);
  if (!stat.isFile()) throw new Error('TXT 原文件不是普通文件');
  if (stat.size > maxBytes) throw new Error(`TXT 文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB，已拒绝在应用内编辑`);
  const buffer = await fs.readFile(resolvedFile);
  if (buffer.length > maxBytes) throw new Error('TXT 文件读取期间超过大小限制');
  if (buffer.includes(0)) throw new Error('文件包含二进制内容，无法按 TXT 安全编辑');
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('文件不是有效的 UTF-8 文本，无法安全编辑');
  }
  return { content, bom: buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), fingerprint: fingerprint(buffer, { ...stat, size: buffer.length }) };
}

function saveText(options) {
  const key = `${path.resolve(options.libraryPath || '.')}\0${String(options.item?.id || '')}`;
  const previous = saveQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => saveTextTransaction(options));
  saveQueues.set(key, current);
  return current.finally(() => {
    if (saveQueues.get(key) === current) saveQueues.delete(key);
  });
}

async function saveTextTransaction({ filePath, libraryPath, item, content, base, backupRoot, replaceFile, ensureLibraryPath = async () => {}, force = false, maxBytes = DEFAULT_MAX_BYTES }) {
  await ensureLibraryPath(libraryPath);
  const resolvedFile = validateTextPath({ filePath, libraryPath, item });
  if (typeof replaceFile !== 'function') throw new Error('Eagle TXT 后台插件未连接，草稿已保留');
  if (typeof content !== 'string') throw new Error('TXT 内容无效');
  if (content.length === 0) throw new Error('Eagle 暂不提交空正文；清空内容仍保留为草稿');
  const current = await readText({ filePath: resolvedFile, libraryPath, item, maxBytes });
  const output = Buffer.from((current.bom ? '\uFEFF' : '') + content, 'utf8');
  if (output.length > maxBytes) throw new Error(`保存内容超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
  if (!force && !sameFingerprint(base, current.fingerprint)) {
    return { conflict: true, current };
  }

  if (!backupRoot || !/^[\w-]{1,128}$/.test(String(item.id || ''))) throw new Error('TXT 备份身份无效');
  const libraryRoot = await fs.realpath(libraryPath);
  const requestedBackup = path.resolve(backupRoot);
  if (requestedBackup === path.resolve(libraryPath) || requestedBackup.startsWith(`${path.resolve(libraryPath)}${path.sep}`)) throw new Error('TXT 备份必须位于资料库之外');
  // Check an existing ancestor before mkdir, including symlinks into a library.
  let ancestor = requestedBackup;
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      if (real === libraryRoot || real.startsWith(`${libraryRoot}${path.sep}`)) throw new Error('TXT 备份必须位于资料库之外');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const libraryKey = crypto.createHash('sha256').update(path.resolve(libraryPath)).digest('hex').slice(0, 16);
  const backupDir = path.join(backupRoot, libraryKey, String(item.id));
  await fs.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${current.fingerprint.hash}-${path.basename(resolvedFile)}`);
  // Back up the exact version we checked, not a second racing read of Eagle.
  const previousBytes = Buffer.from((current.bom ? '\uFEFF' : '') + current.content, 'utf8');
  try { await fs.writeFile(backupPath, previousBytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }

  // Only the official Eagle plugin may replace a library file. The client
  // stages candidates alongside its own backups, never inside the library.
  const stagingRoot = path.join(backupRoot, 'staging');
  await fs.mkdir(stagingRoot, { recursive: true });
  const tempPath = path.join(stagingRoot, `${crypto.randomUUID()}.txt`);
  try {
    await fs.writeFile(tempPath, output, { flag: 'wx', mode: 0o600 });
    await ensureLibraryPath(libraryPath);
    const result = await replaceFile({
      id: item.id, libraryPath: path.resolve(libraryPath), stagedPath: tempPath,
      base: current.fingerprint, outputHash: crypto.createHash('sha256').update(output).digest('hex')
    });
    if (result?.conflict) return result;
    const after = await readText({ filePath: resolvedFile, libraryPath, item, maxBytes });
    if (after.fingerprint.hash !== crypto.createHash('sha256').update(output).digest('hex')) {
      return { conflict: true, current: after, backupPath };
    }
    // Cleanup is best-effort AFTER a confirmed content write; a cleanup failure
    // is not a save failure and must never cause the editor to replay the write.
    await pruneRecoveryVersions(backupDir, path.basename(backupPath)).catch(() => {});
    return { conflict: false, fingerprint: after.fingerprint, backupPath, status: result?.status || 'saved' };
  } finally {
    try { await fs.unlink(tempPath); } catch {}
  }
}

module.exports = { readText, saveText, sameFingerprint, validateTextPath, DEFAULT_MAX_BYTES };
