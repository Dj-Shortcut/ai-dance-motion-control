package dev.andyarijs.rig

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.andyarijs.rig.data.RigQuoteRequest
import dev.andyarijs.rig.data.TEMPORARY_TRANSFER
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

/** Runs the real native screens, quote parser and confirmation failure route.
 * Every HTTP request is intercepted in-process. The synthetic challenge fails
 * before CredentialManager is opened; no real account, credential or provider
 * can be used. This is not proof of the physical Redmi crash's cause. */
@RunWith(AndroidJUnit4::class)
class ConfirmationFailureUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun failedOwnerChallengeKeepsTheAppPriceAndSelectionAndNeverSubmitsVideo() {
        val challengeRequests = AtomicInteger()
        val generationRequests = AtomicInteger()
        val unexpected = ConcurrentLinkedQueue<String>()
        val selection = RigQuoteRequest("image-fixture", "video-fixture", quality = "human-recast",
            prompt = "Vervang de persoon door mij en behoud de beweging.")
        NativeViewModelFixture(funding = "owner-provider", qualities = listOf("pro", "human-recast"), setupStore = { store ->
            val user = requireNotNull(store.session()).userId
            store.write("draft-$user", JSONObject().put("step", 3).put("duration", 6)
                .put("quality", "human-recast").put("prompt", selection.prompt).put("keepSound", true)
                .put("expiresAt", System.currentTimeMillis() + 60_000).put("fullRequest", selection.toJson()))
        }) { request ->
            when (request.url.encodedPath) {
                "/api/native/provider-balance" -> {
                    val now = System.currentTimeMillis()
                    200 to JSONObject().put("availableUsdMicros", 12_340_000).put("currency", "USD")
                        .put("fetchedAt", now).put("expiresAt", now + 30_000)
                }
                "/api/native/generation-quotes" -> 200 to JSONObject().put("id", "quote-fixture")
                    .put("idempotencyKey", "intent-fixture").put("approvalToken", "a".repeat(43))
                    .put("funding", "owner-provider").put("providerCurrency", "USD")
                    .put("providerEstimateUsdMicros", 1_800_000).put("durationSeconds", 6)
                    .put("billedSeconds", 6).put("quality", "human-recast").put("outputResolution", "1080P")
                    .put("transferPolicy", TEMPORARY_TRANSFER).put("expiresAt", System.currentTimeMillis() + 60_000)
                "/api/native/owner/security" -> 200 to JSONObject().put("configured", true)
                "/api/native/owner/security/verification/options" -> {
                    challengeRequests.incrementAndGet()
                    503 to JSONObject().put("error", ERROR)
                }
                "/api/native/generations" -> {
                    generationRequests.incrementAndGet()
                    503 to JSONObject().put("error", "A test may never generate a video.")
                }
                else -> {
                    unexpected.add("${request.method} ${request.url.encodedPath}")
                    503 to JSONObject().put("error", "Unexpected in-process test request.")
                }
            }
        }.use { fixture ->
            val model = fixture.model
            val activity = compose.activity
            compose.setContent {
                val scope = rememberCoroutineScope()
                RigApp(model, onLogin = {}, onConfirm = { scope.launch { model.confirm(activity) } },
                    onRegister = {}, onPurchase = {})
            }
            // Exercise the real determinate-to-indeterminate footer transition,
            // then the transition back to the priced confirmation flow.
            setRenderProgress(model, 100, busy = true)
            compose.waitForIdle()
            setRenderProgress(model, null, busy = true)
            compose.waitForIdle()
            setRenderProgress(model, null, busy = false)
            compose.waitForIdle()
            compose.onNodeWithText("Bekijk de prijs").assertIsEnabled().performClick()
            fixture.awaitState { it.quote != null && !it.busy }
            compose.onNodeWithText("Je video bevestigen").assertIsDisplayed()
            compose.onNodeWithText(PRICE).assertIsDisplayed()
            compose.onNode(isToggleable()).performClick()
            screenshot("confirmation-price-before-challenge")
            compose.onNodeWithText("Bevestig en genereer").assertIsEnabled().performClick()
            fixture.awaitState { it.error == ERROR && !it.busy }

            assertEquals(1, challengeRequests.get())
            assertEquals(0, generationRequests.get())
            assertTrue("All HTTP must stay within the explicit fixture routes: $unexpected", unexpected.isEmpty())
            assertNull(fixture.store.pending(fixture.user))
            assertFalse(model.state.value.pendingSubmission)
            assertNotNull(model.state.value.session)
            assertEquals("quote-fixture", model.state.value.quote?.id)
            assertEquals(selection.prompt, model.state.value.prompt)
            assertEquals("human-recast", model.state.value.quality)
            assertFalse(activity.isFinishing)
            assertFalse(activity.isDestroyed)
            compose.onNodeWithText(PRICE).assertIsDisplayed()
            compose.onNodeWithText("Je video bevestigen").assertIsDisplayed()
            compose.onNodeWithText("Terug").performClick()
            compose.onNodeWithText(ERROR).assertIsDisplayed()
            compose.onNodeWithText("Bekijk de prijs").assertIsEnabled()
            screenshot("confirmation-challenge-error-keeps-app-open")
        }
    }

    /** Test-only render setup, not a production setter or a simulated price.
     * The price and failure above still use the actual repository and parser. */
    @Suppress("UNCHECKED_CAST")
    private fun setRenderProgress(model: RigViewModel, progress: Int?, busy: Boolean) {
        compose.runOnIdle {
            val field = RigViewModel::class.java.getDeclaredField("mutable").apply { isAccessible = true }
            val state = field.get(model) as MutableStateFlow<RigScreenState>
            state.value = state.value.copy(progress = progress, busy = busy, stage = "Je gekozen beelden voorbereiden")
        }
    }

    private fun screenshot(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: error("The native screenshot is unavailable")
        try {
            File(instrumentation.targetContext.cacheDir, "$name.png").outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        } finally { bitmap.recycle() }
    }

    companion object {
        private const val PRICE = "\$1.80 geraamd Fal-verbruik"
        private const val ERROR = "Apparaatbevestiging is tijdelijk niet beschikbaar."
    }
}
