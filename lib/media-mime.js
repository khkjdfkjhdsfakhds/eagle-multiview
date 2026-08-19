'use strict';

// MIME types for the eaglemv:// media protocol. Chromium's PDF viewer and
// stricter fetch paths (ORB/CORS) need a real Content-Type; file:// responses
// from net.fetch ship without one.
const mimeByExtension = Object.freeze({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'application/json', html: 'text/html; charset=utf-8'
});

function mimeForPath(filePath) {
  const ext = String(filePath || '').split('.').pop().toLowerCase();
  return mimeByExtension[ext] || '';
}

module.exports = { mimeForPath, mimeByExtension };
