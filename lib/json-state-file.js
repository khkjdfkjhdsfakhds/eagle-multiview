'use strict';

// Shared reading/writing for MultiView's small JSON state files (manual
// order, folder covers, pins, supplemental items) — S-02.
//
// - A file that does not parse (an empty file after a power cut, a torn
//   write) is set aside as `<name>.corrupt-<time>` and the store starts
//   empty, instead of failing every later read until someone deletes it.
// - A file written by a newer MultiView (an unknown `version`) is left alone:
//   reading it throws, so nothing overwrites data this build cannot read.
// - Writes go to a temporary file that is flushed to disk before the rename.

const fs = require('node:fs/promises');

class NewerStateVersionError extends Error {
  constructor(label) {
    super(`${label}由更新版本的 MultiView 写入，为免覆盖已停止读取；请升级 MultiView`);
    this.code = 'STATE_VERSION_NEWER';
  }
}

async function readStateFile(filePath, { label = '状态文件', isValid, empty, log = console.error } = {}) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return empty();
    throw error;
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (parsed && typeof parsed === 'object' && Number.isFinite(parsed.version) && parsed.version > 1) {
    throw new NewerStateVersionError(label);
  }
  if (parsed && isValid(parsed)) return parsed;
  const aside = `${filePath}.corrupt-${Date.now()}`;
  await fs.rename(filePath, aside).catch(() => {});
  log(`[main] ${label}已损坏，已另存为 ${aside} 并从空状态继续`);
  return empty();
}

async function writeStateFile(filePath, content, { mode } = {}) {
  const handle = await fs.open(filePath, 'w', mode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

module.exports = { readStateFile, writeStateFile, NewerStateVersionError };
