'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

test('each pane owns a four-way view mode with per-slot persistence', () => {
  // viewMode rides the pane proxy like sort does.
  assert.match(rendererSource, /'sortDir', 'randomSeed', 'viewMode', 'viewTitle'/);
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

test('pane navigation, layout, and sort controls match the primary toolbar scale', () => {
  assert.match(cssSource, /\.heading-path-row \{[\s\S]*?border-bottom: 1px solid/);
  assert.match(cssSource, /\.heading-main-row \{[\s\S]*?display: flex;[\s\S]*?align-items: center/);
  assert.match(cssSource, /\.content-heading \{[\s\S]*?grid-template-rows: 24px 48px;/);
  assert.match(cssSource, /\.content-pane \.navigation-controls \{[\s\S]*?position: static;[\s\S]*?height: 34px;[\s\S]*?transform: none;[\s\S]*?\}/);
  assert.match(cssSource, /\.content-pane \.nav-button \{ width: 28px; height: 28px; \}/);
  assert.match(cssSource, /\.nav-button \.ui-icon, \.nav-image-icon \{ width: 16px; height: 16px;/);
  assert.match(cssSource, /\.view-mode-button \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;/);
  assert.match(cssSource, /\.view-mode-svg \{ width: 16px; height: 16px;/);
  assert.match(cssSource, /\.content-pane \.sort-select \{ max-width: 112px; height: 34px; font-size: 12px; \}/);
  assert.match(cssSource, /\.sort-dir-button \{[\s\S]*?width: 30px;[\s\S]*?height: 30px;[\s\S]*?font-size: 14px;/);
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
  assert.match(cssSource, /\.asset-grid\.grid\s*\{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(min\(var\(--thumb\), 100%\), 1fr\)\)/);
  // Square cells: the justified aspect-ratio and flex-basis both have to go.
  assert.ok(cssSource.includes('.asset-grid.grid .thumb-wrap { aspect-ratio: 1; }'));
  assert.ok(cssSource.includes('.asset-grid.grid .item-card { flex: none; }'));
  assert.ok(rendererSource.includes(`data-view-mode="grid" title="网格"`));
  assert.ok(rendererSource.includes('layoutGrid:'), 'the toolbar button has an icon');
});

test('the list layout earns extra columns, and only there', () => {
  assert.ok(rendererSource.includes("${state.viewMode === 'list' ? listRowColumns(item) : ''}"),
    'a grid of thousands must not carry three dead nodes per card');
  assert.ok(rendererSource.includes('function listRowColumns(item)'));
  assert.ok(rendererSource.includes('class="card-list-tags"'));
  assert.ok(rendererSource.includes('class="card-list-rating"'));
  assert.ok(rendererSource.includes('class="card-list-date"'));
  assert.match(cssSource, /\.asset-grid\.list \.item-card \{[^}]*grid-template-columns: 42px minmax\(0, 1\.6fr\) minmax\(0, 1fr\) 62px 84px auto/);
  // Narrow panes shed the soft columns in order rather than overflowing; the
  // last step drops the dimensions too, which a 185px four-way split needs.
  for (const [width, dropped] of [[620, '.card-list-date'], [500, '.card-list-tags'], [400, '.card-list-rating'], [300, '.card-meta']]) {
    const block = cssSource.slice(cssSource.indexOf(`@container (max-width: ${width}px) {`));
    assert.ok(block.startsWith(`@container (max-width: ${width}px) {`), `${width}px breakpoint exists`);
    assert.ok(block.slice(0, 320).includes(`${dropped} { display: none; }`) || block.slice(0, 320).includes(`${dropped} {\n    display: none;`)
      || block.slice(0, 320).includes(`.asset-grid.list ${dropped} { display: none; }`), `${width}px drops ${dropped}`);
  }
});
