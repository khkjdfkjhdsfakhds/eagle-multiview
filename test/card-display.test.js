'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const display = require('../src/card-display');
const { itemDates } = require('../src/pane-state');

const helpers = {
  formatBytes: bytes => `${bytes} B`,
  formatDateTime: time => `t${time}`,
  itemDates
};

test('defaults match Eagle: every card line on, subfolder content off, 尺寸 as the meta line', () => {
  assert.deepEqual(display.parse(null), {
    subfolderContent: false, name: true, meta: true, metaType: 'RESOLUTION', ext: true, extLabel: true, annotation: true
  });
  assert.deepEqual(display.parse('not json'), display.DEFAULTS);
});

test('stored settings keep known values and drop the rest', () => {
  const stored = display.parse(JSON.stringify({ name: false, metaType: 'TAGS', subfolderContent: true, ext: 'no', extra: 1 }));
  assert.equal(stored.name, false);
  assert.equal(stored.metaType, 'TAGS');
  assert.equal(stored.subfolderContent, true);
  assert.equal(stored.ext, true, 'a non-boolean keeps the default');
  assert.equal('extra' in stored, false);
  assert.equal(display.parse(JSON.stringify({ metaType: 'COLOR' })).metaType, 'RESOLUTION');
});

test('the meta line follows the chosen type', () => {
  const item = { size: 2048, width: 832, height: 1216, tags: ['a', 'b'], star: 3, modificationTime: 10, btime: 20, mtime: 30 };
  assert.equal(display.metaText(item, 'RESOLUTION', helpers), '832 x 1216');
  assert.equal(display.metaText(item, 'FILESIZE', helpers), '2048 B');
  assert.equal(display.metaText(item, 'TAGS', helpers), 'a, b');
  assert.equal(display.metaText(item, 'RATING', helpers), '★★★');
  assert.equal(display.metaText(item, 'MTIME', helpers), 't30');
  assert.equal(display.metaText(item, 'BTIME', helpers), 't20');
});

test('尺寸 shows a duration for media and the size when there is no picture size', () => {
  assert.equal(display.metaText({ duration: 75.4, width: 1920, height: 1080 }, 'RESOLUTION', helpers), '01:15');
  assert.equal(display.metaText({ duration: 3725 }, 'RESOLUTION', helpers), '1:02:05');
  assert.equal(display.metaText({ size: 12, width: 0, height: 0 }, 'RESOLUTION', helpers), '12 B');
});

test('format label on everything but PNG and JPG; annotation count from comments', () => {
  assert.equal(display.hasFormatLabel({ ext: 'png' }), false);
  assert.equal(display.hasFormatLabel({ ext: 'JPG' }), false);
  assert.equal(display.hasFormatLabel({ ext: 'jpeg' }), true);
  assert.equal(display.hasFormatLabel({ ext: 'webp' }), true);
  assert.equal(display.hasFormatLabel({}), false);
  assert.equal(display.annotationCount({ comments: [{}, {}] }), 2);
  assert.equal(display.annotationCount({}), 0);
});
