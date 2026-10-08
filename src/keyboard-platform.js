'use strict';

// Which physical modifier plays the role of macOS Command. Apple keyboards
// (macOS, and iPad Safari which reports MacIntel) keep ⌘; everything else —
// the Android WebView shell first of all — uses Ctrl, so the same shortcut
// table works with a hardware keyboard on a phone or tablet.
(function exposeKeyboardPlatform(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVKeyboardPlatform = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const APPLE_PLATFORM = /mac|iphone|ipad|ipod/i;

  function isApplePlatform(nav = {}) {
    const platform = nav.userAgentData?.platform || nav.platform || '';
    if (platform) return APPLE_PLATFORM.test(platform);
    const userAgent = String(nav.userAgent || '');
    return !/android/i.test(userAgent) && APPLE_PLATFORM.test(userAgent);
  }

  function createKeyboardPlatform(nav) {
    const apple = isApplePlatform(nav);
    return {
      apple,
      // Exactly the platform's Command-equivalent; ⌘-only shortcuts on macOS
      // stay ⌘-only, and Ctrl takes their place elsewhere.
      primaryKey: event => Boolean(apple ? event.metaKey : event.ctrlKey),
      otherKey: event => Boolean(apple ? event.ctrlKey : event.metaKey),
      shortcutText: text => localizeShortcutText(text, apple)
    };
  }

  const MODIFIER_NAMES = Object.freeze({ '⌘': 'Ctrl', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' });

  // Mac glyph hints ("⌘ ⇧ C", "⌥← / ⌃←", "⌘S") become "Ctrl+Shift+C",
  // "Alt+← / Ctrl+←", "Ctrl+S" off Apple platforms.
  function localizeShortcutText(text, apple) {
    const value = String(text ?? '');
    if (apple) return value;
    return value
      .replace(/([⌘⌃⌥⇧]) ?/g, (_, glyph) => `${MODIFIER_NAMES[glyph]}+`)
      .replace(/⌫/g, 'Del');
  }

  return { isApplePlatform, createKeyboardPlatform, localizeShortcutText };
});
