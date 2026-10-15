'use strict';

// Eagle's 布局 panel switches (P1-06, P1-07): what each grid card shows and
// whether a folder lists its subfolders' files too. Like Eagle they are one
// global setting, not per folder or per pane, and everything starts on except
// 显示子文件夹内容.
(function exposeCardDisplay(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVCardDisplay = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const STORAGE_KEY = 'eaglemv.cardDisplay.v1';
  const META_TYPES = Object.freeze([
    ['RESOLUTION', '尺寸'], ['FILESIZE', '文件大小'], ['TAGS', '标签'],
    ['RATING', '评分'], ['MTIME', '修改日期'], ['BTIME', '创建日期']
  ]);
  const DEFAULTS = Object.freeze({
    subfolderContent: false,
    name: true,
    meta: true,
    metaType: 'RESOLUTION',
    ext: true,
    extLabel: true,
    annotation: true
  });

  function normalize(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const result = { ...DEFAULTS };
    for (const key of ['subfolderContent', 'name', 'meta', 'ext', 'extLabel', 'annotation']) {
      if (typeof source[key] === 'boolean') result[key] = source[key];
    }
    if (META_TYPES.some(([type]) => type === source.metaType)) result.metaType = source.metaType;
    return result;
  }

  function parse(text) {
    try { return normalize(JSON.parse(text || 'null')); } catch { return normalize(null); }
  }

  // Eagle labels every format but PNG and JPG on the thumbnail.
  function hasFormatLabel(item) {
    const ext = String(item?.ext || '').trim().toLowerCase().replace(/^\./, '');
    return Boolean(ext) && ext !== 'png' && ext !== 'jpg';
  }

  function annotationCount(item) {
    return Array.isArray(item?.comments) ? item.comments.length : 0;
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const pad = value => String(value).padStart(2, '0');
    return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${pad(minutes)}:${pad(total % 60)}`;
  }

  // The one line under the name, as Eagle's 显示简介 picks it. 尺寸 falls back
  // to a duration for audio and video and to the file size when there is no
  // picture size. Formatters come from the page so dates and sizes read the
  // same as in the inspector.
  function metaText(item, type, { formatBytes, formatDateTime, itemDates }) {
    switch (type) {
      case 'FILESIZE': return formatBytes(item?.size);
      case 'TAGS': return (item?.tags || []).map(String).filter(Boolean).join(', ');
      case 'RATING': return '★'.repeat(Math.max(0, Math.min(5, Number(item?.star) || 0)));
      case 'MTIME': return formatDateTime(itemDates(item).modified);
      case 'BTIME': return formatDateTime(itemDates(item).created);
      default:
        if (Number(item?.duration) > 0) return formatDuration(item.duration);
        if (Number(item?.width) > 0 && Number(item?.height) > 0) return `${item.width} x ${item.height}`;
        return formatBytes(item?.size);
    }
  }

  return { STORAGE_KEY, META_TYPES, DEFAULTS, normalize, parse, hasFormatLabel, annotationCount, formatDuration, metaText };
});
