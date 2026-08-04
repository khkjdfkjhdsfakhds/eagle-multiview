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
