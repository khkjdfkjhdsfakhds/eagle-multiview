package com.eaglemultiview.android

/** Rejects callbacks from replaced clients, WebViews, pages, or host connections. */
internal object HostWebViewCallbackGuard {
    fun matches(
        callbackClient: Any,
        activeClient: Any?,
        callbackView: Any?,
        currentView: Any?,
        callbackEndpoint: HostEndpoint,
        activeEndpoint: HostEndpoint?,
    ): Boolean = callbackClient === activeClient &&
        callbackView === currentView &&
        callbackEndpoint == activeEndpoint
}
