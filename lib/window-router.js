'use strict';

function createWindowRouter({ createWindow, resolveEagleWindowState }) {
  const focusOrder = [];

  const remove = window => {
    const index = focusOrder.indexOf(window);
    if (index >= 0) focusOrder.splice(index, 1);
  };

  const remember = window => {
    remove(window);
    focusOrder.unshift(window);
  };

  const lastLiveWindow = () => {
    for (const window of [...focusOrder]) {
      if (!window?.isDestroyed?.()) return window;
      remove(window);
    }
    return null;
  };

  return {
    track(window) {
      if (!window) return;
      if (!focusOrder.length) focusOrder.push(window);
      else if (!focusOrder.includes(window)) focusOrder.push(window);
      window.on('focus', () => remember(window));
      window.on('closed', () => remove(window));
    },

    async openDefault() {
      const source = lastLiveWindow();
      if (source) {
        source.webContents.send('command:new-window');
        return source;
      }
      createWindow(null);
      return null;
    },

    async openEagle() {
      createWindow(resolveEagleWindowState ? await resolveEagleWindowState() : null);
    }
  };
}

module.exports = { createWindowRouter };
