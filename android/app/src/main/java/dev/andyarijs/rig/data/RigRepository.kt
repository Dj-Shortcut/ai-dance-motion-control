package dev.andyarijs.rig.data

import android.content.Context
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID

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

    suspend fun videoConfig(session: NativeAuthSession = requireSession()): RigVideoConfig = RigVideoConfig.fromJson(api.get("/video-config", session))

    suspend fun startPhotoOffer(session: NativeAuthSession): RigStartPhotoOffer {
        val value = api.get("/start-photo", session)
        api.checkSession(session)
        val available = value.optBoolean("enabled") && value.optBoolean("available", value.optInt("remaining") > 0)
        val legacy = !value.has("canCreate") && !value.has("canEdit")
        return RigStartPhotoOffer(
            canCreate = available && (legacy || value.opt("canCreate") == true),
            canEdit = available && (legacy || value.opt("canEdit") == true),
        )
    }

    suspend fun startPhoto(prompt: String, source: File?, session: NativeAuthSession): File {
        val directory = File(cacheDirectory, "rig-media")
        check(directory.mkdirs() || directory.isDirectory)
        val requestId = UUID.randomUUID().toString()
        return api.startPhoto(prompt, requestId, source, File(directory, "start-photo-$requestId.jpg"), session)
    }

    suspend fun providerBalance(): RigProviderBalance {
        val user = requireSession().userId
        // The server checks its pinned owner before reading Fal. Never infer
        // owner authority from a client flag or return a synthetic fallback.
        val value = api.get("/provider-balance")
        checkUser(user)
        return RigProviderBalance.fromJson(value)
    }

    suspend fun upload(kind: String, file: File, durationSeconds: Int? = null, keepSound: Boolean = true, session: NativeAuthSession = requireSession()): String {
        val result = api.upload(kind, file, durationSeconds, keepSound, session)
        val id = result.getString("id")
        require(RIG_ID.matches(id))
        // The current media service normalizes synchronously and exposes no
        // owned asset polling route. Unexpected processing is not a success.
        api.checkSession(session)
        check(result.optString("status") == "ready" && (!result.has("kind") || result.getString("kind") == kind)) { "Het bestand is nog niet klaar. Er is geen video gestart." }
        return id
    }

    suspend fun quote(request: RigQuoteRequest, session: NativeAuthSession = requireSession()): RigQuote {
        check(store.pending(session.userId) == null) { "Controleer eerst je bestaande video. Zo betaal je niet per ongeluk twee keer." }
        val config = videoConfig(session)
        check(config.enabled && request.quality in config.qualities) { "Dit videotype is momenteel niet beschikbaar." }
        val result = RigQuote.fromJson(api.post("/generation-quotes", request.toJson(), session), request, config.funding)
        api.checkSession(session)
        return result
    }

    suspend fun saveDraft(request: JSONObject, session: NativeAuthSession = requireSession()): JSONObject {
        val result = api.post("/video-drafts", request, session)
        api.checkSession(session)
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

    suspend fun draft(jobId: String, session: NativeAuthSession = requireSession()): JSONObject {
        require(RIG_ID.matches(jobId))
        return api.get("/generations/$jobId/draft", session).also { api.checkSession(session) }
    }

    suspend fun download(job: RigJob): File {
        check(job.completed && job.videoPath != null) { "Je video is nog niet klaar." }
        val session = requireSession()
        val directory = File(filesDirectory, "videos/${session.userId}").apply { mkdirs() }
        val file = api.download("/generations/${job.id}/video", File(directory, "RIG-${job.id}.mp4"), session = session)
        api.checkSession(session)
        return file
    }

    suspend fun downloadDraftAsset(draftId: String, assetId: String, kind: String, session: NativeAuthSession = requireSession()): File {
        require(RIG_ID.matches(draftId) && RIG_ID.matches(assetId) && kind in setOf("image", "face", "angle", "video"))
        val directory = File(cacheDirectory, "drafts/${session.userId}").apply { mkdirs() }
        val file = api.download("/video-drafts/$draftId/assets/$assetId", File(directory, "$assetId.${if (kind == "video") "mp4" else "jpg"}"), 16L * 1024 * 1024, session)
        api.checkSession(session)
        return file
    }

    suspend fun accountDeletionRequests(session: NativeAuthSession = requireSession()): List<RigAccountRequestReceipt> {
        val response = api.get("/account-deletion-requests", session)
        api.checkSession(session)
        val requests = response.getJSONArray("requests")
        require(response.safeInteger("limit") == 20L && requests.length() <= 20)
        return (0 until requests.length()).map {
            RigAccountRequestReceipt.fromJson(requests.getJSONObject(it), ACCOUNT_DELETION_REQUEST)
        }
    }

    suspend fun requestAccountDeletion(requestId: String, session: NativeAuthSession = requireSession()): RigAccountRequestReceipt {
        val body = deletionRequestBody(requestId)
        val response = api.post("/account-deletion-requests", body, session)
        api.checkSession(session)
        return RigAccountRequestReceipt.fromJson(response, ACCOUNT_DELETION_REQUEST)
    }

    suspend fun reportVideo(jobId: String, requestId: String, reason: RigContentReportReason, details: String,
        session: NativeAuthSession = requireSession()): RigAccountRequestReceipt {
        require(RIG_REQUEST_ID.matches(jobId)) { "Deze video kan niet worden gemeld." }
        val body = videoReportBody(requestId, reason, details)
        val response = api.post("/generations/$jobId/reports", body, session)
        api.checkSession(session)
        return RigAccountRequestReceipt.fromJson(response, VIDEO_REPORT_REQUEST, jobId)
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
        if (job.terminal) store.clearPending(user) else store.savePending(PendingGeneration(user, quote, intent, job.id))
    }

    fun requireSession(): NativeAuthSession = api.requireSession()
    fun checkUser(userId: String) { check(requireSession().userId == userId) { "Je account is gewijzigd. Open je opdracht opnieuw." } }
}
