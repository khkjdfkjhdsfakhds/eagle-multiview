'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { readMetadataBuffer, readPngChunks, parseA1111 } = require('../lib/metadata-reader');

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, typeBuffer, data, Buffer.alloc(4)]);
}

function pngWithText(chunks) {
  const encoded = chunks.map(({ type = 'tEXt', key, value }) => {
    if (type === 'zTXt') return pngChunk(type, Buffer.concat([Buffer.from(`${key}\0\0`, 'latin1'), zlib.deflateSync(Buffer.from(value))]));
    return pngChunk(type, Buffer.concat([Buffer.from(`${key}\0`, 'latin1'), Buffer.from(value)]));
  });
  return Buffer.concat([PNG_SIGNATURE, ...encoded, pngChunk('IEND', Buffer.alloc(0))]);
}

function tiffWithExifComment(comment, byteOrder = 'II') {
  const raw = Buffer.concat([Buffer.from('ASCII\0\0\0', 'ascii'), Buffer.from(comment), Buffer.from([0])]);
  const tiff = Buffer.alloc(44 + raw.length);
  const write16 = byteOrder === 'II' ? tiff.writeUInt16LE.bind(tiff) : tiff.writeUInt16BE.bind(tiff);
  const write32 = byteOrder === 'II' ? tiff.writeUInt32LE.bind(tiff) : tiff.writeUInt32BE.bind(tiff);
  tiff.write(byteOrder, 0, 'ascii');
  write16(42, 2);
  write32(8, 4);
  write16(1, 8);
  write16(0x8769, 10);
  write16(4, 12);
  write32(1, 14);
  write32(26, 18);
  write32(0, 22);
  write16(1, 26);
  write16(0x9286, 28);
  write16(7, 30);
  write32(raw.length, 32);
  write32(44, 36);
  write32(0, 40);
  raw.copy(tiff, 44);
  return tiff;
}

function jpegWithExifComment(comment) {
  const tiff = tiffWithExifComment(comment);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const size = Buffer.alloc(2);
  size.writeUInt16BE(exif.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), size, exif, Buffer.from([0xff, 0xd9])]);
}

function webpWithExifComment(comment) {
  const tiff = tiffWithExifComment(comment, 'MM');
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(tiff.length);
  const padding = tiff.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  const body = Buffer.concat([Buffer.from('WEBPEXIF', 'ascii'), chunkSize, tiff, padding]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, body]);
}

test('parses Automatic1111 prompts, parameters, and LoRA tokens', () => {
  const metadata = parseA1111('portrait <lora:detail:0.75>\nNegative prompt: blurry\nSteps: 28, Sampler: Euler a, CFG scale: 7, Seed: 42');
  assert.equal(metadata.format, 'Automatic1111 / FORGE');
  assert.equal(metadata.positive, 'portrait <lora:detail:0.75>');
  assert.equal(metadata.negative, 'blurry');
  assert.equal(metadata.params.Seed, '42');
  assert.deepEqual(metadata.loras, [{ name: 'detail', weight: 0.75 }]);
});

test('reads compressed PNG text and parses NovelAI metadata', () => {
  const buffer = pngWithText([
    { key: 'Description', value: 'masterpiece, 1girl' },
    { type: 'zTXt', key: 'Comment', value: JSON.stringify({ uc: 'lowres', steps: 28, scale: 5, seed: 123, sampler: 'k_euler' }) }
  ]);
  assert.equal(JSON.parse(readPngChunks(buffer).Comment).seed, 123);
  const metadata = readMetadataBuffer(buffer, 'png');
  assert.equal(metadata.format, 'NovelAI');
  assert.equal(metadata.positive, 'masterpiece, 1girl');
  assert.equal(metadata.negative, 'lowres');
  assert.equal(metadata.params.Sampler, 'k_euler');
});

