'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('no <label> wraps buttons, tag chips or colour swatches', () => {
  const sources = ['src/index.html', 'src/renderer.js', 'src/feature-ui.js']
    .map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
  for (const source of sources) {
    for (const [, body] of source.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
      assert.equal(/<button\b|tag-chips|color-filter|<label\b/.test(body), false, `label wraps a clickable group: ${body.slice(0, 120)}`);
    }
  }
});

test('clicking a shared tag name or its caption removes nothing', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/label-click-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_LABEL_CLICK '));
  assert.ok(line, `missing label click result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_LABEL_CLICK '.length));
  assert.deepEqual(result.removals, []);
  assert.deepEqual(result.shared, ['alpha', 'beta']);
});
