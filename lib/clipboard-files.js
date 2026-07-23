'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');

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

module.exports = { clipboardFilePaths, defaultPropertyListParser };
