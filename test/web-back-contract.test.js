'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  BACK_ACTION,
  BACK_STATUS,
  createBackRouter,
  createHistoryEntry,
  readHistoryEntry
} = require('../src/window-router');

function resultSummary(result) {
  return { status: result.status, action: result.action, reason: result.reason };
}

test('one back request consumes transient UI, preview, real history, then offers host exit', () => {
  const calls = [];
  let transientOpen = true;
  let previewOpen = true;
  let historyIndex = 1;
  const router = createBackRouter({
    consumeTransient: () => {
      if (!transientOpen) return null;
      transientOpen = false;
      calls.push('transient');
      return BACK_ACTION.TRANSIENT;
    },
    consumePreview: () => {
      if (!previewOpen) return null;
      previewOpen = false;
      calls.push('preview');
      return BACK_ACTION.PREVIEW;
    },
    canNavigateBack: () => historyIndex > 0,
    navigateBack: () => {
      historyIndex -= 1;
      calls.push('history');
      return BACK_ACTION.HISTORY;
    }
  });

  assert.deepEqual(resultSummary(router.request()), { status: BACK_STATUS.HANDLED, action: BACK_ACTION.TRANSIENT, reason: undefined });
  assert.deepEqual(resultSummary(router.request()), { status: BACK_STATUS.HANDLED, action: BACK_ACTION.PREVIEW, reason: undefined });
  assert.deepEqual(resultSummary(router.request()), { status: BACK_STATUS.HANDLED, action: BACK_ACTION.HISTORY, reason: undefined });
  assert.deepEqual(resultSummary(router.request()), { status: BACK_STATUS.EXIT, action: BACK_ACTION.HOST, reason: undefined });
  assert.deepEqual(calls, ['transient', 'preview', 'history']);
});

test('a blocked unsaved edit is reported and cannot fall through to history or exit', () => {
  const calls = [];
  const router = createBackRouter({
    consumePreview: () => ({ blocked: true, action: BACK_ACTION.PREVIEW, reason: 'unsaved-edit' }),
    canNavigateBack: () => true,
    navigateBack: () => { calls.push('history'); return BACK_ACTION.HISTORY; }
  });

  const result = router.request();
  assert.deepEqual(resultSummary(result), {
    status: BACK_STATUS.BLOCKED,
    action: BACK_ACTION.PREVIEW,
    reason: 'unsaved-edit'
  });
  assert.deepEqual(calls, []);
  assert.equal(result.handled, false);
  assert.equal(result.exit, false);
  assert.equal(result.blocked, true);
});

test('a blocked history guard cannot fall through to host exit', () => {
  const router = createBackRouter({
    canNavigateBack: () => true,
    navigateBack: () => ({ blocked: true, action: BACK_ACTION.HISTORY, reason: 'unsaved-edit' })
  });

  assert.deepEqual(resultSummary(router.request()), {
    status: BACK_STATUS.BLOCKED,
    action: BACK_ACTION.HISTORY,
    reason: 'unsaved-edit'
  });
});

test('no real history returns an explicit host-exit result', () => {
  const router = createBackRouter({ canNavigateBack: () => false });
  const result = router.request();
  assert.deepEqual(resultSummary(result), {
    status: BACK_STATUS.EXIT,
    action: BACK_ACTION.HOST,
    reason: undefined
  });
  assert.equal(result.exit, true);
  assert.equal(result.handled, false);
});

test('rapid repeated requests perform at most one transition per invocation', () => {
  const calls = [];
  let transientCount = 2;
  const router = createBackRouter({
    consumeTransient: () => {
      if (!transientCount) return null;
      transientCount -= 1;
      calls.push('close-one-surface');
      return BACK_ACTION.TRANSIENT;
    },
    canNavigateBack: () => false
  });

  const results = [router.request(), router.request(), router.request()];
  assert.deepEqual(results.map(result => result.status), [BACK_STATUS.HANDLED, BACK_STATUS.HANDLED, BACK_STATUS.EXIT]);
  assert.deepEqual(calls, ['close-one-surface', 'close-one-surface']);
});

test('re-entrant requests are blocked instead of closing multiple layers at once', () => {
  let router;
  const nestedResults = [];
  router = createBackRouter({
    consumeTransient: () => {
      nestedResults.push(router.request());
      return BACK_ACTION.TRANSIENT;
    },
    canNavigateBack: () => false
  });

  assert.equal(router.request().status, BACK_STATUS.HANDLED);
  assert.deepEqual(resultSummary(nestedResults[0]), {
    status: BACK_STATUS.BLOCKED,
    action: BACK_ACTION.REQUEST,
    reason: 'busy'
  });
});

test('history snapshots restore search while following the actual cross-folder visit order', () => {
  const searchQuery = { search: '猫', filters: { rating: 4 } };
  const entries = [
    createHistoryEntry({ kind: 'root' }, searchQuery),
    createHistoryEntry({ kind: 'folder', id: 'folder-a' }, { search: '', filters: {} }),
    createHistoryEntry({ kind: 'folder', id: 'folder-b' }, { search: '', filters: {} })
  ];
  let index = entries.length - 1;
  const visited = [];
  const restoredQueries = [];
  const router = createBackRouter({
    canNavigateBack: () => index > 0,
    navigateBack: () => {
      index -= 1;
      const target = readHistoryEntry(entries[index]);
      visited.push(target.view);
      restoredQueries.push(target.query);
      return BACK_ACTION.HISTORY;
    }
  });

  assert.equal(router.request().action, BACK_ACTION.HISTORY);
  assert.equal(router.request().action, BACK_ACTION.HISTORY);
  assert.deepEqual(visited, [
    { kind: 'folder', id: 'folder-a' },
    { kind: 'root' }
  ]);
  assert.deepEqual(restoredQueries, [
    { search: '', filters: {} },
    searchQuery
  ]);
});

test('renderer exposes one WebView-safe entry and routes Option+Left and Control+Left through it', () => {
  const root = path.join(__dirname, '..');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
  const indexHTML = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  assert.ok(indexHTML.includes('<script src="window-router.js"></script>'));
  assert.ok(renderer.includes('window.EagleMVBack.request()'));
  assert.ok(renderer.includes('installBackRouter(backActionRouter)'));
  assert.ok(renderer.includes("(event.altKey || event.ctrlKey) && event.key === 'ArrowLeft'"));
  assert.ok(renderer.includes('requestBackAction()'));
});
