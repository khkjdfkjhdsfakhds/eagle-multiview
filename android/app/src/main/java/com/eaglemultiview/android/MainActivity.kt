package com.eaglemultiview.android

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    private lateinit var hostPanel: LinearLayout
    private lateinit var browserContainer: LinearLayout
    private lateinit var hostInput: EditText
    private lateinit var hostErrorText: TextView
    private lateinit var connectButton: Button
    private lateinit var changeHostButton: Button
    private lateinit var retryButton: Button
    private lateinit var stateChangeHostButton: Button
    private lateinit var authRetryButton: Button
    private lateinit var authChangeHostButton: Button
    private lateinit var statusText: TextView
    private lateinit var authBanner: LinearLayout
    private lateinit var progressBar: ProgressBar
    private lateinit var stateOverlay: LinearLayout
    private lateinit var stateProgress: ProgressBar
    private lateinit var stateTitle: TextView
    private lateinit var stateMessage: TextView
    private lateinit var webView: WebView

    private val connectionCoordinator by lazy {
        HostConnectionCoordinator(SharedPreferencesRecentHostStore(this))
    }
    private val backRequestCoordinator = BackRequestCoordinator()
    private val recoveryCoordinator = HostRecoveryCoordinator()
    private val healthProbeRunner = SessionHealthProbeRunner()
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var connectivityManager: ConnectivityManager
    private var networkCallbackRegistered = false
    private var networkAvailable = true
    private var activeHostSession: HostSession? = null
    private var mainFrameFailed = false
    private var trustClearInProgress = false
    private var trustedPageReady = false
    private var webViewAvailable = true
    private var activeHostWebViewClient: HostWebViewClient? = null
    private var backTimeoutRequestId: Long? = null
    private var backTimeoutRunnable: Runnable? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        hostPanel = findViewById(R.id.hostPanel)
        browserContainer = findViewById(R.id.browserContainer)
        hostInput = findViewById(R.id.hostInput)
        hostErrorText = findViewById(R.id.hostErrorText)
        connectButton = findViewById(R.id.connectButton)
        changeHostButton = findViewById(R.id.changeHostButton)
        retryButton = findViewById(R.id.retryButton)
        stateChangeHostButton = findViewById(R.id.stateChangeHostButton)
        authRetryButton = findViewById(R.id.authRetryButton)
        authChangeHostButton = findViewById(R.id.authChangeHostButton)
        statusText = findViewById(R.id.statusText)
        authBanner = findViewById(R.id.authBanner)
        progressBar = findViewById(R.id.progressBar)
        stateOverlay = findViewById(R.id.stateOverlay)
        stateProgress = findViewById(R.id.stateProgress)
        stateTitle = findViewById(R.id.stateTitle)
        stateMessage = findViewById(R.id.stateMessage)
        webView = findViewById(R.id.webView)

        configureWebView()
        bindHostEntryActions()
        bindBrowserActions()
        bindSystemBack()
        registerNetworkMonitoring()

        val restoredHost = connectionCoordinator.restore()
        if (restoredHost == null) {
            showHostEntry()
        } else {
            hostInput.setText(restoredHost.startUrl)
            val session = recoveryCoordinator.activate(restoredHost, networkAvailable)
            activeHostSession = session
            startEndpoint(session, clearSiteData = false)
        }
    }

    private fun bindHostEntryActions() {
        findViewById<Button>(R.id.pasteButton).setOnClickListener {
            val clipboard = getSystemService(ClipboardManager::class.java)
            val pasted = clipboard?.primaryClip
                ?.takeIf { it.itemCount > 0 }
                ?.getItemAt(0)
                ?.coerceToText(this)
                ?.toString()
                ?.trim()
                .orEmpty()

            if (pasted.isEmpty()) {
                Toast.makeText(this, R.string.clipboard_empty, Toast.LENGTH_SHORT).show()
            } else {
                hostInput.setText(pasted)
                hostInput.setSelection(pasted.length)
            }
        }

        connectButton.setOnClickListener {
            connectFromInput()
        }
        hostInput.setOnEditorActionListener { _, _, _ ->
            connectFromInput()
            true
        }
    }

    private fun bindBrowserActions() {
        changeHostButton.setOnClickListener {
            enterHostEntryAndClearTrust()
        }
        stateChangeHostButton.setOnClickListener {
            enterHostEntryAndClearTrust()
        }
        retryButton.setOnClickListener {
            requestRecoveryRetry()
        }
        authRetryButton.setOnClickListener {
            requestRecoveryRetry()
        }
        authChangeHostButton.setOnClickListener {
            enterHostEntryAndClearTrust()
        }
    }

    private fun bindSystemBack() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                dispatchBackCommand(backRequestCoordinator.begin(currentBackAvailability()))
            }

            // The web client owns its own transient/preview/history state. There is no native
            // visual state to animate, so predictive-back progress is intentionally not mapped
            // to a fabricated page transition. The committed gesture still arrives here.
            override fun handleOnBackStarted(backEvent: BackEventCompat) = Unit

            override fun handleOnBackProgressed(backEvent: BackEventCompat) = Unit

            override fun handleOnBackCancelled() = Unit
        })
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            safeBrowsingEnabled = true
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, false)
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progressBar.progress = newProgress
                progressBar.visibility = if (newProgress in 0..99) View.VISIBLE else View.GONE
            }
        }
    }

    private fun connectFromInput() {
        if (trustClearInProgress) return
        when (val result = HostUrlValidator.validate(hostInput.text.toString())) {
            is HostInputResult.Invalid -> {
                showHostInputError(result.error)
                return
            }
            is HostInputResult.Valid -> {
                clearHostInputError()
                hostInput.setText(result.endpoint.startUrl)
                hostInput.setSelection(hostInput.length())
                invalidateTrustedPage()
                val clearSiteData = connectionCoordinator.beginConnection(result.endpoint)
                val session = recoveryCoordinator.activate(result.endpoint, networkAvailable)
                activeHostSession = session
                startEndpoint(session, clearSiteData)
            }
        }
    }

    private fun startEndpoint(session: HostSession, clearSiteData: Boolean) {
        invalidateTrustedPage()
        browserContainer.visibility = View.VISIBLE
        hostPanel.visibility = View.GONE
        renderState(HostConnectionState.Connecting(session.endpoint))
        if (clearSiteData) {
            clearWebViewTrust {
                if (recoveryCoordinator.isCurrent(session.generation, session.endpoint)) {
                    loadEndpoint(session, session.endpoint.startUrl)
                }
            }
        } else {
            loadEndpoint(session, session.endpoint.startUrl)
        }
    }

    private fun loadEndpoint(session: HostSession, url: String) {
        if (!recoveryCoordinator.isCurrent(session.generation, session.endpoint)) return
        if (!networkAvailable) {
            handleRecoveryAction(recoveryCoordinator.networkUnavailable(session.generation))
            return
        }
        mainFrameFailed = false
        trustedPageReady = false
        webViewAvailable = true
        webView.visibility = View.VISIBLE
        val client = HostWebViewClient(session.endpoint, session.generation)
        activeHostWebViewClient = client
        webView.webViewClient = client
        webView.loadUrl(url)
    }

    private fun enterHostEntryAndClearTrust() {
        invalidateTrustedPage()
        recoveryCoordinator.deactivate()
        activeHostSession = null
        val hadTrustedHost = connectionCoordinator.showHostEntry()
        hostPanel.visibility = View.VISIBLE
        browserContainer.visibility = View.GONE
        clearHostInputError()
        if (hadTrustedHost && !trustClearInProgress) {
            clearWebViewTrust {
                webView.visibility = View.VISIBLE
            }
        }
    }

    /** Clears WebView cookies/storage/cache before a different host is trusted. */
    private fun clearWebViewTrust(onComplete: () -> Unit) {
        invalidateTrustedPage()
        trustClearInProgress = true
        setConnectionControlsEnabled(false)
        mainFrameFailed = false
        webView.stopLoading()
        activeHostWebViewClient = null
        webView.webViewClient = WebViewClient()
        webView.loadUrl("about:blank")
        webView.clearHistory()
        webView.clearCache(true)
        webView.clearFormData()
        WebStorage.getInstance().deleteAllData()
        CookieManager.getInstance().removeAllCookies {
            runOnUiThread {
                trustClearInProgress = false
                setConnectionControlsEnabled(true)
                if (!isDestroyed) onComplete()
            }
        }
        CookieManager.getInstance().flush()
    }

    private fun setConnectionControlsEnabled(enabled: Boolean) {
        connectButton.isEnabled = enabled
        changeHostButton.isEnabled = enabled
        retryButton.isEnabled = enabled
        stateChangeHostButton.isEnabled = enabled
        authRetryButton.isEnabled = enabled
        authChangeHostButton.isEnabled = enabled
    }

    private fun showHostEntry() {
        invalidateTrustedPage()
        hostPanel.visibility = View.VISIBLE
        browserContainer.visibility = View.GONE
        clearHostInputError()
    }

    private fun showHostInputError(error: HostInputError) {
        hostInput.error = getString(error.messageRes())
        hostErrorText.text = getString(error.messageRes())
        hostErrorText.visibility = View.VISIBLE
        hostInput.requestFocus()
    }

    private fun clearHostInputError() {
        hostInput.error = null
        hostErrorText.text = ""
        hostErrorText.visibility = View.GONE
    }

    private fun renderState(state: HostConnectionState) {
        when (state) {
            HostConnectionState.HostEntry -> showHostEntry()
            is HostConnectionState.Connecting -> {
                statusText.text = getString(R.string.loading_host)
                authBanner.visibility = View.GONE
                webView.visibility = View.VISIBLE
                stateOverlay.visibility = View.VISIBLE
                stateProgress.visibility = View.VISIBLE
                stateTitle.text = getString(R.string.state_connecting_title)
                stateMessage.text = getString(R.string.state_connecting_message)
                retryButton.isEnabled = false
            }
            is HostConnectionState.Connected -> {
                statusText.text = getString(R.string.connected_host)
                authBanner.visibility = View.GONE
                stateOverlay.visibility = View.GONE
                webView.visibility = View.VISIBLE
                retryButton.isEnabled = true
            }
            is HostConnectionState.LoginRequired -> {
                statusText.text = getString(R.string.state_login_title)
                authBanner.visibility = View.VISIBLE
                stateOverlay.visibility = View.GONE
                webView.visibility = View.VISIBLE
                retryButton.isEnabled = true
            }
            is HostConnectionState.Failed -> {
                authBanner.visibility = View.GONE
                stateOverlay.visibility = View.VISIBLE
                stateProgress.visibility = View.GONE
                webView.visibility = View.INVISIBLE
                retryButton.isEnabled = !trustClearInProgress
                when (state.kind) {
                    ConnectionFailureKind.OFFLINE -> {
                        statusText.text = getString(R.string.state_offline_title)
                        stateTitle.text = getString(R.string.state_offline_title)
                        stateMessage.text = getString(R.string.state_offline_message)
                    }
                    ConnectionFailureKind.UNREACHABLE -> {
                        statusText.text = getString(R.string.state_unreachable_title)
                        stateTitle.text = getString(R.string.state_unreachable_title)
                        stateMessage.text = getString(R.string.state_unreachable_message)
                    }
                    ConnectionFailureKind.HTTP_ERROR -> {
                        statusText.text = getString(R.string.state_http_error_title)
                        stateTitle.text = getString(R.string.state_http_error_title)
                        stateMessage.text = getString(
                            R.string.state_http_error_message,
                            state.httpStatus ?: 0,
                        )
                    }
                    ConnectionFailureKind.TLS_ERROR -> {
                        statusText.text = getString(R.string.state_tls_error_title)
                        stateTitle.text = getString(R.string.state_tls_error_title)
                        stateMessage.text = getString(R.string.state_tls_error_message)
                    }
                    ConnectionFailureKind.RENDERER_CRASHED -> {
                        statusText.text = getString(R.string.state_renderer_crashed_title)
                        stateTitle.text = getString(R.string.state_renderer_crashed_title)
                        stateMessage.text = getString(R.string.state_renderer_crashed_message)
                    }
                }
            }
        }
    }

    private fun requestRecoveryRetry() {
        val session = activeHostSession ?: return
        handleRecoveryAction(recoveryCoordinator.manualRetry(session.generation))
    }

    private fun handleRecoveryAction(action: HostRecoveryAction?) {
        when (action) {
            null -> Unit
            is HostRecoveryAction.Probe -> {
                connectionCoordinator.retry()
                renderState(HostConnectionState.Connecting(action.request.endpoint))
                val cookie = CookieManager.getInstance().getCookie(action.request.endpoint.startUrl)
                healthProbeRunner.execute(action.request, cookie) callback@ { request, health, httpStatus ->
                    if (isDestroyed) return@callback
                    mainHandler.post {
                        if (!isDestroyed) {
                            handleRecoveryAction(
                                recoveryCoordinator.probeCompleted(request, health, httpStatus),
                            )
                        }
                    }
                }
            }
            is HostRecoveryAction.Navigate -> {
                val session = activeHostSession ?: return
                if (!recoveryCoordinator.isCurrent(session.generation, session.endpoint)) return
                connectionCoordinator.retry()
                renderState(HostConnectionState.Connecting(session.endpoint))
                loadEndpoint(session, action.url)
            }
            is HostRecoveryAction.ShowFailure -> {
                invalidateTrustedPage()
                connectionCoordinator.fail(action.kind, action.httpStatus)
                renderState(connectionCoordinator.state)
            }
        }
    }

    private fun registerNetworkMonitoring() {
        connectivityManager = getSystemService(ConnectivityManager::class.java)
        networkAvailable = connectivityManager.activeNetwork != null
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                mainHandler.post(::refreshNetworkAvailability)
            }

            override fun onLost(network: Network) {
                mainHandler.post(::refreshNetworkAvailability)
            }
        }
        networkCallback = callback
        try {
            connectivityManager.registerDefaultNetworkCallback(callback)
            networkCallbackRegistered = true
        } catch (_: RuntimeException) {
            networkCallback = null
        }
    }

    private fun refreshNetworkAvailability() {
        if (isDestroyed) return
        val available = connectivityManager.activeNetwork != null
        if (available == networkAvailable) return
        networkAvailable = available
        val session = activeHostSession ?: return
        if (available) {
            handleRecoveryAction(recoveryCoordinator.networkAvailable(session.generation))
        } else {
            invalidateTrustedPage()
            mainFrameFailed = true
            webView.stopLoading()
            handleRecoveryAction(recoveryCoordinator.networkUnavailable(session.generation))
        }
    }

    private fun currentBackAvailability(): BackPageAvailability = when {
        hostPanel.visibility == View.VISIBLE || connectionCoordinator.state is HostConnectionState.HostEntry -> {
            BackPageAvailability.HOST_ENTRY
        }
        !webViewAvailable || !trustedPageReady -> BackPageAvailability.UNAVAILABLE
        else -> BackPageAvailability.TRUSTED_PAGE
    }

    private fun dispatchBackCommand(command: BackCommand) {
        when (command) {
            is BackCommand.EvaluateJavascript -> evaluateWebBack(command.requestId)
            BackCommand.FinishActivity -> finishActivityOnce()
            is BackCommand.Stay -> handleBackStay(command.reason)
        }
    }

    private fun evaluateWebBack(requestId: Long) {
        if (!webViewAvailable || !trustedPageReady) {
            dispatchBackCommand(
                backRequestCoordinator.evaluationFailed(requestId)
                    ?: BackCommand.Stay(BackStayReason.UNAVAILABLE),
            )
            return
        }

        scheduleBackTimeout(requestId)
        try {
            webView.evaluateJavascript(WEB_BACK_REQUEST_JAVASCRIPT) { rawResult ->
                cancelBackTimeout(requestId)
                backRequestCoordinator.resolve(requestId, rawResult)?.let(::dispatchBackCommand)
            }
        } catch (_: Throwable) {
            cancelBackTimeout(requestId)
            backRequestCoordinator.evaluationFailed(requestId)?.let(::dispatchBackCommand)
        }
    }

    private fun scheduleBackTimeout(requestId: Long) {
        cancelBackTimeout(backTimeoutRequestId)
        val timeout = Runnable {
            if (backTimeoutRequestId == requestId) {
                backTimeoutRequestId = null
                backTimeoutRunnable = null
                backRequestCoordinator.timeout(requestId)?.let(::dispatchBackCommand)
            }
        }
        backTimeoutRequestId = requestId
        backTimeoutRunnable = timeout
        mainHandler.postDelayed(timeout, BACK_REQUEST_TIMEOUT_MS)
    }

    private fun cancelBackTimeout(requestId: Long?) {
        if (requestId == null || backTimeoutRequestId != requestId) return
        backTimeoutRunnable?.let(mainHandler::removeCallbacks)
        backTimeoutRequestId = null
        backTimeoutRunnable = null
    }

    private fun handleBackStay(reason: BackStayReason) {
        when (reason) {
            BackStayReason.UNAVAILABLE ->
                Toast.makeText(this, R.string.back_unavailable, Toast.LENGTH_SHORT).show()
            BackStayReason.TIMEOUT ->
                Toast.makeText(this, R.string.back_request_timeout, Toast.LENGTH_SHORT).show()
            BackStayReason.INVALID_RESULT,
            BackStayReason.EVALUATION_FAILED,
            -> Toast.makeText(this, R.string.back_request_failed, Toast.LENGTH_SHORT).show()
            BackStayReason.HANDLED,
            BackStayReason.BLOCKED,
            BackStayReason.BUSY,
            BackStayReason.ALREADY_FINISHING,
            -> Unit
        }
    }

    private fun finishActivityOnce() {
        if (!isFinishing && !isDestroyed) finish()
    }

    private fun invalidateTrustedPage() {
        trustedPageReady = false
        backRequestCoordinator.cancelPending()
        cancelBackTimeout(backTimeoutRequestId)
    }

    private fun replaceWebViewAfterRendererGone(deadWebView: WebView) {
        activeHostWebViewClient = null
        val parent = deadWebView.parent as? ViewGroup
        val index = parent?.indexOfChild(deadWebView) ?: -1
        val layoutParams = deadWebView.layoutParams
        if (parent != null && index >= 0) parent.removeViewAt(index)
        deadWebView.destroy()

        if (parent == null || index < 0) {
            webViewAvailable = false
            return
        }

        webView = WebView(this).apply {
            id = R.id.webView
            this.layoutParams = layoutParams
            contentDescription = getString(R.string.webview_description)
        }
        parent.addView(webView, index)
        webViewAvailable = true
        configureWebView()
    }

    private fun launchExternalBrowser(url: String) {
        val uri = try {
            Uri.parse(url)
        } catch (_: Exception) {
            return
        }
        if (uri.scheme?.lowercase() !in setOf("http", "https")) return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_browser_found, Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroy() {
        invalidateTrustedPage()
        recoveryCoordinator.deactivate()
        activeHostSession = null
        healthProbeRunner.shutdown()
        if (networkCallbackRegistered) {
            networkCallback?.let { callback ->
                try {
                    connectivityManager.unregisterNetworkCallback(callback)
                } catch (_: RuntimeException) {
                    // The callback is Activity-owned and already invalidated below.
                }
            }
            networkCallbackRegistered = false
        }
        networkCallback = null
        mainHandler.removeCallbacksAndMessages(null)
        webView.stopLoading()
        webView.webChromeClient = null
        activeHostWebViewClient = null
        webView.webViewClient = WebViewClient()
        webView.destroy()
        super.onDestroy()
    }

    private inner class HostWebViewClient(
        private val endpoint: HostEndpoint,
        private val generation: Long,
    ) : WebViewClient() {
        private fun isCurrentCallback(view: WebView?): Boolean = webViewAvailable &&
            HostWebViewCallbackGuard.matches(
                callbackClient = this,
                activeClient = activeHostWebViewClient,
                callbackView = view,
                currentView = webView,
                callbackEndpoint = endpoint,
                activeEndpoint = connectionCoordinator.activeEndpoint,
                callbackGeneration = generation,
                activeGeneration = activeHostSession?.generation,
            )

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!isCurrentCallback(view)) return true
            if (!request.isForMainFrame) return false
            return when (TrustedNavigationPolicy.classify(endpoint, request.url.toString())) {
                NavigationTarget.TrustedPage,
                NavigationTarget.TrustedLogin,
                -> false
                NavigationTarget.ExternalWeb -> {
                    launchExternalBrowser(request.url.toString())
                    true
                }
                NavigationTarget.Blocked -> true
            }
        }

        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
            if (!isCurrentCallback(view)) return
            trustedPageReady = false
            backRequestCoordinator.cancelPending()
            cancelBackTimeout(backTimeoutRequestId)
            if (TrustedNavigationPolicy.classify(endpoint, url).isTrusted) {
                statusText.text = getString(R.string.loading_host)
            }
        }

        override fun onPageCommitVisible(view: WebView?, url: String?) {
            if (!isCurrentCallback(view)) return
            val committedTrustedPage = !mainFrameFailed &&
                connectionCoordinator.pageCommitted(url)
            trustedPageReady = committedTrustedPage
            if (committedTrustedPage) {
                recoveryCoordinator.pageCommitted(generation)
                renderState(connectionCoordinator.state)
            }
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            if (!isCurrentCallback(view)) return
            if (connectionCoordinator.state is HostConnectionState.Connected ||
                connectionCoordinator.state is HostConnectionState.LoginRequired
            ) {
                CookieManager.getInstance().flush()
            }
        }

        override fun onReceivedHttpError(
            view: WebView,
            request: WebResourceRequest,
            errorResponse: android.webkit.WebResourceResponse,
        ) {
            if (!isCurrentCallback(view)) return
            if (request.isForMainFrame) {
                invalidateTrustedPage()
                mainFrameFailed = true
                handleRecoveryAction(
                    recoveryCoordinator.pageLoadFailed(
                        generation,
                        ConnectionFailureKind.HTTP_ERROR,
                        errorResponse.statusCode,
                    ),
                )
            }
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError,
        ) {
            if (!isCurrentCallback(view)) return
            if (request.isForMainFrame) {
                invalidateTrustedPage()
                mainFrameFailed = true
                val kind = when {
                    !networkAvailable -> ConnectionFailureKind.OFFLINE
                    error.errorCode == WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> {
                        ConnectionFailureKind.TLS_ERROR
                    }
                    else -> ConnectionFailureKind.UNREACHABLE
                }
                handleRecoveryAction(recoveryCoordinator.pageLoadFailed(generation, kind))
            }
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
            handler.cancel()
            if (!isCurrentCallback(view)) return
            invalidateTrustedPage()
            mainFrameFailed = true
            handleRecoveryAction(
                recoveryCoordinator.pageLoadFailed(generation, ConnectionFailureKind.TLS_ERROR),
            )
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (!isCurrentCallback(view)) return true
            invalidateTrustedPage()
            mainFrameFailed = true
            replaceWebViewAfterRendererGone(view)
            handleRecoveryAction(
                recoveryCoordinator.pageLoadFailed(
                    generation,
                    ConnectionFailureKind.RENDERER_CRASHED,
                ),
            )
            return true
        }
    }

    private companion object {
        const val BACK_REQUEST_TIMEOUT_MS = 1_500L
    }
}

private fun HostInputError.messageRes(): Int = when (this) {
    HostInputError.EMPTY -> R.string.invalid_host_empty
    HostInputError.WHITESPACE -> R.string.invalid_host_whitespace
    HostInputError.UNSUPPORTED_SCHEME -> R.string.invalid_host_scheme
    HostInputError.MALFORMED -> R.string.invalid_host_malformed
    HostInputError.CREDENTIALS_NOT_ALLOWED -> R.string.invalid_host_credentials
    HostInputError.MISSING_HOST -> R.string.invalid_host_missing_host
    HostInputError.INVALID_PORT -> R.string.invalid_host_port
    HostInputError.QUERY_OR_FRAGMENT_NOT_ALLOWED -> R.string.invalid_host_query
}
