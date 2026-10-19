'use strict';

(function exposeStealthMetadata(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVStealthMetadata = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const MAX_PIXELS = 32 * 1024 * 1024;
  const MAX_JSON_BYTES = 4 * 1024 * 1024;
  const HEADER_BITS = 15 * 8 + 32;
  const HEADER_PIXELS = HEADER_BITS;
  // NovelAI and the SD WebUI/Forge stealth_pnginfo extension store bytes MSB
  // first in pixel LSBs, down each column: alpha mode uses the alpha channel,
  // RGB mode chains the R, G and B bits of each pixel.
  // https://github.com/NovelAI/novelai-image-metadata/blob/main/nai_meta.py
  const SIGNATURES = [
    ['stealth_rgbinfo', [0, 1, 2], false], ['stealth_rgbcomp', [0, 1, 2], true],
    ['stealth_pnginfo', [3], false], ['stealth_pngcomp', [3], true]
  ];

  // The bitmap may hold only the leftmost columns of an image `fullWidth`
  // wide; `stride` is 4 for RGBA data and 3 for RGB data.
  function bitReader({ data, width, height, stride = 4 }, channels) {
    let cursor = 0;
    const bit = () => {
      const pixel = Math.floor(cursor / channels.length);
      const x = Math.floor(pixel / height), y = pixel % height;
      const value = data[(y * width + x) * stride + channels[cursor % channels.length]] & 1;
      cursor++;
      return value;
    };
    return () => {
      let value = 0;
      for (let index = 0; index < 8; index++) value = value * 2 + bit();
      return value;
    };
  }

  function validBitmap(bitmap, fullWidth) {
    const { data, width, height, stride = 4 } = bitmap || {};
    const pixels = Number(width) * Number(height);
    const total = Number(fullWidth) * Number(height);
    return Boolean(data && Number.isInteger(pixels) && width && height && (stride === 3 || stride === 4)
      && total >= HEADER_PIXELS && total <= MAX_PIXELS && pixels >= HEADER_PIXELS && data.length === pixels * stride);
  }

  // Returns the payload layout, or null when the image carries no signature.
  function readHeader(bitmap, fullWidth = bitmap?.width) {
    if (!validBitmap(bitmap, fullWidth)) return null;
    const stride = bitmap.stride || 4;
    for (const [magic, channels, compressed] of SIGNATURES) {
      if (channels.some(channel => channel >= stride)) continue;
      const byte = bitReader(bitmap, channels);
      let text = '';
      for (let index = 0; index < 15; index++) text += String.fromCharCode(byte());
      if (text !== magic) continue;
      const bitLength = byte() * 0x1000000 + byte() * 0x10000 + byte() * 0x100 + byte();
      const capacity = Number(fullWidth) * bitmap.height * channels.length - HEADER_BITS;
      if (!bitLength || bitLength % 8 || bitLength > capacity || bitLength > MAX_JSON_BYTES * 8) return null;
      return { channels, compressed, bitLength, pixelsNeeded: Math.ceil((HEADER_BITS + bitLength) / channels.length) };
    }
    return null;
  }

  function extractPayload(bitmap, fullWidth = bitmap?.width) {
    const header = readHeader(bitmap, fullWidth);
    if (!header || header.pixelsNeeded > bitmap.width * bitmap.height) return null;
    const byte = bitReader(bitmap, header.channels);
    for (let index = 0; index < HEADER_BITS / 8; index++) byte();
    return { compressed: header.compressed, bytes: Uint8Array.from({ length: header.bitLength / 8 }, byte) };
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

  // Resolves { text } once the image has been checked (text is null when it
  // carries nothing), or null when it could not be loaded or was cancelled,
  // so callers can cache the definite answers. Only the leftmost columns the
  // payload occupies are copied out of the decoded image.
  async function inspectImage(url, { signal } = {}) {
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
      // Decode off the main thread before the canvas reads it.
      await image.decode?.().catch(() => {});
      if (signal?.aborted) return null;
      const width = image.naturalWidth, height = image.naturalHeight;
      if (width * height > MAX_PIXELS || width * height < HEADER_PIXELS) return { text: null };
      canvas = document.createElement('canvas');
      const columns = count => {
        canvas.width = Math.min(width, count); canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, height);
      };
      let bitmap = columns(Math.ceil(HEADER_PIXELS / height));
      const header = readHeader(bitmap, width);
      if (!header) return { text: null };
      if (header.pixelsNeeded > bitmap.width * height) bitmap = columns(Math.ceil(header.pixelsNeeded / height));
      const payload = extractPayload(bitmap, width);
      // Release the pixel buffer before decompressing the small payload.
      canvas.width = canvas.height = 0; bitmap = null;
      const text = await decodePayload(payload).catch(() => null);
      return signal?.aborted ? null : { text };
    } catch { return null; }
    finally { if (canvas) canvas.width = canvas.height = 0; image.src = ''; }
  }

  async function readImage(url, options) {
    return (await inspectImage(url, options))?.text || null;
  }
  return { readHeader, extractPayload, decodePayload, inspectImage, readImage };
});
