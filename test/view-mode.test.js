'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

test('each pane owns a four-way view mode with per-slot persistence', () => {
  // viewMode rides the pane proxy like sort does.
  assert.match(rendererSource, /'sortDir', 'viewMode', 'viewTitle'/);
  assert.ok(rendererSource.includes("const paneViewModes = new Set(['justified', 'grid', 'waterfall', 'list'])"));
  // The toolbar renders one button per mode inside every pane.
  for (const mode of ['justified', 'grid', 'waterfall', 'list']) {
    assert.ok(rendererSource.includes(`data-view-mode="${mode}"`), `模板缺少 ${mode} 按钮`);
  }
  // Selection persists per pane slot and restores on pane creation.
  assert.ok(rendererSource.includes("localStorage.setItem('eaglemv.paneViewModes'"));
  assert.ok(rendererSource.includes('storedPaneViewModes()[id]'));
  // The grid applies the mode class where cards render.
  assert.ok(rendererSource.includes('asset-grid${viewModeClass}'));
  // Bound per pane, switching activates that pane first.
  assert.ok(rendererSource.includes("setPaneViewMode(button.dataset.viewMode, paneId)"));
});

test('waterfall uses CSS columns and list restyles rows without overlays', () => {
  assert.match(cssSource, /\.asset-grid\.waterfall\s*\{[^}]*columns:/);
  assert.match(cssSource, /\.asset-grid\.waterfall \.item-card\s*\{[^}]*break-inside: avoid/);
  assert.match(cssSource, /\.asset-grid\.list \.item-card\s*\{[^}]*grid-template-columns/);
  assert.match(cssSource, /\.asset-grid\.list \.card-stars,\s*\n\.asset-grid\.list \.format-badge,\s*\n\.asset-grid\.list \.pin-badge \{ display: none; \}/);
  // The justified filler pseudo-element belongs to that one mode: every layout
  // now carries its own class, including the default.
  assert.ok(cssSource.includes('.asset-grid.justified::after'));
  assert.ok(!cssSource.includes('.asset-grid:not('), 'no exclusion selectors left to drift');
  assert.match(rendererSource, /const viewModeClass = ` \$\{paneViewModes\.has\(state\.viewMode\) \? state\.viewMode : 'justified'\}`;/);
});

test('the grid layout uses equal square cells', () => {
  assert.match(cssSource, /\.asset-grid\.grid\s*\{[^}]*display: grid/);
  assert.match(cssSource, /\.asset-grid\.grid\s*\{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(var\(--thumb\), 1fr\)\)/);
  // Square cells: the justified aspect-ratio and flex-basis both have to go.
  assert.ok(cssSource.includes('.asset-grid.grid .thumb-wrap { aspect-ratio: 1; }'));
  assert.ok(cssSource.includes('.asset-grid.grid .item-card { flex: none; }'));
  assert.ok(rendererSource.includes(`data-view-mode="grid" title="网格"`));
  assert.ok(rendererSource.includes('layoutGrid:'), 'the toolbar button has an icon');
});
