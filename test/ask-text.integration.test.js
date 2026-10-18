'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('the renderer never calls window.prompt(), which Electron does not show', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  assert.equal(/(^|[^.\w])prompt\(/m.test(source), false);
});

test('comments and tag colours are asked through the in-app dialog', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require('../test-support/electron-binary.cjs'), ['--disable-logging', require.resolve('../test-support/ask-text-probe.cjs')], { env, timeout: 25000 });
  const line = stdout.split('\n').find(entry => entry.startsWith('EAGLEMV_ASK_TEXT '));
  assert.ok(line, `missing ask text result: ${stdout}`);
  const result = JSON.parse(line.slice('EAGLEMV_ASK_TEXT '.length));
  assert.equal(result.colourAsked.initial, '', 'an uncoloured tag starts empty, not on the accent blue');
  assert.equal(result.commentAsked.title, '添加评论');
  assert.equal(result.rectAsked.title, '评论框选区域');
  assert.deepEqual(result.calls.map(call => call.kind), ['tag-color', 'comment']);
  assert.equal(result.calls[0].color, '#ff0000');
  assert.equal(result.calls[1].annotation, '好图');
  assert.equal('x' in result.calls[1], false, 'an empty area keeps it a plain comment');
  assert.equal(result.hidden, true);
  const { initial, searched, afterClear, clearAsked, clearCalls } = result.manager;
  assert.equal(initial.rows, 200);
  assert.match(initial.more, /还有 51 个标签/);
  assert.equal(initial.unset, 199, 'uncoloured tags show a hollow swatch');
  assert.deepEqual(initial.clears, ['alpha'], 'only coloured tags offer 清除颜色');
  assert.equal(initial.unsetInput, '#808080', 'the picker of an uncoloured tag does not start on the accent blue');
  assert.equal(searched.rows, 11, 't24 and t240–t249');
  assert.equal(searched.more, '');
  assert.equal(searched.focused, true, 'typing in the search keeps focus');
  assert.equal(afterClear.rows, 1);
  assert.deepEqual(afterClear.clears, []);
  assert.match(clearAsked.title, /t1/);
  assert.deepEqual(clearCalls.map(call => [call.tag, call.color]), [['alpha', null], ['t1', null]]);
});
