'use strict';
require('./renderer-ui-preload.cjs');
// B2-03 / B2-07: folders with counts; a search in A also matches its child.
const library = {
  path: '/tmp/EagleMV-UI-Test.library',
  name: '测试资料库',
  smartFolders: [],
  folders: [
    { id: 'A', name: 'A', imageCount: 10, children: [{ id: 'A1', name: 'A1', imageCount: 50, children: [] }] },
    { id: 'B', name: 'B', imageCount: 5, children: [] }
  ]
};
window.eagleMV.connect = async () => ({ app: { version: 'ui-test' }, library });
const item = id => ({ id, name: id, ext: 'png', width: 10, height: 10, tags: [], folders: [] });
window.eagleMV.query = async query => {
  if (query.folderId === 'B') return { data: [item('b')], total: 20, nextOffset: 1, hasMore: false };
  const searching = Boolean(String(query.search || '').trim());
  return { data: [item('a')], total: searching ? 30 : 10, nextOffset: 1, hasMore: false };
};
