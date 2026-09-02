'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { assertCleanElectronStderr } = require('../test-support/electron-stderr.cjs');

const execFileAsync = promisify(execFile);

test('preview HUD: the desktop app hides ‹ › ×, the web client shows them, and the HUD fades out after inactivity', { timeout: 20000 }, async () => {
  const electron = require('electron');
  const runner = require.resolve('../test-support/preview-hud-probe.cjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await execFileAsync(electron, ['--disable-logging', runner], { env, timeout: 18000 });
  assertCleanElectronStderr(assert, stderr, 'preview HUD runner');
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_HUD '));
  assert.ok(line, `missing preview HUD result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_HUD '.length));
  // Desktop app keeps the three buttons hidden (Esc/arrows cover those actions).
  assert.equal(result.desktop.close, 'none', 'desktop hides the close button');
  assert.equal(result.desktop.prev, 'none', 'desktop hides the previous button');
  assert.equal(result.desktop.next, 'none', 'desktop hides the next button');
  // Web client shows the HUD buttons.
  assert.equal(result.web.close, 'grid', 'web client shows the close button');
  assert.equal(result.web.prev, 'grid', 'web client shows the previous button');
  assert.equal(result.web.next, 'grid', 'web client shows the next button');
  assert.equal(result.web.rating, 'flex', 'web client shows touch rating controls');
  assert.equal(result.web.slideshow, 'flex', 'web client shows slideshow controls');
  assert.equal(result.web.previewBackground, 'none', 'web client does not expose unrelated preview-view controls');
  assert.equal(result.slideshowPressed, 'true', 'the visible slideshow control starts playback');
  // The HUD stays low-presence (not fully opaque) while visible.
  assert.ok(result.web.closeOpacity < 1, 'the web close button is semi-transparent, not opaque');
  // After inactivity the HUD fades out.
  assert.ok(result.hudHidden.closeOpacity < 0.01, `the HUD fades to nearly transparent (got ${result.hudHidden.closeOpacity})`);
  assert.ok(result.hudHidden.close === 'grid' && result.hudHidden.prev === 'grid', 'fading keeps the buttons present for the transition');
});

test('preview HUD rules are scoped to the web client only', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
  // The show rules must target body.web-client so the desktop app stays hidden.
  assert.ok(styles.includes('body.web-client .content-pane .modal-close'), 'the show rule targets body.web-client');
  assert.ok(styles.includes('body.web-client .content-pane .modal-nav'), 'the show rule targets body.web-client');
});
