package com.eaglemultiview.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BackRequestCoordinatorTest {
    @Test
    fun `handled blocked and exit are the only accepted browser outcomes`() {
        val coordinator = BackRequestCoordinator()

        val handledRequest = coordinator.begin(BackPageAvailability.TRUSTED_PAGE).requestId()
        assertEquals(
            BackCommand.Stay(BackStayReason.HANDLED),
            coordinator.resolve(handledRequest, webResult("handled")),
        )

        val blockedRequest = coordinator.begin(BackPageAvailability.TRUSTED_PAGE).requestId()
        assertEquals(
            BackCommand.Stay(BackStayReason.BLOCKED),
            coordinator.resolve(blockedRequest, webResult("blocked")),
        )

        val exitRequest = coordinator.begin(BackPageAvailability.TRUSTED_PAGE).requestId()
        assertEquals(
            BackCommand.FinishActivity,
            coordinator.resolve(exitRequest, webResult("exit")),
        )
        assertEquals(
            BackCommand.Stay(BackStayReason.ALREADY_FINISHING),
            coordinator.begin(BackPageAvailability.TRUSTED_PAGE),
        )
    }

    @Test
    fun `rapid presses allow only one evaluate request at a time`() {
        val coordinator = BackRequestCoordinator()

        val first = coordinator.begin(BackPageAvailability.TRUSTED_PAGE)
        assertTrue(first is BackCommand.EvaluateJavascript)
        assertEquals(
            BackCommand.Stay(BackStayReason.BUSY),
            coordinator.begin(BackPageAvailability.TRUSTED_PAGE),
        )

        coordinator.resolve(first.requestId(), webResult("handled"))
        val next = coordinator.begin(BackPageAvailability.TRUSTED_PAGE)
        assertTrue(next is BackCommand.EvaluateJavascript)
        assertTrue(next.requestId() > first.requestId())
    }

    @Test
    fun `timeout releases the request and ignores a late out of order callback`() {
        val coordinator = BackRequestCoordinator()
        val timedOutRequest = coordinator.begin(BackPageAvailability.TRUSTED_PAGE).requestId()

        assertEquals(
            BackCommand.Stay(BackStayReason.TIMEOUT),
            coordinator.timeout(timedOutRequest),
        )
        val currentRequest = coordinator.begin(BackPageAvailability.TRUSTED_PAGE).requestId()
        assertNull(coordinator.resolve(timedOutRequest, webResult("exit")))
        assertEquals(
            BackCommand.Stay(BackStayReason.HANDLED),
            coordinator.resolve(currentRequest, webResult("handled")),
        )
    }

    @Test
    fun `invalid result and evaluate exception stay open and remain retryable`() {
        val coordinator = BackRequestCoordinator()
        val malformed = coordinator.begin(BackPageAvailability.TRUSTED_PAGE).requestId()
        assertEquals(
            BackCommand.Stay(BackStayReason.INVALID_RESULT),
            coordinator.resolve(malformed, "{\"status\":\"exit\"}"),
        )

        val exception = coordinator.begin(BackPageAvailability.TRUSTED_PAGE).requestId()
        assertEquals(
            BackCommand.Stay(BackStayReason.EVALUATION_FAILED),
            coordinator.evaluationFailed(exception),
        )
        assertTrue(
            coordinator.begin(BackPageAvailability.TRUSTED_PAGE) is BackCommand.EvaluateJavascript,
        )
    }

    @Test
    fun `unavailable browser session never evaluates or exits while host entry exits natively`() {
        val unavailableCoordinator = BackRequestCoordinator()
        assertEquals(
            BackCommand.Stay(BackStayReason.UNAVAILABLE),
            unavailableCoordinator.begin(BackPageAvailability.UNAVAILABLE),
        )
        assertTrue(
            unavailableCoordinator.begin(BackPageAvailability.TRUSTED_PAGE) is
                BackCommand.EvaluateJavascript,
        )

        val hostEntryCoordinator = BackRequestCoordinator()
        assertEquals(
            BackCommand.FinishActivity,
            hostEntryCoordinator.begin(BackPageAvailability.HOST_ENTRY),
        )
    }

    @Test
    fun `page invalidation makes the old callback stale`() {
        val coordinator = BackRequestCoordinator()
        val oldRequest = coordinator.begin(BackPageAvailability.TRUSTED_PAGE).requestId()

        coordinator.cancelPending()

        assertNull(coordinator.resolve(oldRequest, webResult("exit")))
        assertTrue(
            coordinator.begin(BackPageAvailability.TRUSTED_PAGE) is BackCommand.EvaluateJavascript,
        )
    }

    @Test
    fun `parser rejects unknown contradictory and non object values`() {
        assertEquals(WebBackStatus.HANDLED, WebBackResultParser.parse(webResult("handled")))
        assertEquals(WebBackStatus.BLOCKED, WebBackResultParser.parse(webResult("blocked")))
        assertEquals(WebBackStatus.EXIT, WebBackResultParser.parse(webResult("exit")))

        assertNull(WebBackResultParser.parse(null))
        assertNull(WebBackResultParser.parse("null"))
        assertNull(WebBackResultParser.parse("\"exit\""))
        assertNull(WebBackResultParser.parse("{\"status\":\"unknown\"}"))
        assertNull(
            WebBackResultParser.parse(
                """{"status":"exit","handled":true,"blocked":false,"exit":true}""",
            ),
        )
    }

    private fun webResult(status: String): String {
        val handled = status == "handled"
        val blocked = status == "blocked"
        val exit = status == "exit"
        return """{"status":"$status","handled":$handled,"blocked":$blocked,"exit":$exit,"action":"request"}"""
    }

    private fun BackCommand.requestId(): Long =
        (this as BackCommand.EvaluateJavascript).requestId
}
