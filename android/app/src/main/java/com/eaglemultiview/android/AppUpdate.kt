package com.eaglemultiview.android

import org.json.JSONObject

internal data class ReleaseAsset(val name: String, val url: String, val size: Long)

internal data class AppRelease(
    val version: String,
    val notes: String,
    val pageUrl: String,
    val assets: List<ReleaseAsset>,
) {
    fun apkAsset(): ReleaseAsset? = assets.firstOrNull { it.name.endsWith("-android.apk", ignoreCase = true) }

    fun checksumAsset(): ReleaseAsset? = assets.firstOrNull {
        it.name.equals("SHA256SUMS.txt", ignoreCase = true) || it.name.equals("SHA256SUMS", ignoreCase = true)
    }
}

/**
 * The GitHub release feed shared with the Mac app: the newest non-draft release, its
 * `*-android.apk` asset, and `SHA256SUMS.txt` as the integrity anchor for the download.
 */
internal object AppUpdateRules {
    const val CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000

    private val VERSION = Regex("""^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?""", RegexOption.IGNORE_CASE)
    private val SUM_LINE = Regex("""^([0-9a-fA-F]{64})\s+\*?(.+)$""")

    private data class Version(val core: List<Int>, val pre: String)

    private fun parseVersion(value: String): Version? {
        val match = VERSION.find(value.trim()) ?: return null
        val core = (1..3).map { match.groupValues[it].toIntOrNull() ?: 0 }
        return Version(core, match.groupValues[4])
    }

    fun isValidVersion(value: String): Boolean = parseVersion(value) != null

    /** Positive when [a] is newer than [b]; prereleases sort below their release. */
    fun compareVersions(a: String, b: String): Int {
        val left = parseVersion(a) ?: return 0
        val right = parseVersion(b) ?: return 0
        for (index in 0 until 3) {
            if (left.core[index] != right.core[index]) return left.core[index].compareTo(right.core[index])
        }
        return when {
            left.pre == right.pre -> 0
            left.pre.isEmpty() -> 1
            right.pre.isEmpty() -> -1
            else -> left.pre.compareTo(right.pre).coerceIn(-1, 1)
        }
    }

    fun parseRelease(json: String): AppRelease? {
        val root = try {
            JSONObject(json)
        } catch (_: Exception) {
            return null
        }
        if (root.optBoolean("draft") || root.optBoolean("prerelease")) return null
        val version = root.optString("tag_name").removePrefix("v").removePrefix("V")
        if (!isValidVersion(version)) return null
        val assets = mutableListOf<ReleaseAsset>()
        val array = root.optJSONArray("assets")
        if (array != null) {
            for (index in 0 until array.length()) {
                val asset = array.optJSONObject(index) ?: continue
                val name = asset.optString("name")
                val url = asset.optString("browser_download_url")
                if (name.isNotEmpty() && url.isNotEmpty()) assets += ReleaseAsset(name, url, asset.optLong("size"))
            }
        }
        return AppRelease(
            version = version,
            notes = root.optString("body"),
            pageUrl = root.optString("html_url"),
            assets = assets,
        )
    }

    fun parseSha256Sums(text: String): Map<String, String> = text.lineSequence()
        .mapNotNull { SUM_LINE.find(it.trim()) }
        .associate { it.groupValues[2].trim().substringAfterLast('/') to it.groupValues[1].lowercase() }

    fun isDue(lastCheckAt: Long, now: Long): Boolean = now - lastCheckAt >= CHECK_INTERVAL_MS

    /** Release notes are Markdown; the native dialog shows them as plain lines. */
    fun plainNotes(markdown: String): String = markdown.lineSequence()
        .map { it.trim() }
        .map { line ->
            line.replace(Regex("""^#{1,6}\s+"""), "")
                .replace(Regex("""^[-*+]\s+"""), "• ")
                .replace(Regex("""\*\*(.+?)\*\*"""), "$1")
                .replace(Regex("""`([^`]+)`"""), "$1")
                .replace(Regex("""\[([^\]]+)\]\([^)]+\)"""), "$1")
        }
        .joinToString("\n")
        .replace(Regex("""\n{3,}"""), "\n\n")
        .trim()
}
