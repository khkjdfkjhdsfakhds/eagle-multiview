'use strict';
// Eagle's batch rename rules (batch-rename-modal.js format/replace/case) and
// the order MultiView runs tag renames in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatName, replaceName, applyTextCase, renamed, planTagRenames } = require('../src/batch-rename');

const now = new Date(2026, 9, 19, 8, 5, 9);

test('format tokens follow Eagle', () => {
  const item = { name: '原名', tags: ['b', 'a'], mtime: new Date(2025, 0, 2, 3, 4, 5).getTime(), btime: new Date(2024, 11, 31).getTime() };
  assert.equal(formatName(item, '* - %N', { idx: 7, now }), '原名 - 7');
  assert.equal(formatName(item, '%NNN|%nnnn', { idx: 7, now }), '007|0007');
  assert.equal(formatName(item, '%NN', { idx: 123, now }), '123', 'never cut shorter');
  assert.equal(formatName(item, '%D %DD %DDD', { now }), '2026-10-19 10-19 Oct 19, 2026');
  assert.equal(formatName(item, '%DHM|%DHMS', { now }), '2026-10-19 08_05|2026-10-19 08_05_09');
  assert.equal(formatName(item, '%M|%MHMS|%B', { now }), '2025_01_02|2025_01_02 03_04_05|2024_12_31');
  assert.equal(formatName(item, '%T', { now }), 'a-b');
  assert.equal(formatName(item, '%F', { now, folderNames: ['乙', '甲'] }), '乙-甲'.split('-').sort().join('-'));
  assert.equal(formatName({ name: '标签' }, '%T', { now }), '标签', 'an empty result keeps the original name');
  assert.equal(formatName({ name: '标签' }, '%D', { now }), '2026-10-19', 'no dates on a tag: now');
  assert.equal(formatName({ name: 'x' }, 'a'.repeat(300), { now }).length, 255);
});

test('replace by text or /regex/flags, then case', () => {
  assert.equal(replaceName('a-a-a', 'a', 'b'), 'b-b-b');
  assert.equal(replaceName('a-a-a', '/a/', 'b'), 'b-a-a');
  assert.equal(replaceName('a-A', '/a/gi', 'c'), 'c-c');
  assert.equal(replaceName('x.y', '.', '_'), 'x_y', 'plain text is literal');
  assert.equal(applyTextCase('hello wORLD', 'capitalize'), 'Hello World');
  assert.equal(applyTextCase('Ab', 'uppercase'), 'AB');
  assert.equal(applyTextCase('Ab', 'lowercase'), 'ab');
  assert.equal(applyTextCase('Ab', 'none'), 'Ab');
  assert.deepEqual(renamed([{ name: 'a' }, { name: 'b' }], { method: 'format', pattern: '%N*', startAt: 0, textCase: 'uppercase', now })
    .map(entry => entry.after), ['0A', '1B']);
});

test('tag renames: taken names merge, chains wait, loops go through a temporary name', () => {
  assert.deepEqual(planTagRenames([{ from: 'a', to: 'b' }, { from: 'c', to: 'c' }], ['a', 'c']), [{ kind: 'rename', from: 'a', to: 'b' }]);
  assert.deepEqual(planTagRenames([{ from: 'a', to: 'x' }, { from: 'b', to: 'x' }], ['a', 'b', 'x']),
    [{ kind: 'merge', from: 'a', to: 'x' }, { kind: 'merge', from: 'b', to: 'x' }]);
  assert.deepEqual(planTagRenames([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], ['a', 'b']),
    [{ kind: 'rename', from: 'b', to: 'c' }, { kind: 'rename', from: 'a', to: 'b' }]);
  const swap = planTagRenames([{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], ['a', 'b']);
  assert.deepEqual(swap, [
    { kind: 'rename', from: 'a', to: 'a (重命名中)' },
    { kind: 'rename', from: 'b', to: 'a' },
    { kind: 'rename', from: 'a (重命名中)', to: 'b' }
  ]);
});