test('parses ComfyUI prompt graph', () => {
  const prompt = {
    1: { class_type: 'CLIPTextEncode', inputs: { text: 'sunset city' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry' } },
    3: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
    4: { class_type: 'KSampler', inputs: { positive: ['1', 0], negative: ['2', 0], steps: 20, cfg: 7, seed: 99, sampler_name: 'euler' } }
  };
  const buffer = pngWithText([{ key: 'prompt', value: JSON.stringify(prompt) }, { key: 'workflow', value: JSON.stringify({ nodes: [] }) }]);
  const metadata = readMetadataBuffer(buffer, 'png');
  assert.equal(metadata.format, 'ComfyUI');
  assert.equal(metadata.positive, 'sunset city');
  assert.equal(metadata.negative, 'blurry');
  assert.equal(metadata.params.Model, 'model.safetensors');
});

test('parses NovelAI metadata bundle from JPEG EXIF UserComment', () => {
  const bundle = JSON.stringify({ Description: 'novelai prompt', Comment: JSON.stringify({ uc: 'bad hands', steps: 24, seed: 456 }) });
  const metadata = readMetadataBuffer(jpegWithExifComment(bundle), 'jpg');
  assert.equal(metadata.format, 'NovelAI');
  assert.equal(metadata.positive, 'novelai prompt');
  assert.equal(metadata.negative, 'bad hands');
  assert.equal(metadata.params.Seed, '456');
});

test('parses NovelAI metadata bundle from WebP EXIF UserComment', () => {
  const bundle = JSON.stringify({ Description: 'webp prompt', Comment: JSON.stringify({ uc: 'webp negative', steps: 20, seed: 2304848398 }) });
  const metadata = readMetadataBuffer(webpWithExifComment(bundle), 'webp');
  assert.equal(metadata.format, 'NovelAI');
  assert.equal(metadata.positive, 'webp prompt');
  assert.equal(metadata.negative, 'webp negative');
  assert.equal(metadata.params.Seed, '2304848398');
});

test('returns null for an image without supported generation metadata', () => {
  assert.equal(readMetadataBuffer(pngWithText([]), 'png'), null);
});

test('DA-19: ordinary image descriptions and comments do not claim NovelAI provenance', () => {
  for (const entries of [
    [{ key: 'Description', value: 'A family photograph' }],
    [{ key: 'Comment', value: 'Edited and exported by a camera app' }],
    [{ key: 'Description', value: 'Notes' }, { key: 'Comment', value: '{"steps":3}' }]
  ]) assert.equal(readMetadataBuffer(pngWithText(entries), 'png'), null);
  assert.equal(readMetadataBuffer(pngWithText([
    { key: 'Software', value: 'NovelAI' }, { key: 'Description', value: 'a landscape' }
  ]), 'png').format, 'NovelAI');
  assert.equal(readMetadataBuffer(jpegWithExifComment(JSON.stringify({ Description: 'ordinary notes', Comment: 'camera' })), 'jpg'), null);
});

test('DA-20: LoRA zero and negative weights survive every supported metadata format', () => {
  const expected = [0, -0.5, 1];
  const a1111 = parseA1111('<lora:off:0> <lora:negative:-0.5> <lora:default:invalid>\nSteps: 20');
  assert.deepEqual(a1111.loras.map(lora => lora.weight), expected);
  const comfy = readMetadataBuffer(pngWithText([{ key: 'prompt', value: JSON.stringify({
    1: { class_type: 'LoraLoader', inputs: { lora_name: 'off', strength_model: 0 } },
    2: { class_type: 'LoraLoader', inputs: { lora_name: 'negative', strength_model: -0.5 } },
    3: { class_type: 'LoraLoader', inputs: { lora_name: 'default' } }
  }) }]), 'png');
  assert.deepEqual(comfy.loras.map(lora => lora.weight), expected);
  const invoke = readMetadataBuffer(pngWithText([{ key: 'invokeai_metadata', value: JSON.stringify({
    loras: [{ name: 'off', weight: 0 }, { name: 'negative', strength: -0.5 }, { name: 'default', weight: 'invalid' }]
  }) }]), 'png');
  assert.deepEqual(invoke.loras.map(lora => lora.weight), expected);
});
