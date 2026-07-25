'use strict';

const fs = require('node:fs/promises');
const zlib = require('node:zlib');

function readPngChunks(buffer) {
  const chunks = {};
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return chunks;
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (offset + length + 12 > buffer.length) break;
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'tEXt') {
      const split = data.indexOf(0);
      if (split >= 0) chunks[data.toString('latin1', 0, split)] = data.toString('utf8', split + 1);
    } else if (type === 'zTXt') {
      const split = data.indexOf(0);
      if (split >= 0 && data[split + 1] === 0) {
        try { chunks[data.toString('latin1', 0, split)] = zlib.inflateSync(data.subarray(split + 2)).toString('utf8'); } catch {}
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
              const value = compressed ? zlib.inflateSync(data.subarray(cursor)).toString('utf8') : data.toString('utf8', cursor);
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

function parseA1111(text) {
  if (typeof text !== 'string' || !/(?:Steps|Sampler):\s*/i.test(text)) return null;
  const lines = text.trim().split(/\r?\n/);
  const parameterLine = lines.findIndex(line => /^(Steps|Sampler|CFG scale|Seed|Size|Model|Denoising strength|Clip skip|Version|VAE|Schedule type):/i.test(line.trim()));
  const negativeLine = lines.findIndex(line => /^Negative prompt:/i.test(line.trim()));
  const endPrompt = parameterLine >= 0 ? parameterLine : lines.length;
  const result = { format: 'Automatic1111 / FORGE', positive: lines.slice(0, negativeLine >= 0 ? negativeLine : endPrompt).join('\n').trim(), negative: '', params: {}, loras: [], workflow: null };
  if (negativeLine >= 0) {
    result.negative = lines.slice(negativeLine, endPrompt >= negativeLine ? endPrompt : lines.length).join('\n').replace(/^Negative prompt:\s*/i, '').trim();
  }
  if (parameterLine >= 0) {
    const parameterText = lines.slice(parameterLine).join(', ');
    for (const part of parameterText.split(/,\s*(?=[A-Z][^:]+:)/)) {
      const colon = part.indexOf(':');
      if (colon > 0) result.params[part.slice(0, colon).trim()] = part.slice(colon + 1).trim().replace(/^"|"$/g, '');
    }
  }
  const loraPattern = /<lora:([^:>]+):([^>]+)>/gi;
  let match;
  while ((match = loraPattern.exec(result.positive))) result.loras.push({ name: match[1], weight: Number.parseFloat(match[2]) || 1 });
  return result;
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
    if (/LoraLoader/i.test(type) && inputs.lora_name) result.loras.push({ name: String(inputs.lora_name), weight: Number.parseFloat(inputs.strength_model ?? inputs.strength ?? 1) || 1 });
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

function parseNovelAI(description, comment) {
  if (!description && !comment) return null;
  const result = { format: 'NovelAI', positive: String(description || ''), negative: '', params: {}, loras: [], workflow: null };
  try {
    const data = JSON.parse(comment || '{}');
    if (data.uc) result.negative = String(data.uc);
    for (const [source, target] of [['steps', 'Steps'], ['scale', 'CFG scale'], ['seed', 'Seed'], ['sampler', 'Sampler'], ['strength', 'Strength'], ['noise', 'Noise'], ['model', 'Model'], ['request_type', 'Type']]) {
      if (data[source] !== undefined) result.params[target] = String(data[source]);
    }
    if (data.width && data.height) result.params.Size = `${data.width}x${data.height}`;
  } catch {}
  return result;
}

function parseNovelAIExif(comment) {
  if (typeof comment !== 'string') return null;
  try {
    const bundle = JSON.parse(comment);
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return null;
    if (typeof bundle.Description !== 'string' && typeof bundle.Comment !== 'string') return null;
    return parseNovelAI(bundle.Description, bundle.Comment);
  } catch {
    return null;
  }
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
    if (Array.isArray(data.loras)) result.loras = data.loras.map(lora => ({ name: String(lora.name || lora.lora?.name || '?'), weight: Number.parseFloat(lora.weight ?? lora.strength ?? 1) || 1 }));
    return result;
  } catch { return null; }
}

function readJpegUserComment(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return '';
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xe1 && length > 8) {
      const data = buffer.subarray(offset + 4, offset + 2 + length);
      if (data.subarray(0, 6).toString('ascii') === 'Exif\0\0') {
        const tiff = data.subarray(6);
        const little = tiff.subarray(0, 2).toString('ascii') === 'II';
        const read16 = at => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
        const read32 = at => little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
        if (tiff.length >= 8 && read16(2) === 42) {
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
            if (entry + 12 > tiff.length) break;
            if (read16(entry) !== 0x9286) continue;
            const size = read32(entry + 4);
            const start = read32(entry + 8);
            if (start + size > tiff.length) continue;
            const raw = tiff.subarray(start, start + size);
            const charset = raw.subarray(0, 8).toString('ascii').replace(/\0/g, '').trim();
            return (charset === 'UNICODE' ? raw.subarray(8).toString('utf16le') : raw.subarray(8).toString('utf8')).replace(/\0/g, '').trim();
          }
        }
      }
    }
    offset += 2 + length;
  }
  return '';
}

function readMetadataBuffer(buffer, ext = '') {
  const extension = String(ext).toLowerCase();
  const chunks = readPngChunks(buffer);
  if (Object.keys(chunks).length) {
    const a1111 = parseA1111(chunks.parameters);
    if (a1111) return a1111;
    const comfy = parseComfy(chunks.workflow, chunks.prompt);
    if (comfy) return comfy;
    const novel = parseNovelAI(chunks.Description, chunks.Comment);
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
    return parseNovelAIExif(comment) || parseA1111(comment) || parseA1111(textScanFallback(buffer));
  }
  return parseA1111(textScanFallback(buffer));
}

async function readMetadata(filePath, ext) {
  if (!filePath) return null;
  const buffer = await fs.readFile(filePath);
  return readMetadataBuffer(buffer, ext || filePath.split('.').pop());
}

module.exports = { readMetadata, readMetadataBuffer, readPngChunks, parseA1111 };
