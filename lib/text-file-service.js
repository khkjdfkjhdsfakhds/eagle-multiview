'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

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
  const stat = await fs.stat(resolvedFile);
  if (!stat.isFile()) throw new Error('TXT 原文件不是普通文件');
  if (stat.size > maxBytes) throw new Error(`TXT 文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB，已拒绝在应用内编辑`);
  const buffer = await fs.readFile(resolvedFile);
  if (buffer.includes(0)) throw new Error('文件包含二进制内容，无法按 TXT 安全编辑');
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('文件不是有效的 UTF-8 文本，无法安全编辑');
  }
  return { content, fingerprint: fingerprint(buffer, stat) };
}

async function saveText({ filePath, libraryPath, item, content, base, backupRoot, force = false, maxBytes = DEFAULT_MAX_BYTES }) {
  const resolvedFile = validateTextPath({ filePath, libraryPath, item });
  if (typeof content !== 'string') throw new Error('TXT 内容无效');
  const output = Buffer.from(content, 'utf8');
  if (output.length > maxBytes) throw new Error(`保存内容超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);

  const current = await readText({ filePath: resolvedFile, libraryPath, item, maxBytes });
  if (!force && !sameFingerprint(base, current.fingerprint)) {
    return { conflict: true, current };
  }

  const originalStat = await fs.stat(resolvedFile);
  const libraryKey = crypto.createHash('sha256').update(path.resolve(libraryPath)).digest('hex').slice(0, 16);
  const backupDir = path.join(backupRoot, libraryKey, String(item.id));
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${stamp}-${path.basename(resolvedFile)}`);
  await fs.copyFile(resolvedFile, backupPath);

  const tempPath = path.join(path.dirname(resolvedFile), `.${path.basename(resolvedFile)}.eaglemv-${process.pid}-${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tempPath, 'wx', originalStat.mode);
    await handle.writeFile(output);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, resolvedFile);
  } catch (error) {
    try { await handle?.close(); } catch {}
    try { await fs.unlink(tempPath); } catch {}
    throw error;
  }

  const stat = await fs.stat(resolvedFile);
  return { conflict: false, fingerprint: fingerprint(output, stat), backupPath };
}

module.exports = { readText, saveText, sameFingerprint, validateTextPath, DEFAULT_MAX_BYTES };
