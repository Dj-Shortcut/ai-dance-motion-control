package dev.andyarijs.rig

import androidx.activity.ComponentActivity
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.andyarijs.rig.data.RigQuoteRequest
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicInteger

@RunWith(AndroidJUnit4::class)
class SubmissionRecoveryTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun uncertainConfirmationRecoversExistingJobFromTheSameScreen() = checkRecovery(canceled = false)

    @Test fun canceledIntentReturnsToFreshPricingFromTheSameScreen() = checkRecovery(canceled = true)

    private fun checkRecovery(canceled: Boolean) {
        val submissions = AtomicInteger()
        val checks = AtomicInteger()
        val unavailable = JSONObject().put("error", "Tijdelijk niet beschikbaar.")
        NativeViewModelFixture(funding = "sponsored", setupStore = { store ->
            val selection = RigQuoteRequest("image-1", "video-1", prompt = "Neem mijn beweging over.")
            val draft = JSONObject().put("step", 3).put("duration", 5).put("prompt", selection.prompt)
                .put("expiresAt", System.currentTimeMillis() + 60_000L).put("fullRequest", selection.toJson())
            store.write("draft-" + requireNotNull(store.session()).userId, draft)
        }) { request ->
            when (request.url.encodedPath) {
                "/api/native/generation-quotes" -> 200 to JSONObject()
                    .put("id", "quote-1").put("idempotencyKey", "intent-1").put("approvalToken", "a".repeat(43))
                    .put("priceCents", 100).put("currency", "EUR").put("durationSeconds", 5).put("billedSeconds", 5)
                "/api/native/generations" -> {
                    submissions.incrementAndGet()
                    503 to unavailable
                }
                "/api/native/generation-intents/intent-1/reconcile" -> when {
                    checks.incrementAndGet() == 1 -> 503 to unavailable
                    canceled -> 200 to JSONObject().put("state", "canceled")
                    else -> 200 to JSONObject().put("id", "job-1").put("state", "queued")
                }
                "/api/native/generations/job-1" -> 200 to JSONObject().put("id", "job-1").put("state", "queued")
                else -> error("Unexpected request: ${request.url.encodedPath}")
            }
        }.use { fixture ->
            val model = fixture.model
            val activity = compose.activity
            compose.setContent {
                val scope = rememberCoroutineScope()
                RigApp(model, onLogin = {}, onConfirm = { scope.launch { model.confirm(activity) } },
                    onRegister = {}, onPurchase = {})
            }
            compose.onNodeWithText("Bekijk de prijs").performClick()
            fixture.awaitState { it.quote != null && !it.busy }
            compose.onNodeWithText("Bevestig en genereer").performClick()
            fixture.awaitState { it.pendingSubmission && !it.busy }
            assertNull(model.state.value.quote)
            assertEquals(3, model.state.value.step)
            compose.onNodeWithText("Controleer status").performClick()
            fixture.awaitState { checks.get() == 1 && it.pendingSubmission && !it.busy }
            compose.onNodeWithText("Controleer status").performClick()
            fixture.awaitState { !it.pendingSubmission && !it.busy }
            if (canceled) {
                assertNull(model.state.value.quote)
                assertNull(fixture.store.pending(fixture.user))
                compose.onNodeWithText("Bekijk de prijs").assertIsDisplayed()
            } else {
                assertEquals(4, model.state.value.step)
                assertEquals("job-1", model.state.value.job?.id)
            }
            assertEquals(2, checks.get())
            assertEquals(1, submissions.get())
        }
    }
}
