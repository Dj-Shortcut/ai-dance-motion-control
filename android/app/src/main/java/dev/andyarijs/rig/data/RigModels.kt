package dev.andyarijs.rig.data

import org.json.JSONArray
import org.json.JSONObject

internal val RIG_ID = Regex("^[A-Za-z0-9_-]{1,100}$")
internal val RIG_USER = Regex("^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
internal val RIG_NATIVE_TOKEN = Regex("^rig_native_[A-Za-z0-9_-]{43}$")
internal const val TEMPORARY_TRANSFER = "fal-temporary-links-v1"

data class NativeAuthSession(val accessToken: String, val expiresAt: Long, val userId: String)

data class RigSession(
    val userId: String,
    val balanceCents: Long,
    val frozen: Boolean,
    val funding: String,
    val currency: String,
    val raw: JSONObject,
) {
    companion object {
        fun fromJson(value: JSONObject): RigSession {
            val user = value.getString("userId")
            require(RIG_USER.matches(user) && value.getString("currency") == "EUR" && value.getString("mode") == "live")
            val balance = value.safeInteger("balanceCents")
            require(balance >= 0 && balance <= 9_007_199_254_740_991L)
            return RigSession(user, balance, value.optBoolean("frozen"), value.optString("funding", "credits"), "EUR", value)
        }
    }
}

data class RigVideoConfig(val enabled: Boolean, val funding: String, val qualities: List<String>, val raw: JSONObject) {
    companion object {
        fun fromJson(value: JSONObject): RigVideoConfig = RigVideoConfig(
            value.optBoolean("enabled"), value.optString("funding", "credits"),
            value.optJSONArray("qualities").strings().filter { it in setOf("standard", "pro", "edit-standard", "human-recast") }, value,
        )
    }
}

data class RigQuoteRequest(
    val imageId: String,
    val videoId: String,
    val quality: String = "pro",
    val prompt: String,
    val keepSound: Boolean = true,
    val steadyCamera: Boolean = false,
    val faceId: String? = null,
    val angleIds: List<String> = emptyList(),
) {
    fun toJson(): JSONObject {
        require(RIG_ID.matches(imageId) && RIG_ID.matches(videoId))
        require(faceId == null || RIG_ID.matches(faceId))
        require(angleIds.size <= 3 && angleIds.all(RIG_ID::matches) && (angleIds.isEmpty() || faceId != null))
        require(prompt.trim().length in 1..1900)
        require(quality in setOf("standard", "pro", "edit-standard", "human-recast"))
        require(quality != "edit-standard" || angleIds.size <= 2)
        val edit = quality in setOf("edit-standard", "human-recast")
        require(!edit || !steadyCamera)
        require(quality != "human-recast" || (keepSound && faceId == null && angleIds.isEmpty()))
        return JSONObject().put("imageId", imageId).put("videoId", videoId)
            .put("faceId", faceId ?: JSONObject.NULL).put("angleIds", JSONArray(angleIds))
            .put("quality", quality).put("prompt", prompt.trim()).put("keepSound", keepSound)
            .apply { if (edit) put("transferPolicy", TEMPORARY_TRANSFER) else put("steadyCamera", steadyCamera) }
    }

    fun fullDraft(quoteId: String, fullVideoId: String, selectedSeconds: Int, startMs: Long): JSONObject =
        toJson().apply {
            remove("videoId")
            put("quoteId", quoteId)
            put("fullVideoId", fullVideoId)
            put("selectedSeconds", selectedSeconds)
            put("originalStartSeconds", startMs / 1000.0)
            put("cleanup", false)
        }

    companion object {
        fun fromJson(value: JSONObject) = RigQuoteRequest(
            imageId = value.getString("imageId"),
            videoId = value.getString("videoId"),
            quality = value.getString("quality"),
            prompt = value.getString("prompt"),
            keepSound = value.getBoolean("keepSound"),
            steadyCamera = value.optBoolean("steadyCamera"),
            faceId = if (value.isNull("faceId")) null else value.getString("faceId"),
            angleIds = value.optJSONArray("angleIds").strings(),
        )
    }
}

data class RigQuote(
    val id: String,
    val priceCents: Long?,
    val currency: String?,
    val funding: String,
    val approvalToken: String,
    val idempotencyKey: String,
    val durationSeconds: Double,
    val expiresAt: Long?,
    val transferPolicy: String?,
    val raw: JSONObject,
) {
    val providerEstimateUsdMicros: Long? get() = if (funding == "owner-provider") raw.safeInteger("providerEstimateUsdMicros") else null
    fun confirmationPayload(): JSONObject = JSONObject().put("quoteId", id).put("idempotencyKey", idempotencyKey)
        .apply { if (transferPolicy == TEMPORARY_TRANSFER) put("transferConsent", TEMPORARY_TRANSFER) }

    companion object {
        fun fromJson(value: JSONObject, request: RigQuoteRequest, configuredFunding: String = "credits"): RigQuote {
            val id = value.getString("id")
            val approval = value.getString("approvalToken")
            val intent = value.getString("idempotencyKey")
            val duration = value.getDouble("durationSeconds")
            val edit = request.quality in setOf("edit-standard", "human-recast")
            require(configuredFunding in setOf("credits", "owner-provider", "sponsored"))
            val funding = value.optString("funding", configuredFunding)
            require(funding == configuredFunding)
            require(RIG_ID.matches(id) && RIG_ID.matches(intent) && Regex("^[A-Za-z0-9_-]{43}$").matches(approval))
            require(duration.isFinite() && duration >= 3 && duration <= if (edit) 15 else 30)
            require(request.quality != "human-recast" || duration >= 5)
            require(value.getInt("billedSeconds") == kotlin.math.ceil(duration).toInt())
            require(!value.has("quality") || value.getString("quality") == request.quality)
            require(!edit || value.optString("transferPolicy") == TEMPORARY_TRANSFER)
            require(edit || !value.has("transferPolicy"))
            require(request.quality != "human-recast" || value.optString("outputResolution") == "1080P")
            // Multi-step cleanup/recast preparation needs a native implementation;
            // never present it as a supported one-call generation.
            require(value.optString("workflowVersion") != "rig-workflow-v2")
            val ownProvider = funding == "owner-provider"
            val cents = if (ownProvider) null else value.safeInteger("priceCents")
            require(if (ownProvider) !value.has("priceCents") && !value.has("currency") && value.optString("providerCurrency") == "USD" && value.safeInteger("providerEstimateUsdMicros") > 0 else cents != null && cents > 0 && value.getString("currency") == "EUR")
            return RigQuote(id, cents, if (ownProvider) null else "EUR", funding, approval, intent, duration,
                if (value.has("expiresAt")) value.safeInteger("expiresAt") else null,
                if (edit) TEMPORARY_TRANSFER else null, value)
        }
    }
}

data class RigJob(val id: String, val state: String, val videoPath: String?, val raw: JSONObject) {
    val completed: Boolean get() = state == "completed"
    val terminal: Boolean get() = completed || state == "canceled" || state == "failed" && (raw.optBoolean("refundConfirmed") || raw.optBoolean("finalizationConfirmed"))
    companion object {
        fun fromJson(value: JSONObject): RigJob {
            val id = value.getString("id")
            require(RIG_ID.matches(id))
            val suppliedPath = value.optString("videoPath").takeIf { it.isNotEmpty() }
            val path = suppliedPath ?: if (value.optString("state") == "completed") "/api/generations/$id/video" else null
            require(path == null || path == "/api/generations/$id/video" || path == "/api/native/generations/$id/video")
            return RigJob(id, value.getString("state"), path, value)
        }
    }
}

data class PendingGeneration(val userId: String, val quoteId: String, val idempotencyKey: String, val jobId: String? = null) {
    fun toJson() = JSONObject().put("userId", userId).put("quoteId", quoteId).put("idempotencyKey", idempotencyKey).put("jobId", jobId ?: JSONObject.NULL)
    companion object {
        fun fromJson(value: JSONObject): PendingGeneration {
            val result = PendingGeneration(value.getString("userId"), value.getString("quoteId"), value.getString("idempotencyKey"), value.optString("jobId").takeIf { it != "null" && it.isNotEmpty() })
            require(RIG_USER.matches(result.userId) && RIG_ID.matches(result.quoteId) && RIG_ID.matches(result.idempotencyKey) && (result.jobId == null || RIG_ID.matches(result.jobId)))
            return result
        }
    }
}

internal fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { getString(it) }

internal fun JSONObject.safeInteger(name: String): Long {
    val value = get(name)
    require(value is Number && value.toDouble().isFinite() && value.toDouble() == value.toLong().toDouble() && value.toDouble() in -9_007_199_254_740_991.0..9_007_199_254_740_991.0)
    return value.toLong()
}

class RigApiException(val status: Int, val code: String?, message: String) : Exception(message)
