'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');

// The thumbnail-size slider is the desktop "zoom" control. It used to be
// hidden by a max-width media query measured in zoomed CSS pixels, so zooming
// the interface (⌘+/⌘-) shrank the viewport below the threshold and the
// slider vanished at ordinary zoom levels. It must only disappear in the
// phone/tablet drawer layout, never because the window was zoomed.

test('the size slider only hides in the compact drawer layout', () => {
  const tabletStart = styles.indexOf('@media (max-width: 1120px)');
  const drawerStart = styles.indexOf('@media (max-width: 900px)', tabletStart);
  assert.ok(tabletStart >= 0 && drawerStart > tabletStart, 'the <=1120px media block still exists before the drawer block');
  const tabletBlock = styles.slice(tabletStart, drawerStart);
  assert.ok(!tabletBlock.includes('.size-control'), 'the <=1120px block must not hide the size slider');
  assert.ok(!tabletBlock.includes('.toolbar-control-divider'), 'the divider must stay visible with the slider');

  const drawerBlock = styles.slice(drawerStart, styles.indexOf('@media (max-width: 600px)', drawerStart));
  assert.ok(drawerBlock.includes('.toolbar .size-control'), 'the compact drawer layout still hides the slider');
});

test('the workspace resizer stays above the toolbar so the whole line is draggable', () => {
  const resizer = styles.slice(styles.indexOf('.workspace-resizer {'), styles.indexOf('.workspace-resizer {') + 220);
  const toolbar = styles.slice(styles.indexOf('.toolbar {'), styles.indexOf('.toolbar {') + 120);
  const resizerZ = Number(/z-index:\s*(\d+)/.exec(resizer)?.[1]);
  const toolbarZ = Number(/z-index:\s*(\d+)/.exec(toolbar)?.[1]);
  assert.ok(resizerZ > toolbarZ, `resizer z-index (${resizerZ}) must exceed toolbar z-index (${toolbarZ})`);
});

test('both panels compress further and the drag clamp matches the grid minimum', () => {
  const resizerCode = renderer.slice(renderer.indexOf('function bindWorkspaceResizers()'), renderer.indexOf('function restorePanelSizes()'));
  assert.ok(resizerCode.includes("const contentMin = rect.width <= 1120 ? 360 : 400;"), 'the drag clamp tracks the middle column grid minimum');
  assert.ok(resizerCode.includes("Math.max(kind === 'sidebar' ? 115 : 125"), 'sidebar floor 115px, inspector floor 125px');
  assert.ok(!resizerCode.includes(': 220'), 'the old 220px inspector floor is gone');
});

function ruleBlock(source, opener) {
  const start = source.indexOf(opener);
  assert.ok(start >= 0, `找不到规则 ${opener}`);
  const end = source.indexOf('}', start);
  assert.ok(end > start, `规则未闭合 ${opener}`);
  return source.slice(start, end + 1);
}

test('the toolbar stays one row whenever the middle column has room', () => {
  // The search box must be able to shrink below the placeholder's intrinsic
  // width, or the toolbar wraps to two rows even when the middle column is
  // ample (the exact bug reported at 1280px/1.4x zoom with 150px panels).
  const toolbarSearch = ruleBlock(styles, '.toolbar .search-box {');
  assert.ok(toolbarSearch.includes('flex: 1 1 150px;'), 'search box uses a small shrinkable flex basis');
  assert.ok(toolbarSearch.includes('min-width: 0;'), 'search box may shrink below its placeholder width');
  assert.ok(styles.includes('flex-wrap: wrap;'), 'the toolbar still wraps when space genuinely runs out');
});

test('narrow inspectors shrink inputs and ellipsize action buttons', () => {
  const inputRule = ruleBlock(styles, '.inspector input, .inspector textarea { width: 100%;');
  assert.ok(inputRule.includes('min-width: 0;'), 'inspector inputs may shrink below their intrinsic width');
  const buttonRule = ruleBlock(styles, '.inspector-actions button {');
  assert.ok(buttonRule.includes('text-overflow: ellipsis;'), 'action button labels ellipsize instead of overflowing');
});
