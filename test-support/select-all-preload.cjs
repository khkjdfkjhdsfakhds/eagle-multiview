'use strict';
require('./renderer-ui-preload.cjs');
// P6-02: a view larger than one page, served page by page like the hub.
const count = Number(process.env.EAGLEMV_SELECT_ALL_COUNT || 400);
const items = Array.from({ length: count }, (_, index) => ({ id: `i${index}`, name: `i${index}`, ext: 'png', width: 10, height: 10, tags: [], folders: [] }));
window.eagleMV.query = async ({ offset = 0, limit = 160 } = {}) => {
  const data = items.slice(offset, offset + limit).map(item => ({ ...item }));
  return { data, total: items.length, nextOffset: offset + data.length, hasMore: offset + data.length < items.length };
};
