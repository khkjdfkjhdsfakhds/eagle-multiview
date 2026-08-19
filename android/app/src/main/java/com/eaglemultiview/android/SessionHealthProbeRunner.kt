package com.eaglemultiview.android

import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import javax.net.ssl.SSLException

internal class SessionHealthProbeRunner(
    private val executor: ExecutorService = Executors.newSingleThreadExecutor(),
) {
    fun execute(
        request: SessionHealthProbe,
        cookie: String?,
        onComplete: (SessionHealthProbe, SessionHealth, Int?) -> Unit,
    ) {
        executor.execute {
            var connection: HttpURLConnection? = null
            val result = try {
                connection = (URL("${request.endpoint.origin}/health/session").openConnection() as HttpURLConnection)
                    .apply {
                        requestMethod = "GET"
                        instanceFollowRedirects = false
                        useCaches = false
                        connectTimeout = CONNECT_TIMEOUT_MS
                        readTimeout = READ_TIMEOUT_MS
                        setRequestProperty("Accept", "application/json")
                        if (!cookie.isNullOrBlank()) setRequestProperty("Cookie", cookie)
                    }
                when (val status = connection.responseCode) {
                    HttpURLConnection.HTTP_OK -> Triple(SessionHealth.AUTHENTICATED, null, connection)
                    HttpURLConnection.HTTP_UNAUTHORIZED -> Triple(SessionHealth.LOGIN_REQUIRED, null, connection)
                    else -> Triple(SessionHealth.HTTP_ERROR, status, connection)
                }
            } catch (_: SSLException) {
                Triple(SessionHealth.TLS_ERROR, null, connection)
            } catch (_: Exception) {
                Triple(SessionHealth.UNREACHABLE, null, connection)
            }
            try {
                result.third?.disconnect()
            } finally {
                onComplete(request, result.first, result.second)
            }
        }
    }

    fun shutdown() {
        executor.shutdownNow()
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 4_000
        const val READ_TIMEOUT_MS = 4_000
    }
}
