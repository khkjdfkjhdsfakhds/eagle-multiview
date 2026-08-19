'use strict';

(function exposePaneLayoutPopoverPosition(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EagleMVLayoutPopover = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // Horizontal layout of the pane-layout popover under its toolbar button.
  // All inputs are viewport coordinates except `anchorLeft`, the left edge of
  // the popover's positioned ancestor; `left` is returned relative to that
  // ancestor because the popover is absolutely positioned inside it.  The
  // popover stays centred under the button whenever it fits, and is clamped
  // inside the viewport so no option column is ever clipped off-screen.
  function paneLayoutPopoverPosition({ buttonLeft, buttonWidth, popoverWidth, viewportWidth, anchorLeft, margin = 8, arrowMin = 10 }) {
    const maxLeft = Math.max(margin, viewportWidth - popoverWidth - margin);
    const viewportLeft = clamp(buttonLeft + buttonWidth / 2 - popoverWidth / 2, margin, maxLeft);
    const left = Math.round(viewportLeft - anchorLeft);
    const arrowRaw = buttonLeft + buttonWidth / 2 - viewportLeft;
    const arrowLeft = Math.round(clamp(arrowRaw, arrowMin, popoverWidth - arrowMin - 12));
    return { left, arrowLeft };
  }

  return Object.freeze({ paneLayoutPopoverPosition });
});
