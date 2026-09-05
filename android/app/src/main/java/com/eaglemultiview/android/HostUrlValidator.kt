package com.eaglemultiview.android

import java.net.URI
import java.net.URISyntaxException
import java.util.Locale

data class HostEndpoint(
    val startUrl: String,
    val origin: String,
) {
    fun contains(rawUrl: String?): Boolean = TrustedNavigationPolicy.classify(this, rawUrl).isTrusted

    fun isLoginUrl(rawUrl: String?): Boolean =
        TrustedNavigationPolicy.classify(this, rawUrl) == NavigationTarget.TrustedLogin
}

enum class HostInputError {
    EMPTY,
    WHITESPACE,
    UNSUPPORTED_SCHEME,
    MALFORMED,
    CREDENTIALS_NOT_ALLOWED,
    MISSING_HOST,
    INVALID_PORT,
    QUERY_OR_FRAGMENT_NOT_ALLOWED,
}

sealed interface HostInputResult {
    data class Valid(val endpoint: HostEndpoint) : HostInputResult
    data class Invalid(val error: HostInputError) : HostInputResult
}

/** Pure JVM URL validation shared by the host entry screen, persistence, and tests. */
object HostUrlValidator {
    private val schemePrefix = Regex("^([A-Za-z][A-Za-z0-9+.-]*):")
    private val authoritySchemePrefix = Regex("^([A-Za-z][A-Za-z0-9+.-]*):\\/\\/")
    private val hostWithNumericPort =
        Regex("^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:[0-9]+(?:[/?#].*)?$")
    private val explicitWebScheme = Regex("^(?i:https?)://")
    private val allowedSchemes = setOf("http", "https")

    fun validate(rawValue: String): HostInputResult {
        val trimmed = rawValue.trim()
        if (trimmed.isEmpty()) return HostInputResult.Invalid(HostInputError.EMPTY)
        if (trimmed.any(Char::isWhitespace)) {
            return HostInputResult.Invalid(HostInputError.WHITESPACE)
        }

        val schemeLikePrefix = schemePrefix.find(trimmed)?.groupValues?.get(1)?.lowercase(Locale.US)
        val declaredScheme = when {
            authoritySchemePrefix.containsMatchIn(trimmed) -> schemeLikePrefix
            schemeLikePrefix != null && !hostWithNumericPort.matches(trimmed) -> schemeLikePrefix
            else -> null
        }
        if (declaredScheme != null && declaredScheme !in allowedSchemes) {
            return HostInputResult.Invalid(HostInputError.UNSUPPORTED_SCHEME)
        }
        if (declaredScheme != null && !explicitWebScheme.containsMatchIn(trimmed)) {
            return HostInputResult.Invalid(HostInputError.MALFORMED)
        }

        val candidate = if (declaredScheme == null) "http://$trimmed" else trimmed
        val parsed = try {
            URI(candidate)
        } catch (_: URISyntaxException) {
            return HostInputResult.Invalid(HostInputError.MALFORMED)
        }

        val scheme = parsed.scheme?.lowercase(Locale.US)
            ?: return HostInputResult.Invalid(HostInputError.MALFORMED)
        if (scheme !in allowedSchemes) {
            return HostInputResult.Invalid(HostInputError.UNSUPPORTED_SCHEME)
        }
        if (parsed.userInfo != null) {
            return HostInputResult.Invalid(HostInputError.CREDENTIALS_NOT_ALLOWED)
        }
        val host = parsed.host?.lowercase(Locale.US)
            ?: return HostInputResult.Invalid(HostInputError.MISSING_HOST)
        if (parsed.rawQuery != null || parsed.rawFragment != null) {
            return HostInputResult.Invalid(HostInputError.QUERY_OR_FRAGMENT_NOT_ALLOWED)
        }
        if (parsed.port != -1 && parsed.port !in 1..65535) {
            return HostInputResult.Invalid(HostInputError.INVALID_PORT)
        }

        val normalizedPort = when {
            scheme == "http" && parsed.port == 80 -> -1
            scheme == "https" && parsed.port == 443 -> -1
            else -> parsed.port
        }
        val path = parsed.rawPath.takeUnless { it.isNullOrBlank() } ?: "/"
        return try {
            val originUri = URI(scheme, null, host, normalizedPort, null, null, null)
            // rawPath already contains escapes. A multi-component URI constructor
            // would quote its percent signs again and corrupt persisted addresses.
            val startUri = URI(originUri.toASCIIString() + path).normalize()
            HostInputResult.Valid(
                HostEndpoint(
                    startUrl = startUri.toASCIIString(),
                    origin = originUri.toASCIIString(),
                ),
            )
        } catch (_: URISyntaxException) {
            HostInputResult.Invalid(HostInputError.MALFORMED)
        }
    }

    fun normalize(rawValue: String): String? =
        (validate(rawValue) as? HostInputResult.Valid)?.endpoint?.startUrl
}

enum class NavigationTarget(val isTrusted: Boolean) {
    TrustedPage(true),
    TrustedLogin(true),
    ExternalWeb(false),
    Blocked(false),
}

/** Keeps only same-origin MultiView pages in the privileged WebView. */
object TrustedNavigationPolicy {
    fun classify(endpoint: HostEndpoint, rawUrl: String?): NavigationTarget {
        val uri = parseWebUri(rawUrl) ?: return NavigationTarget.Blocked
        val origin = originOf(uri) ?: return NavigationTarget.Blocked
        if (origin != endpoint.origin) return NavigationTarget.ExternalWeb
        return if (uri.path == "/login") NavigationTarget.TrustedLogin else NavigationTarget.TrustedPage
    }

    private fun parseWebUri(rawUrl: String?): URI? {
        if (rawUrl.isNullOrBlank()) return null
        val uri = try {
            URI(rawUrl)
        } catch (_: URISyntaxException) {
            return null
        }
        val scheme = uri.scheme?.lowercase(Locale.US)
        if (scheme !in setOf("http", "https") || uri.userInfo != null || uri.host.isNullOrBlank()) {
            return null
        }
        return uri
    }

    private fun originOf(uri: URI): String? {
        val scheme = uri.scheme.lowercase(Locale.US)
        val port = when {
            scheme == "http" && uri.port == 80 -> -1
            scheme == "https" && uri.port == 443 -> -1
            else -> uri.port
        }
        return try {
            URI(scheme, null, uri.host.lowercase(Locale.US), port, null, null, null).toASCIIString()
        } catch (_: URISyntaxException) {
            null
        }
    }
}
