'use strict';
require('./review-bugfixes-preload.cjs');
window.__askText = [];
window.eagleMV.setTagColor = async payload => { window.__askText.push({ kind: 'tag-color', ...payload }); return { [payload.tag]: payload.color }; };
window.eagleMV.addComment = async payload => { window.__askText.push({ kind: 'comment', ...payload }); return { ok: true }; };
window.eagleMV.getComments = async () => [];
// Electron's prompt() shows nothing and returns null; prove nothing relies on it.
window.prompt = () => { window.__askText.push({ kind: 'native-prompt' }); return null; };
