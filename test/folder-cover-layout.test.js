'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');

test('folder covers keep Eagle proportions and constrain both image axes', () => {
  const thumbnailRule = styles.match(/\.folder-thumbnail\s*\{([^}]+)\}/)?.[1] || '';
  const imageRule = styles.match(/\.folder-cover img\s*\{([^}]+)\}/)?.[1] || '';

  assert.match(thumbnailRule, /padding-bottom:\s*calc\(75% \+ 10px\)/);
  assert.match(imageRule, /position:\s*absolute/);
  assert.match(imageRule, /max-width:\s*calc\(100% - 8px\)/);
  assert.match(imageRule, /max-height:\s*calc\(100% - 8px\)/);
  assert.match(imageRule, /transform:\s*translate\(-50%, -50%\)/);
});

test('asset previews use their own aspect-ratio flow instead of the folder grid', () => {
  const itemGridRule = styles.match(/\.item-grid\s*\{([^}]+)\}/)?.[1] || '';
  const folderGridRule = styles.match(/\.folder-grid\s*\{([^}]+)\}/)?.[1] || '';
  const assetGridRule = styles.match(/\.asset-grid\s*\{([^}]+)\}/)?.[1] || '';
  // Anchored: layout-specific rules like `.asset-grid.grid .item-card` also
  // contain `.item-card` and would otherwise be matched first.
  const cardRule = styles.match(/^\.item-card\s*\{([^}]+)\}/m)?.[1] || '';
  const thumbnailRule = styles.match(/^\.thumb-wrap\s*\{([^}]+)\}/m)?.[1] || '';

  assert.match(itemGridRule, /display:\s*block/);
  assert.match(folderGridRule, /display:\s*grid/);
  assert.match(folderGridRule, /grid-template-columns:\s*repeat\(auto-fill, minmax\(min\(var\(--thumb\), 100%\), 1fr\)\)/);
  assert.match(assetGridRule, /display:\s*flex/);
  assert.match(assetGridRule, /flex-wrap:\s*wrap/);
  assert.match(cardRule, /flex:\s*var\(--item-aspect\) 1 calc\(var\(--thumb\) \* var\(--item-aspect\)\)/);
  assert.match(thumbnailRule, /aspect-ratio:\s*var\(--item-aspect\)/);
  assert.doesNotMatch(thumbnailRule, /aspect-ratio:\s*1\s*\/\s*1/);
  assert.match(renderer, /function itemThumbnailAspect\(item\)/);
  assert.match(renderer, /class="folder-grid"/);
  assert.match(renderer, /class="asset-grid\$\{viewModeClass\}"/);
  assert.match(renderer, /style="--item-aspect: \$\{aspect\.toFixed\(4\)\}"/);
});
