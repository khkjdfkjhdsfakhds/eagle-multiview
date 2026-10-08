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
