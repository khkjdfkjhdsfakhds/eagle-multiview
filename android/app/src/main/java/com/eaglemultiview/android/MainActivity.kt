package com.eaglemultiview.android

import android.annotation.SuppressLint
import android.content.ClipboardManager
import android.graphics.Bitmap
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
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
    private lateinit var statusText: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        hostPanel = findViewById(R.id.hostPanel)
        browserContainer = findViewById(R.id.browserContainer)
        hostInput = findViewById(R.id.hostInput)
        statusText = findViewById(R.id.statusText)
        progressBar = findViewById(R.id.progressBar)
        webView = findViewById(R.id.webView)

        configureWebView()
        bindHostEntryActions()
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

        findViewById<Button>(R.id.connectButton).setOnClickListener {
            loadHost(hostInput.text.toString())
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
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progressBar.progress = newProgress
                progressBar.visibility = if (newProgress in 0..99) View.VISIBLE else View.GONE
            }
        }
    }

    private fun loadHost(rawHost: String) {
        val normalizedHost = HostUrlValidator.normalize(rawHost)
        if (normalizedHost == null) {
            hostInput.error = getString(R.string.invalid_host_url)
            hostInput.requestFocus()
            return
        }

        hostInput.error = null
        hostInput.setText(normalizedHost)
        statusText.text = normalizedHost
        webView.webViewClient = HostWebViewClient(normalizedHost)
        hostPanel.visibility = View.GONE
        browserContainer.visibility = View.VISIBLE
        webView.loadUrl(normalizedHost)
    }

    override fun onDestroy() {
        webView.stopLoading()
        webView.webChromeClient = null
        webView.webViewClient = WebViewClient()
        webView.destroy()
        super.onDestroy()
    }

    private inner class HostWebViewClient(
        private val hostUrl: String,
    ) : WebViewClient() {
        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
            statusText.text = getString(R.string.loading_host, url ?: hostUrl)
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            statusText.text = url ?: hostUrl
            CookieManager.getInstance().flush()
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError,
        ) {
            if (request.isForMainFrame) {
                statusText.text = getString(R.string.host_load_failed)
            }
        }

    }
}
