'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fileURLToPath, pathToFileURL } = require('node:url');

function escapeXML(value) {
  return String(value).replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
}

function fileListPropertyList(paths) {
  const entries = paths.map(filePath => `    <string>${escapeXML(filePath)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
${entries}
</array>
</plist>`;
}

function macImagePasteboardType(filePath) {
  return ({ '.bmp': 'public.jpeg', '.jpg': 'public.jpeg', '.jpeg': 'public.jpeg', '.png': 'public.png' })[path.extname(filePath).toLowerCase()] || null;
}

function finalizeMacImageClipboard(filePath, scriptPath, {
  platform = process.platform,
  existsSync = fs.existsSync,
  runScript = spawnSync
} = {}) {
  const pasteboardType = macImagePasteboardType(filePath);
  if (platform !== 'darwin' || !pasteboardType) return { handled: false, ok: true };
  if (!scriptPath || !existsSync(scriptPath)) {
    return { handled: true, ok: false, message: '缺少 macOS 文件剪贴板组件' };
  }
  const result = runScript('/usr/bin/osascript', [scriptPath, filePath, pasteboardType, fileListPropertyList([filePath])], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '').trim();
    return { handled: true, ok: false, message: detail || 'macOS 无法写入文件剪贴板' };
  }
  return { handled: true, ok: true };
}

function writeClipboardFilePaths(clipboard, filePaths, {
  platform = process.platform,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync
} = {}) {
  const paths = [...new Set(filePaths || [])].filter(filePath => path.isAbsolute(filePath) && existsSync(filePath));
  if (!paths.length) return [];
  clipboard.clear();
  if (platform !== 'darwin') {
    clipboard.writeText(paths.join('\n'));
    return paths;
  }

  if (paths.length === 1) {
    clipboard.writeBuffer('public.file-url', Buffer.from(pathToFileURL(paths[0]).href));
  }
  clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(fileListPropertyList(paths)));

  if (paths.length === 1) {
    const imageType = ({ '.jpg': 'public.jpeg', '.jpeg': 'public.jpeg', '.png': 'public.png' })[path.extname(paths[0]).toLowerCase()];
    if (imageType) {
      try {
        const image = readFileSync(paths[0]);
        if (image.length) clipboard.writeBuffer(imageType, image);
      } catch {}
    }
  }
  return paths;
}

function defaultPropertyListParser(buffer) {
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: buffer,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0) return [];
  const values = JSON.parse(result.stdout.toString('utf8'));
  return Array.isArray(values) ? values : [];
}

function clipboardFilePaths(clipboard, {
  platform = process.platform,
  existsSync = fs.existsSync,
  parsePropertyList = defaultPropertyListParser
} = {}) {
  const candidates = [];
  const addText = value => {
    for (const raw of String(value || '').split(/[\r\n]+/)) {
      const entry = raw.trim();
      if (!entry || entry.startsWith('#')) continue;
      try {
        if (entry.startsWith('file:')) candidates.push(fileURLToPath(entry));
        else if (path.isAbsolute(entry)) candidates.push(entry);
      } catch {}
    }
  };

  for (const format of ['public.file-url', 'text/uri-list']) {
    try { addText(clipboard.read(format)); } catch {}
  }
  try { addText(clipboard.readText()); } catch {}

  if (platform === 'darwin' && clipboard.availableFormats().includes('NSFilenamesPboardType')) {
    try {
      for (const value of parsePropertyList(clipboard.readBuffer('NSFilenamesPboardType'))) {
        if (path.isAbsolute(value)) candidates.push(value);
      }
    } catch {}
  }
  return [...new Set(candidates)].filter(candidate => existsSync(candidate));
}

module.exports = {
  clipboardFilePaths,
  defaultPropertyListParser,
  fileListPropertyList,
  finalizeMacImageClipboard,
  macImagePasteboardType,
  writeClipboardFilePaths
};
