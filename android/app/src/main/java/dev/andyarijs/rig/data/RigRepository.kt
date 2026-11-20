package dev.andyarijs.rig.data

import android.content.Context
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.File
import java.io.IOException

/** All balances, prices and job states come from RIG. Sending and recovery are
 * separate operations: a lost response must never start another paid video. */
class RigRepository internal constructor(private val filesDirectory: File, private val cacheDirectory: File, val store: RigStore, val api: RigApi = RigApi(store)) {
    constructor(context: Context) : this(context.applicationContext.filesDir, context.applicationContext.cacheDir, RigSecureStore(context.applicationContext))
    val login = RigLoginManager(store, api)
    private val submitLock = Mutex()

    fun signedIn(): Boolean = store.session() != null

    suspend fun session(): RigSession {
        val expected = requireSession().userId
        val value = RigSession.fromJson(api.get("/session"))
        check(value.userId == expected && requireSession().userId == expected) { "Je account is gewijzigd. Open je opdracht opnieuw." }
        return value
    }

    suspend fun videoConfig(): RigVideoConfig = RigVideoConfig.fromJson(api.get("/video-config"))

    suspend fun upload(kind: String, file: File, durationSeconds: Int? = null, keepSound: Boolean = true): String {
        val user = requireSession().userId
        val result = api.upload(kind, file, durationSeconds, keepSound)
        val id = result.getString("id")
        require(RIG_ID.matches(id))
        // The current media service normalizes synchronously and exposes no
        // owned asset polling route. Unexpected processing is not a success.
        checkUser(user)
        check(result.optString("status") == "ready" && (!result.has("kind") || result.getString("kind") == kind)) { "Het bestand is nog niet klaar. Er is geen video gestart." }
        return id
    }

    suspend fun quote(request: RigQuoteRequest): RigQuote {
        val user = requireSession().userId
        check(store.pending(user) == null) { "Controleer eerst je bestaande video. Zo betaal je niet per ongeluk twee keer." }
        val config = videoConfig()
        checkUser(user)
        check(config.enabled && request.quality in config.qualities) { "Dit videotype is momenteel niet beschikbaar." }
        val result = RigQuote.fromJson(api.post("/generation-quotes", request.toJson()), request, config.funding)
        checkUser(user)
        return result
    }

    suspend fun saveDraft(request: JSONObject): JSONObject {
        val result = api.post("/video-drafts", request)
        check(result.optBoolean("saved") && result.optLong("expiresAt") > System.currentTimeMillis()) { "Je volledige fragment kon niet worden bewaard. Start je proefje nog niet." }
        return result
    }

    suspend fun submit(quote: RigQuote, verification: JSONObject?): RigJob = submitLock.withLock {
        val user = requireSession().userId
        check(store.pending(user) == null) { "Controleer eerst je bestaande opdracht." }
        check(quote.expiresAt == null || quote.expiresAt > System.currentTimeMillis()) { "Deze prijs is verlopen. Bekijk de prijs opnieuw." }
        if (quote.funding in setOf("credits", "owner-provider")) check(verification != null) { "Bevestig deze video eerst op je apparaat." }
        val payload = quote.confirmationPayload().put("approvalToken", quote.approvalToken)
            .apply { if (verification != null) put("verification", verification) }
        // Commit synchronously before transmission. A screen lock/process death
        // retains this exact intent and always resumes by reconciliation.
        store.savePending(PendingGeneration(user, quote.id, quote.idempotencyKey))
        val result = try { RigJob.fromJson(api.post("/generations", payload)) } catch (error: Exception) {
            // Keep the marker even for an HTTP error: the server may already
            // have accepted the job or consumed the approval.
            throw error
        }
        checkUser(user)
        recordJob(user, quote.id, quote.idempotencyKey, result)
        result
    }

    suspend fun recoverPending(): RigJob? = submitLock.withLock {
        val user = requireSession().userId
        val pending = store.pending(user) ?: return@withLock null
        val result = if (pending.jobId != null) job(pending.jobId) else {
            val response = api.post("/generation-intents/${pending.idempotencyKey}/reconcile", JSONObject().put("quoteId", pending.quoteId))
            checkUser(user)
            if (response.optString("state") == "canceled") { store.clearPending(user); return@withLock null }
            RigJob.fromJson(response)
        }
        checkUser(user)
        recordJob(user, pending.quoteId, pending.idempotencyKey, result)
        result
    }

    suspend fun job(id: String): RigJob {
        require(RIG_ID.matches(id))
        val user = requireSession().userId
        val result = RigJob.fromJson(api.get("/generations/$id"))
        require(result.id == id)
        checkUser(user)
        store.pending(user)?.takeIf { it.jobId == id }?.let { recordJob(user, it.quoteId, it.idempotencyKey, result) }
        return result
    }

    suspend fun recent(): List<RigJob> {
        val user = requireSession().userId
        val raw = api.get("/generations/recent")
        checkUser(user)
        // The existing API returns one most-recent owned job. Future list
        // support is accepted without creating synthetic local history.
        val list = raw.optJSONArray("jobs") ?: raw.optJSONArray("generations")
        return if (list != null) (0 until list.length()).map { RigJob.fromJson(list.getJSONObject(it)) }
        else if (raw.has("id") && !raw.isNull("id")) listOf(RigJob.fromJson(raw))
        else (raw.optJSONObject("job") ?: raw.optJSONObject("generation"))?.let { listOf(RigJob.fromJson(it)) } ?: emptyList()
    }

    suspend fun draft(jobId: String): JSONObject { require(RIG_ID.matches(jobId)); return api.get("/generations/$jobId/draft") }

    suspend fun download(job: RigJob): File {
        check(job.completed && job.videoPath != null) { "Je video is nog niet klaar." }
        val user = requireSession().userId
        val directory = File(filesDirectory, "videos/$user").apply { mkdirs() }
        val file = api.download("/generations/${job.id}/video", File(directory, "RIG-${job.id}.mp4"))
        checkUser(user)
        return file
    }

    suspend fun downloadDraftAsset(draftId: String, assetId: String, kind: String): File {
        require(RIG_ID.matches(draftId) && RIG_ID.matches(assetId) && kind in setOf("image", "face", "angle", "video"))
        val user = requireSession().userId
        val directory = File(cacheDirectory, "drafts/$user").apply { mkdirs() }
        val file = api.download("/video-drafts/$draftId/assets/$assetId", File(directory, "$assetId.${if (kind == "video") "mp4" else "jpg"}"), 16L * 1024 * 1024)
        checkUser(user)
        return file
    }

    suspend fun logout() {
        try { if (signedIn()) api.post("/auth/logout") } finally {
            store.clearSession()
            store.write("login", null)
            store.write("login-completed", null)
            // Account-scoped unfinished payment/job records stay encrypted so
            // the same user can reconcile them after logging in again.
        }
    }

    private fun recordJob(user: String, quote: String, intent: String, job: RigJob) {
        val finalized = job.completed || job.state == "canceled" || (job.state == "failed" && (job.raw.optBoolean("refundConfirmed") || job.raw.optBoolean("finalizationConfirmed")))
        if (finalized) store.clearPending(user) else store.savePending(PendingGeneration(user, quote, intent, job.id))
    }

    fun requireSession(): NativeAuthSession = store.session() ?: throw RigApiException(401, "login_required", "Meld je aan om verder te gaan.")
    fun checkUser(userId: String) { check(requireSession().userId == userId) { "Je account is gewijzigd. Open je opdracht opnieuw." } }
}
