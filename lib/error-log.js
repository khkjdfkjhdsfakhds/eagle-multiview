'use strict';

const defaultFs = require('node:fs/promises');
const path = require('node:path');

const LEVELS = new Set(['error', 'warn', 'info']);
const MESSAGE_LIMIT = 4000;
const DETAIL_LIMIT = 8000;
const SOURCE_LIMIT = 64;

function clampText(value, limit) {
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…（已截断）` : text;
}

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (typeof value === 'object') {
    if (typeof value.stack === 'string' && value.stack) return value.stack;
    if (typeof value.message === 'string' && value.message) return value.message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function localTimestamp(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function createErrorLog({
  file,
  maxBytes = 512 * 1024,
  maxFiles = 3,
  repeatWindowMs = 5000,
  maxEntries = 1000,
  fs = defaultFs,
  now = () => new Date()
} = {}) {
  if (!file) throw new Error('createErrorLog 需要 file 路径');
  let queue = Promise.resolve();
  let lastKey = null;
  let lastTime = 0;
  let repeatCount = 0;
  let written = 0;
  let capNoted = false;

  const rotatedName = index => `${file}.${index}`;

  async function rotate() {
    await fs.unlink(rotatedName(maxFiles - 1)).catch(() => {});
    for (let index = maxFiles - 2; index >= 1; index -= 1) {
      await fs.rename(rotatedName(index), rotatedName(index + 1)).catch(() => {});
    }
    await fs.rename(file, rotatedName(1)).catch(() => {});
  }

  async function append(text) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const size = await fs.stat(file).then(info => info.size, () => 0);
    if (size > 0 && size + Buffer.byteLength(text, 'utf8') > maxBytes) await rotate();
    await fs.appendFile(file, text, 'utf8');
  }

  function formatEntry(entry, time) {
    const level = LEVELS.has(entry?.level) ? entry.level : 'error';
    const source = clampText(asText(entry?.source) || 'main', SOURCE_LIMIT);
    const message = clampText(asText(entry?.message) || '（无消息）', MESSAGE_LIMIT).replace(/\s*\n\s*/g, ' ');
    const detail = clampText(asText(entry?.detail), DETAIL_LIMIT);
    let text = `[${localTimestamp(time)}] [${level}] [${source}] ${message}\n`;
    if (detail && detail !== message) {
      text += detail.split('\n').map(line => `    ${line}`).join('\n') + '\n';
    }
    return { text, key: `${source}|${message}` };
  }

  function write(entry) {
    const time = now();
    const job = queue.then(async () => {
      if (written >= maxEntries) {
        if (!capNoted) {
          capNoted = true;
          await append(`[${localTimestamp(time)}] [warn] [log] 本次运行日志条数已达上限 ${maxEntries}，后续错误不再落盘\n`);
        }
        return;
      }
      const { text, key } = formatEntry(entry, time);
      const elapsed = time.getTime() - lastTime;
      if (key === lastKey && elapsed >= 0 && elapsed < repeatWindowMs) {
        repeatCount += 1;
        lastTime = time.getTime();
        return;
      }
      let prefix = '';
      if (repeatCount > 0) {
        prefix = `[${localTimestamp(time)}] [info] [log] 上一条日志在短时间内重复出现 ${repeatCount} 次\n`;
        repeatCount = 0;
      }
      lastKey = key;
      lastTime = time.getTime();
      written += 1;
      await append(prefix + text);
    }).catch(() => {});
    queue = job;
    return job;
  }

  return { file, write };
}

module.exports = { createErrorLog };
