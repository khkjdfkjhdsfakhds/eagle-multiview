'use strict';

(function exposeWindowTarget(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVWindowTarget = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const specialViews = new Set(['root', 'all', 'unfiled', 'untagged', 'recent', 'random', 'trash', 'tags']);

  function windowStateForView(view) {
    if (view?.kind === 'folder' && view.id) return { view: { kind: 'folder', id: view.id } };
    if (view?.kind === 'smart' && view.id) {
      return { view: { kind: 'smart', id: view.id, ...(view.name ? { name: view.name } : {}) } };
    }
    return { view: { kind: specialViews.has(view?.kind) ? view.kind : 'root' } };
  }

  return { windowStateForView };
});
