'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { paneLayoutPopoverPosition } = require('../src/pane-layout-popover-position');

test('centres the popover horizontally under the button when there is room', () => {
  assert.deepEqual(
    paneLayoutPopoverPosition({
      buttonLeft: 247,
      buttonWidth: 40,
      popoverWidth: 276,
      viewportWidth: 1280,
      anchorLeft: 247
    }),
    { left: -118, arrowLeft: 138 }
  );
});

test('clamps to the viewport when the button sits near the left edge', () => {
  const position = paneLayoutPopoverPosition({
    buttonLeft: 20,
    buttonWidth: 40,
    popoverWidth: 276,
    viewportWidth: 1066,
    anchorLeft: 20
  });
  assert.equal(position.left, -12);
  assert.equal(position.arrowLeft, 32);
});

test('clamps to the viewport when the button sits near the right edge', () => {
  const position = paneLayoutPopoverPosition({
    buttonLeft: 1240,
    buttonWidth: 40,
    popoverWidth: 276,
    viewportWidth: 1280,
    anchorLeft: 1240
  });
  assert.equal(position.left, -244);
  assert.equal(position.arrowLeft, 254);
});

test('keeps the popover on screen when it is wider than the viewport', () => {
  const position = paneLayoutPopoverPosition({
    buttonLeft: 80,
    buttonWidth: 40,
    popoverWidth: 276,
    viewportWidth: 200,
    anchorLeft: 80
  });
  assert.ok(position.left + 80 >= 0, 'left edge leaves the viewport');
});

test('converts viewport coordinates into the positioned ancestor frame', () => {
  const position = paneLayoutPopoverPosition({
    buttonLeft: 247,
    buttonWidth: 40,
    popoverWidth: 276,
    viewportWidth: 1280,
    anchorLeft: 300
  });
  assert.equal(position.left, -171);
  assert.equal(position.arrowLeft, 138);
});
