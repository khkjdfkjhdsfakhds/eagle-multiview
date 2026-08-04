package com.eaglemultiview.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HostConnectionCoordinatorTest {
    private class FakeStore(private var endpoint: HostEndpoint? = null) : RecentHostStore {
        var saves = 0

        override fun read(): HostEndpoint? = endpoint

        override fun save(endpoint: HostEndpoint) {
            this.endpoint = endpoint
            saves += 1
        }
    }

    private val first = (HostUrlValidator.validate("http://first.example.test") as HostInputResult.Valid).endpoint
    private val second = (HostUrlValidator.validate("http://second.example.test") as HostInputResult.Valid).endpoint

    @Test
    fun `only a committed trusted page saves the recent host`() {
        val store = FakeStore()
        val coordinator = HostConnectionCoordinator(store)

        coordinator.beginConnection(first)
        assertEquals(0, store.saves)
        coordinator.fail(ConnectionFailureKind.UNREACHABLE)
        assertEquals(0, store.saves)
        assertTrue(coordinator.pageCommitted("https://other.example.test/").not())
        assertEquals(0, store.saves)

        coordinator.beginConnection(first)
        assertTrue(coordinator.pageCommitted("http://first.example.test/login"))
        assertEquals(1, store.saves)
        assertEquals(HostConnectionState.LoginRequired(first), coordinator.state)

        assertTrue(coordinator.pageCommitted("http://first.example.test/"))
        assertEquals(HostConnectionState.Connected(first), coordinator.state)
        assertEquals(2, store.saves)
    }

    @Test
    fun `switching origin requests site data clearing and retry keeps current session`() {
        val coordinator = HostConnectionCoordinator(FakeStore())

        coordinator.beginConnection(first)
        assertFalse(coordinator.beginConnection(first))
        assertTrue(coordinator.beginConnection(second))
        assertEquals(HostConnectionState.Connecting(second), coordinator.state)
        assertEquals(second, coordinator.retry())
        assertEquals(HostConnectionState.Connecting(second), coordinator.state)
    }

    @Test
    fun `restore starts only a previously saved normalized host`() {
        val store = FakeStore(first)
        val coordinator = HostConnectionCoordinator(store)

        assertEquals(first, coordinator.restore())
        assertEquals(HostConnectionState.Connecting(first), coordinator.state)

        val empty = HostConnectionCoordinator(FakeStore())
        assertNull(empty.restore())
        assertEquals(HostConnectionState.HostEntry, empty.state)
    }

    @Test
    fun `connection failures remain distinguishable and retry returns to connecting`() {
        val coordinator = HostConnectionCoordinator(FakeStore())
        coordinator.beginConnection(first)

        coordinator.fail(ConnectionFailureKind.UNREACHABLE)
        assertEquals(
            HostConnectionState.Failed(first, ConnectionFailureKind.UNREACHABLE),
            coordinator.state,
        )

        coordinator.retry()
        coordinator.fail(ConnectionFailureKind.HTTP_ERROR, 503)
        assertEquals(
            HostConnectionState.Failed(first, ConnectionFailureKind.HTTP_ERROR, 503),
            coordinator.state,
        )

        coordinator.retry()
        coordinator.fail(ConnectionFailureKind.TLS_ERROR)
        assertEquals(
            HostConnectionState.Failed(first, ConnectionFailureKind.TLS_ERROR),
            coordinator.state,
        )
    }
}
