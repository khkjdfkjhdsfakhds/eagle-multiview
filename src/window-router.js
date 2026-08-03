'use strict';

// Shared browser-side return contract. The renderer installs the callbacks,
// while the WebView bridge only needs to call window.EagleMVBack.request().
(function exposeWindowRouter(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root) return;
  root.EagleMVWindowRouter = api;
  root.EagleMVBack = Object.freeze({ request: api.requestBack });
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const BACK_STATUS = Object.freeze({
    HANDLED: 'handled',
    BLOCKED: 'blocked',
    EXIT: 'exit'
  });
  const BACK_ACTION = Object.freeze({
    TRANSIENT: 'transient',
    PREVIEW: 'preview',
    HISTORY: 'history',
    HOST: 'host',
    REQUEST: 'request'
  });
  const HISTORY_QUERY_KEY = '__eagleMVNavigationQuery';

  let installedRouter = null;

  function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  }

  function createHistoryEntry(view, query) {
    return { ...view, [HISTORY_QUERY_KEY]: clone(query) };
  }

  function readHistoryEntry(entry) {
    const view = { ...(entry || {}) };
    const hasQuery = Object.prototype.hasOwnProperty.call(view, HISTORY_QUERY_KEY);
    const query = hasQuery ? clone(view[HISTORY_QUERY_KEY]) : undefined;
    delete view[HISTORY_QUERY_KEY];
    return { view, query, hasQuery };
  }

  function backResult(status, action, reason) {
    const result = {
      status,
      handled: status === BACK_STATUS.HANDLED,
      exit: status === BACK_STATUS.EXIT,
      blocked: status === BACK_STATUS.BLOCKED,
      action
    };
    if (reason) result.reason = String(reason);
    return Object.freeze(result);
  }

  function normalizeOutcome(value, defaultAction) {
    if (!value) return null;
    if (value === true || typeof value === 'string') {
      return backResult(BACK_STATUS.HANDLED, value === true ? defaultAction : value);
    }
    if (value.status === BACK_STATUS.EXIT) return backResult(BACK_STATUS.EXIT, value.action || BACK_ACTION.HOST, value.reason);
    if (value.status === BACK_STATUS.BLOCKED || value.blocked) {
      return backResult(BACK_STATUS.BLOCKED, value.action || defaultAction, value.reason || 'blocked');
    }
    if (value.status === BACK_STATUS.HANDLED || value.handled) {
      return backResult(BACK_STATUS.HANDLED, value.action || defaultAction, value.reason);
    }
    return backResult(BACK_STATUS.HANDLED, defaultAction);
  }

  function createBackRouter({
    consumeTransient = () => null,
    consumePreview = () => null,
    canNavigateBack = () => false,
    navigateBack = () => false
  } = {}) {
    let running = false;

    function request() {
      if (running) return backResult(BACK_STATUS.BLOCKED, BACK_ACTION.REQUEST, 'busy');
      running = true;
      try {
        const transient = normalizeOutcome(consumeTransient(), BACK_ACTION.TRANSIENT);
        if (transient) return transient;

        const preview = normalizeOutcome(consumePreview(), BACK_ACTION.PREVIEW);
        if (preview) return preview;

        if (!canNavigateBack()) return backResult(BACK_STATUS.EXIT, BACK_ACTION.HOST);
        const history = normalizeOutcome(navigateBack(), BACK_ACTION.HISTORY);
        return history || backResult(BACK_STATUS.BLOCKED, BACK_ACTION.HISTORY, 'navigation-refused');
      } catch (error) {
        return backResult(BACK_STATUS.BLOCKED, BACK_ACTION.REQUEST, error?.message || 'back-failed');
      } finally {
        running = false;
      }
    }

    return Object.freeze({ request });
  }

  function installBackRouter(router) {
    installedRouter = router && typeof router.request === 'function' ? router : null;
    return installedRouter;
  }

  function requestBack() {
    return installedRouter
      ? installedRouter.request()
      : backResult(BACK_STATUS.BLOCKED, BACK_ACTION.REQUEST, 'not-ready');
  }

  return {
    BACK_STATUS,
    BACK_ACTION,
    HISTORY_QUERY_KEY,
    createBackRouter,
    createHistoryEntry,
    readHistoryEntry,
    installBackRouter,
    requestBack
  };
});
