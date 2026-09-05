'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('UW-02/UW-04: real HTTP copying and every responsive pane layout remain usable', { timeout: 45000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/web-platform-probe.cjs')], { env, timeout: 40000 });
  const line = stdout.split('\n').find(row => row.startsWith('EAGLEMV_WEB_PLATFORM '));
  assert.ok(line, stdout);
  const result = JSON.parse(line.slice('EAGLEMV_WEB_PLATFORM '.length));
  assert.equal(result.geometry.length, 48);
  for (const row of result.geometry) {
    assert.ok(row.panes.every(pane => pane.reachable), `${row.width}/${row.layout}: pane not reachable by scrolling`);
    if (row.width === 390) {
      // A non-overlay scrollbar uses 15px on this host; compare usable content width.
      assert.ok(row.panes.every(pane => pane.width >= row.panelClientWidth - 1 && pane.width >= 340), `${row.layout}: narrow strips ${JSON.stringify(row)}`);
      assert.ok(row.panes.every(pane => pane.headingOverflow <= 1), `${row.layout}: heading overflow`);
      assert.equal(row.splittersVisible, false, 'desktop ratio handles are hidden in phone stack');
      if (row.panes.length > 1) assert.equal(row.overflowY, 'auto');
      else assert.ok(row.panes[0].height <= row.panelHeight + 1, 'single pane does not require a second outer scrollbar');
    }
  }
  assert.ok(result.ratios.before);
  assert.equal(result.ratios.phone, '');
  assert.equal(result.ratios.after, result.ratios.before);
  assert.deepEqual(result.copy, { secure: false, dialog: true, text: 'first line\nsecond line', selected: 22, fits: true, copied: true, focusRestored: true });
});
