'use strict';

const fs = require('node:fs/promises');
const zlib = require('node:zlib');
const MAX_TEXT_CHUNK_BYTES = 1024 * 1024;
const MAX_INFLATED_TEXT_BYTES = 4 * 1024 * 1024;
const { parseNovelAI, parseNovelAIExif, parseA1111, loraWeight } = require('../src/novelai-metadata');

function readPngChunks(buffer) {
  const chunks = {};
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return chunks;
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (offset + length + 12 > buffer.length) break;
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    // A crafted file must not stall the main process: oversized text chunks
    // are skipped and decompression stops at a fixed output size.
    if (length > MAX_TEXT_CHUNK_BYTES && /^(tEXt|zTXt|iTXt)$/.test(type)) {
      offset += length + 12;
      continue;
    }
    if (type === 'tEXt') {
      const split = data.indexOf(0);
      if (split >= 0) chunks[data.toString('latin1', 0, split)] = data.toString('utf8', split + 1);
    } else if (type === 'zTXt') {
      const split = data.indexOf(0);
      if (split >= 0 && data[split + 1] === 0) {
        try { chunks[data.toString('latin1', 0, split)] = zlib.inflateSync(data.subarray(split + 2), { maxOutputLength: MAX_INFLATED_TEXT_BYTES }).toString('utf8'); } catch {}
      }
    } else if (type === 'iTXt') {
      const keyEnd = data.indexOf(0);
      if (keyEnd >= 0) {
        let cursor = keyEnd + 1;
        const compressed = data[cursor++] === 1;
        cursor++;
        const languageEnd = data.indexOf(0, cursor);
        if (languageEnd >= 0) {
          cursor = languageEnd + 1;
          const translatedEnd = data.indexOf(0, cursor);
          if (translatedEnd >= 0) {
            cursor = translatedEnd + 1;
            try {
              const value = compressed ? zlib.inflateSync(data.subarray(cursor), { maxOutputLength: MAX_INFLATED_TEXT_BYTES }).toString('utf8') : data.toString('utf8', cursor);
              chunks[data.toString('latin1', 0, keyEnd)] = value;
            } catch {}
          }
        }
      }
    }
    offset += length + 12;
    if (type === 'IEND') break;
  }
  return chunks;
}

function textScanFallback(buffer) {
  const text = buffer.subarray(0, Math.min(buffer.length, 65536)).toString('utf8');
  const marker = text.indexOf('Steps:');
  if (marker < 0) return null;
  let start = marker;
  for (let index = marker - 1; index >= 0; index--) {
    const code = text.charCodeAt(index);
    if (code < 9 || (code > 13 && code < 32)) { start = index + 1; break; }
    if (index === 0) start = 0;
  }
  return text.slice(start, Math.min(start + 8192, text.length));
}

function parseComfy(workflowText, promptText) {
  let workflow = null;
  let prompt = null;
  try { if (workflowText) workflow = JSON.parse(workflowText); } catch {}
  try { if (promptText) prompt = JSON.parse(promptText); } catch {}
  if (!workflow && !prompt) return null;
  const result = { format: 'ComfyUI', positive: '', negative: '', params: {}, loras: [], workflow: workflow || prompt };
  const nodes = prompt && typeof prompt === 'object' ? prompt : workflow && typeof workflow === 'object' ? workflow : {};
  const textNodes = [];
  let sampler = null;
  for (const node of Object.values(nodes)) {
    if (!node || typeof node !== 'object') continue;
    const type = String(node.class_type || node.type || '');
    const inputs = node.inputs || node.widgets_values || {};
    if (/CLIPTextEncode/i.test(type) && typeof inputs.text === 'string') textNodes.push(inputs.text);
    if (/CheckpointLoader/i.test(type) && inputs.ckpt_name) result.params.Model = String(inputs.ckpt_name);
    if (/LoraLoader/i.test(type) && inputs.lora_name) result.loras.push({ name: String(inputs.lora_name), weight: loraWeight(inputs.strength_model ?? inputs.strength) });
    if (/KSampler/i.test(type)) sampler = inputs;
  }
  if (sampler) {
    const links = [sampler.positive, sampler.negative];
    const resolveText = link => {
      const id = Array.isArray(link) ? String(link[0]) : link && typeof link === 'object' ? String(link.node_id ?? link.node ?? link.id ?? '') : '';
      const node = id && nodes[id];
      const text = node?.inputs?.text;
      return typeof text === 'string' ? text : '';
    };
    result.positive = resolveText(links[0]);
    result.negative = resolveText(links[1]);
    if (sampler.steps !== undefined) result.params.Steps = String(sampler.steps);
    if (sampler.cfg !== undefined) result.params['CFG scale'] = String(sampler.cfg);
    if (sampler.seed !== undefined || sampler.noise_seed !== undefined) result.params.Seed = String(sampler.seed ?? sampler.noise_seed);
    if (sampler.sampler_name) result.params.Sampler = String(sampler.sampler_name);
    if (sampler.scheduler) result.params.Scheduler = String(sampler.scheduler);
  }
  if (!result.positive) result.positive = textNodes[0] || '';
  if (!result.negative) result.negative = textNodes.find(text => text !== result.positive) || '';
  return result;
}


