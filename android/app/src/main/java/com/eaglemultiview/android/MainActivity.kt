package com.eaglemultiview.android

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.MarginLayoutParams
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : AppCompatActivity() {
    private lateinit var hostPanel: LinearLayout
    private lateinit var browserContainer: LinearLayout
    private lateinit var hostInput: EditText
    private lateinit var hostErrorText: TextView
    private lateinit var connectButton: Button
    private lateinit var retryButton: Button
    private lateinit var stateChangeHostButton: Button
    private lateinit var authRetryButton: Button
    private lateinit var authChangeHostButton: Button
    private lateinit var authBanner: LinearLayout
    private lateinit var progressBar: ProgressBar
    private lateinit var stateOverlay: LinearLayout
    private lateinit var stateProgress: ProgressBar
    private lateinit var stateTitle: TextView
    private lateinit var stateMessage: TextView
    private lateinit var webView: ShellWebView

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
    private var activeHostNavigationAttempt: HostNavigationAttempt? = null
    private var backTimeoutRequestId: Long? = null
    private var backTimeoutRunnable: Runnable? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private val fileChooserCoordinator = FileChooserCoordinator<Uri>()
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
        ::handleFileChooserResult,
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        hostPanel = findViewById(R.id.hostPanel)
        browserContainer = findViewById(R.id.browserContainer)
        hostInput = findViewById(R.id.hostInput)
        hostErrorText = findViewById(R.id.hostErrorText)
        connectButton = findViewById(R.id.connectButton)
        retryButton = findViewById(R.id.retryButton)
        stateChangeHostButton = findViewById(R.id.stateChangeHostButton)
        authRetryButton = findViewById(R.id.authRetryButton)
        authChangeHostButton = findViewById(R.id.authChangeHostButton)
        authBanner = findViewById(R.id.authBanner)
        progressBar = findViewById(R.id.progressBar)
        stateOverlay = findViewById(R.id.stateOverlay)
        stateProgress = findViewById(R.id.stateProgress)
        stateTitle = findViewById(R.id.stateTitle)
        stateMessage = findViewById(R.id.stateMessage)
        webView = findViewById(R.id.webView)

        applySystemInsets()
        configureWebView()
        bindHostEntryActions()
        bindBrowserActions()
        bindSystemBack()
        registerNetworkMonitoring()

        val recreatedMode = savedInstanceState?.getString(KEY_RECREATED_MODE)
        val recreateNeedsTrustClear = savedInstanceState?.getBoolean(KEY_TRUST_CLEAR_IN_PROGRESS) == true
        val recreatedFailure = savedInstanceState?.getString(KEY_FAILURE_KIND)
            ?.let { savedKind -> ConnectionFailureKind.entries.firstOrNull { it.name == savedKind } }
        val recreatedHttpStatus = savedInstanceState
            ?.takeIf { it.containsKey(KEY_FAILURE_HTTP_STATUS) }
            ?.getInt(KEY_FAILURE_HTTP_STATUS)
        when (recreatedMode) {
            MODE_HOST_ENTRY -> {
                hostInput.setText(savedInstanceState.getString(KEY_HOST_INPUT).orEmpty())
                showHostEntry()
                if (recreateNeedsTrustClear) {
                    clearWebViewTrust {
                        webView.visibility = View.VISIBLE
                    }
                }
            }
            MODE_ACTIVE_HOST -> {
                val activeHost = savedInstanceState.getString(KEY_ACTIVE_HOST)
                    ?.let { HostUrlValidator.validate(it) as? HostInputResult.Valid }
                    ?.endpoint
                if (activeHost == null) {
                    showHostEntry()
                } else {
                    hostInput.setText(activeHost.startUrl)
                    connectionCoordinator.beginConnection(activeHost)
                    val session = recoveryCoordinator.activate(activeHost, networkAvailable)
                    activeHostSession = session
                    if (recreatedFailure == null) {
                        startEndpoint(session, clearSiteData = recreateNeedsTrustClear)
                    } else {
                        connectionCoordinator.fail(recreatedFailure, recreatedHttpStatus)
                        recoveryCoordinator.pageLoadFailed(
                            session.generation,
                            recreatedFailure,
                            recreatedHttpStatus,
                        )
                        browserContainer.visibility = View.VISIBLE
                        hostPanel.visibility = View.GONE
                        renderState(connectionCoordinator.state)
                    }
                }
            }
            else -> {
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
        }
    }

    /**
     * Rotation, split screen, and freeform resizing are handled in place (see the manifest's
     * configChanges) so the web client keeps its folder, preview, and drafts instead of reloading.
     * Only the width-qualified native paddings need refreshing.
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyWindowSizeDimensions()
    }

    private fun applyWindowSizeDimensions() {
        val screenPadding = resources.getDimensionPixelSize(R.dimen.screen_padding)
        val panelPadding = resources.getDimensionPixelSize(R.dimen.panel_padding)
        authBanner.setPaddingRelative(screenPadding, authBanner.paddingTop, screenPadding, authBanner.paddingBottom)
        stateOverlay.setPadding(panelPadding, panelPadding, panelPadding, panelPadding)
        hostPanel.setPadding(panelPadding, panelPadding, panelPadding, panelPadding)
        (hostPanel.layoutParams as? MarginLayoutParams)?.let { params ->
            params.marginStart = screenPadding
            params.marginEnd = screenPadding
            hostPanel.layoutParams = params
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        val session = activeHostSession
        outState.putString(
            KEY_RECREATED_MODE,
            if (session == null || hostPanel.visibility == View.VISIBLE) MODE_HOST_ENTRY else MODE_ACTIVE_HOST,
        )
        outState.putString(KEY_HOST_INPUT, hostInput.text.toString())
        session?.endpoint?.startUrl?.let { outState.putString(KEY_ACTIVE_HOST, it) }
        outState.putBoolean(KEY_TRUST_CLEAR_IN_PROGRESS, trustClearInProgress)
        (connectionCoordinator.state as? HostConnectionState.Failed)?.let { failure ->
            outState.putString(KEY_FAILURE_KIND, failure.kind.name)
            failure.httpStatus?.let { outState.putInt(KEY_FAILURE_HTTP_STATUS, it) }
        }
        super.onSaveInstanceState(outState)
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
        hostInput.setOnEditorActionListener { _, actionId, event ->
            when (HostInputSubmitPolicy.decide(actionId, event?.toHardwareKey())) {
                HostInputSubmit.CONNECT -> {
                    connectFromInput()
                    true
                }
                HostInputSubmit.CONSUME -> true
                HostInputSubmit.IGNORE -> false
            }
        }
    }

    private fun bindBrowserActions() {
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
                requestBack()
            }

            // The web client owns its own transient/preview/history state. There is no native
            // visual state to animate, so predictive-back progress is intentionally not mapped
            // (and with enableOnBackInvokedCallback="false", kept so ShellWebView can see a
            // remapped keyboard Esc, it is not delivered). The committed Back still arrives here.
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
            // Lets the web client recognize the shell (single window, native Back) without
            // guessing from the generic WebView "wv" token.
            userAgentString = "${WebSettings.getDefaultUserAgent(this@MainActivity)} $USER_AGENT_TOKEN/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, false)
        }
        // Keyboard focus stays in the page: Tab traversal leaving the document and focus searches
        // resolve back to the WebView instead of native controls.
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.nextFocusUpId = webView.id
        webView.nextFocusDownId = webView.id
        webView.nextFocusLeftId = webView.id
        webView.nextFocusRightId = webView.id
        webView.nextFocusForwardId = webView.id
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progressBar.progress = newProgress
                progressBar.visibility = if (newProgress in 0..99) View.VISIBLE else View.GONE
            }

            override fun onShowFileChooser(
                view: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean = showFileChooser(view, filePathCallback, fileChooserParams)

            // The preview's <video controls> full-screen button.
            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                showFullscreenView(view, callback)
            }

            override fun onHideCustomView() {
                hideFullscreenView(notifyPage = false)
            }
        }
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            startHostDownload(url, userAgent, contentDisposition, mimeType)
        }
    }

    private fun showFullscreenView(view: View?, callback: WebChromeClient.CustomViewCallback?) {
        if (view == null || callback == null) return
        if (fullscreenView != null) {
            callback.onCustomViewHidden()
            return
        }
        fullscreenView = view
        fullscreenCallback = callback
        view.setBackgroundColor(Color.BLACK)
        rootContainer().addView(
            view,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        WindowCompat.getInsetsController(window, view).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    /** Leaves full-screen video; returns false when none was showing. */
    private fun hideFullscreenView(notifyPage: Boolean): Boolean {
        val view = fullscreenView ?: return false
        val callback = fullscreenCallback
        fullscreenView = null
        fullscreenCallback = null
        (view.parent as? ViewGroup)?.removeView(view)
        WindowCompat.getInsetsController(window, rootContainer()).show(WindowInsetsCompat.Type.systemBars())
        if (notifyPage) callback?.onCustomViewHidden()
        focusWebViewIfBrowsing()
        return true
    }

    private fun rootContainer(): ViewGroup = findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as ViewGroup

    /** System Back, back gestures, and an Esc the page left unconsumed all arrive here. */
    private fun requestBack() {
        if (hideFullscreenView(notifyPage = true)) return
        dispatchBackCommand(backRequestCoordinator.begin(currentBackAvailability()))
    }

    private fun showFileChooser(
        view: WebView?,
        filePathCallback: ValueCallback<Array<Uri>>?,
        params: WebChromeClient.FileChooserParams?,
    ): Boolean {
        if (filePathCallback == null) return false
        if (view !== webView || !webViewAvailable || !trustedPageReady) {
            filePathCallback.onReceiveValue(null)
            return true
        }
        fileChooserCoordinator.begin { uris -> filePathCallback.onReceiveValue(uris?.toTypedArray()) }
        val mimeTypes = FileChooserMimeTypes.resolve(params?.acceptTypes?.toList().orEmpty()) { extension ->
            MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
        }
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeTypes.singleOrNull() ?: "*/*"
            if (mimeTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
            putExtra(
                Intent.EXTRA_ALLOW_MULTIPLE,
                params?.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE,
            )
        }
        try {
            fileChooserLauncher.launch(intent)
        } catch (_: ActivityNotFoundException) {
            fileChooserCoordinator.cancel()
            Toast.makeText(this, R.string.file_chooser_unavailable, Toast.LENGTH_SHORT).show()
        }
        return true
    }

    private fun handleFileChooserResult(result: ActivityResult) {
        val data = result.data
        val clipItems = data?.clipData?.let { clip -> List(clip.itemCount) { clip.getItemAt(it).uri } }.orEmpty()
        fileChooserCoordinator.complete(
            FileChooserResult.collect(result.resultCode == Activity.RESULT_OK, clipItems, data?.data),
        )
        focusWebViewIfBrowsing()
    }

    private fun startHostDownload(
        url: String?,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?,
    ) {
        val endpoint = connectionCoordinator.activeEndpoint.takeIf { trustedPageReady && webViewAvailable }
        val plan = DownloadRequestPlanner.plan(endpoint, url, contentDisposition, mimeType) { mime ->
            MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)
        }
        val accepted = when (plan) {
            is DownloadPlan.Rejected -> {
                Toast.makeText(
                    this,
                    when (plan.reason) {
                        DownloadRejection.UNTRUSTED_ORIGIN -> R.string.download_untrusted
                        DownloadRejection.UNSUPPORTED_URL -> R.string.download_unsupported
                    },
                    Toast.LENGTH_SHORT,
                ).show()
                return
            }
            is DownloadPlan.Accepted -> plan
        }
        try {
            val request = DownloadManager.Request(Uri.parse(accepted.url)).apply {
                // The host authenticates downloads with the same HttpOnly session cookie as the page.
                CookieManager.getInstance().getCookie(accepted.url)?.let { addRequestHeader("Cookie", it) }
                userAgent?.takeIf { it.isNotBlank() }?.let { addRequestHeader("User-Agent", it) }
                accepted.mimeType?.let(::setMimeType)
                setTitle(accepted.fileName)
                setDescription(getString(R.string.download_description))
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, accepted.fileName)
                } else {
                    // Before Android 10 the shared Downloads folder needs a storage permission the
                    // shell intentionally does not request; keep the file in app-scoped Downloads.
                    setDestinationInExternalFilesDir(
                        this@MainActivity,
                        Environment.DIRECTORY_DOWNLOADS,
                        accepted.fileName,
                    )
                }
            }
            getSystemService(DownloadManager::class.java).enqueue(request)
            Toast.makeText(this, getString(R.string.download_started, accepted.fileName), Toast.LENGTH_SHORT)
                .show()
        } catch (_: RuntimeException) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show()
        }
    }

    private fun focusWebViewIfBrowsing() {
        if (!webViewAvailable || isFinishing || isDestroyed) return
        if (browserContainer.visibility != View.VISIBLE || webView.visibility != View.VISIBLE) return
        // Native retry/change-host actions keep focus while the failure overlay is shown.
        if (stateOverlay.visibility == View.VISIBLE) return
        if (!webView.hasFocus()) webView.requestFocus()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // Returning from background, the file picker, or a system dialog.
        if (hasFocus) focusWebViewIfBrowsing()
    }

    /** Returns true when the shell owned the key; false leaves Android's default handling. */
    private fun handleUnhandledWebKey(event: KeyEvent): Boolean =
        when (UnhandledWebKeyPolicy.decide(event.toHardwareKey())) {
            UnhandledKeyDecision.REQUEST_BACK -> {
                requestBack()
                true
            }
            UnhandledKeyDecision.CONSUME -> true
            UnhandledKeyDecision.DEFAULT -> false
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
                // The field is about to be hidden; its keyboard would otherwise stay up over the
                // page, attached to the WebView once that takes focus.
                hostInput.clearFocus()
                WindowCompat.getInsetsController(window, hostInput).hide(WindowInsetsCompat.Type.ime())
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
        val navigationAttempt = recoveryCoordinator.beginNavigation(session.generation) ?: return
        activeHostNavigationAttempt = navigationAttempt
        val client = HostWebViewClient(session.endpoint, session.generation, navigationAttempt)
        activeHostWebViewClient = client
        webView.webViewClient = client
        webView.loadUrl(url)
    }

    private fun enterHostEntryAndClearTrust() {
        invalidateTrustedPage()
        recoveryCoordinator.deactivate()
        activeHostSession = null
        activeHostNavigationAttempt = null
        val hadTrustedHost = connectionCoordinator.showHostEntry()
        hostPanel.visibility = View.VISIBLE
        browserContainer.visibility = View.GONE
        // From the login banner the dark page colours are still on the bars and root.
        applySystemBarColors(pageShowing = false)
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
        fileChooserCoordinator.cancel()
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
        retryButton.isEnabled = enabled
        stateChangeHostButton.isEnabled = enabled
        authRetryButton.isEnabled = enabled
        authChangeHostButton.isEnabled = enabled
    }

    private fun showHostEntry() {
        invalidateTrustedPage()
        hostPanel.visibility = View.VISIBLE
        browserContainer.visibility = View.GONE
        applySystemBarColors(pageShowing = false)
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
                applySystemBarColors(pageShowing = false)
                authBanner.visibility = View.GONE
                webView.visibility = View.VISIBLE
                stateOverlay.visibility = View.VISIBLE
                stateProgress.visibility = View.VISIBLE
                stateTitle.text = getString(R.string.state_connecting_title)
                stateMessage.text = getString(R.string.state_connecting_message)
                retryButton.isEnabled = false
            }
            is HostConnectionState.Connected -> {
                applySystemBarColors(pageShowing = true)
                authBanner.visibility = View.GONE
                stateOverlay.visibility = View.GONE
                webView.visibility = View.VISIBLE
                retryButton.isEnabled = true
            }
            is HostConnectionState.LoginRequired -> {
                applySystemBarColors(pageShowing = true)
                authBanner.visibility = View.VISIBLE
                stateOverlay.visibility = View.GONE
                webView.visibility = View.VISIBLE
                retryButton.isEnabled = true
            }
            is HostConnectionState.Failed -> {
                applySystemBarColors(pageShowing = false)
                authBanner.visibility = View.GONE
                stateOverlay.visibility = View.VISIBLE
                stateProgress.visibility = View.GONE
                webView.visibility = View.INVISIBLE
                retryButton.isEnabled = !trustClearInProgress
                when (state.kind) {
                    ConnectionFailureKind.OFFLINE -> {
                        stateTitle.text = getString(R.string.state_offline_title)
                        stateMessage.text = getString(R.string.state_offline_message)
                    }
                    ConnectionFailureKind.UNREACHABLE -> {
                        stateTitle.text = getString(R.string.state_unreachable_title)
                        stateMessage.text = getString(R.string.state_unreachable_message)
                    }
                    ConnectionFailureKind.HTTP_ERROR -> {
                        stateTitle.text = getString(R.string.state_http_error_title)
                        stateMessage.text = getString(
                            R.string.state_http_error_message,
                            state.httpStatus ?: 0,
                        )
                    }
                    ConnectionFailureKind.TLS_ERROR -> {
                        stateTitle.text = getString(R.string.state_tls_error_title)
                        stateMessage.text = getString(R.string.state_tls_error_message)
                    }
                    ConnectionFailureKind.RENDERER_CRASHED -> {
                        stateTitle.text = getString(R.string.state_renderer_crashed_title)
                        stateMessage.text = getString(R.string.state_renderer_crashed_message)
                    }
                }
            }
        }
    }

    /**
     * targetSdk 35 is drawn edge-to-edge on Android 15+, where adjustResize no
     * longer shrinks the window either. Opt in on every version and pad the
     * root by the system bars, cutout and soft keyboard so the native bars and
     * the page never sit under them.
     */
    private fun applySystemInsets() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val root = rootContainer()
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
    }

    /**
     * There is no native toolbar over the page (a browser tab has none either), so the system bar
     * strips take the colour of whatever fills the window: the dark MultiView page, or the light
     * native connection screens.
     */
    private fun applySystemBarColors(pageShowing: Boolean) {
        val root = rootContainer()
        root.setBackgroundColor(
            getColor(if (pageShowing) R.color.page_background else R.color.surface_background),
        )
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = !pageShowing
            isAppearanceLightNavigationBars = !pageShowing
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
                activeHostNavigationAttempt = null
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
            // A loaded page keeps running offline; only a page still loading needs stopping.
            val pageLive = trustedPageReady && webViewAvailable
            if (!pageLive) {
                invalidateTrustedPage()
                mainFrameFailed = true
                webView.stopLoading()
            }
            handleRecoveryAction(recoveryCoordinator.networkUnavailable(session.generation, pageLive))
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
        hideFullscreenView(notifyPage = true)
        trustedPageReady = false
        backRequestCoordinator.cancelPending()
        cancelBackTimeout(backTimeoutRequestId)
    }

    private fun replaceWebViewAfterRendererGone(deadWebView: WebView) {
        activeHostWebViewClient = null
        fileChooserCoordinator.cancel()
        val parent = deadWebView.parent as? ViewGroup
        val index = parent?.indexOfChild(deadWebView) ?: -1
        val layoutParams = deadWebView.layoutParams
        if (parent != null && index >= 0) parent.removeViewAt(index)
        deadWebView.destroy()

        if (parent == null || index < 0) {
            webViewAvailable = false
            return
        }

        webView = ShellWebView(this).apply {
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
        fileChooserCoordinator.cancel()
        webView.stopLoading()
        webView.setDownloadListener(null)
        webView.webChromeClient = null
        activeHostWebViewClient = null
        webView.webViewClient = WebViewClient()
        webView.destroy()
        super.onDestroy()
    }

    private inner class HostWebViewClient(
        private val endpoint: HostEndpoint,
        private val generation: Long,
        private val navigationAttempt: HostNavigationAttempt,
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
                callbackNavigationAttempt = navigationAttempt,
                activeNavigationAttempt = activeHostNavigationAttempt,
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
        }

        override fun onPageCommitVisible(view: WebView?, url: String?) {
            if (!isCurrentCallback(view)) return
            val committedTrustedPage = !mainFrameFailed &&
                connectionCoordinator.pageCommitted(url)
            trustedPageReady = committedTrustedPage
            if (committedTrustedPage) {
                recoveryCoordinator.pageCommitted(navigationAttempt)
                renderState(connectionCoordinator.state)
                focusWebViewIfBrowsing()
            }
        }

        override fun onUnhandledKeyEvent(view: WebView?, event: KeyEvent?) {
            if (event == null || !isCurrentCallback(view)) return
            if (!handleUnhandledWebKey(event)) super.onUnhandledKeyEvent(view, event)
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
                        navigationAttempt,
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
                handleRecoveryAction(recoveryCoordinator.pageLoadFailed(navigationAttempt, kind))
            }
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
            handler.cancel()
            if (!isCurrentCallback(view)) return
            invalidateTrustedPage()
            mainFrameFailed = true
            handleRecoveryAction(
                recoveryCoordinator.pageLoadFailed(navigationAttempt, ConnectionFailureKind.TLS_ERROR),
            )
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (!isCurrentCallback(view)) return true
            invalidateTrustedPage()
            mainFrameFailed = true
            replaceWebViewAfterRendererGone(view)
            handleRecoveryAction(
                recoveryCoordinator.pageLoadFailed(
                    navigationAttempt,
                    ConnectionFailureKind.RENDERER_CRASHED,
                ),
            )
            return true
        }
    }

    private companion object {
        const val BACK_REQUEST_TIMEOUT_MS = 1_500L
        const val USER_AGENT_TOKEN = "EagleMultiViewAndroid"
        const val KEY_RECREATED_MODE = "recreated_mode"
        const val KEY_HOST_INPUT = "host_input"
        const val KEY_ACTIVE_HOST = "active_host"
        const val KEY_TRUST_CLEAR_IN_PROGRESS = "trust_clear_in_progress"
        const val KEY_FAILURE_KIND = "failure_kind"
        const val KEY_FAILURE_HTTP_STATUS = "failure_http_status"
        const val MODE_HOST_ENTRY = "host_entry"
        const val MODE_ACTIVE_HOST = "active_host"
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
