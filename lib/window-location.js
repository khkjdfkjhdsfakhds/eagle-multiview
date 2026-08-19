'use strict';

const { findFolder } = require('../src/folder-navigation');
const { windowStateForView } = require('../src/window-target');

const rootWindowState = () => windowStateForView({ kind: 'root' });

async function resolveEagleWindowState(client) {
  try {
    const selected = await client.selectedFolder();
    if (!selected?.id) return rootWindowState();
    const folders = await client.folderTree();
    if (!findFolder(folders, selected.id)) return rootWindowState();
    return windowStateForView({ kind: 'folder', id: selected.id });
  } catch {
    return rootWindowState();
  }
}

module.exports = { resolveEagleWindowState, rootWindowState };
