'use strict';

(function exposeQuerySpec(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVQuerySpec = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const trimmed = value => String(value ?? '').trim();
  const lower = value => String(value ?? '').toLocaleLowerCase('zh-CN');

  function parseHexColor(value) {
    const raw = String(value || '').trim().replace(/^#/, '');
    const hex = raw.length === 3 ? [...raw].map(ch => ch + ch).join('') : raw;
    if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }

  // Nearest-dominant-color match against the item's Eagle palette. The Eagle
  // API has no color filter, so this runs purely client-side — a full-library
  // scan calls it per item, hence the parsed-color memo and squared distance.
  let parsedColorCache = { key: null, rgb: null };
  function matchesColor(item, colorValue, threshold = 96) {
    if (parsedColorCache.key !== colorValue) {
      parsedColorCache = { key: colorValue, rgb: parseHexColor(colorValue) };
    }
    const target = parsedColorCache.rgb;
    if (!target) return false;
    const limit = threshold * threshold;
    const palettes = Array.isArray(item?.palettes) ? item.palettes : [];
    return palettes.some(entry => {
      const rgb = Array.isArray(entry?.color) ? entry.color : null;
      if (!rgb || rgb.length < 3) return false;
      const dr = (Number(rgb[0]) || 0) - target[0];
      const dg = (Number(rgb[1]) || 0) - target[1];
      const db = (Number(rgb[2]) || 0) - target[2];
      return dr * dr + dg * dg + db * db <= limit;
    });
  }

  // Range fields (file size, added date) are one query key holding {min, max}
  // rather than two keys, so the filter badge counts a range as one filter
  // and clearing either end leaves the other standing.
  function normalizeRange(value) {
    const min = Number(value?.min);
    const max = Number(value?.max);
    const range = {
      min: Number.isFinite(min) && min > 0 ? min : null,
      max: Number.isFinite(max) && max > 0 ? max : null
    };
    return range.min === null && range.max === null ? null : range;
  }

  function rangeActive(value) {
    return Boolean(value && (value.min !== null || value.max !== null));
  }

  function inRange(candidate, range) {
    const value = Number(candidate) || 0;
    if (range.min !== null && value < range.min) return false;
    if (range.max !== null && value > range.max) return false;
    return true;
  }

  // One row per query field; everything else derives from this table:
  // pane defaults/clone (createQuery), filter badge state (filtersActive/
  // filterCount), client-side matching (matchesConstraints), the
  // /api/v2/item/get body (itemQueryBody), and scan routing
  // (clientConstrained/needsClientScan). Adding a filter means adding a row
  // here plus its input in the filter panel.
  //
  // Row shape:
  // - inQuery: false → view context merged at refresh time, not part of the
  //   pane's persisted query object
  // - filter: true → user-visible filter, counted in the filter badge
  // - clientOnly: true → the Eagle API cannot evaluate it; an active value
  //   must route through the client-side scan pipeline
  // - normalize(raw) → canonical value stored by createQuery
  // - isActive(value) → the value constrains results
  // - match(item, value, context) → client predicate; omit when the server
  //   evaluates the field (full-text search)
  // - applyBody(value, body) → server body mapping; omit for client-only
  const spec = [
    {
      key: 'folderId',
      normalize: value => value || null,
      isActive: Boolean,
      match: (item, value) => (item.folders || []).includes(value),
      applyBody: (value, body) => { body.folders = [value]; }
    },
    {
      key: 'smartFolderId',
      normalize: value => value || null,
      isActive: Boolean,
      match: (item, value, context) => Boolean(context?.smartFolderIds?.has(item.id)),
      applyBody: (value, body) => { body.smartFolders = [value]; }
    },
    {
      key: 'unfiled',
      inQuery: false,
      normalize: Boolean,
      isActive: Boolean,
      match: item => !(item.folders || []).length,
      applyBody: (_value, body) => { body.isUnfiled = true; }
    },
    {
      key: 'isUntagged',
      inQuery: false,
      normalize: Boolean,
      isActive: Boolean,
      match: item => !(item.tags || []).length,
      applyBody: (_value, body) => { body.isUntagged = true; }
    },
    {
      key: 'search',
      filter: true,
      normalize: value => String(value ?? ''),
      isActive: value => Boolean(trimmed(value)),
      applyBody: (value, body) => { body.keywords = trimmed(value).split(/\s+/).filter(Boolean); }
    },
    {
      key: 'tags',
      filter: true,
      normalize: value => [...new Set((value || []).map(String).filter(Boolean))],
      isActive: value => (value || []).length > 0,
      match: (item, value) => value.every(tag => (item.tags || []).includes(tag)),
      applyBody: (value, body) => { body.tags = value; }
    },
    {
      key: 'ext',
      filter: true,
      normalize: value => String(value ?? ''),
      isActive: Boolean,
      match: (item, value) => String(item.ext || '').toLowerCase() === String(value).toLowerCase(),
      applyBody: (value, body) => { body.ext = value; }
    },
    {
      key: 'rating',
      filter: true,
      normalize: value => (Number.isInteger(value) ? value : null),
      isActive: value => Number.isInteger(value),
      match: (item, value) => Number(item.star || 0) === value,
      applyBody: (value, body) => { body.rating = value; }
    },
    {
      key: 'annotation',
      filter: true,
      normalize: value => String(value ?? ''),
      isActive: value => Boolean(trimmed(value)),
      match: (item, value) => lower(item.annotation).includes(lower(trimmed(value))),
      applyBody: (value, body) => { body.annotation = trimmed(value); }
    },
    {
      key: 'url',
      filter: true,
      normalize: value => String(value ?? ''),
      isActive: value => Boolean(trimmed(value)),
      match: (item, value) => lower(item.url).includes(lower(trimmed(value))),
      applyBody: (value, body) => { body.url = trimmed(value); }
    },
    {
      key: 'shape',
      filter: true,
      normalize: value => String(value ?? ''),
      isActive: Boolean,
      match: (item, value) => {
        const width = Number(item.width) || 0;
        const height = Number(item.height) || 0;
        const ratio = width && height ? width / height : 1;
        const shape = item.shape || (ratio === 1 ? 'square' : ratio >= 2 ? 'panoramic-landscape' : ratio <= .5 ? 'panoramic-portrait' : ratio > 1 ? 'landscape' : 'portrait');
        return shape === value;
      },
      applyBody: (value, body) => { body.shape = value; }
    },
    {
      key: 'color',
      filter: true,
      clientOnly: true,
      normalize: value => String(value ?? ''),
      isActive: Boolean,
      match: (item, value) => matchesColor(item, value)
    },
    // /api/v2/item/get ignores every range parameter we probed (sizeMin,
    // minSize, size:{min}, widthMin, btimeMin, startTime…), so these run on
    // the client scan pipeline like the colour filter does. Bytes and
    // millisecond timestamps; the panel converts from MB and dates.
    {
      key: 'size',
      filter: true,
      clientOnly: true,
      normalize: normalizeRange,
      isActive: rangeActive,
      match: (item, value) => inRange(item.size, value)
    },
    {
      key: 'added',
      filter: true,
      clientOnly: true,
      normalize: normalizeRange,
      isActive: rangeActive,
      match: (item, value) => inRange(item.btime, value)
    },
    {
      key: 'pixels',
      filter: true,
      clientOnly: true,
      normalize: normalizeRange,
      isActive: rangeActive,
      match: (item, value) => inRange((Number(item.width) || 0) * (Number(item.height) || 0), value)
    }
  ];

  const filterEntries = spec.filter(entry => entry.filter);

  function createQuery(source = {}) {
    const query = {};
    for (const entry of spec) {
      if (entry.inQuery === false) continue;
      query[entry.key] = entry.normalize(source?.[entry.key]);
    }
    return query;
  }

  function filtersActive(query) {
    const current = createQuery(query);
    return filterEntries.some(entry => entry.isActive(current[entry.key]));
  }

  function filterCount(query) {
    const current = createQuery(query);
    return filterEntries.filter(entry => entry.isActive(current[entry.key])).length;
  }

  function matchesConstraints(item, query, context = {}) {
    if (!item || item.isDeleted) return false;
    for (const entry of spec) {
      if (!entry.match) continue;
      const value = query?.[entry.key];
      if (!entry.isActive(value)) continue;
      if (!entry.match(item, value, context)) return false;
    }
    return true;
  }

  // Any active field the server cannot evaluate for us in the text-query path.
  function clientConstrained(query) {
    return spec.some(entry => entry.match && entry.isActive(query?.[entry.key]));
  }

  // Any active field that forces the client-side scan pipeline outright.
  function needsClientScan(query) {
    return spec.some(entry => entry.clientOnly && entry.isActive(query?.[entry.key]));
  }

  function itemQueryBody(query) {
    const body = {};
    for (const entry of spec) {
      if (!entry.applyBody) continue;
      const value = query?.[entry.key];
      if (entry.isActive(value)) entry.applyBody(value, body);
    }
    return body;
  }

  return {
    spec,
    createQuery,
    filtersActive,
    filterCount,
    matchesConstraints,
    clientConstrained,
    needsClientScan,
    itemQueryBody,
    parseHexColor,
    matchesColor,
    normalizeRange,
    rangeActive,
    inRange
  };
});
