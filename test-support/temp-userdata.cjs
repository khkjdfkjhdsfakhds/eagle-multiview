'use strict';
// A throwaway userData directory for an Electron probe, removed when the
// probe process exits (T-14: probes used to leave one behind per run).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempUserData(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const remove = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  // Electron's quit does not always reach Node's 'exit'; will-quit does.
  require('electron').app?.on?.('will-quit', remove);
  process.on('exit', remove);
  return dir;
}

module.exports = { tempUserData };
