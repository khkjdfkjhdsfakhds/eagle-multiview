package com.eaglemultiview.android

import android.view.KeyEvent

/** A hardware key event reduced to the fields the shell policy depends on. */
data class HardwareKey(
    val keyCode: Int,
    val isDown: Boolean,
    val repeatCount: Int = 0,
    val ctrl: Boolean = false,
    val alt: Boolean = false,
    val meta: Boolean = false,
    val scanCode: Int = 0,
)

/**
 * Recognizes a hardware keyboard's Esc that the system already rewrote into Back.
 *
 * HyperOS (and the emulator's qwerty2 layout) deliver the Esc key as KEYCODE_BACK before any app
 * code runs, so the page would never see Esc: a text field could not be left, and the first
 * presses were spent hiding the IME toolbar or leaving the app. The scan code still names the
 * physical key (Linux KEY_ESC = 1), while navigation buttons and back gestures report 0. Such a
 * Back is handed to the page as the Esc it was; only an Esc the page leaves unconsumed becomes a
 * Back request through [UnhandledWebKeyPolicy]. Modified Esc (e.g. HyperOS Meta+Esc) stays Back.
 */
object RemappedEscapePolicy {
    const val SCAN_CODE_ESC = 1

    fun isRemappedEscape(key: HardwareKey): Boolean =
        key.keyCode == KeyEvent.KEYCODE_BACK &&
            key.scanCode == SCAN_CODE_ESC &&
            !(key.ctrl || key.alt || key.meta)
}

internal fun KeyEvent.toHardwareKey() = HardwareKey(
    keyCode = keyCode,
    isDown = action == KeyEvent.ACTION_DOWN,
    repeatCount = repeatCount,
    ctrl = isCtrlPressed,
    alt = isAltPressed,
    meta = isMetaPressed,
    scanCode = scanCode,
)

enum class UnhandledKeyDecision {
    /** Route through the same native Back request as the system Back button. */
    REQUEST_BACK,

    /** Swallow the key so Android does not move focus out of the WebView or synthesize Back. */
    CONSUME,

    /** Let Android apply its normal unhandled-key behavior. */
    DEFAULT,
}

/**
 * Decides what happens to keys the trusted MultiView page did not consume.
 *
 * The page sees every key first, so all shortcuts stay in the web client. Only leftovers reach
 * this policy: an unconsumed Esc behaves like system Back (exactly once per press, never on key
 * repeat or key up), and unconsumed arrows/Tab never trigger Android focus navigation that would
 * strand keyboard focus on native toolbar buttons.
 */
object UnhandledWebKeyPolicy {
    private val focusNavigationKeys = setOf(
        KeyEvent.KEYCODE_DPAD_UP,
        KeyEvent.KEYCODE_DPAD_DOWN,
        KeyEvent.KEYCODE_DPAD_LEFT,
        KeyEvent.KEYCODE_DPAD_RIGHT,
    )

    fun decide(key: HardwareKey): UnhandledKeyDecision {
        val commandModifier = key.ctrl || key.alt || key.meta
        return when {
            key.keyCode == KeyEvent.KEYCODE_ESCAPE -> when {
                // Alt/Meta/Ctrl+Esc keep Android's own fallbacks (Home, Menu).
                commandModifier -> UnhandledKeyDecision.DEFAULT
                key.isDown && key.repeatCount == 0 -> UnhandledKeyDecision.REQUEST_BACK
                // Key up and auto-repeat must not fall back to a second system Back.
                else -> UnhandledKeyDecision.CONSUME
            }
            key.keyCode in focusNavigationKeys -> UnhandledKeyDecision.CONSUME
            key.keyCode == KeyEvent.KEYCODE_TAB && !commandModifier -> UnhandledKeyDecision.CONSUME
            else -> UnhandledKeyDecision.DEFAULT
        }
    }
}
