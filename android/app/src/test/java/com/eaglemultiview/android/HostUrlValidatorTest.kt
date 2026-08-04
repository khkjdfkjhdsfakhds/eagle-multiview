package com.eaglemultiview.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HostUrlValidatorTest {
    @Test
    fun `adds http scheme to a local host and keeps its port`() {
        assertEquals(
            "http://192.168.1.20:41596/",
            HostUrlValidator.normalize(" 192.168.1.20:41596 "),
        )
        assertEquals(
            "http://localhost:41596/",
            HostUrlValidator.normalize("localhost:41596"),
        )
        assertEquals(
            "http://eagle-host:41596/",
            HostUrlValidator.normalize("eagle-host:41596"),
        )
        assertEquals(
            "http://example.com:8080/",
            HostUrlValidator.normalize("example.com:8080"),
        )
    }

    @Test
    fun `accepts https host paths and removes default port`() {
        assertEquals(
            "https://multiview.example.test/mobile/",
            HostUrlValidator.normalize("https://MultiView.Example.Test:443/mobile/"),
        )
    }

    @Test
    fun `rejects unsupported schemes credentials query and malformed hosts`() {
        assertEquals(
            HostInputError.UNSUPPORTED_SCHEME,
            (HostUrlValidator.validate("ftp://example.test") as HostInputResult.Invalid).error,
        )
        assertEquals(
            HostInputError.UNSUPPORTED_SCHEME,
            (HostUrlValidator.validate("javascript:alert(1)") as HostInputResult.Invalid).error,
        )
        assertEquals(
            HostInputError.CREDENTIALS_NOT_ALLOWED,
            (HostUrlValidator.validate("http://user:pass@example.test") as HostInputResult.Invalid).error,
        )
        assertEquals(
            HostInputError.QUERY_OR_FRAGMENT_NOT_ALLOWED,
            (HostUrlValidator.validate("http://example.test/?access_key=secret") as HostInputResult.Invalid).error,
        )
        assertNull(HostUrlValidator.normalize("file:///tmp/library"))
        assertNull(HostUrlValidator.normalize("not a host"))
    }
}

class TrustedNavigationPolicyTest {
    private val endpoint = (HostUrlValidator.validate("https://example.test:443") as HostInputResult.Valid).endpoint

    @Test
    fun `keeps same origin pages and login inside the webview`() {
        assertEquals(
            NavigationTarget.TrustedPage,
            TrustedNavigationPolicy.classify(endpoint, "https://example.test/library/folder"),
        )
        assertEquals(
            NavigationTarget.TrustedLogin,
            TrustedNavigationPolicy.classify(endpoint, "https://example.test/login"),
        )
        assertTrue(endpoint.contains("https://example.test/?view=all"))
    }

    @Test
    fun `sends other origins out and blocks unsupported schemes`() {
        assertEquals(
            NavigationTarget.ExternalWeb,
            TrustedNavigationPolicy.classify(endpoint, "https://other.example.test/"),
        )
        assertEquals(
            NavigationTarget.Blocked,
            TrustedNavigationPolicy.classify(endpoint, "javascript:alert(1)"),
        )
        assertFalse(endpoint.contains("http://example.test/"))
    }
}
