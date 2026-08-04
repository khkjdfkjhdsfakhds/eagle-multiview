package com.eaglemultiview.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HostRecoveryCoordinatorTest {
    private val first = endpoint("http://first.example.test")
    private val second = endpoint("http://second.example.test")

    @Test
    fun `startup offline enters a recoverable state and recovery reloads once`() {
        val coordinator = HostRecoveryCoordinator()
        val session = coordinator.activate(first, availableNetwork = false)

        assertEquals(
            HostRecoveryAction.ShowFailure(ConnectionFailureKind.OFFLINE),
            coordinator.networkUnavailable(session.generation),
        )

        val probe = coordinator.networkAvailable(session.generation).probe()
        assertEquals(RecoveryTrigger.NETWORK_RECOVERY, probe.trigger)
        assertNull(coordinator.networkAvailable(session.generation))

        assertEquals(
            HostRecoveryAction.Navigate(first.startUrl, RecoveryNavigation.RELOAD_CURRENT),
            coordinator.probeCompleted(probe, SessionHealth.AUTHENTICATED),
        )
        assertNull(coordinator.networkAvailable(session.generation))
    }

    @Test
    fun `failed recovery does not loop and manual retry remains available`() {
        val coordinator = HostRecoveryCoordinator()
        val session = coordinator.activate(first)
        coordinator.networkUnavailable(session.generation)

        val automatic = coordinator.networkAvailable(session.generation).probe()
        assertEquals(
            HostRecoveryAction.ShowFailure(ConnectionFailureKind.UNREACHABLE),
            coordinator.probeCompleted(automatic, SessionHealth.UNREACHABLE),
        )
        assertNull(coordinator.networkAvailable(session.generation))

        val manual = coordinator.manualRetry(session.generation).probe()
        assertEquals(RecoveryTrigger.MANUAL_RETRY, manual.trigger)
        assertEquals(
            HostRecoveryAction.Navigate(first.startUrl, RecoveryNavigation.RELOAD_CURRENT),
            coordinator.probeCompleted(manual, SessionHealth.AUTHENTICATED),
        )
    }

    @Test
    fun `session expiry navigates to login instead of retrying forever`() {
        val coordinator = HostRecoveryCoordinator()
        val session = coordinator.activate(first)

        val probe = coordinator.manualRetry(session.generation).probe()
        assertEquals(
            HostRecoveryAction.Navigate(
                "http://first.example.test/login",
                RecoveryNavigation.LOGIN,
            ),
            coordinator.probeCompleted(probe, SessionHealth.LOGIN_REQUIRED),
        )
        assertNull(coordinator.manualRetry(session.generation))

        coordinator.pageCommitted(session.generation)
        assertFalse(coordinator.hasPendingNavigation)
    }

    @Test
    fun `host generation invalidates old probes callbacks and navigation`() {
        val coordinator = HostRecoveryCoordinator()
        val oldSession = coordinator.activate(first)
        val oldProbe = coordinator.manualRetry(oldSession.generation).probe()

        val newSession = coordinator.activate(second)
        assertTrue(newSession.generation > oldSession.generation)
        assertFalse(coordinator.isCurrent(oldSession.generation, first))
        assertTrue(coordinator.isCurrent(newSession.generation, second))
        assertNull(coordinator.probeCompleted(oldProbe, SessionHealth.AUTHENTICATED))
        assertNull(coordinator.networkUnavailable(oldSession.generation))

        val currentProbe = coordinator.manualRetry(newSession.generation).probe()
        assertEquals(second, currentProbe.endpoint)
    }

    @Test
    fun `new host activation resets stale network state from the old host`() {
        val coordinator = HostRecoveryCoordinator()
        val oldSession = coordinator.activate(first)
        coordinator.networkUnavailable(oldSession.generation)

        val newSession = coordinator.activate(second, availableNetwork = true)
        val probe = coordinator.manualRetry(newSession.generation).probe()

        assertEquals(
            HostRecoveryAction.ShowFailure(ConnectionFailureKind.UNREACHABLE),
            coordinator.probeCompleted(probe, SessionHealth.UNREACHABLE),
        )
    }

    @Test
    fun `load failure after a committed page preserves one safe recovery attempt`() {
        val coordinator = HostRecoveryCoordinator()
        val session = coordinator.activate(first)
        coordinator.pageCommitted(session.generation)

        assertEquals(
            HostRecoveryAction.ShowFailure(ConnectionFailureKind.UNREACHABLE),
            coordinator.pageLoadFailed(session.generation, ConnectionFailureKind.UNREACHABLE),
        )
        coordinator.networkUnavailable(session.generation)
        val probe = coordinator.networkAvailable(session.generation).probe()
        assertEquals(
            HostRecoveryAction.Navigate(first.startUrl, RecoveryNavigation.RELOAD_CURRENT),
            coordinator.probeCompleted(probe, SessionHealth.AUTHENTICATED),
        )

        assertEquals(
            HostRecoveryAction.ShowFailure(ConnectionFailureKind.UNREACHABLE),
            coordinator.pageLoadFailed(session.generation, ConnectionFailureKind.UNREACHABLE),
        )
        assertNull(coordinator.networkAvailable(session.generation))
    }

    @Test
    fun `deactivation invalidates pending work for activity destroy or host entry`() {
        val coordinator = HostRecoveryCoordinator()
        val session = coordinator.activate(first)
        val probe = coordinator.manualRetry(session.generation).probe()

        coordinator.deactivate()

        assertNull(coordinator.probeCompleted(probe, SessionHealth.AUTHENTICATED))
        assertFalse(coordinator.hasActiveHost)
        assertFalse(coordinator.hasPendingNavigation)
    }

    private fun HostRecoveryAction?.probe(): SessionHealthProbe =
        (this as HostRecoveryAction.Probe).request

    private fun endpoint(url: String): HostEndpoint =
        (HostUrlValidator.validate(url) as HostInputResult.Valid).endpoint
}
