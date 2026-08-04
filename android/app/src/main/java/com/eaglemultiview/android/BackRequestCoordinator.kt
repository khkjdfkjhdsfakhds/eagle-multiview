package com.eaglemultiview.android

import org.json.JSONObject

internal const val WEB_BACK_REQUEST_JAVASCRIPT = "window.EagleMVBack.request()"

enum class BackPageAvailability {
    HOST_ENTRY,
    TRUSTED_PAGE,
    UNAVAILABLE,
}

enum class WebBackStatus {
    HANDLED,
    BLOCKED,
    EXIT,
}

enum class BackStayReason {
    HANDLED,
    BLOCKED,
    BUSY,
    UNAVAILABLE,
    INVALID_RESULT,
    EVALUATION_FAILED,
    TIMEOUT,
    ALREADY_FINISHING,
}

sealed interface BackCommand {
    data class EvaluateJavascript(val requestId: Long) : BackCommand
    data object FinishActivity : BackCommand
    data class Stay(val reason: BackStayReason) : BackCommand
}

/**
 * Serializes native Back requests around the synchronous browser return contract.
 *
 * Transport failures remain on the current native screen. Only an explicit, well-formed Web
 * result with status=exit may finish a trusted browser session.
 */
class BackRequestCoordinator {
    private var nextRequestId = 0L
    private var pendingRequestId: Long? = null
    private var finishIssued = false

    fun begin(availability: BackPageAvailability): BackCommand {
        if (finishIssued) return BackCommand.Stay(BackStayReason.ALREADY_FINISHING)
        if (pendingRequestId != null) return BackCommand.Stay(BackStayReason.BUSY)

        return when (availability) {
            BackPageAvailability.HOST_ENTRY -> {
                finishIssued = true
                BackCommand.FinishActivity
            }
            BackPageAvailability.TRUSTED_PAGE -> {
                val requestId = ++nextRequestId
                pendingRequestId = requestId
                BackCommand.EvaluateJavascript(requestId)
            }
            BackPageAvailability.UNAVAILABLE -> BackCommand.Stay(BackStayReason.UNAVAILABLE)
        }
    }

    fun resolve(requestId: Long, rawResult: String?): BackCommand? {
        if (!consumePending(requestId)) return null
        return when (WebBackResultParser.parse(rawResult)) {
            WebBackStatus.HANDLED -> BackCommand.Stay(BackStayReason.HANDLED)
            WebBackStatus.BLOCKED -> BackCommand.Stay(BackStayReason.BLOCKED)
            WebBackStatus.EXIT -> {
                finishIssued = true
                BackCommand.FinishActivity
            }
            null -> BackCommand.Stay(BackStayReason.INVALID_RESULT)
        }
    }

    fun evaluationFailed(requestId: Long): BackCommand? {
        if (!consumePending(requestId)) return null
        return BackCommand.Stay(BackStayReason.EVALUATION_FAILED)
    }

    fun timeout(requestId: Long): BackCommand? {
        if (!consumePending(requestId)) return null
        return BackCommand.Stay(BackStayReason.TIMEOUT)
    }

    /** Invalidates callbacks from a page that is navigating, switching host, or being destroyed. */
    fun cancelPending() {
        pendingRequestId = null
    }

    private fun consumePending(requestId: Long): Boolean {
        if (pendingRequestId != requestId || finishIssued) return false
        pendingRequestId = null
        return true
    }
}

/** Strictly validates the complete status/boolean shape produced by window.EagleMVBack.request(). */
object WebBackResultParser {
    fun parse(rawResult: String?): WebBackStatus? {
        if (rawResult.isNullOrBlank() || rawResult == "null") return null
        val result = try {
            JSONObject(rawResult)
        } catch (_: Exception) {
            return null
        }

        val status = when (result.optString("status", "")) {
            "handled" -> WebBackStatus.HANDLED
            "blocked" -> WebBackStatus.BLOCKED
            "exit" -> WebBackStatus.EXIT
            else -> return null
        }
        val handled = result.strictBoolean("handled") ?: return null
        val blocked = result.strictBoolean("blocked") ?: return null
        val exit = result.strictBoolean("exit") ?: return null
        if (handled != (status == WebBackStatus.HANDLED)) return null
        if (blocked != (status == WebBackStatus.BLOCKED)) return null
        if (exit != (status == WebBackStatus.EXIT)) return null
        return status
    }

    private fun JSONObject.strictBoolean(key: String): Boolean? {
        if (!has(key)) return null
        return opt(key) as? Boolean
    }
}
