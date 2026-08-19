'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
const indexHTML = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');

test('the preview carries its own rating row', () => {
  assert.ok(indexHTML.includes('id="modalRating"'));
  assert.ok(renderer.includes('function renderPreviewRating(item)'));
  assert.ok(renderer.includes('function ratePreviewItem(rating)'));
  // Repainted from one place, so it can never disagree with the item shown.
  assert.ok(renderer.includes('  renderPreviewRating(item);\n  $(\'#prevPreview\').disabled'));
  assert.ok(renderer.includes("if (state.previewId) updatePreviewChrome("), 'a rating repaints the row');
  assert.ok(styles.includes('.modal-star.filled { color: #ffce69; }'));
});

test('clicking a lit star clears the rating, as Eagle does', () => {
  assert.ok(renderer.includes("ratePreviewItem(value === Number(event.currentTarget.dataset.rating || 0) ? 0 : value);"));
  assert.ok(renderer.includes("row.dataset.rating = String(rating);"), 'the current rating is readable from the row');
});

test('rating from the preview targets the previewed item, not the selection', () => {
  assert.ok(
    renderer.includes('  if (previewOpen) ratePreviewItem(Number(event.key));\n      else setSelectionRating(') ||
    renderer.includes('if (previewOpen) {\n        ratePreviewItem(rating);\n        broadcastPaneAction(pane => { if (pane.previewId) ratePreviewItem(rating); });\n      } else {')
  );
  assert.ok(renderer.includes('setSelectionRating({ ids: [state.previewId], rating });'));
});

test('operations that leave items on screen keep the selection', () => {
  // Rating and tag-adding remove nothing from the view, so the selection
  // survives; only failures are singled out, mirroring mutateSelectionSet's
  // keepSelection (which tag *removal* already used — the two were
  // inconsistent). Trash and move still clear, because their items leave.
  const keep = renderer.match(/pane\.selected = new Set\(outcome\.failed\.length\n\s+\? outcome\.failed\n\s+: ids\.filter\(id => pane\.items\.some\(item => item\.id === id\)\)\);/g) || [];
  assert.strictEqual(keep.length, 2, '评分与批量加标签各一处');
  const clears = renderer.match(/pane\.selected = new Set\(outcome\.failed\);/g) || [];
  assert.strictEqual(clears.length, 2, '只剩废纸篓与移动两处仍然清空');
});

test('preview view options: transparent backing and grayscale', () => {
  assert.ok(indexHTML.includes('id="previewBackground"'));
  assert.ok(indexHTML.includes('id="previewGrayscale"'));
  assert.ok(renderer.includes('function cyclePreviewBackground()'));
  assert.ok(renderer.includes('function togglePreviewGrayscale()'));
  // Four states, cycling, with the button chip showing the current one.
  assert.ok(renderer.includes("{ key: 'none'") && renderer.includes("{ key: 'checker'")
    && renderer.includes("{ key: 'white'") && renderer.includes("{ key: 'black'"));
  assert.ok(renderer.includes('PREVIEW_BACKGROUNDS[(index + 1) % PREVIEW_BACKGROUNDS.length]'));
  // Classes live on the modal, so swapping images keeps the setting.
  assert.ok(renderer.includes("modal.classList.toggle(`bg-${option.key}`, option.key === background)"));
  assert.ok(renderer.includes("modal.classList.toggle('preview-grayscale', grayscale)"));
  // The backing paints the image's own box, not the whole modal.
  assert.ok(styles.includes('.preview-modal.bg-checker .preview-image {'));
  assert.ok(styles.includes('.preview-modal.preview-grayscale .preview-image { filter: grayscale(1); }'));
  assert.ok(!styles.includes('.preview-modal.bg-checker .modal-media'), 'the modal itself must not take the backing');
  // Remembered, and only a known background is restored.
  assert.ok(renderer.includes("const PREVIEW_VIEW_KEY = 'eaglemv.previewView';"));
  assert.ok(renderer.includes('PREVIEW_BACKGROUNDS.some(option => option.key === stored?.background)'));
  // B and G are preview-scoped like S.
  for (const [letter, fn] of [['b', 'cyclePreviewBackground()'], ['g', 'togglePreviewGrayscale()']]) {
    const line = renderer.split('\n').find(text => text.includes(`event.key.toLowerCase() === '${letter}'`) && text.includes('previewOpen'));
    assert.ok(line, `${letter} binding exists`);
    assert.ok(line.includes('!editable') && line.includes('!primaryKey'), `${letter} is plain and not while typing`);
    assert.ok(renderer.includes(`      ${fn};`), `${letter} calls ${fn}`);
  }
});
