@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package dev.andyarijs.rig

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import androidx.browser.customtabs.CustomTabsIntent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import dev.andyarijs.rig.data.RigJob
import dev.andyarijs.rig.data.RigQuote
import dev.andyarijs.rig.data.ACCOUNT_DELETION_REQUEST
import dev.andyarijs.rig.data.REPORT_DETAILS_LIMIT
import dev.andyarijs.rig.data.RigContentReportReason
import dev.andyarijs.rig.media.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import java.math.BigDecimal
import java.math.RoundingMode
import java.util.Currency
import androidx.compose.ui.platform.testTag
import kotlinx.coroutines.withContext
import java.util.Locale
import java.text.NumberFormat

private val Background = Color(0xff101416)
private val Surface = Color(0xff1a2023)
private val Border = Color(0xff2e383c)
private val Ink = Color(0xffeef2f0)
private val Muted = Color(0xffa9b3b0)
private val Accent = Color(0xff8fe3b8)
private const val PRIVACY_URL = "https://rig-motion-studio.shortcutcomputerguy.chatgpt.site/privacy"
private val scheme = darkColorScheme(primary = Accent, onPrimary = Color(0xff0d1f17), background = Background,
    surface = Surface, onSurface = Ink, onBackground = Ink, outline = Border, secondary = Accent)
internal fun euro(cents: Long) = NumberFormat.getCurrencyInstance(Locale.forLanguageTag("nl-BE")).format(cents / 100.0)

