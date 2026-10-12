package com.eaglemultiview.android

import android.content.Context

class SharedPreferencesRecentHostStore(context: Context) : RecentHostStore {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun read(): HostEndpoint? {
        val saved = preferences.getString(KEY_RECENT_HOST, null) ?: return null
        return (HostUrlValidator.validate(saved) as? HostInputResult.Valid)?.endpoint
    }

    override fun save(endpoint: HostEndpoint) {
        preferences.edit().putString(KEY_RECENT_HOST, endpoint.startUrl).apply()
    }

    companion object {
        const val PREFERENCES_NAME = "trusted_host"
        const val KEY_RECENT_HOST = "recent_successful_host"
    }
}

/** Remembered addresses live next to the recent host, in the app's private preferences only. */
class SharedPreferencesSavedHostStore(context: Context) : SavedHostStore {
    private val preferences = context.getSharedPreferences(
        SharedPreferencesRecentHostStore.PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    override val enabled: Boolean
        get() = preferences.getBoolean(KEY_ENABLED, false)

    override fun read(): SavedHostBook =
        if (enabled) SavedHostCodec.decode(preferences.getString(KEY_SAVED_HOSTS, null)) else SavedHostBook()

    override fun write(book: SavedHostBook) {
        if (!enabled) return
        preferences.edit().putString(KEY_SAVED_HOSTS, SavedHostCodec.encode(book)).apply()
    }

    /** Turning the feature off forgets every remembered address. */
    override fun setEnabled(enabled: Boolean) {
        preferences.edit().apply {
            putBoolean(KEY_ENABLED, enabled)
            if (!enabled) remove(KEY_SAVED_HOSTS)
        }.apply()
    }

    companion object {
        const val KEY_ENABLED = "remember_hosts_enabled"
        const val KEY_SAVED_HOSTS = "saved_hosts"
    }
}
