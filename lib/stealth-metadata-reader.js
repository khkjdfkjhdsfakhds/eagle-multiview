'use strict';

const fs = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');
const zlib = require('node:zlib');
const { parseStealthText } = require('../src/novelai-metadata');
const { extractPayload: sharedExtractPayload } = require('../src/stealth-metadata');

const MAX_PIXELS = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_PAM_BYTES = MAX_PIXELS * 4 + 1024;
const DWEBP_CANDIDATES = [
  process.env.EAGLEMV_DWEBP,
  '/opt/homebrew/bin/dwebp',
  '/usr/local/bin/dwebp',
  'dwebp'
].filter(Boolean);
const MAGICK_CANDIDATES = [
  process.env.EAGLEMV_MAGICK,
  '/opt/homebrew/bin/magick',
  '/usr/local/bin/magick',
  'magick'
].filter(Boolean);
const decoderPathPromises = new Map();

// The bit layout is shared with the renderer, which reads the same payloads.
function extractPayload(bitmap) {
  const payload = sharedExtractPayload(bitmap);
  return payload && { compressed: payload.compressed, bytes: Buffer.from(payload.bytes.buffer, payload.bytes.byteOffset, payload.bytes.length) };
}

function decodePayload(payload) {
  if (!payload) return null;
  try {
    const bytes = payload.compressed ? zlib.gunzipSync(payload.bytes, { maxOutputLength: MAX_JSON_BYTES }) : payload.bytes;
    if (bytes.length > MAX_JSON_BYTES) return null;
    return bytes.toString('utf8');
  } catch {
    return null;
  }
}

function parseStealthMetadataBitmap(bitmap) {
  return parseStealthText(decodePayload(extractPayload(bitmap)));
}

function parsePam(buffer) {
  const marker = Buffer.from('ENDHDR\n');
  const headerEnd = buffer.indexOf(marker);
  if (headerEnd < 0) return null;
  const header = buffer.subarray(0, headerEnd).toString('ascii');
  const width = Number(header.match(/(?:^|\n)WIDTH (\d+)/)?.[1]);
  const height = Number(header.match(/(?:^|\n)HEIGHT (\d+)/)?.[1]);
  const depth = Number(header.match(/(?:^|\n)DEPTH (\d+)/)?.[1]);
  // Images without alpha decode to RGB, which can still carry an RGB-mode payload.
  if (!width || !height || (depth !== 4 && depth !== 3) || width * height > MAX_PIXELS) return null;
  const data = buffer.subarray(headerEnd + marker.length);
  if (data.length !== width * height * depth) return null;
  return { data, width, height, stride: depth };
}

async function findDecoder(kind) {
  if (decoderPathPromises.has(kind)) return decoderPathPromises.get(kind);
  const candidates = kind === 'webp' ? DWEBP_CANDIDATES : MAGICK_CANDIDATES;
  const promise = (async () => {
    for (const candidate of candidates) {
      if (candidate.includes('/')) {
        try { await fs.access(candidate); return candidate; } catch { continue; }
      }
      try {
        await new Promise((resolve, reject) => execFile(candidate, ['-version'], { timeout: 2000 }, error => error ? reject(error) : resolve()));
        return candidate;
      } catch {}
    }
    return null;
  })();
  decoderPathPromises.set(kind, promise);
  return promise;
}

const DECODE_TIMEOUT_MS = 20000;

function decodeToPam(decoder, kind, filePath, { timeoutMs = DECODE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    // ImageMagick reads a trailing [n] as a frame selector and a leading
    // "name:" as a format, so the format and frame are always spelled out.
    const args = kind === 'webp' && /(?:^|\/)dwebp$/.test(decoder)
      ? [filePath, '-pam', '-quiet', '-o', '-']
      : [`${kind}:${filePath}[0]`, '-depth', '8', 'PAM:-'];
    const child = spawn(decoder, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // A hung decoder must not hold an index worker forever.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('image decoder timed out'));
    }, timeoutMs);
    child.once('close', () => clearTimeout(timer));
    const chunks = [];
    let size = 0;
    let stderr = '';
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_PAM_BYTES) {
        child.kill();
        reject(new Error('Decoded image is too large'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(stderr || `image decoder exited with ${code}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

async function readStealthMetadata(filePath, ext = '') {
  const kind = String(ext).toLowerCase();
  if (!['png', 'webp'].includes(kind) || !filePath) return null;
  const decoder = await findDecoder(kind);
  // A Homebrew libwebp install is the fastest WebP path. ImageMagick is a
  // portable fallback for WebP and the decoder used for PNG alpha payloads.
  const selectedDecoder = decoder || (kind === 'webp' ? await findDecoder('png') : null);
  const selectedKind = decoder ? kind : 'png';
  if (!selectedDecoder) return null;
  try {
    const pam = await decodeToPam(selectedDecoder, selectedKind, filePath);
    return parseStealthMetadataBitmap(parsePam(pam));
  } catch {
    return null;
  }
}

module.exports = {
  decodeToPam, extractPayload, decodePayload, parsePam, parseStealthMetadataBitmap, readStealthMetadata };
