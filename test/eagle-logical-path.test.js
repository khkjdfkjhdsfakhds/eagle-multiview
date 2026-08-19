'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatEaglePath, resolveEaglePath } = require('../src/eagle-logical-path');

const folders = [
  {
    id: 'reference',
    name: '参考',
    children: [
      {
        id: 'people',
        name: '人物',
        children: [{ id: 'faces', name: '表情', children: [] }]
      },
      { id: 'duplicate-a', name: '重复', children: [] }
    ]
  },
  {
    id: 'project',
    name: '项目',
    children: [
      { id: 'project-duplicate', name: '重复', children: [] },
      { id: 'same-name', name: '人物', children: [] }
    ]
  },
  { id: 'assets', name: 'Assets', children: [{ id: 'drafts', name: 'Drafts', children: [] }] },
  { id: 'duplicate-root', name: '重复', children: [] }
];

test('formats root and nested folders in Eagle logical path syntax', () => {
  assert.equal(formatEaglePath(folders, null), '');
  assert.equal(formatEaglePath(folders, 'reference'), '参考');
  assert.equal(formatEaglePath(folders, 'faces'), '参考 / 人物 / 表情');
});

test('resolves the empty Eagle path to the library root', () => {
  assert.deepEqual(resolveEaglePath(folders, '  '), {
    ok: true,
    view: { kind: 'root' }
  });
});

test('resolves an exact deep path without consulting the filesystem', () => {
  assert.deepEqual(resolveEaglePath(folders, '参考 / 人物 / 表情'), {
    ok: true,
    view: { kind: 'folder', id: 'faces' }
  });
});

test('uses the complete path to distinguish same-named folders', () => {
  assert.deepEqual(resolveEaglePath(folders, '参考 / 重复'), {
    ok: true,
    view: { kind: 'folder', id: 'duplicate-a' }
  });
  assert.deepEqual(resolveEaglePath(folders, '项目 / 重复'), {
    ok: true,
    view: { kind: 'folder', id: 'project-duplicate' }
  });
});

test('reports ambiguous complete paths instead of choosing a folder', () => {
  const ambiguous = [
    { id: 'one', name: '同名', children: [] },
    { id: 'two', name: '同名', children: [] }
  ];
  assert.deepEqual(resolveEaglePath(ambiguous, '同名'), {
    ok: false,
    code: 'ambiguous'
  });
});

test('reports missing and non-Eagle path formats without accepting local paths', () => {
  assert.deepEqual(resolveEaglePath(folders, '不存在 / 文件夹'), {
    ok: false,
    code: 'not-found'
  });
  assert.deepEqual(resolveEaglePath(folders, '/Users/example/Library.library/images'), {
    ok: false,
    code: 'unsupported-format'
  });
  assert.deepEqual(resolveEaglePath(folders, 'file:///Users/example/Library.library'), {
    ok: false,
    code: 'unsupported-format'
  });
  assert.deepEqual(resolveEaglePath(folders, '参考\n人物'), {
    ok: false,
    code: 'unsupported-format'
  });
});

test('does not invent a second separator or case-insensitive format', () => {
  assert.deepEqual(resolveEaglePath(folders, '参考/人物/表情'), {
    ok: false,
    code: 'not-found'
  });
  assert.deepEqual(resolveEaglePath(folders, '参考 / 人物 / 表情 '), {
    ok: true,
    view: { kind: 'folder', id: 'faces' }
  });
  assert.deepEqual(resolveEaglePath(folders, 'assets / drafts'.toLocaleUpperCase('en-US')), {
    ok: false,
    code: 'not-found'
  });
});