function parseInvoke(text, legacy = false) {
  if (!text) return null;
  if (legacy) {
    const match = String(text).match(/^"?(.*?)"?\s*\[([^\]]+)\]/s);
    if (!match) return null;
    const result = { format: 'InvokeAI', positive: match[1].trim(), negative: '', params: {}, loras: [], workflow: null };
    for (const [regex, key] of [[/seed:(\d+)/, 'Seed'], [/-s(\d+)/, 'Steps'], [/-W(\d+)/, 'Width'], [/-H(\d+)/, 'Height'], [/-C([\d.]+)/, 'CFG scale'], [/-A([\w_]+)/, 'Sampler']]) { const found = match[2].match(regex); if (found) result.params[key] = found[1]; }
    if (result.params.Width && result.params.Height) result.params.Size = `${result.params.Width}x${result.params.Height}`;
    delete result.params.Width; delete result.params.Height;
    return result;
  }
  try {
    const data = JSON.parse(text);
    const result = { format: 'InvokeAI', positive: data.positive_prompt || data.prompt || '', negative: data.negative_prompt || '', params: {}, loras: [], workflow: null };
    for (const [source, target] of [['cfg_scale', 'CFG scale'], ['steps', 'Steps'], ['seed', 'Seed'], ['scheduler', 'Sampler'], ['strength', 'Denoising strength']]) if (data[source] !== undefined) result.params[target] = String(data[source]);
    if (data.model?.name) result.params.Model = String(data.model.name);
    if (data.vae?.name) result.params.VAE = String(data.vae.name);
    if (data.width && data.height) result.params.Size = `${data.width}x${data.height}`;
    if (Array.isArray(data.loras)) result.loras = data.loras.map(lora => ({ name: String(lora.name || lora.lora?.name || '?'), weight: loraWeight(lora.weight ?? lora.strength) }));
    return result;
  } catch { return null; }
}

function readTiffUserComment(tiff) {
  if (tiff.length < 8) return '';
  const byteOrder = tiff.subarray(0, 2).toString('ascii');
  if (byteOrder !== 'II' && byteOrder !== 'MM') return '';
  const little = byteOrder === 'II';
  const read16 = at => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const read32 = at => little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
  if (read16(2) !== 42) return '';

  const ifd0 = read32(4);
  const ifd0Count = ifd0 + 2 <= tiff.length ? read16(ifd0) : 0;
  let ifd = ifd0;
  for (let index = 0; index < ifd0Count; index++) {
    const entry = ifd0 + 2 + index * 12;
    if (entry + 12 > tiff.length) break;
    if (read16(entry) === 0x8769) {
      ifd = read32(entry + 8);
      break;
    }
  }

  const count = ifd + 2 <= tiff.length ? read16(ifd) : 0;
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > tiff.length || read16(entry) !== 0x9286) continue;
    const size = read32(entry + 4);
    const start = size <= 4 ? entry + 8 : read32(entry + 8);
    if (start > tiff.length || size > tiff.length - start) continue;
    const raw = tiff.subarray(start, start + size);
    const charset = raw.subarray(0, 8).toString('ascii').replace(/\0/g, '').trim();
    return (charset === 'UNICODE' ? raw.subarray(8).toString('utf16le') : raw.subarray(8).toString('utf8')).replace(/\0/g, '').trim();
  }
  return '';
}

