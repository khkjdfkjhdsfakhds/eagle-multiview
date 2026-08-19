package com.eaglemultiview.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostWebViewCallbackGuardTest {
    private val endpoint = HostEndpoint(
        startUrl = "https://current.example.test/",
        origin = "https://current.example.test",
    )

    @Test
    fun `accepts only the active client current webview and current endpoint`() {
        val activeClient = Any()
        val currentView = Any()

        assertTrue(
            HostWebViewCallbackGuard.matches(
                activeClient,
                activeClient,
                currentView,
                currentView,
                endpoint,
                endpoint,
                4L,
                4L,
            ),
        )
        assertFalse(
            HostWebViewCallbackGuard.matches(
                Any(),
                activeClient,
                currentView,
                currentView,
                endpoint,
                endpoint,
                4L,
                4L,
            ),
        )
        assertFalse(
            HostWebViewCallbackGuard.matches(
                activeClient,
                activeClient,
                Any(),
                currentView,
                endpoint,
                endpoint,
                4L,
                4L,
            ),
        )
        assertFalse(
            HostWebViewCallbackGuard.matches(
                activeClient,
                activeClient,
                currentView,
                currentView,
                HostEndpoint("https://old.example.test/", "https://old.example.test"),
                endpoint,
                4L,
                4L,
            ),
        )
        assertFalse(
            HostWebViewCallbackGuard.matches(
                activeClient,
                activeClient,
                currentView,
                currentView,
                endpoint,
                endpoint,
                3L,
                4L,
            ),
        )
    }
}
