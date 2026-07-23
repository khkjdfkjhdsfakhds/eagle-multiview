'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fieldsEqual, detectConflicts, applySetDelta } = require('../lib/conflict');

test('array fields compare independent of order', () => {
  assert.equal(fieldsEqual(['b', 'a'], ['a', 'b']), true);
});

test('detects another window changing the same field', () => {
  const conflicts = detectConflicts(
    { name: '窗口 B', tags: ['a'] },
    { name: '原名', tags: ['a'] },
    { name: '窗口 A' }
  );
  assert.deepEqual(conflicts.map(item => item.field), ['name']);
});

test('does not conflict when different fields changed', () => {
  const conflicts = detectConflicts(
    { name: '原名', tags: ['b'] },
    { name: '原名', tags: ['a'] },
    { name: '新名' }
  );
  assert.equal(conflicts.length, 0);
});

test('set delta preserves concurrent values', () => {
  assert.deepEqual(applySetDelta(['a', 'b'], ['c'], ['a']).sort(), ['b', 'c']);
});
