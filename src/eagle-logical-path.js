'use strict';

(function exposeEagleLogicalPath(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVLogicalPath = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const SEPARATOR = ' / ';

  function collectPaths(nodes, trail = [], result = []) {
    for (const folder of nodes || []) {
      const next = [...trail, String(folder?.name || '')];
      result.push({ id: folder?.id, path: next.join(SEPARATOR) });
      collectPaths(folder?.children, next, result);
    }
    return result;
  }

  function formatEaglePath(nodes, folderId) {
    if (folderId === null || folderId === undefined || folderId === '') return '';
    return collectPaths(nodes).find(entry => entry.id === folderId)?.path || null;
  }

  function hasUnsupportedFormat(value) {
    return /[\r\n]/.test(value)
      || value.startsWith('/')
      || value.startsWith('file://')
      || /^[A-Za-z]:[\\/]/.test(value);
  }

  function resolveEaglePath(nodes, rawValue) {
    const value = String(rawValue ?? '').trim();
    if (!value) return { ok: true, view: { kind: 'root' } };
    if (hasUnsupportedFormat(value)) return { ok: false, code: 'unsupported-format' };

    const matches = collectPaths(nodes).filter(entry => entry.path === value);
    if (matches.length > 1) return { ok: false, code: 'ambiguous' };
    if (matches.length === 0) return { ok: false, code: 'not-found' };
    return { ok: true, view: { kind: 'folder', id: matches[0].id } };
  }

  return Object.freeze({ SEPARATOR, formatEaglePath, resolveEaglePath });
});
