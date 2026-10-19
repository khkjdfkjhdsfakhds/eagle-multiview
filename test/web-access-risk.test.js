'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

test('W-03: the Web 访问 window says the connection is plain HTTP', () => {
  const dialog = html.slice(html.indexOf('<div id="webAccessDialog"'), html.indexOf('<datalist id="tagSuggestions">'));
  const note = dialog.match(/<p class="web-access-risk" role="note">([^<]+)<\/p>/);
  assert.ok(note, 'risk note present inside the dialog');
  assert.match(note[1], /明文 HTTP/);
  assert.match(note[1], /自家 Wi‑Fi/);
  assert.match(note[1], /访问密钥开启/);
  // Shown before the switches, right under the introduction.
  assert.ok(dialog.indexOf('web-access-risk') < dialog.indexOf('id="webAccessEnabled"'));
  assert.match(css, /\.web-access-card \.web-access-risk \{[^}]*font-size: 12px/);
});