function readJpegUserComment(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return '';
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;
    if (marker === 0xe1 && length > 8) {
      const data = buffer.subarray(offset + 4, offset + 2 + length);
      if (data.subarray(0, 6).toString('ascii') === 'Exif\0\0') return readTiffUserComment(data.subarray(6));
    }
    offset += 2 + length;
  }
  return '';
}

function readWebpUserComment(buffer) {
  if (buffer.length < 20 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') return '';
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start > buffer.length || length > buffer.length - start) break;
    if (type === 'EXIF') {
      const data = buffer.subarray(start, start + length);
      return readTiffUserComment(data.subarray(0, 6).toString('ascii') === 'Exif\0\0' ? data.subarray(6) : data);
    }
    offset = start + length + (length % 2);
  }
  return '';
}

// `scanBuffer` is what the plain-text fallback searches; it defaults to the
// buffer itself.
function readMetadataBuffer(buffer, ext = '', { scanBuffer = buffer } = {}) {
  const extension = String(ext).toLowerCase();
  const chunks = readPngChunks(buffer);
  if (Object.keys(chunks).length) {
    const a1111 = parseA1111(chunks.parameters);
    if (a1111) return a1111;
    const comfy = parseComfy(chunks.workflow, chunks.prompt);
    if (comfy) return comfy;
    const novel = parseNovelAI(chunks.Description, chunks.Comment, chunks.Software);
    if (novel) return novel;
    const invoke = parseInvoke(chunks.invokeai_metadata) || parseInvoke(chunks.dream, true);
    if (invoke) return invoke;
    for (const key of ['sd-metadata', 'metadata', 'UserComment']) {
      const fallback = parseA1111(chunks[key]) || parseInvoke(chunks[key]);
      if (fallback) return fallback;
    }
  }
  if (extension === 'jpg' || extension === 'jpeg' || (buffer[0] === 0xff && buffer[1] === 0xd8)) {
    const comment = readJpegUserComment(buffer);
    return parseNovelAIExif(comment) || parseA1111(comment) || parseA1111(textScanFallback(scanBuffer));
  }
  if (extension === 'webp' || (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP')) {
    const comment = readWebpUserComment(buffer);
    return parseNovelAIExif(comment) || parseA1111(comment) || parseA1111(textScanFallback(scanBuffer));
  }
  return parseA1111(textScanFallback(scanBuffer));
}

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const TEXT_SCAN_BYTES = 65536;

// A PNG is walked chunk by chunk: only chunk headers and the text chunks are
// read, so the image data (IDAT, often most of the file) never enters memory
// (E-02). Text chunks after the image data are still found. Returns null when
// the file is not a PNG.
async function readPngTextChunks(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, TEXT_SCAN_BYTES));
    await handle.read(head, 0, head.length, 0);
    if (head.length < 8 || !head.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    const parts = [PNG_SIGNATURE];
    const header = Buffer.alloc(8);
    let offset = 8;
    while (offset + 12 <= size) {
      await handle.read(header, 0, 8, offset);
      const length = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      if (offset + length + 12 > size) break;
      if (/^(tEXt|zTXt|iTXt)$/.test(type) && length <= MAX_TEXT_CHUNK_BYTES) {
        // readPngChunks ignores CRCs, so the chunk is copied without one.
        const chunk = Buffer.alloc(length + 12);
        header.copy(chunk, 0);
        await handle.read(chunk, 8, length, offset + 8);
        parts.push(chunk);
      }
      offset += length + 12;
      if (type === 'IEND') break;
    }
    const end = Buffer.alloc(12);
    end.write('IEND', 4, 'ascii');
    parts.push(end);
    return { buffer: Buffer.concat(parts), head };
  } finally {
    await handle.close();
  }
}

async function readMetadata(filePath, ext) {
  if (!filePath) return null;
  const extension = ext || filePath.split('.').pop();
  const png = await readPngTextChunks(filePath);
  if (png) return readMetadataBuffer(png.buffer, extension, { scanBuffer: png.head });
  const buffer = await fs.readFile(filePath);
  return readMetadataBuffer(buffer, extension);
}

module.exports = { readMetadata, readMetadataBuffer, readPngChunks, readPngTextChunks, parseA1111 };
