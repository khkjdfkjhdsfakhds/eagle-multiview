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

function jpegWithExifComment(comment) {
  const raw = Buffer.concat([Buffer.from('ASCII\0\0\0', 'ascii'), Buffer.from(comment), Buffer.from([0])]);
  const tiff = Buffer.alloc(44 + raw.length);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8769, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(1, 26);
  tiff.writeUInt16LE(0x9286, 28);
  tiff.writeUInt16LE(7, 30);
  tiff.writeUInt32LE(raw.length, 32);
  tiff.writeUInt32LE(44, 36);
  tiff.writeUInt32LE(0, 40);
  raw.copy(tiff, 44);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const size = Buffer.alloc(2);
  size.writeUInt16BE(exif.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), size, exif, Buffer.from([0xff, 0xd9])]);
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

test('returns null for an image without supported generation metadata', () => {
  assert.equal(readMetadataBuffer(pngWithText([]), 'png'), null);
});
