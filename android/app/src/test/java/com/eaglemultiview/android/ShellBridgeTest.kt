package com.eaglemultiview.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellBridgeTest {
    private val host = (HostUrlValidator.validate("http://192.168.1.5:41600") as HostInputResult.Valid).endpoint

    @Test
    fun `only known command names are accepted`() {
        assertEquals(ShellCommand.CHECK_FOR_UPDATES, ShellCommand.parse("check-for-updates"))
        assertEquals(ShellCommand.CHANGE_HOST, ShellCommand.parse("change-host"))
        for (raw in listOf(null, "", "CHANGE_HOST", "change-host ", "finish")) assertNull(raw, ShellCommand.parse(raw))
    }

    @Test
    fun `commands require the loaded page of the active host`() {
        assertTrue(ShellCommandPolicy.allowed(host, pageReady = true, pageUrl = "http://192.168.1.5:41600/"))
        assertTrue(ShellCommandPolicy.allowed(host, pageReady = true, pageUrl = "http://192.168.1.5:41600/?pane=2"))
        // Not ready yet, no host, the login page, or anything off-origin.
        assertFalse(ShellCommandPolicy.allowed(host, pageReady = false, pageUrl = "http://192.168.1.5:41600/"))
        assertFalse(ShellCommandPolicy.allowed(null, pageReady = true, pageUrl = "http://192.168.1.5:41600/"))
        assertFalse(ShellCommandPolicy.allowed(host, pageReady = true, pageUrl = "http://192.168.1.5:41600/login"))
        for (url in listOf(null, "about:blank", "http://192.168.1.5:41601/", "https://example.com/")) {
            assertFalse(url, ShellCommandPolicy.allowed(host, pageReady = true, pageUrl = url))
        }
    }
}
