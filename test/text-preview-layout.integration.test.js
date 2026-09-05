'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('TXT editor uses remaining space and every control stays visible through recovery, errors, narrow panes, zoom and mobile Web', { timeout: 90000 }, async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('electron'), ['--disable-logging', require.resolve('../test-support/text-preview-layout-probe.cjs')], { env, timeout: 80000 });
  const rows = stdout.split('\n').filter(line => line.startsWith('TXT_LAYOUT ')).map(line => JSON.parse(line.slice(11)));
  assert.equal(rows.length, 27);
  for (const row of rows) {
    const evidence = `${row.name}: ${JSON.stringify(row)}`;
    assert.equal(row.zoomFactor, row.config.zoom || 1, `requested browser zoom was not applied: ${evidence}`);
    assert.ok(row.initialSelectFits, `recovery prompt clipped before choosing a draft: ${evidence}`);
    assert.equal(row.restored, Boolean(row.config.recovery), `recovery control did not restore the selected draft: ${evidence}`);
    assert.equal(row.toolbars.length, row.config.recovery ? 2 : 1, evidence);
    if (!row.config.error && row.preview.width > 600) {
      assert.ok(row.toolbars.every(rect => rect.height <= 62), `toolbar expanded into editor space: ${evidence}`);
      assert.ok(row.editor.height >= row.preview.height * 0.65, `editor collapsed: ${evidence}`);
    }
    assert.ok(row.editor.height >= 80, `editor has no usable content area: ${evidence}`);
    assert.ok(Math.abs(row.editor.bottom - row.preview.bottom + 1) <= 2, `editor does not fill remaining height: ${evidence}`);
    assert.ok(Math.abs(row.editor.top - row.toolbars.at(-1).bottom) <= 2, `unused gap above editor: ${evidence}`);
    assert.ok(row.overflow.scrollWidth <= row.overflow.clientWidth + 1, `horizontal overflow: ${evidence}`);
    assert.ok(row.overflow.scrollHeight <= row.overflow.clientHeight + 1, `vertical overflow: ${evidence}`);
    assert.ok(row.status.rect.top >= row.toolbars[0].top && row.status.rect.bottom <= row.toolbars[0].bottom, `status escaped toolbar: ${evidence}`);
    assert.ok(row.status.scrollWidth <= row.status.clientWidth + 1, `status text clipped: ${evidence}`);
    for (const control of row.controls) {
      assert.ok(control.rect.left >= row.preview.left && control.rect.right <= row.preview.right, `control outside preview: ${evidence}`);
      assert.ok(control.rect.top >= row.preview.top && control.rect.bottom <= row.editor.top, `control overlaps editor: ${evidence}`);
      assert.ok(control.hit, `control is not hit-testable: ${evidence}`);
      // Native selects may ellipsize a long draft excerpt; their initial prompt
      // must fit, and all action-button labels must remain completely visible.
      if (control.tag === 'BUTTON') assert.ok(control.scrollWidth <= control.clientWidth + 1, `control label clipped: ${evidence}`);
      assert.ok(control.scrollHeight <= control.clientHeight + 1, `wrapped control label clipped vertically: ${evidence}`);
    }
  }
});
