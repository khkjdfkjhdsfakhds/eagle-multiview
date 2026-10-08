'use strict';

const fs = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');
const zlib = require('node:zlib');
const { parseNovelAIExif } = require('../src/novelai-metadata');

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

function extractPayload(bitmap = {}) {
  const { data, width, height } = bitmap || {};
  const pixels = Number(width) * Number(height);
  if (!data || !Number.isInteger(pixels) || !width || !height || pixels < 152 || pixels > MAX_PIXELS || data.length !== pixels * 4) return null;
  let cursor = 0;
  const byte = () => {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1, cursor += 1) {
      const x = Math.floor(cursor / height);
      const y = cursor % height;
      value = value * 2 + (data[(y * width + x) * 4 + 3] & 1);
    }
    return value;
  };
  let magic = '';
  for (let index = 0; index < 15; index += 1) magic += String.fromCharCode(byte());
  if (magic !== 'stealth_pngcomp' && magic !== 'stealth_pnginfo') return null;
  const bitLength = byte() * 0x1000000 + byte() * 0x10000 + byte() * 0x100 + byte();
  if (!bitLength || bitLength % 8 || bitLength > pixels - cursor || bitLength > MAX_JSON_BYTES * 8) return null;
  const bytes = Buffer.allocUnsafe(bitLength / 8);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = byte();
  return { compressed: magic === 'stealth_pngcomp', bytes };
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
  return parseNovelAIExif(decodePayload(extractPayload(bitmap)));
}

function parsePam(buffer) {
  const marker = Buffer.from('ENDHDR\n');
  const headerEnd = buffer.indexOf(marker);
  if (headerEnd < 0) return null;
  const header = buffer.subarray(0, headerEnd).toString('ascii');
  const width = Number(header.match(/(?:^|\n)WIDTH (\d+)/)?.[1]);
  const height = Number(header.match(/(?:^|\n)HEIGHT (\d+)/)?.[1]);
  const depth = Number(header.match(/(?:^|\n)DEPTH (\d+)/)?.[1]);
  if (!width || !height || depth !== 4 || width * height > MAX_PIXELS) return null;
  const data = buffer.subarray(headerEnd + marker.length);
  if (data.length !== width * height * 4) return null;
  return { data, width, height };
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

function decodeToPam(decoder, kind, filePath) {
  return new Promise((resolve, reject) => {
    const args = kind === 'webp' && /(?:^|\/)dwebp$/.test(decoder)
      ? [filePath, '-pam', '-quiet', '-o', '-']
      : [filePath, '-depth', '8', 'PAM:-'];
    const child = spawn(decoder, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

module.exports = { extractPayload, decodePayload, parsePam, parseStealthMetadataBitmap, readStealthMetadata };
