package com.eaglemultiview.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DownloadRequestPlannerTest {
    private val endpoint = (HostUrlValidator.validate("http://10.0.2.2:41600") as HostInputResult.Valid).endpoint

    @Test
    fun `host export uses the RFC 5987 utf8 file name`() {
        // Exactly what lib/web-server.js attachmentHeader() sends for a zip of 3 items.
        val plan = DownloadRequestPlanner.plan(
            endpoint,
            "http://10.0.2.2:41600/export?token=abc",
            "attachment; filename=\"EagleMultiView-3__.zip\"; filename*=UTF-8''EagleMultiView-3%E9%A1%B9.zip",
            "application/zip",
        )
        assertEquals(
            DownloadPlan.Accepted(
                "http://10.0.2.2:41600/export?token=abc",
                "EagleMultiView-3项.zip",
                "application/zip",
            ),
            plan,
        )
    }

    @Test
    fun `single file keeps its name and drops generic mime`() {
        val plan = DownloadRequestPlanner.plan(
            endpoint,
            "http://10.0.2.2:41600/export?token=abc",
            "attachment; filename=\"a b+c.png\"; filename*=UTF-8''a%20b%2Bc.png",
            "application/octet-stream",
        ) as DownloadPlan.Accepted
        assertEquals("a b+c.png", plan.fileName)
        assertNull(plan.mimeType)
    }

    @Test
    fun `falls back to quoted filename then path segment then generic name`() {
        assertEquals(
            "plain;name.jpg",
            accepted("attachment; filename=\"plain;name.jpg\"; filename*=bogus").fileName,
        )
        assertEquals(
            "图.webp",
            (DownloadRequestPlanner.plan(endpoint, "http://10.0.2.2:41600/media/%E5%9B%BE.webp", null, null)
                as DownloadPlan.Accepted).fileName,
        )
        assertEquals(
            "download.zip",
            (DownloadRequestPlanner.plan(endpoint, "http://10.0.2.2:41600/", "attachment", "application/zip") {
                if (it == "application/zip") "zip" else null
            } as DownloadPlan.Accepted).fileName,
        )
    }

    @Test
    fun `mime parameters are stripped`() {
        assertEquals(
            "text/plain",
            (DownloadRequestPlanner.plan(endpoint, "http://10.0.2.2:41600/a.txt", null, "Text/Plain; charset=utf-8")
                as DownloadPlan.Accepted).mimeType,
        )
    }

    @Test
    fun `only the trusted host may use the session download`() {
        assertEquals(
            DownloadPlan.Rejected(DownloadRejection.UNTRUSTED_ORIGIN),
            DownloadRequestPlanner.plan(endpoint, "http://evil.example/export", null, null),
        )
        assertEquals(
            DownloadPlan.Rejected(DownloadRejection.UNTRUSTED_ORIGIN),
            DownloadRequestPlanner.plan(endpoint, "http://10.0.2.2:41601/export", null, null),
        )
        assertEquals(
            DownloadPlan.Rejected(DownloadRejection.UNTRUSTED_ORIGIN),
            DownloadRequestPlanner.plan(null, "http://10.0.2.2:41600/export", null, null),
        )
        assertEquals(
            DownloadPlan.Rejected(DownloadRejection.UNTRUSTED_ORIGIN),
            DownloadRequestPlanner.plan(endpoint, "http://10.0.2.2:41600/login", null, null),
        )
        assertEquals(
            DownloadPlan.Rejected(DownloadRejection.UNSUPPORTED_URL),
            DownloadRequestPlanner.plan(endpoint, "blob:http://10.0.2.2:41600/uuid", null, null),
        )
        assertEquals(
            DownloadPlan.Rejected(DownloadRejection.UNSUPPORTED_URL),
            DownloadRequestPlanner.plan(endpoint, "data:text/plain,hi", null, null),
        )
        assertEquals(
            DownloadPlan.Rejected(DownloadRejection.UNSUPPORTED_URL),
            DownloadRequestPlanner.plan(endpoint, null, null, null),
        )
    }

    @Test
    fun `file names are made safe for the shared Downloads folder`() {
        assertEquals("passwd", ContentDispositionFileName.sanitize("../../etc/passwd"))
        assertEquals("evil.png", ContentDispositionFileName.sanitize("..\\evil.png"))
        assertEquals("a_b_c_.png", ContentDispositionFileName.sanitize("a:b*c?.png"))
        assertEquals("hidden", ContentDispositionFileName.sanitize(".hidden"))
        assertEquals("download", ContentDispositionFileName.sanitize("..."))
        assertEquals("download", ContentDispositionFileName.sanitize("\u0000\u0001"))
        val long = ContentDispositionFileName.sanitize("x".repeat(400) + ".jpeg")
        assertEquals(150, long.length)
        assertEquals(".jpeg", long.takeLast(5))
    }

    private fun accepted(contentDisposition: String) = DownloadRequestPlanner.plan(
        endpoint,
        "http://10.0.2.2:41600/export?token=abc",
        contentDisposition,
        null,
    ) as DownloadPlan.Accepted
}
