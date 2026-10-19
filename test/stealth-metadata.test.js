'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { readHeader, extractPayload, decodePayload } = require('../src/stealth-metadata');

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

// SD WebUI/Forge RGB mode chains the R, G and B bits of each pixel down the columns.
function rgbImageWithPayload(magic, payload, { width = 64, height = 48, stride = 4 } = {}) {
  const data = new Uint8ClampedArray(width * height * stride).fill(255);
  const length = Buffer.alloc(4); length.writeUInt32BE(payload.length * 8);
  const bytes = Buffer.concat([Buffer.from(magic), length, payload]);
  bytes.forEach((value, index) => { for (let bit = 0; bit < 8; bit++) {
    const cursor = index * 8 + bit, pixel = Math.floor(cursor / 3);
    const offset = ((pixel % height) * width + Math.floor(pixel / height)) * stride + cursor % 3;
    data[offset] = 254 | ((value >> (7 - bit)) & 1);
  } });
  return { data, width, height, stride };
}

test('stealth RGB mode reads SD WebUI payloads from RGBA and RGB pixels', async () => {
  const text = 'castle\nNegative prompt: blurry\nSteps: 20, Sampler: Euler a, Seed: 7';
  for (const stride of [4, 3]) for (const compressed of [false, true]) {
    const bytes = compressed ? zlib.gzipSync(Buffer.from(text)) : Buffer.from(text);
    const payload = extractPayload(rgbImageWithPayload(compressed ? 'stealth_rgbcomp' : 'stealth_rgbinfo', bytes, { stride }));
    assert.equal(await decodePayload(payload), text);
  }
  assert.equal(extractPayload(rgbImageWithPayload('ordinary_pixels', Buffer.from(text))), null);
});

test('the payload can be read from only the leftmost columns of a wide image', async () => {
  const json = JSON.stringify({ Description: 'strip' });
  const full = imageWithPayload('stealth_pnginfo', Buffer.from(json));
  const header = readHeader(full);
  assert.ok(header && header.pixelsNeeded < full.width * full.height);
  const columns = Math.ceil(header.pixelsNeeded / full.height);
  const strip = { width: columns, height: full.height, data: new Uint8ClampedArray(columns * full.height * 4) };
  for (let y = 0; y < full.height; y++) strip.data.set(full.data.subarray(y * full.width * 4, (y * full.width + columns) * 4), y * columns * 4);
  assert.equal(await decodePayload(extractPayload(strip, full.width)), json);
  // A strip too narrow for the payload is refused rather than read past its end.
  const narrow = { width: 2, height: full.height, data: strip.data.slice(0, 2 * full.height * 4) };
  for (let y = 0; y < full.height; y++) narrow.data.set(strip.data.subarray(y * columns * 4, y * columns * 4 + 8), y * 8);
  assert.ok(readHeader(narrow, full.width));
  assert.equal(extractPayload(narrow, full.width), null);
});

test('stealth text parses as NovelAI or SD parameters and object values stay readable', () => {
  const { parseStealthText } = require('../src/novelai-metadata');
  const sd = parseStealthText('castle <lora:detail:0.5>\nNegative prompt: blurry\nSteps: 20, Sampler: Euler a');
  assert.equal(sd.format, 'Automatic1111 / FORGE');
  assert.equal(sd.negative, 'blurry');
  assert.deepEqual(sd.loras, [{ name: 'detail', weight: 0.5 }]);
  const nai = parseStealthText(JSON.stringify({ Software: 'NovelAI', Description: 'p', Comment: JSON.stringify({ uc: 'n', steps: 28, seed: 1, sampler: { name: 'k_euler', smea: true } }) }));
  assert.equal(nai.params.Sampler, '{"name":"k_euler","smea":true}');
  assert.equal(parseStealthText('just words'), null);
});
