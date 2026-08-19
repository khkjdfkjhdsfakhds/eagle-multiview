'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
const indexHTML = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');

test('the slideshow is built on the preview, not beside it', () => {
  assert.ok(renderer.includes('slideshow: { timer: null, intervalMs: 4000 },'));
  assert.ok(renderer.includes('function toggleSlideshow()'));
  assert.ok(renderer.includes('function advanceSlideshow()'));
  assert.ok(renderer.includes('function scheduleSlideshowStep()'));
  // Advancing goes through movePreview, so zoom reset, chrome, lazy paging and
  // the neighbour prefetch all stay on the same path as manual navigation.
  assert.ok(renderer.includes("if (await movePreview(1, { fromSlideshow: true })) return true;"));
  assert.ok(indexHTML.includes('id="slideshowToggle"'));
  assert.ok(indexHTML.includes('id="slideshowInterval"'));
  assert.ok(indexHTML.indexOf('id="slideshowControls"') < indexHTML.indexOf('id="closePreview"'), 'controls sit opposite the close button');
});

test('a running show cannot outlive its preview', () => {
  assert.match(
    renderer,
    /function closePreview\([^)]*\)\s*\{\s*if \(!skipDiscard && state\.textSession\?\.dirty && !confirmDiscardChanges\(\)\) return false;\s*stopSlideshow\(\);/,
    'closing the preview stops the timer'
  );
  // Every timer is cleared before a new one is set, so a stray schedule cannot
  // leave two running at once.
  assert.ok(renderer.includes('if (state.slideshow.timer) clearTimeout(state.slideshow.timer);\n  state.slideshow.timer = setTimeout'));
  assert.ok(renderer.includes('if (!state.previewId) return renderSlideshow();'), 'a closed preview ends the step');
  assert.ok(renderer.includes('else stopSlideshow();'), 'running out of items ends the show');
});

test('a refused preview ends the show instead of reprompting forever', () => {
  // openPreview can be refused — an unsaved TXT asks first. Reporting "moved"
  // on a refusal would make the slideshow reopen that confirm every few
  // seconds, so movePreview reports whether the preview actually changed.
  assert.ok(renderer.includes('return Boolean(next) && state.previewId !== before;'));
  assert.ok(renderer.includes('  const before = state.previewId;\n  if (next) await openPreview(next.id);'));
  assert.ok(renderer.includes('    if (advanced && state.previewId) scheduleSlideshowStep();\n    else stopSlideshow();'));
});

test('the end of the list wraps instead of stalling', () => {
  const advance = renderer.slice(renderer.indexOf('async function advanceSlideshow()'), renderer.indexOf('function toggleSlideshow()'));
  assert.ok(advance.includes('if (items.length < 2 || items[0].id === before) return false;'), 'a one-item view has nowhere to wrap to');
  assert.ok(advance.includes('return openPreview(items[0].id);'));
});

test('stepping by hand restarts the dwell', () => {
  assert.ok(renderer.includes('if (!fromSlideshow && slideshowPlaying()) scheduleSlideshowStep();'));
  // Changing the interval applies to the picture on screen, not just the next.
  assert.ok(renderer.includes('if (slideshowPlaying()) scheduleSlideshowStep();'));
});

test('the interval is remembered and the controls stay tappable', () => {
  assert.ok(renderer.includes("const SLIDESHOW_INTERVAL_KEY = 'eaglemv.slideshowInterval';"));
  assert.ok(renderer.includes('localStorage.setItem(SLIDESHOW_INTERVAL_KEY'));
  assert.ok(renderer.includes("[...$('#slideshowInterval').options].some(option => Number(option.value) === interval)"),
    'a stored value must still be one of the offered intervals');
  // The modal captures pointers for swipe/pinch; the controls have to opt out.
  assert.ok(renderer.includes("if (event.target.closest('#slideshowControls, #modalRating')) return;"));
  assert.ok(styles.includes('.slideshow-controls, .modal-rating { touch-action: auto; }'));
  assert.match(styles, /@media \(pointer: coarse\)[\s\S]*?\.slideshow-button \{ width: 44px; height: 44px;/);
});

test('S toggles the show only while a preview is open', () => {
  // ⌘S already saves the TXT editor and the inspector, so pick the plain-S line.
  const line = renderer.split('\n').find(text => text.includes("event.key.toLowerCase() === 's'") && text.includes('previewOpen'));
  assert.ok(line, 'the S binding exists');
  assert.ok(line.includes('previewOpen'), 'it is scoped to the preview');
  assert.ok(line.includes('!editable'), 'typing an "s" in a field is not a shortcut');
  assert.ok(line.includes('!primaryKey') && line.includes('!event.shiftKey') && line.includes('!event.altKey'),
    'plain S only, so ⌘S and friends are untouched');
});