@Composable
fun RigApp(model: RigViewModel, onLogin: () -> Unit, onConfirm: () -> Unit, onRegister: () -> Unit, onPurchase: (String) -> Unit) {
    // Drawing callbacks can outlive this composition. Keep its state snapshot
    // instead of rereading the delegate after progress has been cleared.
    val s = model.state.collectAsStateWithLifecycle().value
    val billing by model.billing.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var options by remember { mutableStateOf(false) }
    var crop by remember { mutableStateOf<String?>(null) }
    var account by remember { mutableStateOf(false) }
    val openPrivacy: () -> Unit = {
        account = false
        runCatching { CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(PRIVACY_URL)) }
            .onFailure(model::showError)
    }
    var referenceTarget by remember { mutableStateOf("face") }
    val ownPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { model.select(it, "subject") } }
    val motionPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { model.select(it, "motion") } }
    val referencePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { model.select(it, referenceTarget) } }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("video/mp4")) { uri -> uri?.let { model.saveResult(it) } }
    BackHandler(s.step > 0 || s.showHistory || s.showCredits || options) {
        when { options -> options = false; s.showHistory -> model.history(false); s.showCredits -> model.credits(false); s.step == 4 -> model.step(0); else -> model.step(s.step - 1) }
    }
    MaterialTheme(colorScheme = scheme, typography = Typography()) {
        Scaffold(containerColor = Background, topBar = {
            Column(Modifier.statusBarsPadding().padding(horizontal = 20.dp, vertical = 8.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("RIG.", fontSize = 25.sp, fontWeight = FontWeight.Bold, color = Ink, modifier = Modifier.weight(1f))
                    if (s.session?.funding == "owner-provider") {
                        RigOwnerBalance(s.providerBalance, s.providerBalanceLoading)
                    } else if (s.session != null) TextButton(onClick = { model.credits(true) }) {
                        Text(euro(s.session!!.balanceCents))
                    }
                    TextButton(onClick = { if (s.session == null) onLogin() else account = true }) { Text(if (s.session == null) "Aanmelden" else "Account") }
                }
                if (s.session != null) TextButton(onClick = { model.history(true) }, modifier = Modifier.align(Alignment.End).height(32.dp), contentPadding = PaddingValues(0.dp)) { Text("Mijn video’s", color = Muted, fontSize = 13.sp) }
            }
        }, bottomBar = {
            if (!s.showHistory && !s.showCredits) Surface(color = Background, modifier = Modifier.navigationBarsPadding().imePadding()) {
                Column(Modifier.padding(20.dp).fillMaxWidth()) {
                    if (s.busy) {
                        Text(s.stage, color = Muted, fontSize = 13.sp, modifier = Modifier.padding(bottom = 10.dp))
                        if (s.progress == null) LinearProgressIndicator(Modifier.fillMaxWidth().padding(bottom = 12.dp))
                        else LinearProgressIndicator(progress = { s.progress!! / 100f }, modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp))
                    }
                    val label = if (s.pendingSubmission) "Controleer status" else when (s.step) {
                        0 -> "Maak een video"
                        1, 2 -> "Verder"
                        3 -> if (s.session == null) "Aanmelden en prijs bekijken" else "Bekijk de prijs"
                        else -> if (s.job?.terminal == false) "Controleer status" else "Nog eentje"
                    }
                    val enabled = !s.busy && (s.pendingSubmission || when (s.step) {
                        1 -> s.subject != null && s.motion != null
                        2 -> s.config == null || s.quality in s.config!!.qualities
                        3 -> s.prompt.isNotBlank()
                        else -> true
                    })
                    if (s.step == 4 && s.fullAvailable && !s.pendingSubmission) {
                        TextButton(onClick = model::continueFull, enabled = enabled, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                            Text("Volledige versie maken")
                        }
                    } else Button(enabled = enabled, onClick = {
                        if (s.pendingSubmission) model.checkSubmission() else when (s.step) {
                            0, 1, 2 -> model.step(s.step + 1)
                            3 -> if (s.session == null) onLogin() else model.prepareQuote()
                            else -> if (s.job?.terminal == false) model.checkStatus() else model.newVideo()
                        }
                    }, modifier = Modifier.fillMaxWidth().height(56.dp), shape = RoundedCornerShape(16.dp)) { Text(label, fontSize = 17.sp, fontWeight = FontWeight.SemiBold) }
                }
            }
        }) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)) {
                if (s.error != null) Card(colors = CardDefaults.cardColors(containerColor = Color(0xff3c2727)), modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                    Column(Modifier.padding(16.dp)) { Text(s.error!!, color = Ink); TextButton(onClick = model::clearError) { Text("Sluiten") } }
                }
                if (s.showHistory) {
                    PageTitle("Mijn video’s", "Je laatste opdracht bij RIG.", onBack = { model.history(false) })
                    if (s.history.isEmpty() && !s.busy) Text("Je hebt nog geen video om te bekijken.", color = Muted)
                    s.history.forEach { job -> ChoiceCard("Video · ${jobLabel(job)}", job.raw.optString("createdAt").takeIf { it.isNotBlank() } ?: "Open je opdracht", false, { model.open(job) }) }
                } else if (s.showCredits) {
                    PageTitle("RIG-tegoed", if (s.session?.funding == "owner-provider") "Je video’s gebruiken je eigen Fal-account. Je hoeft geen RIG-tegoed te kopen." else "Je ziet de prijs vóór je een video bevestigt.", { model.credits(false) })
                    if (s.session?.funding != "owner-provider") {
                        Text(billing.message, color = Muted, modifier = Modifier.padding(bottom = 16.dp))
                        billing.packages.forEach { pack -> ChoiceCard("${euro(pack.creditsCents)} RIG-tegoed", pack.formattedPrice + " via Google Play", false, { onPurchase(pack.productId) }, enabled = billing.available && !billing.loading) }
                        TextButton(onClick = { model.credits(true) }, enabled = !billing.loading) { Text("Aankoopstatus controleren") }
                        if (billing.loading) CircularProgressIndicator(Modifier.size(24.dp))
                    }
                } else when(s.step) {
                    0 -> {
                        Spacer(Modifier.height(30.dp))
                        Text("Zet je foto\nin beweging.", color = Ink, fontWeight = FontWeight.Bold, fontSize = 36.sp, lineHeight = 42.sp)
                        Text("Kies je beeld en een voorbeeldvideo. Jij bepaalt wat er gebeurt.", color = Muted, fontSize = 16.sp, lineHeight = 24.sp, modifier = Modifier.padding(top = 20.dp))
                        Row(Modifier.fillMaxWidth().padding(vertical = 36.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            StartCard("01", "Jouw beeld", Modifier.weight(1f)); StartCard("02", "Beweging", Modifier.weight(1f)); StartCard("03", "Jouw video", Modifier.weight(1f))
                        }
                        Text("De prijs staat vast vóór je bevestigt.", color = Accent, fontSize = 14.sp)
                        if (s.session == null) TextButton(onClick = openPrivacy,
                            modifier = Modifier.testTag("rig-start-privacy")) { Text("Privacy", color = Muted, fontSize = 13.sp) }
                    }
                    1 -> {
                        Progress(1)
                        PageTitle("Kies je beeld.", "Een foto of het beste moment uit je eigen video.", { model.step(0) })
                        MediaCard("Jouw beeld", s.subject, s.frameMs, { model.frame(it) }, { ownPicker.launch(arrayOf("image/*", "video/*")) })
                        if (s.subject?.isVideo == true) Text("Pauzeer op het beeld dat je wilt gebruiken.", color = Muted, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
                        Spacer(Modifier.height(20.dp))
                        MediaCard("Bewegingsvideo", s.motion, s.startMs, {}, { motionPicker.launch(arrayOf("video/*")) })
                        s.motion?.let { motion ->
                            Text("Fragment · ${seconds(s.startMs)} tot ${seconds(s.startMs + s.duration * 1000L)}", color = Ink, fontSize = 14.sp, modifier = Modifier.padding(top = 16.dp))
                            val maxStart = (motion.durationMs - RigMediaLimits.exportLengthMs(s.duration)).coerceAtLeast(0)
                            Text("Start", color = Muted, fontSize = 12.sp)
                            Slider(s.startMs.toFloat().coerceIn(0f, maxStart.toFloat()), onValueChange = { model.timing(it.toLong().coerceAtMost(maxStart), s.duration) }, enabled = maxStart > 0, valueRange = 0f..maxStart.toFloat().coerceAtLeast(1f))
                            val minimum = if(s.quality == "human-recast") 6 else 3
                            val maxDuration = minOf(if(s.quality == "pro") 30 else 15, ((motion.durationMs - s.startMs) / 1000).toInt()).coerceAtLeast(minimum)
                            Text("Duur · ${s.duration} seconden", color = Muted, fontSize = 12.sp)
                            Slider(s.duration.toFloat().coerceIn(minimum.toFloat(),maxDuration.toFloat()), { model.timing(s.startMs, it.toInt()) }, valueRange = minimum.toFloat()..maxDuration.toFloat().coerceAtLeast(minimum + .01f), steps = (maxDuration-minimum-1).coerceAtLeast(0))
                        }
                        TextButton(onClick = { options = true }, modifier = Modifier.padding(vertical = 12.dp)) { Text("Meer opties  +") }
                    }
                    2 -> {
                        Progress(2)
                        PageTitle("Waar gebeurt het?", "Kies wat je wilt overnemen.", { model.step(1) })
                        ChoiceCard("Op je foto", "Je neemt de beweging over. De omgeving van je foto blijft het uitgangspunt.", s.quality == "pro", { model.quality("pro") }, s.subject)
                        val editing = preferredVideoEditQuality(s.config?.qualities.orEmpty())
                        if (editing != null) ChoiceCard("In de video",
                            if(editing == "human-recast") "Vervang de persoon in de scène door jou. 1080p · 6–15 seconden, met geluid van de video."
                            else "Bewerk de bestaande scène met jouw referentiefoto. Beschrijf precies wie of wat wordt vervangen.",
                            s.quality in setOf("human-recast", "edit-standard"), { model.quality(editing) }, s.motion)
                        if (s.config != null && editing == null) Text("Videobewerking is nog niet beschikbaar voor je account.", color = Muted, fontSize = 13.sp, modifier = Modifier.padding(top = 12.dp))
                    }
                    3 -> {
                        Progress(3)
                        PageTitle("Maak het van jou.", "Vertel wat je in het resultaat wilt zien.", { model.step(2) })
                        OutlinedTextField(s.prompt, model::prompt, modifier = Modifier.fillMaxWidth().heightIn(min = 170.dp), placeholder = { Text("Wie zie je, wat doet die en wat blijft hetzelfde?") }, shape = RoundedCornerShape(16.dp), enabled = !s.busy)
                        Text(if(s.quality == "pro") "Beweging · Pro" else if(s.quality == "human-recast") "In de video · 1080p" else "Video bewerken", color = Accent, fontSize = 13.sp, modifier = Modifier.padding(vertical = 16.dp))
                        val trialSeconds = if(s.quality == "human-recast") 6 else 5
                        if (s.duration > trialSeconds) ChoiceCard("Eerst een proefje", "$trialSeconds seconden. Het proefje gaat ook van je tegoed af.", s.trial, { model.trial(true) })
                        ChoiceCard("Je volledige fragment", "${s.duration} seconden · de prijs volgt na voorbereiding", !s.trial, { model.trial(false) })
                        TextButton(onClick = { options = true }) { Text("Meer opties  +") }
                    }
                    else -> {
                        val job = s.job
                        PageTitle(if(job?.completed == true) "Je video is klaar." else "Je video.", if(job == null) "Controleer je opdracht." else jobLabel(job), null)
                        s.result?.let { file ->
                            NativeVideo(Uri.fromFile(file), 0, {}, Modifier.fillMaxWidth().height(360.dp))
                            Row(Modifier.fillMaxWidth().padding(vertical = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                OutlinedButton(onClick = { save.launch("RIG-${job?.id ?: "video"}.mp4") }, modifier = Modifier.weight(1f)) { Text("Bewaren") }
                                OutlinedButton(onClick = {
                                    runCatching {
                                        val uri = FileProvider.getUriForFile(context, "dev.andyarijs.rig.files", file)
                                        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("video/mp4").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Video delen"))
                                    }.onFailure(model::showError)
                                }, modifier = Modifier.weight(1f)) { Text("Delen") }
                            }
                        }
                        if (job?.terminal == false) {
                            LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = 24.dp))
                            Text("Je mag je scherm vergrendelen. RIG haalt de bestaande opdracht weer op als je terugkomt.", color = Muted, lineHeight = 22.sp)
                        }
                        if (job?.state == "failed") Text(job.raw.optString("error", "Deze video kon niet worden gemaakt. Controleer je tegoed en de opdrachtstatus."), color = Muted)
                        if (s.fullAvailable) Text("Je volledige selectie staat nog klaar. Je krijgt eerst een nieuwe prijs.", color = Muted, modifier = Modifier.padding(top = 12.dp))
                        if (s.draftLookupFailed) {
                            Text("Je video is klaar. Je volledige selectie kon niet worden gecontroleerd.", color = Muted)
                            TextButton(onClick = model::retryDraftLookup, enabled = !s.busy) { Text("Selectie opnieuw controleren") }
                        }
                        if (job?.completed == true) TextButton(onClick = model::openVideoReport,
                            enabled = !s.busy, modifier = Modifier.testTag("rig-report-video")) {
                            Text("Inhoud melden", color = Muted, fontSize = 13.sp)
                        }
                    }
                }
                Spacer(Modifier.height(20.dp))
            }
        }
        if (s.quote != null) QuoteDialog(s.quote!!, s.needsRegistration, s.busy, model::closeQuote, onRegister, onConfirm)
        if (account) AlertDialog(onDismissRequest = { account = false }, title = { Text("Je RIG-account") }, text = {
            Column {
                Text("Je RIG-tegoed en video’s horen bij hetzelfde account als op de website.")
                TextButton(onClick = openPrivacy, modifier = Modifier.testTag("rig-privacy")) { Text("Privacy") }
                TextButton(onClick = { account = false; model.openAccountDeletionRequest() }, enabled = !s.busy,
                    modifier = Modifier.testTag("rig-delete-account")) { Text("Account verwijderen") }
            }
        }, confirmButton = { TextButton(onClick = { account = false; model.logout() }) { Text("Afmelden") } }, dismissButton = { TextButton(onClick = { account = false }) { Text("Sluiten") } })
        s.accountRequest?.let { request ->
            AccountRequestDialog(request, model::closeAccountRequest, model::submitAccountRequest,
                model::reportReason, model::reportDetails)
        }
        if (options) ModalBottomSheet(onDismissRequest = { options = false }, containerColor = Surface) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).navigationBarsPadding()) {
                Text("Meer opties", fontSize = 24.sp, fontWeight = FontWeight.Bold)
                s.subject?.let { TextButton(onClick = { crop = "subject"; options = false }) { Text("Jouw beeld uitsnijden") } }
                s.motion?.let { TextButton(onClick = { crop = "motion"; options = false }) { Text("Bewegingsvideo uitsnijden") } }
                if(s.quality == "human-recast") Text("Met het geluid van de video", color = Muted, fontSize = 14.sp, modifier = Modifier.padding(vertical = 12.dp))
                else Row(verticalAlignment = Alignment.CenterVertically) { Text("Geluid van de video behouden", modifier = Modifier.weight(1f)); Switch(s.keepSound, model::keepSound) }
                if (s.quality == "pro") {
                    HorizontalDivider(Modifier.padding(vertical = 16.dp))
                    Text("Gezicht en hoeken", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                    Text("Optioneel. Gebruik een close-up en maximaal drie verschillende aanzichten.", color = Muted, fontSize = 13.sp, modifier = Modifier.padding(vertical = 8.dp))
                    Row { TextButton(onClick = { referenceTarget = "face"; referencePicker.launch(arrayOf("image/*")) }) { Text(if(s.face==null) "Close-up kiezen" else "Close-up vervangen") }
                        if (s.subject?.isVideo == true) TextButton(onClick = { model.referenceFrame(true) }) { Text("Gebruik dit beeld") } }
                    s.face?.let { ref -> ReferenceRow("Close-up", ref) { model.removeReference(-1) } }
                    s.angles.forEachIndexed { index, ref -> ReferenceRow("Hoek ${index+1}", ref) { model.removeReference(index) } }
                    if (s.face != null && s.angles.size < 3) Row {
                        TextButton(onClick = { referenceTarget = "angle"; referencePicker.launch(arrayOf("image/*")) }) { Text("Hoek kiezen") }
                        if (s.subject?.isVideo == true) TextButton(onClick = { model.referenceFrame(false) }) { Text("Gebruik dit beeld") }
                    }
                }
                Spacer(Modifier.height(24.dp))
            }
        }
        crop?.let { target ->
            val source = if(target == "subject") s.subject else s.motion
            if (source != null) NativeCropDialog(source = source, framePositionMs = if(target == "subject") s.frameMs else s.startMs,
                initialCrop = if(target == "subject") s.subjectCrop else s.motionCrop,
                onDismiss = { crop = null }, onApply = { model.crop(target == "subject", it); crop = null })
        }
    }
}

