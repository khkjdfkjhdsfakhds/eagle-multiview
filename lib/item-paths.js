'use strict';

const path = require('node:path');

// Item names come from Eagle metadata. A name with a separator or `..` must
// not lead a path built from it out of the item's own folder.
function fileInDirectory(directory, fileName) {
  const name = String(fileName || '');
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.includes('\0')) return null;
  const candidate = path.join(directory, name);
  return path.dirname(candidate) === path.normalize(directory).replace(/[\\/]+$/, '') ? candidate : null;
}

module.exports = { fileInDirectory };
