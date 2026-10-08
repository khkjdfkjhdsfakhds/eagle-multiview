'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { extractPayload, decodePayload } = require('../src/stealth-metadata');

function imageWithPayload(magic, payload, bits = payload.length * 8) {
  const width = 128, height = 128, data = new Uint8ClampedArray(width * height * 4).fill(255);
  const length = Buffer.alloc(4); length.writeUInt32BE(bits);
  const bytes = Buffer.concat([Buffer.from(magic), length, payload]);
  bytes.forEach((value, index) => { for (let bit = 0; bit < 8; bit++) {
    const cursor = index * 8 + bit;
    data[((cursor % height) * width + Math.floor(cursor / height)) * 4 + 3] = 254 | ((value >> (7 - bit)) & 1);
  } });
  return { data, width, height };
}

test('stealth alpha reads column-major bytes and compressed/uncompressed UTF-8', async () => {
  const json = JSON.stringify({ Description: '中文提示词 🌅' });
  for (const compressed of [false, true]) {
    const bytes = compressed ? zlib.gzipSync(Buffer.from(json)) : Buffer.from(json);
    const payload = extractPayload(imageWithPayload(compressed ? 'stealth_pngcomp' : 'stealth_pnginfo', bytes));
    assert.equal(await decodePayload(payload), json);
  }
});

test('invalid stealth signatures, lengths and images cannot trigger oversized reads', () => {
  for (const bits of [0, 7, 0xffffffff]) assert.equal(extractPayload(imageWithPayload('stealth_pngcomp', Buffer.alloc(1), bits)), null);
  assert.equal(extractPayload(imageWithPayload('ordinary pixels', Buffer.alloc(1))), null);
  assert.equal(extractPayload({ width: 1, height: 1, data: new Uint8Array(4) }), null);
  assert.equal(extractPayload({ width: 100000, height: 100000, data: new Uint8Array(4) }), null);
});

test('corrupted gzip fails safely and inflated metadata has a bounded size', async () => {
  await assert.rejects(decodePayload({ compressed: true, bytes: new Uint8Array([1, 2, 3]) }));
  assert.equal(await decodePayload({ compressed: true, bytes: zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024 + 1)) }), null);
});
