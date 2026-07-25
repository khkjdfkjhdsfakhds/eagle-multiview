'use strict';

(function exposeOperationState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVOperationState = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function createOperationTracker(initialStatus = '等待同步') {
    let statusText = String(initialStatus || '');
    let sequence = 0;
    const operations = new Map();

    function setStatus(text) {
      statusText = String(text || '');
      return currentText();
    }

    function begin(label, { key = null, blocksClose = true } = {}) {
      if (key) {
        const duplicate = [...operations.values()].find(operation => operation.key === key);
        if (duplicate) return { token: null, duplicate: { ...duplicate } };
      }
      const token = ++sequence;
      operations.set(token, { token, label: String(label || '操作正在进行'), key, blocksClose });
      return { token, duplicate: null };
    }

    function end(token) {
      return operations.delete(token);
    }

    function active() {
      return [...operations.values()].map(operation => ({ ...operation }));
    }

    function blocking() {
      return active().filter(operation => operation.blocksClose !== false);
    }

    function summary(values = active()) {
      if (!values.length) return '操作正在进行';
      if (values.length === 1) return values[0].label;
      return `${values.at(-1).label}，另有 ${values.length - 1} 项操作尚未完成`;
    }

    function currentText() {
      const values = active();
      const latest = values.at(-1);
      return latest
        ? `${latest.label}${values.length > 1 ? ` · 共 ${values.length} 项` : ''}`
        : statusText;
    }

    return {
      setStatus,
      begin,
      end,
      active,
      blocking,
      summary,
      currentText,
      get size() { return operations.size; }
    };
  }

  return { createOperationTracker };
});
