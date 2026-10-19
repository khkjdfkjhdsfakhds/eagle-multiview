'use strict';
// The inspector-refresh library, plus hooks for the menu bar's IPC.
require('./inspector-refresh-preload.cjs');
window.__menuReports = [];
window.eagleMV.onMenuCommand = callback => {
  window.__menuCommand = callback;
  return () => {};
};
window.eagleMV.reportMenuState = report => window.__menuReports.push(report);
