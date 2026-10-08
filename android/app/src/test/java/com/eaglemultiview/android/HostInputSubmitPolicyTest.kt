package com.eaglemultiview.android

import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class HostInputSubmitPolicyTest {
    @Test
    fun `hardware Enter connects once per press`() {
        assertEquals(HostInputSubmit.CONNECT, decide(KeyEvent.KEYCODE_ENTER, isDown = true))
        // The key up of the same press, and auto-repeat, must not start the connection again.
        assertEquals(HostInputSubmit.CONSUME, decide(KeyEvent.KEYCODE_ENTER, isDown = false))
        assertEquals(HostInputSubmit.CONSUME, decide(KeyEvent.KEYCODE_ENTER, isDown = true, repeatCount = 1))
        assertEquals(HostInputSubmit.CONNECT, decide(KeyEvent.KEYCODE_NUMPAD_ENTER, isDown = true))
    }

    @Test
    fun `soft keyboard Go and Done connect`() {
        assertEquals(HostInputSubmit.CONNECT, HostInputSubmitPolicy.decide(EditorInfo.IME_ACTION_GO, null))
        assertEquals(HostInputSubmit.CONNECT, HostInputSubmitPolicy.decide(EditorInfo.IME_ACTION_DONE, null))
        assertEquals(HostInputSubmit.IGNORE, HostInputSubmitPolicy.decide(EditorInfo.IME_ACTION_NEXT, null))
    }

    @Test
    fun `other keys are left to the field`() {
        assertEquals(HostInputSubmit.IGNORE, decide(KeyEvent.KEYCODE_A, isDown = true))
    }

    private fun decide(keyCode: Int, isDown: Boolean, repeatCount: Int = 0) = HostInputSubmitPolicy.decide(
        EditorInfo.IME_NULL,
        HardwareKey(keyCode = keyCode, isDown = isDown, repeatCount = repeatCount),
    )
}
