'use strict';

// Sidebar and secondary text follow Eagle's own values (app.css in Eagle 4):
// 26px rows of 13px/400 text in --color-text-primary, 11px monospace counts at
// 60% white, 12px section labels, and counts that follow Eagle's rules —
// quick access shows a folder's own items, the tree shows the subtree total
// while collapsed and the own count once expanded, zero shows nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

function extract(name) {
  const start = renderer.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  return renderer.slice(start, renderer.indexOf('\n}\n', start) + 2);
}

const sandbox = {};
vm.runInNewContext(['folderCountBadge', 'folderTreeCount', 'countFolders'].map(extract).join('\n')
  + '\nthis.api = { folderCountBadge, folderTreeCount, countFolders };', sandbox);
const { folderCountBadge, folderTreeCount, countFolders } = sandbox.api;

function rule(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} rule must exist`);
  return styles.slice(start, styles.indexOf('}', start));
}

test('count badges use separators and hide zero like Eagle', () => {
  assert.equal(folderCountBadge(48925), '<span class="folder-count">48,925</span>');
  assert.equal(folderCountBadge(4), '<span class="folder-count">4</span>');
  assert.equal(folderCountBadge(0), '');
  assert.equal(folderCountBadge(undefined), '');
});

test('tree counts: subtree total when collapsed, own items when expanded', () => {
  const folder = { imageCount: 1, descendantImageCount: 9828 };
  assert.equal(folderTreeCount(folder, false), 9828);
  assert.equal(folderTreeCount(folder, true), 1);
  assert.equal(folderTreeCount({ imageCount: 7 }, false), 7, 'falls back to own count');
});

test('quick access shows own counts and section labels carry totals', () => {
  const tree = extract('renderFolderTree');
  const quick = tree.slice(tree.indexOf('const quickHTML'), tree.indexOf('tree.innerHTML'));
  assert.ok(quick.includes('folderCountBadge(folder.imageCount)'));
  assert.ok(!quick.includes('descendantImageCount'), 'quick access must not show subtree totals');
  assert.ok(tree.includes('快速访问 (${quickEntries.length})'));
  assert.ok(tree.includes('文件夹 (${countFolders(state.library.folders)})'));
  assert.equal(countFolders([{ children: [{ children: [] }, { children: [{}] }] }, {}]), 5);
});

test('sidebar rows use Eagle sizes and near-white text', () => {
  const row = rule('.folder-row');
  assert.match(row, /height: 26px;/);
  assert.match(row, /color: #f8f9fb;/);
  assert.match(rule('.folder-count'), /11px ui-monospace/);
  const label = rule('.folder-section-label');
  assert.match(label, /font-size: 12px;/);
  assert.doesNotMatch(label, /uppercase/);
  assert.match(rule('.card-meta'), /font-size: 11px;/);
  assert.match(rule('.card-meta'), /white-space: nowrap;/, 'meta must not wrap on narrow cards');
});

test('touch layouts get finger-sized rows and a 12px text floor', () => {
  const touch = styles.slice(styles.lastIndexOf('@media (pointer: coarse) {'));
  assert.match(touch, /\.folder-row \{ height: 40px; \}/);
  assert.match(touch, /\.folder-children > \.folder-node::before \{ top: 20px; \}/);
  assert.match(touch, /\.card-meta, \.folder-meta, \.folder-count[^{]*\{ font-size: 12px; \}/);
});
