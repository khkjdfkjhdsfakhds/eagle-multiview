'use strict';
// Group 6 C, step 1: Eagle's filter conditions in the filter panel — folder
// and format lists with counts, include / exclude, the 任意/全部/相同 switch,
// excluded tags and 未标签, quick dates and months, 标注 and duration.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('filter panel in a real renderer', { timeout: 60000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/filter-panel-probe.cjs')], { env, timeout: 55000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_FILTER_PANEL '));
  assert.ok(line, `missing filter panel result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_FILTER_PANEL '.length));

  assert.deepEqual(result.folders, [['未分类', '1', ''], ['甲', '2', ''], ['乙', '1', ''], ['丙', '1', '']]);
  assert.deepEqual(result.exts, [['PNG', '2', ''], ['JPG', '1', ''], ['MP4', '1', '']], 'formats by count, with counts');
  assert.deepEqual(result.presets, ['今日', '昨日', '最近 7 日', '最近 30 日', '最近 90 日', '最近 365 日']);
  assert.deepEqual(result.logic, ['任意*', '全部', '相同'], 'Eagle starts on 任意');
  assert.equal(result.folderChecked, '+');
  assert.equal(result.openAfterClick, true, 'ticking a row keeps the panel open');
  assert.deepEqual(result.folderMarks, ['未分类', '甲+', '乙-', '丙']);
  assert.equal(result.extExcluded, '-', 'right-click excludes a format');
  assert.equal(result.excludedChip, true, 'right-click turns a tag chip into an exclusion');
  assert.equal(result.badgeTags, '1', 'the whole tag rule is one badge entry');
  assert.equal(result.months, 3);
  assert.equal(result.commentsTextEnabled, true, '标注 keywords open up with 有标注');
  assert.deepEqual(result.durationStored, { min: 60, max: null }, '1 minute is stored as 60 seconds');
  assert.equal(result.stillOpen, true);
  assert.equal(result.popoverFits, true, 'the panel stays inside a 980×640 window');
  assert.equal(result.noOverflow, true, 'no section overflows sideways');
  assert.equal(result.panelOnTop, true, 'the inspector resizer does not cover the panel');
  assert.equal(result.lastQueryHasNoFilter, true, 'every control clears back to no filter');
});
