package com.eaglemultiview.android

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
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
    private var mainFrameFailed = false
    private var trustClearInProgress = false

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
                val clearSiteData = connectionCoordinator.beginConnection(result.endpoint)
                startEndpoint(result.endpoint, clearSiteData)
            }
        }
    }

    private fun startEndpoint(endpoint: HostEndpoint, clearSiteData: Boolean) {
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
        webView.visibility = View.VISIBLE
        webView.webViewClient = HostWebViewClient(endpoint)
        webView.loadUrl(endpoint.startUrl)
    }

    private fun enterHostEntryAndClearTrust() {
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
        mainFrameFailed = false
        webView.stopLoading()
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
                }
            }
        }
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
        webView.stopLoading()
        webView.webChromeClient = null
        webView.webViewClient = WebViewClient()
        webView.destroy()
        super.onDestroy()
    }

    private inner class HostWebViewClient(
        private val endpoint: HostEndpoint,
    ) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
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
            if (TrustedNavigationPolicy.classify(endpoint, url).isTrusted) {
                statusText.text = getString(R.string.loading_host)
            }
        }

        override fun onPageCommitVisible(view: WebView?, url: String?) {
            if (!mainFrameFailed && connectionCoordinator.pageCommitted(url)) {
                renderState(connectionCoordinator.state)
            }
        }

        override fun onPageFinished(view: WebView?, url: String?) {
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
            if (request.isForMainFrame) {
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
            if (request.isForMainFrame) {
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
            mainFrameFailed = true
            connectionCoordinator.fail(ConnectionFailureKind.TLS_ERROR)
            renderState(connectionCoordinator.state)
        }
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
