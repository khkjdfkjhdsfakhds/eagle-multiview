'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

test('folder covers keep Eagle proportions and constrain both image axes', () => {
  const thumbnailRule = styles.match(/\.folder-thumbnail\s*\{([^}]+)\}/)?.[1] || '';
  const imageRule = styles.match(/\.folder-cover img\s*\{([^}]+)\}/)?.[1] || '';

  assert.match(thumbnailRule, /padding-bottom:\s*calc\(75% \+ 10px\)/);
  assert.match(imageRule, /position:\s*absolute/);
  assert.match(imageRule, /max-width:\s*calc\(100% - 8px\)/);
  assert.match(imageRule, /max-height:\s*calc\(100% - 8px\)/);
  assert.match(imageRule, /transform:\s*translate\(-50%, -50%\)/);
});
