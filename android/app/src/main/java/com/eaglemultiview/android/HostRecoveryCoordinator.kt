package com.eaglemultiview.android

enum class RecoveryTrigger {
    MANUAL_RETRY,
    NETWORK_RECOVERY,
}

enum class RecoveryNavigation {
    RELOAD_CURRENT,
    LOGIN,
}

enum class SessionHealth {
    AUTHENTICATED,
    LOGIN_REQUIRED,
    UNREACHABLE,
    TLS_ERROR,
    HTTP_ERROR,
}

data class HostSession(
    val endpoint: HostEndpoint,
    val generation: Long,
)

data class HostNavigationAttempt(
    val id: Long,
    val generation: Long,
)

data class SessionHealthProbe(
    val id: Long,
    val generation: Long,
    val endpoint: HostEndpoint,
    val trigger: RecoveryTrigger,
)

sealed interface HostRecoveryAction {
    data class Probe(val request: SessionHealthProbe) : HostRecoveryAction
    data class Navigate(
        val url: String,
        val reason: RecoveryNavigation,
    ) : HostRecoveryAction
    data class ShowFailure(
        val kind: ConnectionFailureKind,
        val httpStatus: Int? = null,
    ) : HostRecoveryAction
}

/**
 * Serializes recovery work for one trusted host generation.
 *
 * The coordinator never replays RPCs. Its only successful recovery action is one safe GET
 * navigation after a read-only session probe. Every host activation/deactivation invalidates
 * older network, probe, WebView, and timer callbacks through [HostSession.generation].
 */
class HostRecoveryCoordinator {
    private var nextGeneration = 0L
    private var nextProbeId = 0L
    private var nextNavigationAttemptId = 0L
    private var activeSession: HostSession? = null
    private var activeProbe: SessionHealthProbe? = null
    private var activeNavigationAttempt: HostNavigationAttempt? = null
    private var networkAvailable: Boolean? = null
    private var outageActive = false
    private var automaticRecoveryAttempted = false

    var hasPendingNavigation = false
        private set

    val hasActiveHost: Boolean
        get() = activeSession != null

    fun activate(endpoint: HostEndpoint, availableNetwork: Boolean? = null): HostSession {
        val session = HostSession(endpoint, ++nextGeneration)
        activeSession = session
        activeProbe = null
        activeNavigationAttempt = null
        networkAvailable = availableNetwork
        outageActive = false
        automaticRecoveryAttempted = false
        hasPendingNavigation = false
        return session
    }

    fun deactivate() {
        nextGeneration += 1
        activeSession = null
        activeProbe = null
        activeNavigationAttempt = null
        outageActive = false
        automaticRecoveryAttempted = false
        hasPendingNavigation = false
    }

    fun isCurrent(generation: Long, endpoint: HostEndpoint? = null): Boolean {
        val session = activeSession ?: return false
        return session.generation == generation && (endpoint == null || session.endpoint == endpoint)
    }

    fun beginNavigation(generation: Long): HostNavigationAttempt? {
        if (!isCurrent(generation)) return null
        return HostNavigationAttempt(++nextNavigationAttemptId, generation).also {
            activeNavigationAttempt = it
        }
    }

    fun isCurrentNavigation(attempt: HostNavigationAttempt): Boolean =
        isCurrent(attempt.generation) && activeNavigationAttempt == attempt

    fun networkUnavailable(generation: Long): HostRecoveryAction? {
        if (!isCurrent(generation)) return null
        if (networkAvailable != false || !outageActive) {
            outageActive = true
            automaticRecoveryAttempted = false
        }
        networkAvailable = false
        activeProbe = null
        activeNavigationAttempt = null
        hasPendingNavigation = false
        return HostRecoveryAction.ShowFailure(ConnectionFailureKind.OFFLINE)
    }

    fun networkAvailable(generation: Long): HostRecoveryAction? {
        if (!isCurrent(generation)) return null
        networkAvailable = true
        if (!outageActive || automaticRecoveryAttempted || activeProbe != null || hasPendingNavigation) {
            return null
        }
        automaticRecoveryAttempted = true
        activeNavigationAttempt = null
        return beginProbe(RecoveryTrigger.NETWORK_RECOVERY)
    }

    fun manualRetry(generation: Long): HostRecoveryAction? {
        if (!isCurrent(generation) || activeProbe != null || hasPendingNavigation) return null
        activeNavigationAttempt = null
        return beginProbe(RecoveryTrigger.MANUAL_RETRY)
    }

    fun pageLoadFailed(
        generation: Long,
        kind: ConnectionFailureKind,
        httpStatus: Int? = null,
    ): HostRecoveryAction? {
        if (!isCurrent(generation)) return null
        if (activeProbe != null) return null
        outageActive = true
        activeProbe = null
        activeNavigationAttempt = null
        hasPendingNavigation = false
        return HostRecoveryAction.ShowFailure(kind, httpStatus)
    }

    fun pageCommitted(generation: Long) {
        if (!isCurrent(generation)) return
        outageActive = false
        automaticRecoveryAttempted = false
        activeProbe = null
        activeNavigationAttempt = null
        hasPendingNavigation = false
    }

    fun probeCompleted(
        request: SessionHealthProbe,
        health: SessionHealth,
        httpStatus: Int? = null,
    ): HostRecoveryAction? {
        if (!isCurrent(request.generation, request.endpoint) || activeProbe != request) return null
        activeProbe = null
        return when (health) {
            SessionHealth.AUTHENTICATED -> navigate(
                request.endpoint.startUrl,
                RecoveryNavigation.RELOAD_CURRENT,
            )
            SessionHealth.LOGIN_REQUIRED -> navigate(
                "${request.endpoint.origin}/login",
                RecoveryNavigation.LOGIN,
            )
            SessionHealth.UNREACHABLE -> HostRecoveryAction.ShowFailure(
                if (networkAvailable == false) ConnectionFailureKind.OFFLINE else ConnectionFailureKind.UNREACHABLE,
            )
            SessionHealth.TLS_ERROR -> HostRecoveryAction.ShowFailure(ConnectionFailureKind.TLS_ERROR)
            SessionHealth.HTTP_ERROR -> HostRecoveryAction.ShowFailure(
                ConnectionFailureKind.HTTP_ERROR,
                httpStatus,
            )
        }
    }

    fun pageLoadFailed(
        attempt: HostNavigationAttempt,
        kind: ConnectionFailureKind,
        httpStatus: Int? = null,
    ): HostRecoveryAction? {
        if (!isCurrentNavigation(attempt)) return null
        return pageLoadFailed(attempt.generation, kind, httpStatus)
    }

    fun pageCommitted(attempt: HostNavigationAttempt) {
        if (!isCurrentNavigation(attempt)) return
        outageActive = false
        automaticRecoveryAttempted = false
        activeProbe = null
        hasPendingNavigation = false
    }

    private fun beginProbe(trigger: RecoveryTrigger): HostRecoveryAction.Probe {
        val session = checkNotNull(activeSession)
        val request = SessionHealthProbe(
            id = ++nextProbeId,
            generation = session.generation,
            endpoint = session.endpoint,
            trigger = trigger,
        )
        activeProbe = request
        return HostRecoveryAction.Probe(request)
    }

    private fun navigate(url: String, reason: RecoveryNavigation): HostRecoveryAction.Navigate {
        hasPendingNavigation = true
        return HostRecoveryAction.Navigate(url, reason)
    }
}
