package dev.andyarijs.rig

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.andyarijs.rig.billing.RigPlayBilling
import dev.andyarijs.rig.data.*
import dev.andyarijs.rig.media.*
import dev.andyarijs.rig.security.RigDeviceSecurity
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import kotlin.math.min

data class RigAccountRequestDialog(
    val type: String,
    val accountUserId: String,
    val requestId: String = UUID.randomUUID().toString(),
    val jobId: String? = null,
    val reason: RigContentReportReason? = null,
    val details: String = "",
    val busy: Boolean = false,
    val error: String? = null,
    val receipt: RigAccountRequestReceipt? = null,
)

data class RigScreenState(
    val step: Int = 0, val session: RigSession? = null, val config: RigVideoConfig? = null,
    val providerBalance: RigProviderBalance? = null, val providerBalanceLoading: Boolean = false,
    val subject: NativeMediaSource? = null, val motion: NativeMediaSource? = null,
    val subjectRevision: Long = 0,
    val frameMs: Long = 0, val startMs: Long = 0, val duration: Int = 5,
    val subjectCrop: NormalizedCrop = NormalizedCrop.FULL, val motionCrop: NormalizedCrop = NormalizedCrop.FULL,
    val face: NativeMediaSource? = null, val angles: List<NativeMediaSource> = emptyList(),
    // A null quality keeps an explicit in-video selection until account capabilities are known.
    val quality: String? = "pro", val prompt: String = "", val keepSound: Boolean = true,
    val trial: Boolean = false, val busy: Boolean = false, val stage: String = "", val progress: Int? = null,
    val error: String? = null, val quote: RigQuote? = null, val job: RigJob? = null,
    val pendingSubmission: Boolean = false,
    val result: File? = null, val fullAvailable: Boolean = false,
    val draftLookupFailed: Boolean = false,
    val history: List<RigJob> = emptyList(), val showHistory: Boolean = false,
    val showCredits: Boolean = false, val needsRegistration: Boolean = false,
    val accountRequest: RigAccountRequestDialog? = null,
    val startPhotoRemaining: Int? = null,
    val startPhotoPreview: NativeMediaSource? = null,
) {
    val placementAvailable: Boolean get() = config == null || (config.enabled && quality in config.qualities)
    val inVideo: Boolean get() = quality == null || quality == "human-recast" || quality == "edit-standard"

    val fragmentIssue: String? get() = when {
        quality != "human-recast" || motion == null || !placementAvailable -> null
        motion.durationMs < 6_000L -> "Kies een bewegingsvideo van minstens 6 seconden."
        motion.durationMs - startMs < 6_000L -> "Kies een eerder beginpunt zodat er minstens 6 seconden overblijven."
        else -> null
    }

    fun withQuality(value: String?): RigScreenState {
        val seconds = duration.coerceIn(if (value == "human-recast") 6 else 3, if (value == "pro") 30 else 15)
        return copy(quality = value, duration = seconds, keepSound = value == "human-recast" || keepSound,
            trial = trial && seconds > if (value == "human-recast") 6 else 5)
    }
}

internal data class DancePhotoSelection(
    val source: NativeMediaSource, val frameMs: Long, val crop: NormalizedCrop,
    val userId: String?, val revision: Long,
)

internal fun RigScreenState.dancePhotoSelection() = subject?.let {
    DancePhotoSelection(it, if (it.isVideo) frameMs else 0, subjectCrop, session?.userId, subjectRevision)
}

private fun selectedFrame(source: NativeMediaSource?, positionMs: Long): Long =
    if (source?.isVideo == true) positionMs.coerceIn(0L, (source.durationMs - 1).coerceAtLeast(0L)) else 0L

internal data class DancePhotoCheckResult(val selection: DancePhotoSelection, val assessment: DancePhotoAssessment?)

internal typealias AssessDancePhoto = suspend (NativeMediaSource, Long, NormalizedCrop) -> DancePhotoAssessment

