'use strict';

(function exposeGridGestures(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVGridGestures = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  // Pull-to-refresh: the indicator travels half the finger's distance and
  // stops well before the finger does, so the gesture keeps a rubber-band
  // feel and cannot drag the banner off screen.
  const PULL_RESISTANCE = .5;
  const PULL_TRIGGER = 64;
  const PULL_MAX = 96;
  // Thumbnail bounds mirror the size slider's min/max in index.html.
  const THUMB_MIN = 110;
  const THUMB_MAX = 260;
  const THUMB_DEFAULT = 168;

  function pullOffset(delta, { resistance = PULL_RESISTANCE, max = PULL_MAX } = {}) {
    if (!Number.isFinite(delta) || delta <= 0) return 0;
    return Math.min(max, delta * resistance);
  }

  function pullArmed(offset, { trigger = PULL_TRIGGER } = {}) {
    return Number.isFinite(offset) && offset >= trigger;
  }

  function pullOpacity(offset, { fadeIn = 26 } = {}) {
    if (!Number.isFinite(offset) || offset <= 0) return 0;
    return Math.min(1, offset / fadeIn);
  }

  function clampThumbnailSize(size) {
    const value = Number(size);
    return Math.max(THUMB_MIN, Math.min(THUMB_MAX, Math.round(Number.isFinite(value) ? value : THUMB_DEFAULT)));
  }

  // Pinching scales the thumbnail width by the same ratio as the finger
  // spread, so the cards track the fingers instead of drifting.
  function pinchThumbnailSize(baseSize, startSpread, currentSpread) {
    if (!Number.isFinite(startSpread) || startSpread <= 0) return clampThumbnailSize(baseSize);
    if (!Number.isFinite(currentSpread) || currentSpread <= 0) return clampThumbnailSize(baseSize);
    return clampThumbnailSize(Number(baseSize) * (currentSpread / startSpread));
  }

  function spread(touches) {
    if (!touches || touches.length < 2) return 0;
    return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  }

  return {
    PULL_RESISTANCE,
    PULL_TRIGGER,
    PULL_MAX,
    THUMB_MIN,
    THUMB_MAX,
    THUMB_DEFAULT,
    pullOffset,
    pullArmed,
    pullOpacity,
    clampThumbnailSize,
    pinchThumbnailSize,
    spread
  };
});
