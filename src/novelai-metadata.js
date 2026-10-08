'use strict';

(function exposeNovelAIMetadata(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVNovelAIMetadata = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
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
      if (data[source] !== undefined) result.params[target] = String(data[source]);
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
  return { parseNovelAI, parseNovelAIExif };
});
