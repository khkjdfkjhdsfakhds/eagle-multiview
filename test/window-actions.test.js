'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWindowActions } = require('../src/window-actions');
const { windowStateForView } = require('../src/window-target');

test('new-window targets pass only their resolved location', async () => {
  const opened = [];
  const bridge = {
    currentEagleWindowState: async () => ({ view: { kind: 'folder', id: 'eagle-folder' }, selectedIds: ['ignored'] }),
    newWindow: async state => opened.push(state)
  };
  const actions = createWindowActions({
    bridge,
    currentView: () => ({ kind: 'smart', id: 'smart-1', name: '最近筛选', query: 'ignored' }),
    windowStateForView
  });

  await actions.open('root');
  await actions.open('multiview');
  await actions.open('eagle');

  assert.deepEqual(opened, [
    { view: { kind: 'root' } },
    { view: { kind: 'smart', id: 'smart-1', name: '最近筛选' } },
    { view: { kind: 'folder', id: 'eagle-folder' } }
  ]);
});

test('web Eagle target reserves a tab before awaiting the current path', async () => {
  const calls = [];
  let release;
  const eagleState = new Promise(resolve => { release = resolve; });
  const reserved = { name: 'reserved-tab' };
  const bridge = {
    prepareNewWindow: () => { calls.push('reserve'); return reserved; },
    currentEagleWindowState: async () => { calls.push('query'); return eagleState; },
    newWindow: async (state, prepared) => calls.push(['open', state, prepared])
  };
  const actions = createWindowActions({ bridge, currentView: () => ({ kind: 'root' }), windowStateForView });

  const opening = actions.open('eagle');
  assert.deepEqual(calls, ['reserve', 'query']);
  release({ view: { kind: 'folder', id: 'live-folder' } });
  await opening;
  assert.deepEqual(calls[2], ['open', { view: { kind: 'folder', id: 'live-folder' } }, reserved]);
});

test('Eagle path failures resolve to root for both opening and in-place navigation', async () => {
  const opened = [];
  const bridge = {
    currentEagleWindowState: async () => { throw new Error('offline'); },
    newWindow: async state => opened.push(state)
  };
  const actions = createWindowActions({ bridge, currentView: () => ({ kind: 'folder', id: 'mv' }), windowStateForView });

  assert.deepEqual(await actions.eagleState(), { view: { kind: 'root' } });
  await actions.open('eagle');
  assert.deepEqual(opened, [{ view: { kind: 'root' } }]);
});
