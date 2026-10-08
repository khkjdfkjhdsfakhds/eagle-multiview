package com.eaglemultiview.android

import java.util.Locale

/**
 * Owns the single WebView file-chooser callback.
 *
 * WebView refuses to open another chooser until the previous callback receives a value, so every
 * path (result, cancel, launch failure, a newer request, Activity teardown) must deliver exactly
 * once; cancellations deliver null.
 */
class FileChooserCoordinator<T : Any> {
    private var pending: ((List<T>?) -> Unit)? = null

    val hasPending: Boolean
        get() = pending != null

    /** Takes ownership of [deliver]; an older unanswered chooser is cancelled first. */
    fun begin(deliver: (List<T>?) -> Unit) {
        val previous = pending
        pending = deliver
        previous?.invoke(null)
    }

    /** Delivers the chosen items, or null for cancel/empty. Returns false when nothing is pending. */
    fun complete(result: List<T>?): Boolean {
        val deliver = pending ?: return false
        pending = null
        deliver(result?.takeIf { it.isNotEmpty() })
        return true
    }

    fun cancel(): Boolean = complete(null)
}

object FileChooserResult {
    /**
     * Collects a picker result. Multi-select pickers return ClipData items; single-select ones
     * return the data URI. Order is kept and duplicates dropped; anything but OK is a cancel.
     */
    fun <T : Any> collect(resultOk: Boolean, clipItems: List<T?>, dataItem: T?): List<T>? {
        if (!resultOk) return null
        val items = LinkedHashSet<T>()
        clipItems.filterNotNullTo(items)
        dataItem?.let(items::add)
        return items.toList().takeIf { it.isNotEmpty() }
    }
}

object FileChooserMimeTypes {
    /**
     * Converts HTML `accept` values (MIME types, wildcards, or `.ext`) into picker MIME filters.
     * An empty result means "any file". Any value that cannot be expressed as a MIME type widens
     * the filter to any file rather than hiding files the page would accept.
     */
    fun resolve(acceptTypes: List<String?>, mimeForExtension: (String) -> String?): List<String> {
        val tokens = acceptTypes
            .flatMap { it.orEmpty().split(',') }
            .map { it.trim().lowercase(Locale.US) }
            .filter { it.isNotEmpty() }
        if (tokens.isEmpty()) return emptyList()
        val mimeTypes = LinkedHashSet<String>()
        for (token in tokens) {
            val mime = when {
                token.startsWith('.') -> mimeForExtension(token.removePrefix("."))?.lowercase(Locale.US)
                token.contains('/') -> token
                else -> null
            }
            if (mime == null || mime == "*/*") return emptyList()
            mimeTypes += mime
        }
        return mimeTypes.toList()
    }
}
