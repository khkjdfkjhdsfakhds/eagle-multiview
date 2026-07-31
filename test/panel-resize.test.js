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

test('both panels compress to 150px and the drag clamp matches the grid minimum', () => {
  const resizerCode = renderer.slice(renderer.indexOf('function bindWorkspaceResizers()'), renderer.indexOf('function restorePanelSizes()'));
  assert.ok(resizerCode.includes("const contentMin = rect.width <= 1120 ? 360 : 400;"), 'the drag clamp tracks the middle column grid minimum');
  assert.ok(resizerCode.includes('const next = Math.max(150, Math.min(max, startValue + delta));'), 'both panels share the 150px floor');
  assert.ok(!resizerCode.includes(': 220'), 'the old 220px inspector floor is gone');
});
