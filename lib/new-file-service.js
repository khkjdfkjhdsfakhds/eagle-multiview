'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');

const NEW_FILE_TYPES = Object.freeze({
  txt: { label: 'TXT', defaultName: '未命名文本', content: '' },
  // Eagle 4.0 ignores zero-byte Markdown and deduplicates byte-identical blank
  // Markdown files. Its payload is generated per creation below so repeated
  // blank documents remain visually empty while retaining distinct bytes.
  md: { label: 'Markdown', defaultName: '未命名文档', content: null },
  json: { label: 'JSON', defaultName: '未命名数据', content: '{}\n' },
  html: {
    label: 'HTML',
    defaultName: '未命名网页',
    content: '<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8">\n  <title></title>\n</head>\n<body>\n</body>\n</html>\n'
  },
  svg: {
    label: 'SVG',
    defaultName: '未命名图形',
    content: '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">\n</svg>\n'
  }
});

function normalizeNewFileType(type) {
  const normalized = String(type || '').trim().toLowerCase().replace(/^\./, '');
  if (!NEW_FILE_TYPES[normalized]) throw new Error('不支持的新建文件类型');
  return normalized;
}

// Eagle folders are logical metadata nodes, not directories on the local
// filesystem. Eagle therefore preserves characters such as /, \\, :, and | in
// folder names even though those characters are unsafe in imported filenames.
function normalizeEagleFolderName(value) {
  const name = String(value || '').trim();
  if (!name) throw new Error('名称不能为空');
  if (name.length > 1024) throw new Error('名称不能超过 1024 个字符');
  return name;
}

function validateNewItemName(value, { extension = '' } = {}) {
  let name = String(value || '').trim();
  if (!name) throw new Error('名称不能为空');
  if (name.length > 240) throw new Error('名称不能超过 240 个字符');
  if (/[\u0000-\u001f<>:"/\\|?*]/.test(name)) throw new Error('名称不能包含 \\ / : * ? " < > | 或控制字符');
  if (/[. ]$/.test(name)) throw new Error('名称不能以空格或句点结尾');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('这个名称是系统保留名称，请换一个名称');
  const ext = String(extension || '').toLowerCase().replace(/^\./, '');
  if (ext && name.toLowerCase().endsWith(`.${ext}`)) name = name.slice(0, -(ext.length + 1)).trim();
  if (!name) throw new Error('名称不能为空');
  return name;
}

function nextAvailableName(requestedName, existingItems = [], extension = '') {
  const ext = String(extension || '').toLowerCase().replace(/^\./, '');
  const occupied = new Set((existingItems || []).filter(item => {
    return !ext || String(item?.ext || '').toLowerCase().replace(/^\./, '') === ext;
  }).map(item => String(item?.name || item || '').trim().toLocaleLowerCase('zh-CN')));
  if (!occupied.has(requestedName.toLocaleLowerCase('zh-CN'))) return requestedName;
  let index = 1;
  while (occupied.has(`${requestedName} (${index})`.toLocaleLowerCase('zh-CN'))) index += 1;
  return `${requestedName} (${index})`;
}

function newFileContent(type, randomBytes = crypto.randomBytes) {
  const normalizedType = normalizeNewFileType(type);
  if (normalizedType !== 'md') return NEW_FILE_TYPES[normalizedType].content;
  const nonce = randomBytes(8);
  let invisibleNonce = '';
  for (const byte of nonce) {
    for (let bit = 7; bit >= 0; bit -= 1) invisibleNonce += byte & (1 << bit) ? '\t' : ' ';
  }
  return `\uFEFF${invisibleNonce}\n`;
}

async function createTemporaryNewFile({ root, name, type, fileSystem = fs, randomBytes = crypto.randomBytes }) {
  const normalizedType = normalizeNewFileType(type);
  const normalizedName = validateNewItemName(name, { extension: normalizedType });
  const base = path.resolve(root);
  await fileSystem.mkdir(base, { recursive: true });
  const directory = await fileSystem.mkdtemp(path.join(base, 'create-'));
  const filePath = path.join(directory, `${normalizedName}.${normalizedType}`);
  try {
    await fileSystem.writeFile(filePath, newFileContent(normalizedType, randomBytes), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    await fileSystem.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  let cleaned = false;
  return {
    type: normalizedType,
    name: normalizedName,
    filePath,
    directory,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await fileSystem.rm(directory, { recursive: true, force: true });
    }
  };
}

module.exports = {
  NEW_FILE_TYPES,
  normalizeNewFileType,
  normalizeEagleFolderName,
  validateNewItemName,
  nextAvailableName,
  newFileContent,
  createTemporaryNewFile
};
