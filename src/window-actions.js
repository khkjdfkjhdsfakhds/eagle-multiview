'use strict';

(function exposeWindowActions(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVWindowActions = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function createWindowActions({ bridge, currentView, windowStateForView }) {
    const rootState = () => windowStateForView({ kind: 'root' });

    async function eagleState() {
      try {
        const state = await bridge.currentEagleWindowState();
        return windowStateForView(state?.view);
      } catch {
        return rootState();
      }
    }

    async function open(target = 'multiview') {
      // Browser popup policies require the blank tab to be opened inside the
      // original click/key event, before the Eagle-path RPC yields.
      const preparedWindow = target === 'eagle' ? bridge.prepareNewWindow?.() : null;
      const initialState = target === 'root'
        ? rootState()
        : target === 'eagle'
          ? await eagleState()
          : windowStateForView(currentView());
      return bridge.newWindow(initialState, preparedWindow);
    }

    return { eagleState, open };
  }

  return { createWindowActions };
});
