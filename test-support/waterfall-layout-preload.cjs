'use strict';
// 400 images of varied aspect ratio in one folder, served in pages so the
// 瀑布流 probe can append a page and check the earlier cards stay put.
require('./renderer-ui-preload.cjs');
const shapes = [[10, 10], [10, 20], [20, 10], [10, 15], [30, 10]];
const items = Array.from({ length: 400 }, (_, index) => {
  const [width, height] = shapes[(index * 7 + Math.floor(index / 3)) % shapes.length];
  return { id: `w-${index}`, name: `Image ${index}`, ext: 'jpg', width, height, size: 100 + index,
    modificationTime: 1000 + index, folders: ['mv-folder'], tags: [] };
});
window.eagleMV.query = async ({ offset = 0, limit = 160 } = {}) => {
  const data = items.slice(offset, offset + limit).map(item => ({ ...item }));
  return { data, total: items.length, nextOffset: offset + data.length, hasMore: offset + data.length < items.length };
};
