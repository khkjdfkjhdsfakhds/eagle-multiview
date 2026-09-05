'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { paneLayoutSpecs, paneRevealTargets } = require('../src/pane-state');

test('pane reveal targets exclude the source and follow every layout slot rather than pane IDs', () => {
  for (const [layout, spec] of Object.entries(paneLayoutSpecs)) {
    const panes = spec.slots.map((_, index) => ({ id: 'identity-' + (10 - index) }));
    for (const source of panes) {
      const targets = paneRevealTargets(layout, panes, source.id);
      assert.equal(targets.length, spec.count - 1, layout);
      assert.equal(new Set(targets.map(target => target.label)).size, targets.length, layout);
      assert.ok(!targets.some(target => target.paneId === source.id));
    }
  }
  const panes = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  assert.deepEqual(paneRevealTargets('grid4', panes, 'b').map(target => target.label), ['左上', '左下', '右下']);
  assert.deepEqual(paneRevealTargets('vertical4', panes, 'a').map(target => target.label), ['中左', '中右', '右']);
  assert.deepEqual(paneRevealTargets('horizontal4', panes, 'a').map(target => target.label), ['中上', '中下', '下']);
  assert.deepEqual(paneRevealTargets('leftStack', panes.slice(0, 3), 'c').map(target => target.label), ['左', '右上']);
  assert.deepEqual(paneRevealTargets('grid4', panes, 'missing'), []);
});

test('stacked mobile panes use their displayed order instead of desktop left/right labels', () => {
  const targets = paneRevealTargets('grid4', ['a', 'b', 'c', 'd'].map(id => ({ id })), 'c', { stacked: true });
  assert.deepEqual(targets.map(target => target.label), ['第 1 栏', '第 2 栏', '第 4 栏']);
});
