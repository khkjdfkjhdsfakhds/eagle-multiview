package com.eaglemultiview.android

import android.content.Context
import android.util.AttributeSet
import android.view.KeyEvent
import android.webkit.WebView

/**
 * The page's WebView, with one pre-IME key rule: a keyboard Esc that the system rewrote into Back
 * (see [RemappedEscapePolicy]) is delivered to the page as Esc. It runs before the input method so
 * an IME toolbar cannot spend the press on hiding itself, and before Android's own Back handling.
 * Requires `enableOnBackInvokedCallback="false"`; otherwise the platform drops every Back key
 * ahead of the view tree.
 */
class ShellWebView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : WebView(context, attrs) {
    override fun dispatchKeyEventPreIme(event: KeyEvent): Boolean {
        if (RemappedEscapePolicy.isRemappedEscape(event.toHardwareKey())) {
            dispatchKeyEvent(event.asEscape())
            return true
        }
        return super.dispatchKeyEventPreIme(event)
    }

    private fun KeyEvent.asEscape() = KeyEvent(
        downTime,
        eventTime,
        action,
        KeyEvent.KEYCODE_ESCAPE,
        repeatCount,
        metaState,
        deviceId,
        scanCode,
        flags,
        source,
    )
}
