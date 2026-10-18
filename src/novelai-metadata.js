'use strict';

(function exposeNovelAIMetadata(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVNovelAIMetadata = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const paramText = value => value && typeof value === 'object' ? JSON.stringify(value) : String(value);

  function parseNovelAI(description, comment, software = '') {
    if (!description && !comment) return null;
    let data = {};
    try { data = JSON.parse(comment || '{}'); } catch {}
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    const generationSignature = typeof data.uc === 'string' && Number.isFinite(data.steps) && Number.isFinite(data.seed);
    if (!/\bNovelAI\b/i.test(String(software)) && !generationSignature) return null;
    const positiveCaption = data.v4_prompt?.caption;
    const negativeCaption = data.v4_negative_prompt?.caption;
    const firstText = (...values) => values.find(value => typeof value === 'string' && value.length) || '';
    const result = { format: 'NovelAI', positive: firstText(description, data.prompt, positiveCaption?.base_caption), negative: firstText(data.uc, negativeCaption?.base_caption), characters: [], params: {}, loras: [], workflow: null };
    const characters = Array.isArray(positiveCaption?.char_captions) ? positiveCaption.char_captions : [];
    result.characters = characters.flatMap((character, index) => {
      const positive = firstText(character?.char_caption);
      return positive ? [{ index: index + 1, positive }] : [];
    });
    for (const [source, target] of [['steps', 'Steps'], ['scale', 'CFG scale'], ['seed', 'Seed'], ['sampler', 'Sampler'], ['strength', 'Strength'], ['noise', 'Noise'], ['model', 'Model'], ['request_type', 'Type']]) {
      if (data[source] !== undefined) result.params[target] = paramText(data[source]);
    }
    if (data.width && data.height) result.params.Size = `${data.width}x${data.height}`;
    return result;
  }

  function parseNovelAIExif(comment) {
    if (typeof comment !== 'string') return null;
    try {
      const bundle = JSON.parse(comment);
      if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return null;
      if (typeof bundle.Description !== 'string' && typeof bundle.Comment !== 'string') return null;
      return parseNovelAI(bundle.Description, bundle.Comment, bundle.Software);
    } catch { return null; }
  }

  function loraWeight(value) {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : 1;
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
      // The key in the lookahead may not cross a comma: an unbounded key made
      // each split rescan the rest of the line (quadratic on long parameters).
      for (const part of parameterText.split(/,\s*(?=[A-Z][^:,]*:)/)) {
        const colon = part.indexOf(':');
        if (colon > 0) result.params[part.slice(0, colon).trim()] = part.slice(colon + 1).trim().replace(/^"|"$/g, '');
      }
    }
    const loraPattern = /<lora:([^:>]+):([^>]+)>/gi;
    let match;
    while ((match = loraPattern.exec(result.positive))) result.loras.push({ name: match[1], weight: loraWeight(match[2]) });
    return result;
  }

  // Stealth payloads hold NovelAI's JSON bundle or SD WebUI/Forge parameters.
  function parseStealthText(text) {
    return parseNovelAIExif(text) || parseA1111(text);
  }
  return { parseNovelAI, parseNovelAIExif, parseA1111, parseStealthText, loraWeight };
});
