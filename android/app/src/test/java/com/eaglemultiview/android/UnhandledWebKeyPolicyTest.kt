package com.eaglemultiview.android

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Test

class UnhandledWebKeyPolicyTest {
    @Test
    fun `unconsumed Esc requests Back exactly once per press`() {
        assertEquals(UnhandledKeyDecision.REQUEST_BACK, decide(KeyEvent.KEYCODE_ESCAPE, isDown = true))
        assertEquals(
            UnhandledKeyDecision.CONSUME,
            decide(KeyEvent.KEYCODE_ESCAPE, isDown = true, repeatCount = 1),
        )
        // Key up must not fall back to a second system Back after the down already routed one.
        assertEquals(UnhandledKeyDecision.CONSUME, decide(KeyEvent.KEYCODE_ESCAPE, isDown = false))
    }

    @Test
    fun `modified Esc keeps the Android fallback`() {
        assertEquals(UnhandledKeyDecision.DEFAULT, decide(KeyEvent.KEYCODE_ESCAPE, isDown = true, alt = true))
        assertEquals(UnhandledKeyDecision.DEFAULT, decide(KeyEvent.KEYCODE_ESCAPE, isDown = true, ctrl = true))
        assertEquals(UnhandledKeyDecision.DEFAULT, decide(KeyEvent.KEYCODE_ESCAPE, isDown = true, meta = true))
    }

    @Test
    fun `arrows never become native focus navigation`() {
        for (keyCode in listOf(
            KeyEvent.KEYCODE_DPAD_UP,
            KeyEvent.KEYCODE_DPAD_DOWN,
            KeyEvent.KEYCODE_DPAD_LEFT,
            KeyEvent.KEYCODE_DPAD_RIGHT,
        )) {
            assertEquals(UnhandledKeyDecision.CONSUME, decide(keyCode, isDown = true))
            assertEquals(UnhandledKeyDecision.CONSUME, decide(keyCode, isDown = false))
            assertEquals(UnhandledKeyDecision.CONSUME, decide(keyCode, isDown = true, alt = true))
        }
    }

    @Test
    fun `plain and shifted Tab stay in the page while command Tab is left to Android`() {
        assertEquals(UnhandledKeyDecision.CONSUME, decide(KeyEvent.KEYCODE_TAB, isDown = true))
        assertEquals(UnhandledKeyDecision.DEFAULT, decide(KeyEvent.KEYCODE_TAB, isDown = true, ctrl = true))
        assertEquals(UnhandledKeyDecision.DEFAULT, decide(KeyEvent.KEYCODE_TAB, isDown = true, alt = true))
    }

    @Test
    fun `other keys keep default handling`() {
        for (keyCode in listOf(
            KeyEvent.KEYCODE_A,
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_SPACE,
            KeyEvent.KEYCODE_PAGE_DOWN,
            KeyEvent.KEYCODE_MOVE_HOME,
            KeyEvent.KEYCODE_1,
        )) {
            assertEquals(UnhandledKeyDecision.DEFAULT, decide(keyCode, isDown = true))
            assertEquals(UnhandledKeyDecision.DEFAULT, decide(keyCode, isDown = true, ctrl = true))
        }
    }

    @Test
    fun `Back carrying the Esc scan code is a remapped keyboard Esc`() {
        assertEquals(true, RemappedEscapePolicy.isRemappedEscape(back(scanCode = 1)))
        assertEquals(true, RemappedEscapePolicy.isRemappedEscape(back(scanCode = 1, isDown = false)))
    }

    @Test
    fun `buttons, gestures, and modified Esc stay system Back`() {
        // Navigation buttons, gestures and `input keyevent BACK` carry no scan code.
        assertEquals(false, RemappedEscapePolicy.isRemappedEscape(back(scanCode = 0)))
        // A dedicated Back key (Linux KEY_BACK = 158) is not Esc.
        assertEquals(false, RemappedEscapePolicy.isRemappedEscape(back(scanCode = 158)))
        assertEquals(false, RemappedEscapePolicy.isRemappedEscape(back(scanCode = 1, meta = true)))
        assertEquals(false, RemappedEscapePolicy.isRemappedEscape(back(scanCode = 1, ctrl = true)))
        assertEquals(false, RemappedEscapePolicy.isRemappedEscape(back(scanCode = 1, alt = true)))
        assertEquals(
            false,
            RemappedEscapePolicy.isRemappedEscape(HardwareKey(KeyEvent.KEYCODE_ESCAPE, true, scanCode = 1)),
        )
    }

    private fun back(
        scanCode: Int,
        isDown: Boolean = true,
        ctrl: Boolean = false,
        alt: Boolean = false,
        meta: Boolean = false,
    ) = HardwareKey(KeyEvent.KEYCODE_BACK, isDown, ctrl = ctrl, alt = alt, meta = meta, scanCode = scanCode)

    private fun decide(
        keyCode: Int,
        isDown: Boolean,
        repeatCount: Int = 0,
        ctrl: Boolean = false,
        alt: Boolean = false,
        meta: Boolean = false,
    ) = UnhandledWebKeyPolicy.decide(HardwareKey(keyCode, isDown, repeatCount, ctrl, alt, meta))
}
