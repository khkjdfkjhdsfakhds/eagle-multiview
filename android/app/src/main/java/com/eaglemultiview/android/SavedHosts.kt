package com.eaglemultiview.android

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * One remembered host address. History entries come from successful connections; pinned entries
 * are the ones the user fixed (optionally with a name) and are never evicted by newer history.
 */
data class SavedHost(
    val endpoint: HostEndpoint,
    val name: String? = null,
    val pinned: Boolean = false,
    val pinnedAt: Long = 0L,
    val lastConnectedAt: Long = 0L,
) {
    val label: String
        get() = name ?: endpoint.startUrl
}

/**
 * Immutable list of remembered addresses (the opt-in "记住访问地址" feature). Ordering is the
 * order the user sees and the order failover tries: pinned entries first in pin order, then
 * history newest first.
 */
class SavedHostBook(entries: List<SavedHost> = emptyList()) {
    val entries: List<SavedHost> = entries
        .distinctBy { it.endpoint.startUrl }
        .sortedWith(
            compareByDescending<SavedHost> { it.pinned }
                .thenBy { if (it.pinned) it.pinnedAt else 0L }
                .thenByDescending { it.lastConnectedAt },
        )
        .let { sorted ->
            val pinned = sorted.filter { it.pinned }.take(MAX_PINNED)
            pinned + sorted.filterNot { it.pinned }.take(MAX_HISTORY)
        }

    val origins: Set<String>
        get() = entries.mapTo(mutableSetOf()) { it.endpoint.origin }

    fun find(startUrl: String): SavedHost? = entries.firstOrNull { it.endpoint.startUrl == startUrl }

    fun recordConnected(endpoint: HostEndpoint, now: Long): SavedHostBook {
        val existing = find(endpoint.startUrl)
        val updated = existing?.copy(lastConnectedAt = now) ?: SavedHost(endpoint, lastConnectedAt = now)
        return SavedHostBook(entries.filterNot { it.endpoint.startUrl == endpoint.startUrl } + updated)
    }

    fun pin(startUrl: String, name: String?, now: Long): SavedHostBook {
        val existing = find(startUrl) ?: return this
        val pinned = existing.copy(
            name = sanitizeName(name),
            pinned = true,
            pinnedAt = if (existing.pinned) existing.pinnedAt else now,
        )
        return SavedHostBook(entries.map { if (it.endpoint.startUrl == startUrl) pinned else it })
    }

    /** An unpinned address rejoins history as the newest entry, so the history cap cannot drop it at once. */
    fun unpin(startUrl: String, now: Long): SavedHostBook = SavedHostBook(
        entries.map {
            if (it.endpoint.startUrl == startUrl) {
                it.copy(pinned = false, pinnedAt = 0L, name = null, lastConnectedAt = maxOf(it.lastConnectedAt, now))
            } else {
                it
            }
        },
    )

    fun remove(startUrl: String): SavedHostBook =
        SavedHostBook(entries.filterNot { it.endpoint.startUrl == startUrl })

    /** Chrome-style matching: an empty query or one that already names a whole entry shows everything. */
    fun suggestions(query: String?): List<SavedHost> {
        val needle = query?.trim().orEmpty()
        if (needle.isEmpty() || entries.any { it.endpoint.startUrl == needle }) return entries
        return entries.filter {
            it.endpoint.startUrl.contains(needle, ignoreCase = true) ||
                it.name?.contains(needle, ignoreCase = true) == true
        }
    }

    /** Remembered addresses to try after [failed] could not be reached, in failover order. */
    fun failoverCandidates(failed: HostEndpoint, alreadyTried: Set<String>): List<HostEndpoint> =
        entries
            .map { it.endpoint }
            .filter { it.origin != failed.origin && it.startUrl !in alreadyTried }
            .distinctBy { it.origin }

    companion object {
        const val MAX_HISTORY = 20
        const val MAX_PINNED = 50
        private const val MAX_NAME_LENGTH = 60

        fun sanitizeName(raw: String?): String? = raw
            ?.replace(Regex("\\s+"), " ")
            ?.trim()
            ?.take(MAX_NAME_LENGTH)
            ?.takeIf { it.isNotEmpty() }
    }
}

/**
 * What a connection may keep from the WebView's previous host. Without remembered addresses every
 * origin change wipes cookies and storage (one trusted host at a time). With them, the WebView keeps
 * each origin's own login — cookies and storage stay origin-scoped, so no host can read another's —
 * and the data is dropped per origin when an address is removed, and entirely when the feature is
 * turned off.
 */
object SiteDataPolicy {
    fun clearBeforeConnecting(previousOrigin: String?, nextOrigin: String, savedOrigins: Set<String>?): Boolean =
        savedOrigins == null && previousOrigin != null && previousOrigin != nextOrigin

    fun clearOnLeavingHost(activeOrigin: String?, savedOrigins: Set<String>?): Boolean =
        savedOrigins == null && activeOrigin != null
}

object SavedHostCodec {
    fun encode(book: SavedHostBook): String = JSONArray().apply {
        book.entries.forEach { entry ->
            put(
                JSONObject()
                    .put("url", entry.endpoint.startUrl)
                    .put("name", entry.name ?: JSONObject.NULL)
                    .put("pinned", entry.pinned)
                    .put("pinnedAt", entry.pinnedAt)
                    .put("lastConnectedAt", entry.lastConnectedAt),
            )
        }
    }.toString()

    /** Unreadable or no-longer-valid entries are dropped rather than failing the whole list. */
    fun decode(raw: String?): SavedHostBook {
        if (raw.isNullOrBlank()) return SavedHostBook()
        val array = try {
            JSONArray(raw)
        } catch (_: JSONException) {
            return SavedHostBook()
        }
        val entries = (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            val endpoint = (HostUrlValidator.validate(item.optString("url")) as? HostInputResult.Valid)?.endpoint
                ?: return@mapNotNull null
            SavedHost(
                endpoint = endpoint,
                name = if (item.isNull("name")) null else SavedHostBook.sanitizeName(item.optString("name")),
                pinned = item.optBoolean("pinned"),
                pinnedAt = item.optLong("pinnedAt"),
                lastConnectedAt = item.optLong("lastConnectedAt"),
            )
        }
        return SavedHostBook(entries)
    }
}

interface SavedHostStore {
    val enabled: Boolean
    fun read(): SavedHostBook
    fun write(book: SavedHostBook)
    fun setEnabled(enabled: Boolean)
}
