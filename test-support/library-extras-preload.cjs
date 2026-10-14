'use strict';
require('./renderer-ui-preload.cjs');
// B3-08 / H-11: the extras RPCs can be held or made to fail on demand.
window.__extras = { holdOrders: false, failPins: false, ordersWaiters: [], pinsReply: { f: { i: 1 } } };
window.eagleMV.getPins = async () => {
  if (window.__extras.failPins) throw new Error('transient');
  return window.__extras.pinsReply;
};
window.eagleMV.getTagColors = async () => ({ red: '#ff0000' });
window.eagleMV.getManualOrders = async () => {
  if (window.__extras.holdOrders) await new Promise(resolve => window.__extras.ordersWaiters.push(resolve));
  return {};
};
window.__extrasRelease = () => { for (const resolve of window.__extras.ordersWaiters.splice(0)) resolve(); };
