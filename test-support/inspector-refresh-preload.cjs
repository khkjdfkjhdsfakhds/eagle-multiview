'use strict';
// One folder of images whose metadata a probe can change between refreshes,
// with counters for the inspector's comment and generation-metadata reads.
require('./renderer-ui-preload.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const items = Array.from({ length: 3 }, (_, index) => ({
  id: `i-${index}`, name: `Image ${index}`, ext: 'jpg', width: 10, height: 10, size: 100 + index,
  modificationTime: 1000 + index, folders: ['mv-folder'], tags: []
}));
window.__inspectorRefresh = { items, comments: 0, metadata: 0 };
window.eagleMV.query = async () => ({ data: clone(items), total: items.length, nextOffset: items.length, hasMore: false });
window.eagleMV.getComments = async () => {
  window.__inspectorRefresh.comments += 1;
  await new Promise(resolve => setTimeout(resolve, 30));
  return [{ id: 'c-1', annotation: 'note' }];
};
window.eagleMV.readMetadata = async id => {
  window.__inspectorRefresh.metadata += 1;
  return { metadata: { format: 'test', positive: `prompt for ${id}`, workflow: { nodes: [id] } } };
};
