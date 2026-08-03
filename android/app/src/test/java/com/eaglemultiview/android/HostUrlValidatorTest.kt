package com.eaglemultiview.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HostUrlValidatorTest {
    @Test
    fun `adds http scheme to a local host and keeps its port`() {
        assertEquals(
            "http://192.168.1.20:41596/",
            HostUrlValidator.normalize(" 192.168.1.20:41596 "),
        )
    }

    @Test
    fun `accepts https host paths`() {
        assertEquals(
            "https://multiview.example.test/mobile/",
            HostUrlValidator.normalize("https://MultiView.Example.Test/mobile/"),
        )
    }

    @Test
    fun `rejects file javascript credentials and malformed hosts`() {
        assertNull(HostUrlValidator.normalize("file:///tmp/library"))
        assertNull(HostUrlValidator.normalize("javascript:alert(1)"))
        assertNull(HostUrlValidator.normalize("http://user:pass@example.test"))
        assertNull(HostUrlValidator.normalize("not a host"))
    }
}
