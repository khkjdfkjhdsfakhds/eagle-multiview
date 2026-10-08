'use strict';

(function exposeStealthMetadata(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVStealthMetadata = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const MAX_PIXELS = 32 * 1024 * 1024;
  const MAX_JSON_BYTES = 4 * 1024 * 1024;

  // NovelAI stores bytes MSB first in alpha LSBs, down each column.
  // https://github.com/NovelAI/novelai-image-metadata/blob/main/nai_meta.py
  function extractPayload({ data, width, height }) {
    const pixels = width * height;
    if (!width || !height || pixels < 152 || pixels > MAX_PIXELS || data.length !== pixels * 4) return null;
    let cursor = 0;
    const byte = () => {
      let value = 0;
      for (let bit = 0; bit < 8; bit++, cursor++) {
        const x = Math.floor(cursor / height), y = cursor % height;
        value = value * 2 + (data[(y * width + x) * 4 + 3] & 1);
      }
      return value;
    };
    const magic = Array.from({ length: 15 }, byte).map(value => String.fromCharCode(value)).join('');
    if (magic !== 'stealth_pngcomp' && magic !== 'stealth_pnginfo') return null;
    const bitLength = byte() * 0x1000000 + byte() * 0x10000 + byte() * 0x100 + byte();
    if (!bitLength || bitLength % 8 || bitLength > pixels - cursor || bitLength > MAX_JSON_BYTES * 8) return null;
    return { compressed: magic === 'stealth_pngcomp', bytes: Uint8Array.from({ length: bitLength / 8 }, byte) };
  }

  async function decodePayload(payload) {
    if (!payload) return null;
    let bytes = payload.bytes;
    if (payload.compressed) {
      const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_JSON_BYTES) { await reader.cancel(); return null; }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  async function readImage(url, { signal } = {}) {
    if (signal?.aborted) return null;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    let canvas;
    try {
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer); signal?.removeEventListener('abort', abort);
          image.onload = image.onerror = null;
          if (error) { image.src = ''; reject(error); } else resolve();
        };
        const abort = () => finish(new Error('Metadata image cancelled'));
        const timer = setTimeout(() => finish(new Error('Metadata image timed out')), 10000);
        signal?.addEventListener('abort', abort, { once: true });
        image.onload = () => finish(); image.onerror = () => finish(new Error('Metadata image unavailable'));
        image.src = url;
      });
      if (signal?.aborted || image.naturalWidth * image.naturalHeight > MAX_PIXELS) return null;
      canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const payload = extractPayload(context.getImageData(0, 0, canvas.width, canvas.height));
      // Release the decoded pixel buffer before decompressing the small payload.
      canvas.width = canvas.height = 0;
      const text = await decodePayload(payload);
      return signal?.aborted ? null : text;
    } catch { return null; }
    finally { if (canvas) canvas.width = canvas.height = 0; image.src = ''; }
  }
  return { extractPayload, decodePayload, readImage };
});
