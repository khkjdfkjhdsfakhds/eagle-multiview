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

  const searchScopes = new Set(['', 'name', 'tags', 'annotation', 'url']);

  function searchScopeText(item, scope) {
    if (scope === 'name') return lower(`${item?.name ?? ''}.${item?.ext ?? ''}`);
    if (scope === 'tags') return lower((item?.tags || []).join(' '));
    if (scope === 'annotation') return lower(item?.annotation);
    if (scope === 'url') return lower(item?.url);
    return '';
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

  const list = value => (Array.isArray(value) ? value : []);
  const uniqueStrings = value => [...new Set(list(value).map(String).filter(Boolean))];
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

  // Eagle's tag and folder filters share one rule switch: 任意 (OR), 全部
  // (AND) and 完全相同 (the item has exactly the chosen ones). Eagle starts
  // on OR.
  const LOGICS = ['OR', 'AND', 'EQUAL'];
  const DEFAULT_LOGIC = 'OR';

  // Mirrors Eagle's filterData for tags (app.bundle.js): under OR an item
  // passes on any included tag, *or* on carrying none of the excluded ones,
  // and 未标签 adds the untagged items; under AND/EQUAL every rule narrows.
  function matchTagRules(item, query) {
    const tags = list(item?.tags);
    const includes = uniqueStrings(query?.tags);
    const excludes = uniqueStrings(query?.tagsExclude);
    const logic = pick(query?.tagLogic, LOGICS, DEFAULT_LOGIC);
    const untagged = !tags.length;
    if (logic === 'OR') {
      if (includes.length || excludes.length) {
        if (includes.some(tag => tags.includes(tag))) return true;
        if (excludes.length && !excludes.some(tag => tags.includes(tag))) return true;
        return Boolean(query?.noTags) && untagged;
      }
      return query?.noTags ? untagged : true;
    }
    if (includes.length) {
      if (logic === 'EQUAL' && tags.length !== includes.length) return false;
      if (!includes.every(tag => tags.includes(tag))) return false;
    }
    if (excludes.some(tag => tags.includes(tag))) return false;
    if (query?.noTags && !untagged) return false;
    return true;
  }

  // Eagle lists 未分类 among the folders it filters by.
  const NO_FOLDER = 'NoFolders';

  function matchFolderRules(item, query) {
    const folders = list(item?.folders);
    const includes = uniqueStrings(query?.folderInclude);
    const excludes = uniqueStrings(query?.folderExclude);
    const logic = pick(query?.folderLogic, LOGICS, DEFAULT_LOGIC);
    const holds = id => (id === NO_FOLDER ? !folders.length : folders.includes(id));
    if (logic === 'OR') {
      if (includes.some(holds)) return true;
      return excludes.length > 0 && !excludes.some(holds);
    }
    if (includes.length) {
      if (logic === 'EQUAL' && folders.length !== includes.filter(id => id !== NO_FOLDER).length) return false;
      if (!includes.every(holds)) return false;
    }
    return !excludes.some(holds);
  }

  const normalizeExtensions = value => {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\s,，]+/);
    return [...new Set(raw.map(ext => String(ext ?? '').trim().replace(/^\./, '').toLowerCase()).filter(Boolean))];
  };

  function matchExtensionRules(item, query) {
    const ext = String(item?.ext || '').toLowerCase();
    const includes = normalizeExtensions(query?.ext);
    if (includes.length && !includes.includes(ext)) return false;
    return !normalizeExtensions(query?.extExclude).includes(ext);
  }

  // Eagle's quick date ranges (今天 … 最近 365 日). They are kept as names so a
  // remembered filter stays relative to the day it is used, and several
  // chosen ones, plus a custom range, widen each other as in Eagle.
  const DATE_PRESETS = ['today', 'yesterday', 'last7', 'last30', 'last90', 'last365'];
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const normalizePresets = value => uniqueStrings(value).filter(name => DATE_PRESETS.includes(name));
  const normalizeMonths = value => uniqueStrings(value).filter(month => /^\d{4}\/\d{2}$/.test(month));

  function matchesDatePreset(time, name, now) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const today = midnight.getTime();
    if (name === 'today') return time >= today;
    if (name === 'yesterday') return time >= today - ONE_DAY && time < today;
    const days = Number(name.slice(4));
    return now - time < days * ONE_DAY;
  }

  function monthKey(time) {
    const date = new Date(time);
    return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  // 添加日期 is Eagle's modificationTime and 修改日期 the file's mtime, falling
  // back to the former as Eagle does (P1-04).
  const dateFields = {
    added: item => Number(item?.modificationTime) || 0,
    modified: item => Number(item?.mtime) || Number(item?.modificationTime) || 0
  };

  function dateRuleActive(key, value, query) {
    return rangeActive(value) || normalizePresets(query?.[`${key}Presets`]).length > 0 || normalizeMonths(query?.[`${key}Months`]).length > 0;
  }

  function matchDateRules(key, item, query, now = Date.now()) {
    const time = dateFields[key](item);
    const range = normalizeRange(query?.[key]);
    const presets = normalizePresets(query?.[`${key}Presets`]);
    if (range || presets.length) {
      const inPreset = presets.some(name => matchesDatePreset(time, name, now));
      if (!inPreset && !(range && inRange(time, range))) return false;
    }
    const months = normalizeMonths(query?.[`${key}Months`]);
    return !months.length || months.includes(monthKey(time));
  }

  // Seconds. Unlike the size range, an item with no duration (a still image)
  // never passes a duration filter, as in Eagle.
  function matchDuration(item, range) {
    const duration = Number(item?.duration);
    if (!Number.isFinite(duration) || item?.duration === undefined || item?.duration === null) return false;
    return inRange(duration, range);
  }

  // 标注 (Eagle's comments): 有标注 optionally narrowed by comma-separated
  // keywords that must each appear in some comment, or 没有标注.
  const COMMENT_STATES = ['has', 'none'];
  function matchCommentRules(item, value, query) {
    const comments = list(item?.comments);
    if (value === 'none') return !comments.length;
    if (!comments.length) return false;
    const keywords = String(query?.commentsText ?? '').split(/[,，]/).map(word => lower(word.trim())).filter(Boolean);
    return keywords.every(keyword => comments.some(comment => lower(comment?.annotation).includes(keyword)));
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
  //   must route through the client-side scan pipeline. A function decides
  //   per value (several formats need the scan, one does not)
  // - rows with only normalize hold a companion setting of another row (the
  //   tag rule switch, excluded formats); that row's isActive/match read it
  //   from the query
  // - normalize(raw) → canonical value stored by createQuery
  // - isActive(value, query) → the value constrains results; the whole query
  //   is available for fields that only bite in combination (search scope is
  //   inert with an empty search box)
  // - match(item, value, context) → client predicate; context carries the
  //   whole query plus any resolved lookups. Omit when the server evaluates
  //   the field (full-text search)
  // - applyBody(value, body, query) → server body mapping; omit for
  //   client-only. It may only narrow to a superset of the client match,
  //   since the scan pipeline sends the same body
  const spec = [
    {
      key: 'folderId',
      normalize: value => value || null,
      isActive: Boolean,
      match: (item, value, context) => {
        const ids = Array.isArray(context?.query?.folderIds) && context.query.folderIds.length ? context.query.folderIds : [value];
        return (item.folders || []).some(folderId => ids.includes(folderId));
      },
      // /api/v2/item/get keeps only items in *every* listed folder, so a
      // folder widened to its subtree is matched locally (folderIds below).
      applyBody: (value, body) => {
        if (Array.isArray(body._folderIds) && body._folderIds.length > 1) return;
        body.folders = Array.isArray(body._folderIds) && body._folderIds.length ? body._folderIds : [value];
      }
    },
    {
      // The open folder plus its descendants, set per view (a search, or
      // 显示子文件夹内容); never part of the stored filters.
      key: 'folderIds',
      inQuery: false,
      clientOnly: true,
      normalize: value => (Array.isArray(value) ? [...value] : null),
      isActive: value => Array.isArray(value) && value.length > 1,
      match: (item, value) => (item.folders || []).some(folderId => value.includes(folderId))
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
    // Eagle can aim the search box at one field. The API only offers whole-item
    // keyword search, so a narrowed scope keeps the server's recall and filters
    // it down here. It is inert without search text, which keeps an idle scope
    // out of the scan pipeline.
    {
      key: 'searchScope',
      clientOnly: true,
      normalize: value => {
        const scope = String(value ?? '');
        return searchScopes.has(scope) ? scope : '';
      },
      isActive: (value, query) => Boolean(value) && Boolean(trimmed(query?.search)),
      match: (item, value, context) => {
        const terms = lower(trimmed(context?.query?.search)).split(/\s+/).filter(Boolean);
        if (!terms.length) return true;
        const haystack = searchScopeText(item, value);
        return terms.every(term => haystack.includes(term));
      }
    },
    // One badge entry for the whole tag rule: included tags, excluded ones
    // (right-click in the panel) and 未标签. The API's tags parameter keeps
    // items holding every listed tag, so it serves AND and narrows EQUAL; the
    // rest goes through the scan.
    {
      key: 'tags',
      filter: true,
      normalize: uniqueStrings,
      isActive: (value, query) => list(value).length > 0 || uniqueStrings(query?.tagsExclude).length > 0 || Boolean(query?.noTags),
      clientOnly: (value, query) => {
        const logic = pick(query?.tagLogic, LOGICS, DEFAULT_LOGIC);
        return uniqueStrings(query?.tagsExclude).length > 0 || Boolean(query?.noTags) || logic === 'EQUAL' || (logic === 'OR' && list(value).length > 1);
      },
      match: (item, _value, context) => matchTagRules(item, context?.query),
      applyBody: (value, body, query) => {
        const tags = uniqueStrings(value);
        if (!tags.length) return;
        const plainOr = tags.length === 1 && !uniqueStrings(query?.tagsExclude).length && !query?.noTags;
        if (pick(query?.tagLogic, LOGICS, DEFAULT_LOGIC) !== 'OR' || plainOr) body.tags = tags;
      }
    },
    { key: 'tagsExclude', normalize: uniqueStrings },
    { key: 'tagLogic', normalize: value => pick(value, LOGICS, DEFAULT_LOGIC) },
    { key: 'noTags', normalize: Boolean },
    // 文件夹 filter (not the open folder): direct membership, include and
    // exclude, under the same rule switch as tags.
    {
      key: 'folderInclude',
      filter: true,
      clientOnly: true,
      normalize: uniqueStrings,
      isActive: (value, query) => list(value).length > 0 || uniqueStrings(query?.folderExclude).length > 0,
      match: (item, _value, context) => matchFolderRules(item, context?.query)
    },
    { key: 'folderExclude', normalize: uniqueStrings },
    { key: 'folderLogic', normalize: value => pick(value, LOGICS, DEFAULT_LOGIC) },
    // 格式: any of the ticked extensions, none of the excluded ones. A single
    // one is still the API's ext parameter.
    {
      key: 'ext',
      filter: true,
      normalize: normalizeExtensions,
      isActive: (value, query) => normalizeExtensions(value).length > 0 || normalizeExtensions(query?.extExclude).length > 0,
      clientOnly: (value, query) => normalizeExtensions(value).length !== 1 || normalizeExtensions(query?.extExclude).length > 0,
      match: (item, _value, context) => matchExtensionRules(item, context?.query),
      applyBody: (value, body) => {
        const exts = normalizeExtensions(value);
        if (exts.length === 1) body.ext = exts[0];
      }
    },
    { key: 'extExclude', normalize: normalizeExtensions },
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
      // Eagle's isMatchShapeRule: panoramic from a 2.5:1 side ratio, square
      // only when both sides are equal, so a local scan agrees with the API.
      match: (item, value) => {
        const width = Number(item.width) || 0;
        const height = Number(item.height) || 0;
        const shape = item.shape || (width > height
          ? (width / height >= 2.5 ? 'panoramic-landscape' : 'landscape')
          : width < height ? (height / width >= 2.5 ? 'panoramic-portrait' : 'portrait') : 'square');
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
      isActive: (value, query) => dateRuleActive('added', value, query),
      match: (item, _value, context) => matchDateRules('added', item, context?.query)
    },
    { key: 'addedPresets', normalize: normalizePresets },
    { key: 'addedMonths', normalize: normalizeMonths },
    {
      key: 'modified',
      filter: true,
      clientOnly: true,
      normalize: normalizeRange,
      isActive: (value, query) => dateRuleActive('modified', value, query),
      match: (item, _value, context) => matchDateRules('modified', item, context?.query)
    },
    { key: 'modifiedPresets', normalize: normalizePresets },
    { key: 'modifiedMonths', normalize: normalizeMonths },
    {
      key: 'duration',
      filter: true,
      clientOnly: true,
      normalize: normalizeRange,
      isActive: rangeActive,
      match: (item, value) => matchDuration(item, value)
    },
    // The unit the panel shows the duration range in; the range is seconds.
    { key: 'durationUnit', normalize: value => pick(value, ['s', 'm', 'h'], 's') },
    {
      key: 'comments',
      filter: true,
      clientOnly: true,
      normalize: value => pick(value, COMMENT_STATES, ''),
      isActive: Boolean,
      match: (item, value, context) => matchCommentRules(item, value, context?.query)
    },
    { key: 'commentsText', normalize: value => String(value ?? '') },
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
    return filterEntries.some(entry => entry.isActive(current[entry.key], current));
  }

  function filterCount(query) {
    const current = createQuery(query);
    return filterEntries.filter(entry => entry.isActive(current[entry.key], current)).length;
  }

  function matchesConstraints(item, query, context = {}) {
    if (!item || item.isDeleted) return false;
    const scoped = { ...context, query };
    for (const entry of spec) {
      if (!entry.match) continue;
      const value = query?.[entry.key];
      if (!entry.isActive(value, query)) continue;
      if (!entry.match(item, value, scoped)) return false;
    }
    return true;
  }

  // Any active field the server cannot evaluate for us in the text-query path.
  function clientConstrained(query) {
    return spec.some(entry => entry.match && entry.isActive(query?.[entry.key], query));
  }

  // Any active field that forces the client-side scan pipeline outright.
  function needsClientScan(query) {
    return spec.some(entry => {
      if (!entry.clientOnly || !entry.isActive) return false;
      const value = query?.[entry.key];
      if (!entry.isActive(value, query)) return false;
      return typeof entry.clientOnly === 'function' ? entry.clientOnly(value, query) : true;
    });
  }

  function itemQueryBody(query) {
    const body = {};
    if (Array.isArray(query?.folderIds) && query.folderIds.length) body._folderIds = query.folderIds;
    for (const entry of spec) {
      if (!entry.applyBody) continue;
      const value = query?.[entry.key];
      if (entry.isActive(value, query)) entry.applyBody(value, body, query);
    }
    delete body._folderIds;
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
    inRange,
    normalizeExtensions,
    monthKey,
    matchDateRules,
    NO_FOLDER,
    DATE_PRESETS
  };
});
