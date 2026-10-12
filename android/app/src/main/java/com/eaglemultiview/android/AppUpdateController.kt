package com.eaglemultiview.android

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.LayoutInflater
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Checks the GitHub release feed, downloads the APK into the app cache, verifies it against
 * SHA256SUMS.txt and hands it to the system package installer. The installer itself enforces
 * that the new APK carries the same signature as the installed app.
 */
internal class AppUpdateController(
    private val activity: AppCompatActivity,
    private val feedUrl: String = BuildConfig.UPDATE_FEED_URL,
    private val currentVersion: String = BuildConfig.VERSION_NAME,
) {
    private val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var dialog: AlertDialog? = null
    private var checking = false
    /** Bumped when a manual check is cancelled so its late result is dropped. */
    private var checkGeneration = 0
    @Volatile private var downloadCancelled = false
    private var downloading = false
    /** An APK verified but waiting for the user to allow installs from this app. */
    private var pendingApk: File? = null

    var autoCheckEnabled: Boolean
        get() = prefs.getBoolean(KEY_AUTO_CHECK, true)
        set(value) = prefs.edit().putBoolean(KEY_AUTO_CHECK, value).apply()

    fun autoCheck() {
        if (!autoCheckEnabled || !AppUpdateRules.isDue(prefs.getLong(KEY_LAST_CHECK, 0), System.currentTimeMillis())) return
        check(manual = false)
    }

    fun checkNow() = check(manual = true)

    /** Called from onResume: continue an install the user had to permit in system settings. */
    fun resume() {
        val apk = pendingApk ?: return
        if (canInstallPackages()) {
            pendingApk = null
            launchInstaller(apk)
        }
    }

    fun shutdown() {
        downloadCancelled = true
        executor.shutdownNow()
        dismissDialog()
    }

    private fun alive() = !activity.isFinishing && !activity.isDestroyed

    private fun post(block: () -> Unit) = mainHandler.post { if (alive()) block() }

    private fun dismissDialog() {
        dialog?.takeIf { it.isShowing }?.dismiss()
        dialog = null
    }

    private fun show(builder: AlertDialog.Builder): AlertDialog {
        dismissDialog()
        return builder.show().also { dialog = it }
    }

    private fun check(manual: Boolean) {
        if (checking || downloading) {
            if (manual) Toast.makeText(activity, R.string.update_busy, Toast.LENGTH_SHORT).show()
            return
        }
        checking = true
        val generation = ++checkGeneration
        if (manual) {
            val cancel = {
                if (checkGeneration == generation) {
                    checkGeneration++
                    checking = false
                }
            }
            show(
                AlertDialog.Builder(activity)
                    .setTitle(R.string.update_checking)
                    .setView(ProgressBar(activity).apply { setPadding(0, 32, 0, 32) })
                    .setNegativeButton(R.string.cancel) { _, _ -> cancel() },
            ).setOnCancelListener { cancel() }
        }
        executor.execute {
            val result = runCatching { AppUpdateRules.parseRelease(fetchText(feedUrl)) }
            post {
                if (checkGeneration != generation) return@post
                checking = false
                if (manual) dismissDialog()
                result.onSuccess { release ->
                    prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply()
                    when {
                        release == null || AppUpdateRules.compareVersions(release.version, currentVersion) <= 0 ->
                            if (manual) showLatest() else Unit
                        !manual && release.version == prefs.getString(KEY_SKIP_VERSION, null) -> Unit
                        else -> showAvailable(release)
                    }
                }.onFailure { error ->
                    if (manual) showError(activity.getString(R.string.update_check_failed, describe(error)), null)
                }
            }
        }
    }

    private fun showLatest() {
        show(
            AlertDialog.Builder(activity)
                .setTitle(R.string.update_latest_title)
                .setMessage(activity.getString(R.string.update_latest_message, currentVersion))
                .setPositiveButton(R.string.update_ok, null),
        )
    }

    private fun showAvailable(release: AppRelease) {
        val apk = release.apkAsset()
        val sums = release.checksumAsset()
        val summary = buildList {
            add(activity.getString(R.string.update_current_version, currentVersion))
            apk?.size?.takeIf { it > 0 }?.let { add(activity.getString(R.string.update_size, formatBytes(it))) }
        }.joinToString(" · ")
        val notes = AppUpdateRules.plainNotes(release.notes)
        val builder = AlertDialog.Builder(activity)
            .setTitle(activity.getString(R.string.update_available_title, release.version))
            .setMessage(if (notes.isEmpty()) summary else "$summary\n\n$notes")
            .setNeutralButton(R.string.update_skip) { _, _ ->
                prefs.edit().putString(KEY_SKIP_VERSION, release.version).apply()
            }
            .setNegativeButton(R.string.update_later, null)
        if (apk != null && sums != null) {
            builder.setPositiveButton(R.string.update_download) { _, _ -> download(release, apk, sums) }
        } else {
            builder.setPositiveButton(R.string.update_open_page) { _, _ -> openPage(release.pageUrl) }
        }
        show(builder)
    }

    private fun showError(message: String, pageUrl: String?) {
        val builder = AlertDialog.Builder(activity)
            .setTitle(R.string.update_failed_title)
            .setMessage(message)
            .setPositiveButton(R.string.update_close, null)
        if (!pageUrl.isNullOrEmpty()) builder.setNeutralButton(R.string.update_open_page) { _, _ -> openPage(pageUrl) }
        show(builder)
    }

    private fun download(release: AppRelease, apk: ReleaseAsset, sums: ReleaseAsset) {
        if (downloading) return
        downloading = true
        downloadCancelled = false
        val view = LayoutInflater.from(activity).inflate(R.layout.dialog_update_progress, null)
        val bar = view.findViewById<ProgressBar>(R.id.updateProgressBar)
        val text = view.findViewById<TextView>(R.id.updateProgressText)
        show(
            AlertDialog.Builder(activity)
                .setTitle(activity.getString(R.string.update_downloading_title, release.version))
                .setView(view)
                .setCancelable(false)
                .setNegativeButton(R.string.cancel) { _, _ -> downloadCancelled = true },
        )
        executor.execute {
            val directory = File(activity.cacheDir, UPDATE_DIR)
            val target = File(directory, apk.name.substringAfterLast('/'))
            val outcome = runCatching {
                directory.listFiles()?.forEach { it.delete() }
                directory.mkdirs()
                val expected = AppUpdateRules.parseSha256Sums(fetchText(sums.url))[apk.name]
                    ?: throw IOException(activity.getString(R.string.update_missing_checksum))
                var lastReport = 0L
                val actual = downloadFile(apk, target) { received, total ->
                    val now = System.currentTimeMillis()
                    if (now - lastReport > 150 || received == total) {
                        lastReport = now
                        post { renderProgress(bar, text, received, total) }
                    }
                }
                if (!actual.equals(expected, ignoreCase = true)) throw IOException(activity.getString(R.string.update_checksum_mismatch))
                target
            }
            post {
                downloading = false
                outcome.onSuccess { file ->
                    dismissDialog()
                    install(file)
                }.onFailure { error ->
                    target.delete()
                    if (downloadCancelled) {
                        dismissDialog()
                    } else {
                        showError(activity.getString(R.string.update_download_failed, describe(error)), release.pageUrl)
                    }
                }
            }
        }
    }

    private fun renderProgress(bar: ProgressBar, text: TextView, received: Long, total: Long) {
        if (total > 0) {
            bar.isIndeterminate = false
            bar.max = 1000
            bar.progress = (received * 1000 / total).toInt()
            text.text = activity.getString(
                R.string.update_progress,
                formatBytes(received),
                formatBytes(total),
                (received * 100 / total).toInt(),
            )
        } else {
            text.text = formatBytes(received)
        }
    }

    private fun canInstallPackages() =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

    private fun install(apk: File) {
        if (canInstallPackages()) {
            launchInstaller(apk)
            return
        }
        pendingApk = apk
        show(
            AlertDialog.Builder(activity)
                .setTitle(R.string.update_permission_title)
                .setMessage(R.string.update_permission_message)
                .setPositiveButton(R.string.update_permission_open) { _, _ ->
                    try {
                        activity.startActivity(
                            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
                        )
                    } catch (_: ActivityNotFoundException) {
                        Toast.makeText(activity, R.string.update_permission_unavailable, Toast.LENGTH_LONG).show()
                    }
                }
                .setNegativeButton(R.string.cancel) { _, _ -> pendingApk = null },
        )
    }

    private fun launchInstaller(apk: File) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", apk)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, APK_MIME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            activity.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            showError(activity.getString(R.string.update_installer_unavailable), null)
        }
    }

    private fun openPage(url: String) {
        if (!url.startsWith("https://github.com/")) return
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(activity, R.string.no_browser_found, Toast.LENGTH_SHORT).show()
        }
    }

    private fun open(url: String): HttpURLConnection {
        var location = URL(url)
        // GitHub asset URLs redirect to a CDN host; follow a bounded number of HTTPS-or-same-scheme hops.
        repeat(MAX_REDIRECTS) {
            val connection = (location.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                setRequestProperty("Accept", "application/vnd.github+json, */*")
                setRequestProperty("User-Agent", "EagleMultiViewAndroid/$currentVersion")
            }
            val status = connection.responseCode
            if (status in 300..399) {
                val next = connection.getHeaderField("Location")
                connection.disconnect()
                val resolved = URL(location, next ?: throw IOException("HTTP $status"))
                if (location.protocol == "https" && resolved.protocol != "https") throw IOException("insecure redirect")
                location = resolved
                return@repeat
            }
            if (status !in 200..299) {
                connection.disconnect()
                throw IOException("HTTP $status")
            }
            return connection
        }
        throw IOException("too many redirects")
    }

    private fun fetchText(url: String): String {
        val connection = open(url)
        return try {
            connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    private fun downloadFile(asset: ReleaseAsset, target: File, onProgress: (Long, Long) -> Unit): String {
        val connection = open(asset.url)
        try {
            val total = connection.contentLengthLong.takeIf { it > 0 } ?: asset.size
            val digest = MessageDigest.getInstance("SHA-256")
            var received = 0L
            connection.inputStream.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        if (downloadCancelled) throw IOException("cancelled")
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                        digest.update(buffer, 0, count)
                        received += count
                        onProgress(received, total)
                    }
                }
            }
            if (asset.size > 0 && received != asset.size) throw IOException(activity.getString(R.string.update_incomplete))
            return digest.digest().joinToString("") { "%02x".format(it) }
        } finally {
            connection.disconnect()
        }
    }

    private fun describe(error: Throwable): String = when (error) {
        is java.net.UnknownHostException, is java.net.ConnectException, is java.net.SocketTimeoutException,
        is javax.net.ssl.SSLException -> activity.getString(R.string.update_network_error)
        else -> error.message ?: error.javaClass.simpleName
    }

    private fun formatBytes(bytes: Long): String = when {
        bytes >= 1024L * 1024 -> String.format(Locale.US, "%.1f MB", bytes / 1024.0 / 1024.0)
        bytes >= 1024 -> "${bytes / 1024} KB"
        else -> "$bytes B"
    }

    private companion object {
        const val PREFS = "app_update"
        const val KEY_AUTO_CHECK = "auto_check"
        const val KEY_LAST_CHECK = "last_check_at"
        const val KEY_SKIP_VERSION = "skip_version"
        const val UPDATE_DIR = "updates"
        const val APK_MIME = "application/vnd.android.package-archive"
        const val CONNECT_TIMEOUT_MS = 15_000
        const val READ_TIMEOUT_MS = 30_000
        const val MAX_REDIRECTS = 5
    }
}
