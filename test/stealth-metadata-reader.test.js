'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { extractPayload, decodePayload, parseStealthMetadataBitmap } = require('../lib/stealth-metadata-reader');

function bitmapWithPayload(bundle, compressed = true) {
  const width = 128;
  const height = 128;
  const data = new Uint8Array(width * height * 4).fill(255);
  const payload = Buffer.from(JSON.stringify(bundle));
  const bytes = compressed ? zlib.gzipSync(payload) : payload;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length * 8);
  const encoded = Buffer.concat([Buffer.from(compressed ? 'stealth_pngcomp' : 'stealth_pnginfo'), length, bytes]);
  encoded.forEach((value, index) => {
    for (let bit = 0; bit < 8; bit += 1) {
      const cursor = index * 8 + bit;
      const x = Math.floor(cursor / height);
      const y = cursor % height;
      data[(y * width + x) * 4 + 3] = 254 | ((value >> (7 - bit)) & 1);
    }
  });
  return { data, width, height };
}

test('reads NovelAI alpha-embedded metadata from decoded RGBA pixels', () => {
  const bundle = {
    Software: 'NovelAI',
    Description: '0.6::artist:nyong nyong ::',
    Comment: JSON.stringify({ uc: 'lowres', steps: 28, seed: 42 })
  };
  const metadata = parseStealthMetadataBitmap(bitmapWithPayload(bundle));
  assert.equal(metadata.format, 'NovelAI');
  assert.equal(metadata.positive, bundle.Description);
  assert.equal(metadata.negative, 'lowres');
});

test('rejects invalid alpha payloads safely', () => {
  assert.equal(extractPayload(null), null);
  assert.equal(decodePayload(null), null);
  assert.equal(parseStealthMetadataBitmap({ width: 1, height: 1, data: new Uint8Array(4) }), null);
});

test('reads SD WebUI RGB-mode parameters from an RGB PAM decode', () => {
  const { parsePam } = require('../lib/stealth-metadata-reader');
  const width = 32, height = 32;
  const text = 'tower\nNegative prompt: lowres\nSteps: 30, Sampler: DPM++ 2M, Seed: 9';
  const length = Buffer.alloc(4); length.writeUInt32BE(Buffer.byteLength(text) * 8);
  const encoded = Buffer.concat([Buffer.from('stealth_rgbinfo'), length, Buffer.from(text)]);
  const pixels = Buffer.alloc(width * height * 3, 255);
  encoded.forEach((value, index) => {
    for (let bit = 0; bit < 8; bit += 1) {
      const cursor = index * 8 + bit, pixel = Math.floor(cursor / 3);
      pixels[((pixel % height) * width + Math.floor(pixel / height)) * 3 + cursor % 3] = 254 | ((value >> (7 - bit)) & 1);
    }
  });
  const pam = Buffer.concat([Buffer.from(`P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH 3\nMAXVAL 255\nTUPLTYPE RGB\nENDHDR\n`), pixels]);
  const metadata = parseStealthMetadataBitmap(parsePam(pam));
  assert.equal(metadata.format, 'Automatic1111 / FORGE');
  assert.equal(metadata.positive, 'tower');
  assert.equal(metadata.negative, 'lowres');
  assert.equal(metadata.params.Seed, '9');
});

// Builds a minimal PNG (8-bit RGBA or RGB) from raw pixels.
function encodePng(width, height, channels, pixels) {
  const crcTable = buf => zlib.crc32(buf);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crcTable(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = channels === 4 ? 6 : 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) rows.push(Buffer.from([0]), pixels.subarray(y * width * channels, (y + 1) * width * channels));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('ImageMagick reads files whose names look like patterns or frame selectors (E-03)', async t => {
  const { readStealthMetadata, findDecoder } = require('../lib/stealth-metadata-reader');
  if (!(await findDecoder('png'))) return t.skip('ImageMagick is not installed');
  const fsSync = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'eaglemv-magick-name-'));
  t.after(() => fsSync.rmSync(dir, { recursive: true, force: true }));
  const width = 64, height = 64;
  // NovelAI alpha mode in an RGBA PNG.
  const bundle = { Software: 'NovelAI', Description: 'named prompt', Comment: JSON.stringify({ uc: 'n', steps: 28, seed: 1 }) };
  const payload = Buffer.from(JSON.stringify(bundle));
  const alphaLength = Buffer.alloc(4); alphaLength.writeUInt32BE(payload.length * 8);
  const alphaEncoded = Buffer.concat([Buffer.from('stealth_pnginfo'), alphaLength, payload]);
  const rgbaPixels = Buffer.alloc(width * height * 4, 255);
  alphaEncoded.forEach((value, index) => {
    for (let bit = 0; bit < 8; bit += 1) {
      const cursor = index * 8 + bit;
      rgbaPixels[((cursor % height) * width + Math.floor(cursor / height)) * 4 + 3] = 254 | ((value >> (7 - bit)) & 1);
    }
  });
  const alphaFile = path.join(dir, 'shot %d [1] *.png');
  fsSync.writeFileSync(alphaFile, encodePng(width, height, 4, rgbaPixels));
  assert.equal((await readStealthMetadata(alphaFile, 'png'))?.positive, 'named prompt');
  // SD WebUI RGB mode in an RGB PNG.
  const text = 'rgb prompt\nNegative prompt: bad\nSteps: 20, Seed: 3';
  const length = Buffer.alloc(4); length.writeUInt32BE(Buffer.byteLength(text) * 8);
  const encoded = Buffer.concat([Buffer.from('stealth_rgbinfo'), length, Buffer.from(text)]);
  const rgbPixels = Buffer.alloc(width * height * 3, 255);
  encoded.forEach((value, index) => {
    for (let bit = 0; bit < 8; bit += 1) {
      const cursor = index * 8 + bit, pixel = Math.floor(cursor / 3);
      rgbPixels[((pixel % height) * width + Math.floor(pixel / height)) * 3 + cursor % 3] = 254 | ((value >> (7 - bit)) & 1);
    }
  });
  const rgbFile = path.join(dir, 'png:rgb%03d.png');
  fsSync.writeFileSync(rgbFile, encodePng(width, height, 3, rgbPixels));
  const sd = await readStealthMetadata(rgbFile, 'png');
  assert.equal(sd?.format, 'Automatic1111 / FORGE');
  assert.equal(sd.positive, 'rgb prompt');
});
