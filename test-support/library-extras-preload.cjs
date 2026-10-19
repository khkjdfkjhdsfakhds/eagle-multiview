'use strict';
require('./renderer-ui-preload.cjs');
// B3-08 / H-11: the extras RPCs can be held or made to fail on demand.
window.__extras = { holdOrders: false, failPins: false, ordersWaiters: [], pinsReply: { f: { i: 1 } }, pinReads: 0, colorReads: 0 };
window.eagleMV.getPins = async () => {
  window.__extras.pinReads += 1;
  if (window.__extras.failPins) throw new Error('transient');
  return window.__extras.pinsReply;
};
window.eagleMV.getTagColors = async () => { window.__extras.colorReads += 1; return { red: '#ff0000' }; };
window.eagleMV.onTagDataChanged = callback => { window.__extrasTagDataChanged = callback; return () => {}; };
window.eagleMV.getManualOrders = async () => {
  if (window.__extras.holdOrders) await new Promise(resolve => window.__extras.ordersWaiters.push(resolve));
  return {};
};
window.__extrasRelease = () => { for (const resolve of window.__extras.ordersWaiters.splice(0)) resolve(); };