@Composable private fun AccountRequestDialog(request: RigAccountRequestDialog, close: () -> Unit,
    submit: () -> Unit, reason: (RigContentReportReason) -> Unit, details: (String) -> Unit) {
    val deletion = request.type == ACCOUNT_DELETION_REQUEST
    var reasonsExpanded by remember(request.requestId) { mutableStateOf(false) }
    AlertDialog(onDismissRequest = { if (!request.busy) close() },
        title = { Text(if (deletion) "Account verwijderen" else "Inhoud melden") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                val receipt = request.receipt
                if (receipt != null) {
                    Text(receipt.acknowledgement, modifier = Modifier.testTag("rig-request-receipt"))
                    Text("Ontvangstnummer: ${receipt.id}", style = MaterialTheme.typography.bodySmall, color = Muted)
                    if (deletion) Text("Dit bevestigt de ontvangst van je verzoek. Je account is nog niet verwijderd.",
                        style = MaterialTheme.typography.bodySmall)
                } else {
                    if (deletion) {
                        Text("Vraag om je RIG-account en bijbehorende gegevens te verwijderen. Dit verstuurt een verzoek; je account wordt niet meteen verwijderd.")
                        Text("Verplichte administratie kan bewaard blijven.", style = MaterialTheme.typography.bodySmall, color = Muted)
                    } else {
                        Text("Meld ongepaste of schadelijke inhoud in deze video.")
                        Box {
                            OutlinedButton(onClick = { reasonsExpanded = true }, enabled = !request.busy) {
                                Text(request.reason?.label ?: "Kies een reden")
                            }
                            DropdownMenu(expanded = reasonsExpanded, onDismissRequest = { reasonsExpanded = false }) {
                                RigContentReportReason.entries.forEach { item ->
                                    DropdownMenuItem(text = { Text(item.label) }, onClick = { reason(item); reasonsExpanded = false })
                                }
                            }
                        }
                        OutlinedTextField(value = request.details, onValueChange = details, enabled = !request.busy,
                            modifier = Modifier.fillMaxWidth().testTag("rig-report-details"),
                            label = { Text("Extra uitleg (optioneel)") }, minLines = 2, maxLines = 3,
                            supportingText = { Text("${request.details.codePointCount(0, request.details.length)}/$REPORT_DETAILS_LIMIT") })
                    }
                    if (request.busy) Row(verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        Text("Je verzoek controleren…", style = MaterialTheme.typography.bodySmall)
                    }
                    request.error?.let { Text(it, color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.testTag("rig-request-error")) }
                }
            }
        },
        confirmButton = {
            if (request.receipt != null) TextButton(onClick = close, enabled = !request.busy) { Text("Sluiten") }
            else TextButton(onClick = submit,
                enabled = !request.busy && (deletion || request.reason != null)) {
                Text(if (deletion) "Verwijderverzoek sturen" else "Melding versturen")
            }
        },
        dismissButton = { if (request.receipt == null) TextButton(onClick = close, enabled = !request.busy) { Text("Annuleren") } })
}

