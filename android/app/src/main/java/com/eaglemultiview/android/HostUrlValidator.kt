package com.eaglemultiview.android

import java.net.URI
import java.net.URISyntaxException
import java.util.Locale

/** Pure JVM URL validation shared by the host entry screen and unit tests. */
object HostUrlValidator {
    private val explicitScheme = Regex("^[A-Za-z][A-Za-z0-9+.-]*://")
    private val allowedSchemes = setOf("http", "https")

    fun normalize(rawValue: String): String? {
        val trimmed = rawValue.trim()
        if (trimmed.isEmpty() || trimmed.any(Char::isWhitespace)) {
            return null
        }

        val candidate = if (explicitScheme.containsMatchIn(trimmed)) {
            trimmed
        } else {
            "http://$trimmed"
        }

        val parsed = try {
            URI(candidate)
        } catch (_: URISyntaxException) {
            return null
        }

        val scheme = parsed.scheme?.lowercase(Locale.US) ?: return null
        if (scheme !in allowedSchemes || parsed.userInfo != null || parsed.host.isNullOrBlank()) {
            return null
        }
        if (parsed.port !in -1..65535) {
            return null
        }

        val path = parsed.rawPath.takeUnless { it.isNullOrBlank() } ?: "/"
        return try {
            URI(
                scheme,
                null,
                parsed.host.lowercase(Locale.US),
                parsed.port,
                path,
                parsed.rawQuery,
                parsed.rawFragment,
            ).normalize().toASCIIString()
        } catch (_: URISyntaxException) {
            null
        }
    }

}
