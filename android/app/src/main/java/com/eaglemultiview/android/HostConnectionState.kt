package com.eaglemultiview.android

enum class ConnectionFailureKind {
    UNREACHABLE,
    HTTP_ERROR,
    TLS_ERROR,
    RENDERER_CRASHED,
}

sealed interface HostConnectionState {
    data object HostEntry : HostConnectionState
    data class Connecting(val endpoint: HostEndpoint) : HostConnectionState
    data class Connected(val endpoint: HostEndpoint) : HostConnectionState
    data class LoginRequired(val endpoint: HostEndpoint) : HostConnectionState
    data class Failed(
        val endpoint: HostEndpoint,
        val kind: ConnectionFailureKind,
        val httpStatus: Int? = null,
    ) : HostConnectionState
}

interface RecentHostStore {
    fun read(): HostEndpoint?
    fun save(endpoint: HostEndpoint)
}

/**
 * Owns host trust and connection transitions without depending on WebView callbacks directly.
 * Later Android tickets can add back navigation, offline recovery, and host handoff around this model.
 */
class HostConnectionCoordinator(
    private val recentHostStore: RecentHostStore,
) {
    var state: HostConnectionState = HostConnectionState.HostEntry
        private set

    var activeEndpoint: HostEndpoint? = null
        private set

    fun restore(): HostEndpoint? = recentHostStore.read()?.also { beginConnection(it) }

    /** Returns true when changing origin requires clearing WebView site data first. */
    fun beginConnection(endpoint: HostEndpoint): Boolean {
        val clearPreviousOrigin = activeEndpoint?.origin?.let { it != endpoint.origin } == true
        activeEndpoint = endpoint
        state = HostConnectionState.Connecting(endpoint)
        return clearPreviousOrigin
    }

    fun pageCommitted(rawUrl: String?): Boolean {
        val endpoint = activeEndpoint ?: return false
        val target = TrustedNavigationPolicy.classify(endpoint, rawUrl)
        if (!target.isTrusted) return false

        recentHostStore.save(endpoint)
        state = if (target == NavigationTarget.TrustedLogin) {
            HostConnectionState.LoginRequired(endpoint)
        } else {
            HostConnectionState.Connected(endpoint)
        }
        return true
    }

    fun fail(kind: ConnectionFailureKind, httpStatus: Int? = null) {
        val endpoint = activeEndpoint ?: return
        state = HostConnectionState.Failed(endpoint, kind, httpStatus)
    }

    fun retry(): HostEndpoint? = activeEndpoint?.also { state = HostConnectionState.Connecting(it) }

    /** Returns whether trusted WebView data needs clearing before showing host entry. */
    fun showHostEntry(): Boolean {
        val hadActiveHost = activeEndpoint != null
        activeEndpoint = null
        state = HostConnectionState.HostEntry
        return hadActiveHost
    }
}
