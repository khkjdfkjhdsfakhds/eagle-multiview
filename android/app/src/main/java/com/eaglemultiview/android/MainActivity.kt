package com.eaglemultiview.android

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Bitmap
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
    private val mainHandler = Handler(Looper.getMainLooper())
    private var mainFrameFailed = false
    private var trustClearInProgress = false
    private var trustedPageReady = false
    private var webViewAvailable = true
    private var activeHostWebViewClient: HostWebViewClient? = null
    private var backTimeoutRequestId: Long? = null
    private var backTimeoutRunnable: Runnable? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        hostPanel = findViewById(R.id.hostPanel)
        browserContainer = findViewById(R.id.browserContainer)
        hostInput = findViewById(R.id.hostInput)
        hostErrorText = findViewById(R.id.hostErrorText)
        connectButton = findViewById(R.id.connectButton)
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

        val restoredHost = connectionCoordinator.restore()
        if (restoredHost == null) {
            showHostEntry()
        } else {
            hostInput.setText(restoredHost.startUrl)
            startEndpoint(restoredHost, clearSiteData = false)
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
        findViewById<Button>(R.id.changeHostButton).setOnClickListener {
            enterHostEntryAndClearTrust()
        }
        findViewById<Button>(R.id.stateChangeHostButton).setOnClickListener {
            enterHostEntryAndClearTrust()
        }
        findViewById<Button>(R.id.retryButton).setOnClickListener {
            connectionCoordinator.retry()?.let { endpoint ->
                startEndpoint(endpoint, clearSiteData = false)
            }
        }
        findViewById<Button>(R.id.authRetryButton).setOnClickListener {
            connectionCoordinator.retry()?.let { endpoint ->
                startEndpoint(endpoint, clearSiteData = false)
            }
        }
        findViewById<Button>(R.id.authChangeHostButton).setOnClickListener {
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
                startEndpoint(result.endpoint, clearSiteData)
            }
        }
    }

    private fun startEndpoint(endpoint: HostEndpoint, clearSiteData: Boolean) {
        invalidateTrustedPage()
        browserContainer.visibility = View.VISIBLE
        hostPanel.visibility = View.GONE
        renderState(HostConnectionState.Connecting(endpoint))
        if (clearSiteData) {
            clearWebViewTrust { loadEndpoint(endpoint) }
        } else {
            loadEndpoint(endpoint)
        }
    }

    private fun loadEndpoint(endpoint: HostEndpoint) {
        mainFrameFailed = false
        trustedPageReady = false
        webViewAvailable = true
        webView.visibility = View.VISIBLE
        val client = HostWebViewClient(endpoint)
        activeHostWebViewClient = client
        webView.webViewClient = client
        webView.loadUrl(endpoint.startUrl)
    }

    private fun enterHostEntryAndClearTrust() {
        invalidateTrustedPage()
        val hadTrustedHost = connectionCoordinator.showHostEntry()
        hostPanel.visibility = View.VISIBLE
        browserContainer.visibility = View.GONE
        clearHostInputError()
        if (hadTrustedHost) {
            trustClearInProgress = true
            connectButton.isEnabled = false
            clearWebViewTrust {
                trustClearInProgress = false
                connectButton.isEnabled = true
                webView.visibility = View.VISIBLE
            }
        }
    }

    /** Clears WebView cookies/storage/cache before a different host is trusted. */
    private fun clearWebViewTrust(onComplete: () -> Unit) {
        invalidateTrustedPage()
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
            runOnUiThread(onComplete)
        }
        CookieManager.getInstance().flush()
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
            }
            is HostConnectionState.Connected -> {
                statusText.text = getString(R.string.connected_host)
                authBanner.visibility = View.GONE
                stateOverlay.visibility = View.GONE
                webView.visibility = View.VISIBLE
            }
            is HostConnectionState.LoginRequired -> {
                statusText.text = getString(R.string.state_login_title)
                authBanner.visibility = View.VISIBLE
                stateOverlay.visibility = View.GONE
                webView.visibility = View.VISIBLE
            }
            is HostConnectionState.Failed -> {
                authBanner.visibility = View.GONE
                stateOverlay.visibility = View.VISIBLE
                stateProgress.visibility = View.GONE
                webView.visibility = View.INVISIBLE
                when (state.kind) {
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
    ) : WebViewClient() {
        private fun isCurrentCallback(view: WebView?): Boolean = webViewAvailable &&
            HostWebViewCallbackGuard.matches(
                callbackClient = this,
                activeClient = activeHostWebViewClient,
                callbackView = view,
                currentView = webView,
                callbackEndpoint = endpoint,
                activeEndpoint = connectionCoordinator.activeEndpoint,
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
                connectionCoordinator.fail(ConnectionFailureKind.HTTP_ERROR, errorResponse.statusCode)
                renderState(connectionCoordinator.state)
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
                val kind = if (error.errorCode == WebViewClient.ERROR_FAILED_SSL_HANDSHAKE) {
                    ConnectionFailureKind.TLS_ERROR
                } else {
                    ConnectionFailureKind.UNREACHABLE
                }
                connectionCoordinator.fail(kind)
                renderState(connectionCoordinator.state)
            }
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
            handler.cancel()
            if (!isCurrentCallback(view)) return
            invalidateTrustedPage()
            mainFrameFailed = true
            connectionCoordinator.fail(ConnectionFailureKind.TLS_ERROR)
            renderState(connectionCoordinator.state)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (!isCurrentCallback(view)) return true
            invalidateTrustedPage()
            mainFrameFailed = true
            replaceWebViewAfterRendererGone(view)
            connectionCoordinator.fail(ConnectionFailureKind.RENDERER_CRASHED)
            renderState(connectionCoordinator.state)
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
