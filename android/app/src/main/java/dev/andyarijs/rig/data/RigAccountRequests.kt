package dev.andyarijs.rig.data

import org.json.JSONObject

internal val RIG_REQUEST_ID = Regex("^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
internal const val ACCOUNT_DELETION_REQUEST = "account-deletion"
internal const val VIDEO_REPORT_REQUEST = "video-report"
internal const val REPORT_DETAILS_LIMIT = 1000
private val REQUEST_URL = Regex("(?i)(?:[a-z][a-z0-9+.-]*://|\\bwww\\.)")

enum class RigContentReportReason(val wireValue: String, val label: String) {
    SEXUAL("sexual", "Seksuele inhoud"),
    VIOLENCE("violence", "Geweld"),
    HATE("hate", "Haat of discriminatie"),
    UNSAFE("unsafe", "Gevaarlijke of schadelijke inhoud"),
    OTHER("other", "Iets anders"),
}

internal fun validRequestText(value: String, maxCodePoints: Int): Boolean =
    value.codePointCount(0, value.length) <= maxCodePoints &&
        value.none { it.isISOControl() } && !REQUEST_URL.containsMatchIn(value)

internal fun deletionRequestBody(requestId: String): JSONObject {
    require(RIG_REQUEST_ID.matches(requestId)) { "Dit verzoek kon niet veilig worden voorbereid. Open het opnieuw." }
    return JSONObject().put("requestId", requestId)
}

internal fun videoReportBody(requestId: String, reason: RigContentReportReason, details: String): JSONObject {
    val text = details.trim()
    require(validRequestText(text, REPORT_DETAILS_LIMIT)) { "Gebruik maximaal 1000 tekens en laat links en regeleinden weg." }
    return deletionRequestBody(requestId).put("reason", reason.wireValue).apply {
        if (text.isNotEmpty()) put("details", text)
    }
}

/** A server receipt acknowledges a request only. It never means that an
 * account, video, balance or session has been deleted or changed. */
data class RigAccountRequestReceipt(
    val id: String,
    val type: String,
    val createdAt: Long,
    val replayed: Boolean,
    val acknowledgement: String,
    val jobId: String?,
) {
    companion object {
        fun fromJson(value: JSONObject, expectedType: String, expectedJobId: String? = null): RigAccountRequestReceipt {
            require(expectedType in setOf(ACCOUNT_DELETION_REQUEST, VIDEO_REPORT_REQUEST))
            val id = value.getString("id")
            val type = value.getString("type")
            val createdAt = value.safeInteger("createdAt")
            val acknowledgement = value.getString("acknowledgement")
            val jobId = if (value.has("jobId") && !value.isNull("jobId")) value.getString("jobId") else null
            require(RIG_REQUEST_ID.matches(id) && type == expectedType && value.getString("status") == "pending")
            require(value.get("actionPerformed") == false && value.get("replayed") is Boolean)
            require(createdAt > 0 && createdAt <= System.currentTimeMillis() + 60_000)
            require(acknowledgement.isNotBlank() && validRequestText(acknowledgement, 500))
            require(if (expectedType == ACCOUNT_DELETION_REQUEST) jobId == null && expectedJobId == null
                else expectedJobId != null && RIG_REQUEST_ID.matches(expectedJobId) && jobId == expectedJobId)
            return RigAccountRequestReceipt(id, type, createdAt, value.getBoolean("replayed"), acknowledgement, jobId)
        }
    }
}
