package com.eaglemultiview.android

import android.os.Handler
import android.webkit.JavascriptInterface

/** Shell actions the web client may request from its own menus. */
internal enum class ShellCommand(val wireName: String) {
    CHECK_FOR_UPDATES("check-for-updates"),
    CHANGE_HOST("change-host"),
    ;

    companion object {
        fun parse(raw: String?): ShellCommand? = entries.firstOrNull { it.wireName == raw }
    }
}

/** Only the loaded MultiView page of the active host may drive the shell. */
internal object ShellCommandPolicy {
    fun allowed(endpoint: HostEndpoint?, pageReady: Boolean, pageUrl: String?): Boolean =
        pageReady && endpoint != null &&
            TrustedNavigationPolicy.classify(endpoint, pageUrl) == NavigationTarget.TrustedPage
}

/**
 * Exposed to the page as `window.EagleMVAndroid`. JavaScript calls arrive on a WebView binder
 * thread, so each request hops to the main thread where [dispatch] re-checks the page trust.
 */
internal class ShellBridge(
    private val mainHandler: Handler,
    private val versionName: String,
    private val dispatch: (ShellCommand) -> Unit,
) {
    @JavascriptInterface
    fun appVersion(): String = versionName

    @JavascriptInterface
    fun request(command: String?) {
        val parsed = ShellCommand.parse(command) ?: return
        mainHandler.post { dispatch(parsed) }
    }

    companion object {
        const val NAME = "EagleMVAndroid"
    }
}
