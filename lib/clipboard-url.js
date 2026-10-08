'use strict';

function normalizeClipboardURL(value) {
  const text = String(value || '').trim();
  if (!text || /[\r\n]/.test(text)) return null;
  let parsed;
  try { parsed = new URL(text); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  return parsed.toString();
}

function clipboardURLKind(contentType) {
  const type = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  return type.startsWith('image/') ? 'image' : 'bookmark';
}

module.exports = { normalizeClipboardURL, clipboardURLKind };
