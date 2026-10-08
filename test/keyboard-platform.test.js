'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isApplePlatform, createKeyboardPlatform, localizeShortcutText } = require('../src/keyboard-platform');

test('Apple platforms keep Command; Android and other platforms use Ctrl', () => {
  assert.equal(isApplePlatform({ platform: 'MacIntel' }), true);
  assert.equal(isApplePlatform({ userAgentData: { platform: 'macOS' } }), true);
  assert.equal(isApplePlatform({ platform: 'iPad' }), true);
  assert.equal(isApplePlatform({ userAgentData: { platform: 'Android' }, platform: 'Linux aarch64' }), false);
  assert.equal(isApplePlatform({ platform: 'Linux armv81' }), false);
  assert.equal(isApplePlatform({ platform: 'Win32' }), false);
  assert.equal(isApplePlatform({ platform: '', userAgent: 'Mozilla/5.0 (Linux; Android 15; 24091RPADC) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Safari/537.36' }), false);
  assert.equal(isApplePlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), true);
});

test('the primary key is exactly the platform Command-equivalent', () => {
  const mac = createKeyboardPlatform({ platform: 'MacIntel' });
  const android = createKeyboardPlatform({ userAgentData: { platform: 'Android' } });
  assert.equal(mac.primaryKey({ metaKey: true }), true);
  assert.equal(mac.primaryKey({ ctrlKey: true }), false);
  assert.equal(mac.otherKey({ ctrlKey: true }), true);
  assert.equal(android.primaryKey({ ctrlKey: true }), true);
  assert.equal(android.primaryKey({ metaKey: true }), false);
  assert.equal(android.otherKey({ metaKey: true }), true);
});

test('Mac glyph hints are spelled out with platform modifier names off Apple', () => {
  assert.equal(localizeShortcutText('⌘ ⇧ C', true), '⌘ ⇧ C');
  assert.equal(localizeShortcutText('⌘ ⇧ C', false), 'Ctrl+Shift+C');
  assert.equal(localizeShortcutText('⌘ ⌫', false), 'Ctrl+Del');
  assert.equal(localizeShortcutText('⌘ ⇧ ⌫', false), 'Ctrl+Shift+Del');
  assert.equal(localizeShortcutText('⌘ Enter', false), 'Ctrl+Enter');
  assert.equal(localizeShortcutText('返回（⌥← / ⌃←）', false), '返回（Alt+← / Ctrl+←）');
  assert.equal(localizeShortcutText('显示/隐藏检查器（⌘⇧I）', false), '显示/隐藏检查器（Ctrl+Shift+I）');
  assert.equal(localizeShortcutText('⇧S', false), 'Shift+S');
  assert.equal(localizeShortcutText('排序', false), '排序');
});