internal fun preferredVideoEditQuality(qualities: List<String>): String? = when {
    "human-recast" in qualities -> "human-recast"
    "edit-standard" in qualities -> "edit-standard"
    else -> null
}

@Composable internal fun RigOwnerBalance(balance: dev.andyarijs.rig.data.RigProviderBalance?, loading: Boolean = false) {
    var fresh by remember(balance) { mutableStateOf(balance?.isFresh() == true) }
    LaunchedEffect(balance) {
        fresh = balance?.isFresh() == true
        if (fresh && balance != null) {
            delay((balance.expiresAt - System.currentTimeMillis()).coerceAtLeast(0))
            fresh = false
        }
    }
    val label = when {
        fresh && balance != null -> NumberFormat.getCurrencyInstance(Locale.forLanguageTag("nl-BE")).apply {
            currency = Currency.getInstance("USD")
        }.format(BigDecimal.valueOf(balance.availableUsdMicros, 6).setScale(2, RoundingMode.DOWN))
        loading -> "Saldo laden…"
        else -> "Saldo niet beschikbaar"
    }
    Text(label, color = if(fresh) Accent else Muted, fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("rig-owner-balance").padding(horizontal = 12.dp, vertical = 8.dp))
}

@Composable private fun StartCard(number: String, label: String, modifier: Modifier) {
    Surface(modifier.height(145.dp), shape = RoundedCornerShape(18.dp), border = BorderStroke(1.dp, Border), color = Surface) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.SpaceBetween) { Text(number, fontSize = 26.sp, color = Accent); Text(label, color = Ink, fontSize = 13.sp) }
    }
}
@Composable private fun Progress(step: Int) { Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 20.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) { repeat(3) { n -> Box(Modifier.weight(1f).height(4.dp).background(if(n < step) Accent else Border, RoundedCornerShape(2.dp))) } } }
@Composable private fun PageTitle(title: String, subtitle: String, onBack: (() -> Unit)?) {
    if(onBack != null) TextButton(onClick = onBack, contentPadding = PaddingValues(0.dp)) { Text("‹  Terug", color = Muted) }
    Text(title, color = Ink, fontSize = 28.sp, fontWeight = FontWeight.Bold, lineHeight = 34.sp)
    Text(subtitle, color = Muted, fontSize = 15.sp, lineHeight = 22.sp, modifier = Modifier.padding(top = 10.dp, bottom = 24.dp))
}
@Composable private fun ChoiceCard(title: String, subtitle: String, selected: Boolean, onClick: () -> Unit, source: NativeMediaSource? = null, enabled: Boolean = true) {
    Surface(onClick = onClick, enabled = enabled, color = if(selected) Color(0xff1d2c26) else Surface, shape = RoundedCornerShape(18.dp), border = BorderStroke(1.dp, if(selected) Accent else Border), modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
        Column(Modifier.padding(18.dp)) {
            source?.let { MediaThumbnail(it, 0, Modifier.fillMaxWidth().height(125.dp).padding(bottom = 12.dp)) }
            Row(verticalAlignment = Alignment.CenterVertically) { Text(title, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, color = Ink, modifier = Modifier.weight(1f)); if(selected) Text("✓", color = Accent) }
            Text(subtitle, color = Muted, fontSize = 14.sp, lineHeight = 21.sp, modifier = Modifier.padding(top = 6.dp))
        }
    }
}
@Composable private fun MediaCard(title: String, source: NativeMediaSource?, position: Long, onPosition: (Long) -> Unit, choose: () -> Unit) {
    Surface(shape = RoundedCornerShape(18.dp), color = Surface, border = BorderStroke(1.dp,Border), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) { Text(title, color = Ink, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f)); TextButton(onClick = choose) { Text(if(source==null) "Kiezen" else "Wijzigen") } }
            if(source==null) Box(Modifier.fillMaxWidth().height(150.dp), contentAlignment = Alignment.Center) { Text("+", fontSize = 32.sp, color = Accent) }
            else if(source.isVideo) NativeVideo(source.uri, position, onPosition, Modifier.fillMaxWidth().height(230.dp))
            else MediaThumbnail(source,0,Modifier.fillMaxWidth().height(230.dp))
            source?.let { Text(it.displayName, color = Muted, fontSize = 12.sp, maxLines = 2, modifier = Modifier.padding(top=8.dp)) }
        }
    }
}
@Composable internal fun MediaThumbnail(source: NativeMediaSource, frameMs: Long, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val bitmap by produceState<Bitmap?>(null, source.uri, frameMs) {
        value = withContext(Dispatchers.IO) { runCatching {
            if (source.isVideo) MediaMetadataRetriever().let { retriever -> try { retriever.setDataSource(context,source.uri); retriever.getScaledFrameAtTime(frameMs*1000,MediaMetadataRetriever.OPTION_CLOSEST_SYNC,640,640) } finally { retriever.release() } }
            else ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver,source.uri)) { decoder,info,_ -> val scale = 640f / maxOf(info.size.width,info.size.height); if(scale<1) decoder.setTargetSize((info.size.width*scale).toInt().coerceAtLeast(1),(info.size.height*scale).toInt().coerceAtLeast(1)); decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE }
        }.getOrNull() }
    }
    if(bitmap!=null) Image(bitmap!!.asImageBitmap(),contentDescription="Gekozen beeld",modifier=modifier,contentScale=ContentScale.Fit)
    else Box(modifier.background(Background),contentAlignment=Alignment.Center) { Text("Beeld laden…",color=Muted,fontSize=12.sp) }
}
@Composable private fun ReferenceRow(title: String, source: NativeMediaSource, remove: () -> Unit) {
    Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically) { MediaThumbnail(source,0,Modifier.size(54.dp)); Text(title,modifier=Modifier.weight(1f).padding(12.dp),color=Ink); TextButton(onClick=remove) { Text("Verwijderen") } }
}
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable internal fun NativeVideo(uri: Uri, positionMs: Long, onPosition: (Long) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val reportPosition by rememberUpdatedState(onPosition)
    var player by remember(uri) { mutableStateOf<ExoPlayer?>(null) }
    var resumePosition by rememberSaveable(uri.toString()) { mutableLongStateOf(positionMs) }
    var lastInput by rememberSaveable(uri.toString()) { mutableLongStateOf(positionMs) }
    var reportedPosition by remember(uri) { mutableStateOf<Long?>(null) }
    LifecycleStartEffect(uri, lifecycleOwner = owner) {
        val active = ExoPlayer.Builder(context).build()
        active.setMediaItem(MediaItem.fromUri(uri), resumePosition)
        active.prepare()
        fun report(position: Long) {
            reportedPosition = position
            reportPosition(position)
        }
        val listener = object : androidx.media3.common.Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) { if (!isPlaying) report(active.currentPosition) }
            override fun onPositionDiscontinuity(oldPosition: androidx.media3.common.Player.PositionInfo, newPosition: androidx.media3.common.Player.PositionInfo, reason: Int) {
                if (reason == androidx.media3.common.Player.DISCONTINUITY_REASON_SEEK) report(newPosition.positionMs)
            }
        }
        active.addListener(listener)
        player = active
        onStopOrDispose {
            resumePosition = active.currentPosition
            active.removeListener(listener)
            if (!owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) && active.isPlaying) report(resumePosition)
            player = null
            active.release()
        }
    }
    LaunchedEffect(uri, positionMs) {
        if (positionMs != lastInput) {
            lastInput = positionMs
            val active = player
            if (active == null || !active.isPlaying || reportedPosition != positionMs) {
                resumePosition = positionMs
                if (active != null && active.currentPosition != positionMs) active.seekTo(positionMs)
            }
            reportedPosition = null
        }
    }
    AndroidView(factory = { PlayerView(it).apply { this.player=player; useController=true; setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING) } },update={it.player=player},modifier=modifier)
}
@Composable private fun QuoteDialog(quote: RigQuote, registration: Boolean, busy: Boolean, dismiss: () -> Unit, register: () -> Unit, confirm: () -> Unit) {
    var consent by remember(quote.id) { mutableStateOf(false) }
    AlertDialog(onDismissRequest={if(!busy)dismiss()},title={Text("Je video bevestigen")},text={
        Column(Modifier.verticalScroll(rememberScrollState())) {
            Text(if(quote.funding=="owner-provider") NumberFormat.getCurrencyInstance(Locale.US).format(quote.raw.getLong("providerEstimateUsdMicros")/1000000.0) + " geraamd Fal-verbruik" else euro(quote.priceCents!!),fontSize=26.sp,fontWeight=FontWeight.Bold,color=Accent)
            Text("${String.format(Locale.forLanguageTag("nl-BE"), "%.1f", quote.durationSeconds)} seconden",modifier=Modifier.padding(vertical=12.dp))
            if(quote.funding=="owner-provider") Text("Je eigen Fal-account betaalt de verwerking. De werkelijke Fal-kosten kunnen afwijken.",fontSize=13.sp,color=Muted)
            else Text("Dit bedrag gaat van je RIG-tegoed af na je bevestiging.",fontSize=13.sp,color=Muted)
            if(quote.transferPolicy!=null) Row(verticalAlignment=Alignment.CenterVertically) { Checkbox(consent,{consent=it},enabled=!busy); Text("Akkoord met tijdelijke Fal-links voor mijn beelden en resultaat (24 uur). Iedereen met die link kan ze openen.",fontSize=13.sp) }
            if(registration) Text("Stel eerst je apparaatbevestiging in. Daarmee bescherm je je tegoed.",modifier=Modifier.padding(top=12.dp),fontSize=13.sp)
        }
    },confirmButton={TextButton(onClick=if(registration)register else confirm,enabled=!busy&&(quote.transferPolicy==null||consent)) { Text(if(registration)"Apparaat instellen" else "Bevestig en genereer") }},dismissButton={TextButton(onClick=dismiss,enabled=!busy){Text("Terug")}})
}
private fun seconds(ms: Long) = "%d:%02d".format(ms/60000,(ms/1000)%60)
private fun jobLabel(job: RigJob) = when(job.state) { "completed" -> "Klaar"; "failed" -> "Mislukt"; "canceled" -> "Geannuleerd"; "queued" -> "In de wachtrij"; "processing","running" -> "Wordt gemaakt"; else -> "Status controleren" }