class RigViewModel internal constructor(
    app: Application, val repository: RigRepository, assessPhoto: AssessDancePhoto? = null,
) : AndroidViewModel(app) {
    constructor(app: Application) : this(app, RigRepository(app))
    val billing = RigPlayBilling(app, repository, viewModelScope)
    private val media = RigMediaPreparer(app)
    private val checkDancePhoto = assessPhoto ?: DancePhotoChecker(media)::check
    private val checkedPhoto = MutableStateFlow<DancePhotoCheckResult?>(null)
    internal val dancePhotoCheck = checkedPhoto.asStateFlow()
    private val security = RigDeviceSecurity(repository)
    private val mutable = MutableStateFlow(RigScreenState())
    val state = mutable.asStateFlow()
    private var running: Job? = null
    private var poll: Job? = null
    private var fullPrepared: PreparedMediaRefs? = null
    private var restoredFullRequest: RigQuoteRequest? = null
    private var draftRestored = false
    private var activeUser: String? = null
    private var resuming: Job? = null
    private var foreground = true
    private var balancePolling: Job? = null
    private var accountRequestJob: Job? = null

    init {
        media.pruneCache()
        viewModelScope.launch {
            state.map { it.dancePhotoSelection() }.distinctUntilChanged().collectLatest { selection ->
                checkedPhoto.value = null
                if (selection == null) return@collectLatest
                val assessment = try {
                    checkDancePhoto(selection.source, selection.frameMs, selection.crop)
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    null
                }
                currentCoroutineContext().ensureActive()
                if (selection == mutable.value.dancePhotoSelection()) {
                    checkedPhoto.value = DancePhotoCheckResult(selection, assessment)
                }
            }
        }
        running = viewModelScope.launch {
            mutable.update { it.copy(busy = true, stage = "Je selectie terughalen") }
            try {
                if(repository.signedIn()) { refreshAccount(); recoverSubmission() }
                else restoreDraft("draft-anonymous")
            } catch(e: CancellationException) { throw e } catch(e: Exception) { showError(e) }
            finally { mutable.update { it.copy(busy = false) } }
        }
        viewModelScope.launch {
            var previous = ""
            billing.state.collect { value ->
                if(value.message != previous && value.message.startsWith("Je aankoop is bevestigd")) {
                    try { if (repository.signedIn()) refreshAccount() }
                    catch (e: CancellationException) { throw e } catch (e: Exception) { showError(e) }
                }
                previous = value.message
            }
        }
    }
    fun showError(error: Throwable) {
        val pending = try {
            if (error is RigStorageUnavailable) throw error
            val session = repository.store.session()
            if (session == null && (activeUser != null || mutable.value.session != null)) {
                clearExpiredAccount(error.message ?: "Meld je opnieuw aan om verder te gaan.")
                return
            }
            session?.let { repository.store.pending(it.userId) }
        } catch (e: RigStorageUnavailable) {
            mutable.update { it.copy(error = e.message) }
            return
        }
        val uncertain = pending != null && pending.jobId == null
        mutable.update {
            it.copy(
                quote = if (uncertain) null else it.quote,
                pendingSubmission = uncertain,
                error = if (uncertain) "De ontvangst van je videoaanvraag is nog niet bevestigd. Controleer de status."
                        else error.message?.take(350) ?: "Dit lukte niet. Probeer het opnieuw.",
            )
        }
    }
    private fun clearExpiredAccount(message: String) {
        running?.cancel()
        poll?.cancel()
        resuming?.cancel()
        balancePolling?.cancel()
        accountRequestJob?.cancel()
        fullPrepared = null
        restoredFullRequest = null
        activeUser = null
        draftRestored = false
        // The foreground operation releases its own busy/progress state in finally.
        mutable.update { RigScreenState(error = message, busy = it.busy, progress = it.progress, stage = it.stage) }
    }
    fun closeQuote() { if (!mutable.value.busy) mutable.update { it.copy(quote = null) } }
    fun saveResult(uri: Uri) = work("Video bewaren") {
        val file = mutable.value.result ?: error("Je video is nog niet klaar.")
        withContext(Dispatchers.IO) {
            getApplication<Application>().contentResolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out) } } ?: error("Je video kon niet worden bewaard.")
        }
    }
    fun clearError() { mutable.update { it.copy(error = null) } }

    fun openAccountDeletionRequest() {
        val dialog = openAccountRequest(ACCOUNT_DELETION_REQUEST) ?: return
        accountRequestWork(dialog) { session -> repository.accountDeletionRequests(session).firstOrNull() }
    }

    fun openVideoReport() {
        val job = mutable.value.job?.takeIf { it.completed && RIG_REQUEST_ID.matches(it.id) } ?: return
        openAccountRequest(VIDEO_REPORT_REQUEST, job.id)
    }

    private fun openAccountRequest(type: String, jobId: String? = null): RigAccountRequestDialog? {
        if (mutable.value.accountRequest?.busy == true) return null
        return try {
            val session = repository.requireSession()
            check(session.userId == mutable.value.session?.userId) { "Je account is gewijzigd. Open het verzoek opnieuw." }
            RigAccountRequestDialog(type, session.userId, jobId = jobId).also { dialog ->
                accountRequestJob?.cancel()
                mutable.update { it.copy(accountRequest = dialog) }
            }
        } catch (error: Exception) { showError(error); null }
    }

    fun closeAccountRequest() {
        if (mutable.value.accountRequest?.busy != true) mutable.update { it.copy(accountRequest = null) }
    }

    fun reportReason(reason: RigContentReportReason) = editVideoReport { it.copy(reason = reason) }

    fun reportDetails(value: String) {
        val text = value.replace('\r', ' ').replace('\n', ' ').replace('\t', ' ')
        val end = text.offsetByCodePoints(0, minOf(REPORT_DETAILS_LIMIT, text.codePointCount(0, text.length)))
        editVideoReport { it.copy(details = text.substring(0, end)) }
    }

    private fun editVideoReport(edit: (RigAccountRequestDialog) -> RigAccountRequestDialog) {
        mutable.update { state ->
            val current = state.accountRequest ?: return@update state
            if (current.type != VIDEO_REPORT_REQUEST || current.busy || current.receipt != null) return@update state
            val next = edit(current)
            if (next.reason == current.reason && next.details == current.details) state
            else state.copy(accountRequest = next.copy(requestId = UUID.randomUUID().toString(), error = null))
        }
    }

    fun submitAccountRequest() {
        val dialog = mutable.value.accountRequest ?: return
        if (dialog.busy || dialog.receipt != null) return
        if (dialog.type == VIDEO_REPORT_REQUEST && dialog.reason == null) {
            mutable.update { it.copy(accountRequest = dialog.copy(error = "Kies eerst een reden.")) }
            return
        }
        accountRequestWork(dialog) { session ->
            if (dialog.type == ACCOUNT_DELETION_REQUEST) repository.requestAccountDeletion(dialog.requestId, session)
            else repository.reportVideo(requireNotNull(dialog.jobId), dialog.requestId, requireNotNull(dialog.reason), dialog.details, session)
        }
    }

    private fun accountRequestWork(dialog: RigAccountRequestDialog,
        action: suspend (NativeAuthSession) -> RigAccountRequestReceipt?) {
        if (mutable.value.accountRequest?.requestId != dialog.requestId || mutable.value.accountRequest?.busy == true) return
        fun changeDialog(update: (RigAccountRequestDialog) -> RigAccountRequestDialog) {
            mutable.update { state ->
                val current = state.accountRequest
                if (current?.requestId == dialog.requestId && state.session?.userId == dialog.accountUserId)
                    state.copy(accountRequest = update(current)) else state
            }
        }
        val session = try {
            repository.requireSession().also { check(it.userId == dialog.accountUserId) { "Je account is gewijzigd. Open het verzoek opnieuw." } }
        } catch (error: Exception) {
            if (error is RigApiException && error.status == 401) showError(error)
            else changeDialog { it.copy(error = "Je account kon niet worden gecontroleerd. Open het verzoek opnieuw.") }
            return
        }
        changeDialog { it.copy(busy = true, error = null) }
        accountRequestJob = viewModelScope.launch {
            try {
                val receipt = action(session)
                repository.api.checkSession(session)
                changeDialog { it.copy(receipt = receipt) }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (error is RigApiException && error.status == 401) showError(error)
                else changeDialog { it.copy(error = when (error) {
                    is RigApiException, is RigSessionReplacedException, is RigStorageUnavailable -> error.message
                    is IllegalArgumentException -> error.message?.takeIf { message -> message.startsWith("Gebruik maximaal") }
                    else -> null
                } ?: "Je verzoek kon niet worden bevestigd. Probeer het opnieuw.") }
            } finally { changeDialog { it.copy(busy = false) } }
        }
    }
    private fun change(mediaChanged: Boolean = true, block: (RigScreenState) -> RigScreenState) {
        val current = mutable.value
        if (current.busy) return
        val edited = block(current)
        if (current == edited) return
        mutable.value = edited.copy(quote = null, error = null)
        if (mediaChanged) {
            fullPrepared = null
            restoredFullRequest = null
        }
        try { persistDraft() } catch (e: RigStorageUnavailable) { showError(e) }
    }
    fun step(step: Int) { if (!mutable.value.busy) mutable.update { it.copy(step = step, error = null) } }
    fun prompt(value: String) = change(mediaChanged = false) { it.copy(prompt = value.take(1900)) }
    fun quality(value: String?) = change {
        if (it.quality == value || it.config?.let { config -> !config.enabled || value !in config.qualities } == true) it
        else it.withQuality(value).copy(trial = false)
    }
    fun keepSound(value: Boolean) = change { it.copy(keepSound = if(it.quality == "human-recast") true else value) }
    fun trial(value: Boolean) = change { it.copy(trial = value) }
    fun frame(value: Long) = change { it.copy(frameMs = selectedFrame(it.subject, value)) }
    fun timing(start: Long, duration: Int) = change { it.copy(startMs = start, duration = duration.coerceIn(if(it.quality == "human-recast") 6 else 3, if(it.quality == "pro") 30 else 15)) }
    fun crop(subject: Boolean, crop: NormalizedCrop) = change { if (subject) it.copy(subjectCrop = crop) else it.copy(motionCrop = crop) }
    fun removeReference(index: Int) = change { if (index < 0) it.copy(face = null, angles = emptyList()) else it.copy(angles = it.angles.filterIndexed { n, _ -> n != index }) }
    fun history(visible: Boolean) { mutable.update { it.copy(showHistory = visible) }; if (visible) work("Video’s ophalen") { val jobs = repository.recent(); mutable.update { it.copy(history = jobs) } } }
    fun credits(visible: Boolean) { mutable.update { it.copy(showCredits = visible) }; if (visible) viewModelScope.launch { billing.refresh() } }
    fun select(uri: Uri, target: String) = work("Bestand openen") {
        runCatching { getApplication<Application>().contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        val source = media.inspect(uri)
        if (target == "motion") {
            check(source.isVideo) { "Kies een bewegingsvideo." }
            RigMediaLimits.requireMotionLength(source.durationMs, mutable.value.quality)
        }
        if (target in setOf("face", "angle")) check(!source.isVideo) { "Kies een foto. Een beeld uit je referentievideo voeg je toe met ‘Gebruik dit beeld’." }
        mutable.update { current -> when (target) {
            "subject" -> current.copy(subject = source, subjectRevision = current.subjectRevision + 1, subjectCrop = NormalizedCrop.FULL, frameMs = 0, quote = null)
            "motion" -> current.copy(motion = source, motionCrop = NormalizedCrop.FULL, startMs = 0, duration = min((source.durationMs / 1000).toInt(), if (current.quality == "pro") 30 else 15).coerceAtLeast(if(current.quality == "human-recast") 6 else 3), quote = null)
            "face" -> current.copy(face = source, quote = null)
            else -> { check(current.face != null) { "Voeg eerst een close-up toe." }; check(current.angles.size < 3); current.copy(angles = current.angles + source, quote = null) }
        } }
        fullPrepared = null; restoredFullRequest = null; persistDraft()
    }
    fun generateStartPhoto(prompt: String, edit: Boolean) = work("Startfoto maken") {
        val state = mutable.value
        val session = repository.requireSession()
        check(state.step == 1 && state.session?.userId == session.userId && (state.startPhotoRemaining ?: 0) > 0)
        require(prompt.isNotBlank() && prompt.length <= 400) { "Geef een beschrijving van maximaal 400 tekens." }
        val source = if (edit) {
            val selected = state.subject?.takeUnless { it.isVideo } ?: error("Kies eerst een foto om te bewerken.")
            media.prepareImage(selected, state.subjectCrop)
        } else null
        val preview = try {
            val file = repository.startPhoto(prompt.trim(), source?.file, session)
            media.inspect(Uri.fromFile(file))
        } finally {
            refreshStartPhotoAllowance(session)
        }
        repository.api.checkSession(session)
        mutable.update { it.copy(startPhotoPreview = preview) }
    }

    private suspend fun refreshStartPhotoAllowance(session: NativeAuthSession) {
        val remaining = try { repository.startPhotoAllowance(session) }
        catch (error: CancellationException) { throw error }
        catch (_: Exception) { null }
        if (repository.store.session() == session && mutable.value.session?.userId == session.userId)
            mutable.update { it.copy(startPhotoRemaining = remaining) }
    }

    fun discardStartPhoto() {
        if (!mutable.value.busy) mutable.update { it.copy(startPhotoPreview = null) }
    }

    fun useStartPhoto() {
        val preview = mutable.value.startPhotoPreview ?: return
        change { it.copy(subject = preview, subjectRevision = it.subjectRevision + 1, subjectCrop = NormalizedCrop.FULL, frameMs = 0, startPhotoPreview = null) }
    }

    fun saveStartPhoto(uri: Uri) = work("Startfoto bewaren") {
        val preview = mutable.value.startPhotoPreview ?: return@work
        withContext(Dispatchers.IO) {
            val resolver = getApplication<Application>().contentResolver
            resolver.openOutputStream(uri)?.use { output ->
                resolver.openInputStream(preview.uri)?.use { it.copyTo(output) } ?: error("De foto kon niet worden geopend.")
            } ?: error("De foto kon niet worden bewaard.")
        }
    }

    fun referenceFrame(face: Boolean) = work("Referentiebeeld bewaren") {
        val s = mutable.value; val source = s.subject ?: error("Kies eerst je eigen video.")
        check(source.isVideo)
        val asset = media.prepareFrame(source, s.frameMs, s.subjectCrop)
        val ref = media.inspect(Uri.fromFile(asset.file))
        mutable.update { if (face) it.copy(face = ref, quote = null) else { check(it.face != null && it.angles.size < 3) { "Voeg eerst een close-up toe. Maximaal drie hoeken." }; it.copy(angles = it.angles + ref, quote = null) } }
        fullPrepared = null
        restoredFullRequest = null
        persistDraft()
    }
    fun beginLogin(): Uri {
        val uri = repository.login.beginLogin()
        val draft = if (activeUser == null && mutable.value.session == null) repository.store.read("draft-anonymous") else null
        repository.store.write("draft-login", draft?.put("loginState", uri.getQueryParameter("state")))
        return uri
    }
    suspend fun completeLogin(uri: Uri) {
        mutable.update { it.copy(busy = true, stage = "Je RIG-account openen") }
        try {
            val pending = repository.store.read("draft-login")?.takeIf { it.optString("loginState") == uri.getQueryParameter("state") && it.optLong("expiresAt") > System.currentTimeMillis() }
            repository.login.completeCallback(uri)
            if(pending != null) {
                val user = repository.requireSession().userId
                pending.remove("loginState")
                repository.store.write("draft-$user", pending)
                draftRestored = false
            }
            repository.store.write("draft-login", null)
            repository.store.write("draft-anonymous", null)
            refreshAccount()
            recoverSubmission()
        } catch (e: CancellationException) { throw e } catch (e: Exception) { showError(e) }
        finally { mutable.update { it.copy(busy = false) } }
    }
    fun resume() {
        foreground = true
        restartBalancePolling()
        if (running?.isActive == true || mutable.value.busy || resuming?.isActive == true) return
        resuming = viewModelScope.launch {
            try {
                if (!repository.signedIn()) {
                    if (activeUser != null) clearExpiredAccount("Meld je opnieuw aan om verder te gaan.")
                    return@launch
                }
                refreshAccount()
                recoverSubmission()
                if (mutable.value.showCredits) billing.refresh()
            } catch (e: CancellationException) { throw e } catch (e: Exception) { showError(e) }
        }
    }
    private suspend fun refreshAccount() {
        val session = repository.session()
        val config = repository.videoConfig()
        if (repository.store.session()?.userId != session.userId) return
        if (activeUser != null && activeUser != session.userId) {
            fullPrepared = null; restoredFullRequest = null; draftRestored = false
            mutable.update { RigScreenState(busy = it.busy, stage = it.stage, progress = it.progress) }
        }
        activeUser = session.userId
        mutable.update { it.copy(session = session.copy(funding = config.funding), config = config,
            providerBalance = it.providerBalance?.takeIf { config.funding == "owner-provider" && it.isFresh() }) }
        restartBalancePolling()
        repository.store.session()?.takeIf { it.userId == session.userId }?.let { credential ->
            viewModelScope.launch { refreshStartPhotoAllowance(credential) }
        }
        if (!draftRestored) {
            draftRestored = true
            try { restoreDraft() } catch (error: Exception) {
                if (activeUser == session.userId) draftRestored = false
                throw error
            }
        }
        val state = mutable.value
        if (state.session?.userId != session.userId || state.config != config) return
        val resolved = if (state.quality == null && config.videoEditQuality != null) state.withQuality(config.videoEditQuality) else state
        val needsFragment = restoredFullRequest == null && resolved.fragmentIssue != null
        val next = if (resolved.step == 3 && (!resolved.placementAvailable || needsFragment)) resolved.copy(step = 2) else resolved
        if (next != state) {
            mutable.value = next.copy(quote = null)
            persistDraft()
        }
    }
    fun pause() {
        foreground = false
        balancePolling?.cancel()
        balancePolling = null
        mutable.update { it.copy(providerBalanceLoading = false) }
    }
    private fun restartBalancePolling() {
        balancePolling?.cancel()
        balancePolling = null
        val user = mutable.value.session?.takeIf { it.funding == "owner-provider" }?.userId ?: return
        if(!foreground) return
        balancePolling = viewModelScope.launch {
            while(foreground && mutable.value.session?.userId == user && mutable.value.session?.funding == "owner-provider") {
                mutable.update { it.copy(providerBalanceLoading = true) }
                try {
                    repository.checkUser(user)
                    val balance = repository.providerBalance()
                    repository.checkUser(user)
                    mutable.update { if(it.session?.userId == user && it.session.funding == "owner-provider") it.copy(providerBalance = balance, providerBalanceLoading = false) else it }
                } catch(e: CancellationException) { throw e }
                catch(e: Exception) {
                    mutable.update { if(it.session?.userId == user) it.copy(providerBalance = null, providerBalanceLoading = false) else it }
                    if (e is RigStorageUnavailable || e is RigApiException && e.status == 401) { showError(e); return@launch }
                }
                val remaining = mutable.value.providerBalance?.let { it.expiresAt - System.currentTimeMillis() - 2_000L }
                delay(if(remaining == null) 15_000L else remaining.coerceIn(1_000L, 20_000L))
            }
        }
    }
    fun prepareQuote() = work("Je gekozen beelden voorbereiden") {
        val s = mutable.value
        check(s.session != null) { "Meld je aan om je prijs te bekijken." }
        val session = repository.requireSession()
        if (s.session.userId != session.userId) throw RigSessionReplacedException()
        check(s.config?.enabled == true) { "Video maken is tijdelijk niet beschikbaar." }
        val quality = s.quality
        check(quality != null && quality in s.config.qualities) { "Deze verwerking is nog niet beschikbaar voor je account." }
        check(s.prompt.isNotBlank()) { "Beschrijf eerst wat je wilt zien." }
        restoredFullRequest?.let { request ->
            mutable.update { it.copy(stage = "Je volledige video berekenen") }
            readyQuote(repository.quote(request.copy(prompt = s.prompt), session), false, session)
            return@work
        }
        val subject = s.subject ?: error("Kies je foto of een beeld uit je eigen video.")
        val motion = s.motion ?: error("Kies de bewegingsvideo.")
        if(s.quality == "human-recast") check(s.duration in 6..15 && s.startMs + s.duration * 1000L <= motion.durationMs && s.keepSound) { "Kies voor deze bewerking een fragment van 6 tot 15 seconden met het originele geluid." }
        val primary = if (subject.isVideo) media.prepareFrame(subject, s.frameMs, s.subjectCrop) else media.prepareImage(subject, s.subjectCrop)
        val face = s.face?.takeIf { s.quality == "pro" }?.let { media.prepareImage(it) }
        val angles = s.angles.takeIf { s.quality == "pro" }.orEmpty().map { media.prepareImage(it) }
        val full = media.prepareMotion(motion, s.startMs, s.duration, s.motionCrop, s.keepSound,
            minSide = if (s.quality in setOf("edit-standard", "human-recast")) 720 else 0, maxDurationSeconds = if(s.quality == "pro") 30 else 15) { progress -> mutable.update { it.copy(progress = progress) } }
        fullPrepared = PreparedMediaRefs(primary, full, face, angles)
        val trialSeconds = if (s.quality == "human-recast") 6 else 5
        val trial = s.trial && s.duration > trialSeconds
        val clip = if (trial) media.prepareMotion(motion, s.startMs, trialSeconds, s.motionCrop, s.keepSound,
            minSide = if (s.quality in setOf("edit-standard", "human-recast")) 720 else 0, maxDurationSeconds = if(s.quality == "pro") 30 else 15) { progress -> mutable.update { it.copy(progress = progress) } } else full
        mutable.update { it.copy(stage = "Je gekozen fragment veilig uploaden", progress = null) }
        val imageId = repository.upload("image", primary.file, session = session)
        val faceId = face?.let { repository.upload("face", it.file, session = session) }
        val angleIds = angles.map { repository.upload("angle", it.file, session = session) }
        val videoId = repository.upload("video", clip.file, clip.durationSeconds, s.keepSound, session)
        val request = RigQuoteRequest(imageId, videoId, quality, s.prompt, s.keepSound, false, faceId, angleIds)
        mutable.update { it.copy(stage = "Je prijs berekenen") }
        val quote = repository.quote(request, session)
        if (trial) {
            mutable.update { it.copy(stage = "Je volledige fragment bewaren") }
            val fullId = repository.upload("video", full.file, full.durationSeconds, s.keepSound, session)
            repository.saveDraft(request.fullDraft(quote.id, fullId, s.duration, s.startMs), session)
        }
        readyQuote(quote, trial, session)
    }
    private suspend fun readyQuote(quote: RigQuote, trial: Boolean, session: NativeAuthSession) {
        val device = if(quote.funding in setOf("credits", "owner-provider")) security.status(quote.funding == "owner-provider", session) else JSONObject().put("configured", true)
        repository.api.checkSession(session)
        mutable.update { it.copy(quote = quote, fullAvailable = trial, needsRegistration = quote.funding == "credits" && !device.optBoolean("configured")) }
    }

    suspend fun register(activity: Activity) {
        if (mutable.value.busy) return
        mutable.update { it.copy(busy = true, stage = "Je apparaat instellen") }
        try { security.register(activity); mutable.update { it.copy(needsRegistration = false) } } catch (e: CancellationException) { throw e } catch (e: Exception) { showError(e) }
        finally { mutable.update { it.copy(busy = false) } }
    }
    suspend fun confirm(activity: Activity) {
        if (mutable.value.busy) return
        val q = mutable.value.quote ?: return
        mutable.update { it.copy(busy = true, stage = "Bevestig op je apparaat", error = null) }
        try {
            val verification = if(q.funding in setOf("credits", "owner-provider")) security.verify(activity, q) else null
            mutable.update { it.copy(stage = "Naar RIG sturen") }
            accept(repository.submit(q, verification))
        } catch (e: CancellationException) { throw e } catch (e: Exception) { showError(e) }
        finally { mutable.update { it.copy(busy = false) } }
    }
    private fun accept(job: RigJob) {
        mutable.update { it.copy(job = job, step = 4, quote = null, showHistory = false, result = null, fullAvailable = false, draftLookupFailed = false) }
        poll?.cancel()
        poll = viewModelScope.launch {
            try {
                var current = job
                while (!current.terminal) { delay(5000); current = repository.job(current.id); mutable.update { it.copy(job = current) } }
                if (current.completed) {
                    val result = repository.download(current)
                    currentCoroutineContext().ensureActive()
                    mutable.update { if (it.job?.id == current.id) it.copy(result = result) else it }
                    checkDraftAvailability(current.id)
                }
                val freshSession = repository.session(); mutable.update { it.copy(session = freshSession.copy(funding = it.config?.funding ?: freshSession.funding)) }; restartBalancePolling()
            } catch (e: CancellationException) { throw e } catch (e: Exception) { showError(e) }
        }
    }
    fun open(job: RigJob) = accept(job)
    fun retryDraftLookup() = work("Je volledige selectie controleren") {
        val state = mutable.value
        if (state.draftLookupFailed && state.result != null) state.job?.let { checkDraftAvailability(it.id) }
    }

    private suspend fun checkDraftAvailability(jobId: String) {
        val available = try {
            repository.draft(jobId).getBoolean("available")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e is RigApiException && e.status == 401) throw e
            null
        }
        currentCoroutineContext().ensureActive()
        mutable.update {
            if (it.job?.id == jobId) it.copy(fullAvailable = available == true, draftLookupFailed = available == null) else it
        }
    }
    fun checkSubmission() = work("Je videoaanvraag controleren") { recoverSubmission() }
    private suspend fun recoverSubmission() {
        val job = repository.recoverPending()
        mutable.update {
            it.copy(pendingSubmission = false, error = when {
                !it.pendingSubmission -> it.error
                job == null -> "Je vorige videoaanvraag is geannuleerd. Je kunt de prijs opnieuw bekijken."
                else -> null
            })
        }
        if (job != null) accept(job)
    }
    fun checkStatus() { val job = mutable.value.job; if (job != null) work("Status controleren") { accept(repository.job(job.id)) } else resume() }
    fun continueFull() = work("Je volledige fragment terughalen") {
        val session = repository.requireSession()
        if (mutable.value.session?.userId != session.userId) throw RigSessionReplacedException()
        val job = mutable.value.job ?: error("Open eerst je proefje.")
        val draft = repository.draft(job.id, session)
        check(draft.optBoolean("available")) { "De privébewaring van dit fragment is verlopen. Je proefvideo blijft beschikbaar." }
        val request = RigQuoteRequest.fromJson(draft.getJSONObject("request"))
        check(!draft.optBoolean("cleanup")) { "Dit fragment gebruikt een verwerking die nog niet in Android beschikbaar is. Open het op de website." }
        val assets = draft.getJSONObject("assets")
        val videoPath = assets.getJSONObject("video").getString("path")
        val match = Regex("^/api/(?:native/)?video-drafts/([a-f0-9-]{36})/assets/([a-f0-9-]{36})$").matchEntire(videoPath) ?: error("Dit bewaarde fragment kon niet worden gecontroleerd.")
        check(match.groupValues[2] == request.videoId)
        val draftId = match.groupValues[1]
        val imageFile = repository.downloadDraftAsset(draftId, request.imageId, "image", session)
        val videoFile = repository.downloadDraftAsset(draftId, request.videoId, "video", session)
        val subject = media.inspect(Uri.fromFile(imageFile)); val motion = media.inspect(Uri.fromFile(videoFile))
        val face = request.faceId?.let { media.inspect(Uri.fromFile(repository.downloadDraftAsset(draftId, it, "face", session))) }
        val angles = request.angleIds.map { media.inspect(Uri.fromFile(repository.downloadDraftAsset(draftId, it, "angle", session))) }
        currentCoroutineContext().ensureActive()
        repository.api.checkSession(session)
        restoredFullRequest = request
        mutable.update {
            val supported = it.config?.let { config -> config.enabled && request.quality in config.qualities } == true
            it.copy(subject = subject, motion = motion, face = face, angles = angles, duration = draft.getInt("selectedSeconds"), startMs = 0, frameMs = 0, subjectCrop = NormalizedCrop.FULL, motionCrop = NormalizedCrop.FULL, prompt = request.prompt, quality = request.quality, keepSound = request.keepSound, trial = false, quote = null, step = if (supported) 3 else 2, result = null, job = null, fullAvailable = false)
        }
        persistDraft()
    }
    suspend fun purchase(activity: Activity, id: String) { try { billing.purchase(activity, id); refreshAccount() } catch (e: CancellationException) { throw e } catch (e: Exception) { showError(e) } }
    fun logout() = work("Afmelden") {
        val user = activeUser ?: mutable.value.session?.userId
        poll?.cancel()
        resuming?.cancel()
        accountRequestJob?.cancel()
        try {
            repository.logout()
        } finally {
            activeUser = null
            draftRestored = false
            fullPrepared = null
            restoredFullRequest = null
            mutable.value = RigScreenState()
            user?.let { repository.store.write("draft-$it", null) }
            repository.store.write("draft-anonymous", null)
            repository.store.write("draft-login", null)
        }
    }
    fun newVideo() { if (mutable.value.busy) return; mutable.update { it.copy(step = 1, result = null, job = null, quote = null, fullAvailable = false, draftLookupFailed = false, trial = false) } }
    private fun work(stage: String, block: suspend () -> Unit) {
        if (running?.isActive == true || mutable.value.busy) return
        running = viewModelScope.launch {
            mutable.update { it.copy(busy = true, stage = stage, progress = null, error = null) }
            try { block() } catch (e: CancellationException) { throw e } catch (e: Exception) { showError(e) }
            finally { mutable.update { it.copy(busy = false, progress = null) } }
        }
    }
    private fun persistDraft() {
        val user = mutable.value.session?.userId
        val key = if(user == null) "draft-anonymous" else "draft-$user"
        val s = mutable.value
        repository.store.write(key, JSONObject().put("expiresAt", System.currentTimeMillis() + 86400000)
            .put("subject", s.subject?.uri?.toString()).put("motion", s.motion?.uri?.toString())
            .put("frameMs", s.frameMs).put("startMs", s.startMs).put("duration", s.duration).put("step", s.step.coerceIn(0,3))
            .put("subjectCrop", cropJson(s.subjectCrop)).put("motionCrop", cropJson(s.motionCrop))
            .put("prompt", s.prompt).put("quality", s.quality ?: JSONObject.NULL).put("keepSound", s.keepSound).put("trial", s.trial)
            .apply { if (user != null && user == activeUser) put("fullRequest", restoredFullRequest?.toJson()) }
            .put("face", s.face?.uri?.toString()).put("angles", JSONArray(s.angles.map { it.uri.toString() })))
    }
    private suspend fun restoreDraft(anonymousKey: String? = null) {
        val user = mutable.value.session?.userId
        val key = if(anonymousKey == "draft-anonymous" && user == null) anonymousKey else user?.let { "draft-$it" } ?: return
        val d = repository.store.read(key) ?: return
        if (d.optLong("expiresAt") <= System.currentTimeMillis()) { repository.store.write(key, null); return }
        suspend fun source(key: String): NativeMediaSource? = d.optString(key).takeIf { it.isNotBlank() && it != "null" }?.let { runCatching { media.inspect(Uri.parse(it)) }.getOrNull() }
        val subject = source("subject"); val motion = source("motion"); val face = source("face")
        val angles = d.optJSONArray("angles")?.let { a -> (0 until min(3, a.length())).mapNotNull { n -> runCatching { media.inspect(Uri.parse(a.getString(n))) }.getOrNull() } } ?: emptyList()
        currentCoroutineContext().ensureActive()
        if (mutable.value.session?.userId != user || repository.store.session()?.userId != user) return
        restoredFullRequest = if (user == null) null else d.optJSONObject("fullRequest")?.let(RigQuoteRequest::fromJson)
        val hasSelection = restoredFullRequest != null || (subject != null && motion != null)
        val quality = if (d.has("quality") && d.isNull("quality")) null else d.optString("quality", "pro")
        mutable.update { it.copy(step = if (hasSelection) d.optInt("step",1) else 0, subject = subject, motion = motion, face = face, angles = if(face!=null) angles else emptyList(), frameMs = selectedFrame(subject, d.optLong("frameMs")), startMs = d.optLong("startMs"), duration = d.optInt("duration",5), subjectCrop = cropFrom(d.optJSONArray("subjectCrop")), motionCrop = cropFrom(d.optJSONArray("motionCrop")), prompt = d.optString("prompt"), quality = quality, keepSound = d.optBoolean("keepSound",true), trial = d.optBoolean("trial")) }
    }
    private fun cropJson(c: NormalizedCrop) = JSONArray(listOf(c.left,c.top,c.right,c.bottom))
    private fun cropFrom(a: JSONArray?) = runCatching { if(a==null) NormalizedCrop.FULL else NormalizedCrop(a.getDouble(0).toFloat(),a.getDouble(1).toFloat(),a.getDouble(2).toFloat(),a.getDouble(3).toFloat()) }.getOrDefault(NormalizedCrop.FULL)
    override fun onCleared() { billing.close(); super.onCleared() }
}
