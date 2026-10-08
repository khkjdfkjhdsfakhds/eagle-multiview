package com.eaglemultiview.android

import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.nio.charset.Charset
import java.util.Locale

enum class DownloadRejection {
    /** No trusted host, or the URL points outside the active MultiView origin. */
    UNTRUSTED_ORIGIN,

    /** blob:/data:/other URLs the system download manager cannot fetch. */
    UNSUPPORTED_URL,
}

sealed interface DownloadPlan {
    data class Accepted(
        val url: String,
        val fileName: String,
        val mimeType: String?,
    ) : DownloadPlan

    data class Rejected(val reason: DownloadRejection) : DownloadPlan
}

/**
 * Turns a WebView download into a system download request.
 *
 * Only same-origin MultiView URLs are handed to the download manager (they carry the session
 * cookie); the saved name prefers the RFC 5987 `filename*` the host sends for non-ASCII names.
 */
object DownloadRequestPlanner {
    private const val FALLBACK_NAME = "download"

    fun plan(
        endpoint: HostEndpoint?,
        url: String?,
        contentDisposition: String?,
        mimeType: String?,
        extensionForMime: (String) -> String? = { null },
    ): DownloadPlan {
        val scheme = url?.substringBefore(':', "")?.lowercase(Locale.US)
        if (scheme !in setOf("http", "https")) return DownloadPlan.Rejected(DownloadRejection.UNSUPPORTED_URL)
        if (endpoint == null ||
            TrustedNavigationPolicy.classify(endpoint, url) != NavigationTarget.TrustedPage
        ) {
            return DownloadPlan.Rejected(DownloadRejection.UNTRUSTED_ORIGIN)
        }
        val normalizedMime = mimeType
            ?.substringBefore(';')
            ?.trim()
            ?.lowercase(Locale.US)
            ?.takeIf { it.isNotEmpty() && it != "application/octet-stream" }
        val rawName = ContentDispositionFileName.parse(contentDisposition)
            ?: lastPathSegment(url)
            ?: FALLBACK_NAME
        var fileName = ContentDispositionFileName.sanitize(rawName)
        if (!fileName.contains('.') && normalizedMime != null) {
            extensionForMime(normalizedMime)?.takeIf { it.isNotBlank() }?.let { fileName = "$fileName.$it" }
        }
        return DownloadPlan.Accepted(url!!, fileName, normalizedMime)
    }

    private fun lastPathSegment(url: String?): String? {
        val path = try {
            URI(url).rawPath
        } catch (_: URISyntaxException) {
            null
        } ?: return null
        val segment = path.substringAfterLast('/').takeIf { it.isNotEmpty() } ?: return null
        return percentDecode(segment, Charsets.UTF_8)
    }

    internal fun percentDecode(value: String, charset: Charset): String? = try {
        // URLDecoder treats '+' as space; Content-Disposition/path encoding does not.
        URLDecoder.decode(value.replace("+", "%2B"), charset.name())
    } catch (_: IllegalArgumentException) {
        null
    }
}

object ContentDispositionFileName {
    private const val MAX_NAME_LENGTH = 150
    private val unsafeCharacters = Regex("[\\u0000-\\u001f\\u007f/\\\\:*?\"<>|]")

    /** Returns `filename*` when decodable, otherwise `filename`, otherwise null. */
    fun parse(header: String?): String? {
        if (header.isNullOrBlank()) return null
        val parameters = parameters(header)
        val extended = parameters["filename*"]?.let(::decodeExtendedValue)
        if (!extended.isNullOrBlank()) return extended
        return parameters["filename"]?.takeIf { it.isNotBlank() }
    }

    /** Produces a single safe file name for the shared Downloads folder. */
    fun sanitize(name: String): String {
        val cleaned = name
            .substringAfterLast('/')
            .substringAfterLast('\\')
            .replace(unsafeCharacters, "_")
            .trim()
            .trimStart('.')
            .trimEnd('.', ' ')
        if (cleaned.isEmpty() || cleaned.all { it == '_' }) return "download"
        if (cleaned.length <= MAX_NAME_LENGTH) return cleaned
        val dot = cleaned.lastIndexOf('.')
        val extension = if (dot > 0 && cleaned.length - dot <= 16) cleaned.substring(dot) else ""
        return cleaned.take(MAX_NAME_LENGTH - extension.length).trimEnd('.', ' ') + extension
    }

    private fun parameters(header: String): Map<String, String> {
        val result = linkedMapOf<String, String>()
        for (part in splitOutsideQuotes(header).drop(1)) {
            val separator = part.indexOf('=')
            if (separator <= 0) continue
            val key = part.substring(0, separator).trim().lowercase(Locale.US)
            var value = part.substring(separator + 1).trim()
            if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
                value = value.substring(1, value.length - 1).replace(Regex("\\\\(.)"), "$1")
            }
            result.putIfAbsent(key, value)
        }
        return result
    }

    private fun splitOutsideQuotes(header: String): List<String> {
        val parts = mutableListOf<String>()
        val current = StringBuilder()
        var quoted = false
        var escaped = false
        for (char in header) {
            when {
                escaped -> {
                    current.append(char)
                    escaped = false
                }
                char == '\\' && quoted -> {
                    current.append(char)
                    escaped = true
                }
                char == '"' -> {
                    current.append(char)
                    quoted = !quoted
                }
                char == ';' && !quoted -> {
                    parts += current.toString()
                    current.clear()
                }
                else -> current.append(char)
            }
        }
        parts += current.toString()
        return parts
    }

    /** RFC 5987: charset'language'percent-encoded-value. */
    private fun decodeExtendedValue(value: String): String? {
        val firstQuote = value.indexOf('\'')
        val secondQuote = if (firstQuote >= 0) value.indexOf('\'', firstQuote + 1) else -1
        if (firstQuote <= 0 || secondQuote < 0) return null
        val charset = try {
            Charset.forName(value.substring(0, firstQuote))
        } catch (_: IllegalArgumentException) {
            return null
        }
        return DownloadRequestPlanner.percentDecode(value.substring(secondQuote + 1), charset)
    }
}
