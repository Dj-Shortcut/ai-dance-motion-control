package dev.andyarijs.rig

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.andyarijs.rig.data.ACCOUNT_DELETION_REQUEST
import dev.andyarijs.rig.data.RigJob
import dev.andyarijs.rig.data.VIDEO_REPORT_REQUEST
import kotlinx.coroutines.flow.MutableStateFlow
import okhttp3.Request
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference

/** Actual native controls + actual ViewModel/repository, with every HTTP call
 * intercepted in-process. No production account, deletion or video is used. */
@RunWith(AndroidJUnit4::class)
class RigAccountRequestsUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val jobId = "22222222-2222-4222-8222-222222222222"
    private val receiptId = "33333333-3333-4333-8333-333333333333"

    @Test fun deletionIsAnExplicitRequestWithServerReceiptAndNoLogoutOrGeneration() {
        val posts = CopyOnWriteArrayList<JSONObject>()
        fixture { request ->
            when {
                request.method == "GET" -> emptyDeletionList()
                else -> { posts += body(request); 201 to receipt(ACCOUNT_DELETION_REQUEST) }
            }
        }.use { fixture ->
            show(fixture)
            openDeletion()
            fixture.awaitState { it.accountRequest != null && !it.accountRequest.busy }
            assertTrue(posts.isEmpty())
            compose.onNodeWithText("Verwijderverzoek sturen").assertIsEnabled().performClick()
            fixture.awaitState { it.accountRequest?.receipt != null && !it.accountRequest.busy }
            compose.onNodeWithTag("rig-request-receipt").assertIsDisplayed()
            compose.onNodeWithText("Dit bevestigt de ontvangst van je verzoek. Je account is nog niet verwijderd.").assertIsDisplayed()
            assertEquals(1, posts.size)
            assertEquals(setOf("requestId"), posts.single().keys().asSequence().toSet())
            assertTrue(Regex("^[a-f0-9-]{36}$").matches(posts.single().getString("requestId")))
            assertEquals(fixture.user, fixture.store.session()?.userId)
            assertNotNull(fixture.model.state.value.session)
            assertNull(fixture.store.pending(fixture.user))
            assertFalse(compose.activity.isFinishing)
        }
    }

    @Test fun retryShowsTheErrorInsideTheRequestAndKeepsTheSameIdempotencyId() {
        val posts = CopyOnWriteArrayList<String>()
        fixture { request ->
            if (request.method == "GET") emptyDeletionList() else {
                posts += body(request).getString("requestId")
                if (posts.size == 1) 503 to JSONObject().put("error", "Je verzoek is tijdelijk niet beschikbaar.")
                else 200 to receipt(ACCOUNT_DELETION_REQUEST).put("replayed", true)
            }
        }.use { fixture ->
            show(fixture); openDeletion()
            fixture.awaitState { it.accountRequest != null && !it.accountRequest.busy }
            compose.onNodeWithText("Verwijderverzoek sturen").performClick()
            fixture.awaitState { it.accountRequest?.error != null && !it.accountRequest.busy }
            compose.onNodeWithTag("rig-request-error").assertIsDisplayed()
            compose.onNodeWithText("Verwijderverzoek sturen").assertIsEnabled().performClick()
            fixture.awaitState { it.accountRequest?.receipt != null && !it.accountRequest.busy }
            compose.onNodeWithTag("rig-request-receipt").assertIsDisplayed()
            assertEquals(2, posts.size)
            assertEquals(posts[0], posts[1])
            assertNull(fixture.model.state.value.error)
            assertEquals(fixture.user, fixture.store.session()?.userId)
        }
    }

    @Test fun anAlreadyReceivedDeletionRequestIsShownWithoutPostingAgain() {
        fixture { request ->
            assertEquals("GET", request.method)
            200 to JSONObject().put("requests", JSONArray().put(receipt(ACCOUNT_DELETION_REQUEST))).put("limit", 20)
        }.use { fixture ->
            show(fixture); openDeletion()
            fixture.awaitState { it.accountRequest?.receipt != null && !it.accountRequest.busy }
            compose.onNodeWithTag("rig-request-receipt").assertIsDisplayed()
            compose.onNodeWithText("Verwijderverzoek sturen").assertDoesNotExist()
            assertEquals(receiptId, fixture.model.state.value.accountRequest?.receipt?.id)
        }
    }

    @Test fun aCompletedVideoCanBeReportedInsideRigWithTheExactJobAndReason() {
        val posts = CopyOnWriteArrayList<Pair<String, JSONObject>>()
        fixture { request ->
            assertEquals("POST", request.method)
            assertEquals("/api/native/generations/$jobId/reports", request.url.encodedPath)
            posts += request.url.encodedPath to body(request)
            201 to receipt(VIDEO_REPORT_REQUEST)
        }.use { fixture ->
            seedCompletedResult(fixture.model)
            show(fixture)
            compose.onNodeWithTag("rig-report-video").performScrollTo().performClick()
            compose.onNodeWithText("Kies een reden").performClick()
            compose.onNodeWithText("Geweld", substring = false).performClick()
            compose.onNodeWithTag("rig-report-details").performTextReplacement("Gevaarlijk voorbeeld.")
            compose.onNodeWithText("Melding versturen").assertIsEnabled().performClick()
            fixture.awaitState { it.accountRequest?.receipt != null && !it.accountRequest.busy }
            compose.onNodeWithTag("rig-request-receipt").assertIsDisplayed()
            assertEquals(1, posts.size)
            assertEquals("violence", posts.single().second.getString("reason"))
            assertEquals("Gevaarlijk voorbeeld.", posts.single().second.getString("details"))
            assertEquals(jobId, fixture.model.state.value.accountRequest?.receipt?.jobId)
            assertEquals(jobId, fixture.model.state.value.job?.id)
            assertNull(fixture.store.pending(fixture.user))
            assertEquals(fixture.user, fixture.store.session()?.userId)
        }
    }

    @Test fun privacyIsAvailableBeforeLoginAndOpensOnlyThePublishedRigPrivacyPage() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val captured = AtomicReference<Intent>()
        val monitor = object : Instrumentation.ActivityMonitor() {
            override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
                if (intent.action != Intent.ACTION_VIEW) return null
                captured.set(Intent(intent))
                return Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null)
            }
        }
        instrumentation.addMonitor(monitor)
        try {
            fixture { error("Privacy must not submit an account or generation request") }.use { fixture ->
                fixture.onMain { fixture.store.clearSession(); fixture.model.resume() }
                fixture.awaitState { it.session == null && !it.busy }
                show(fixture)
                compose.onNodeWithText("Aanmelden", substring = false).assertIsDisplayed()
                compose.onNodeWithTag("rig-start-privacy").performScrollTo().performClick()
                compose.waitUntil(5_000) { captured.get() != null }
                assertEquals("https://rig-motion-studio.shortcutcomputerguy.chatgpt.site/privacy", captured.get().dataString)
                assertNull(fixture.store.session())
                assertFalse(compose.activity.isFinishing)
            }
        } finally { instrumentation.removeMonitor(monitor) }
    }

    private fun show(fixture: NativeViewModelFixture) = compose.setContent {
        RigApp(fixture.model, onLogin = { fail("No login in this fixture") },
            onConfirm = { fail("No generation in this fixture") }, onRegister = { fail("No passkey in this fixture") },
            onPurchase = { fail("No purchase in this fixture") })
    }

    private fun openDeletion() {
        compose.onNodeWithText("Account", substring = false).performClick()
        compose.onNodeWithText("RIG-tegoed", substring = false).assertIsDisplayed()
        compose.onNodeWithTag("rig-delete-account").assertDoesNotExist()
        compose.onNodeWithText("Privacy en gegevens", substring = false).performClick()
        compose.onNodeWithTag("rig-privacy").assertIsDisplayed()
        compose.onNodeWithTag("rig-delete-account").performClick()
    }

    private fun fixture(respond: (Request) -> Pair<Int, JSONObject>) = NativeViewModelFixture { request ->
        check(request.url.encodedPath == "/api/native/account-deletion-requests" ||
            request.url.encodedPath == "/api/native/generations/$jobId/reports") {
            "Unexpected request: ${request.method} ${request.url.encodedPath}"
        }
        respond(request)
    }

    private fun emptyDeletionList() = 200 to JSONObject().put("requests", JSONArray()).put("limit", 20)

    private fun receipt(type: String) = JSONObject().put("id", receiptId).put("type", type).put("status", "pending")
        .put("createdAt", System.currentTimeMillis() - 1_000).put("replayed", false)
        .put("acknowledgement", "Je verzoek is ontvangen.").put("actionPerformed", false)
        .apply { if (type == VIDEO_REPORT_REQUEST) put("jobId", jobId) }

    private fun body(request: Request) = Buffer().also { request.body!!.writeTo(it) }.readUtf8().let(::JSONObject)

    /** Only the existing owned-result view is seeded. The report itself goes
     * through the actual UI, ViewModel, repository and response validation. */
    @Suppress("UNCHECKED_CAST")
    private fun seedCompletedResult(model: RigViewModel) = compose.runOnUiThread {
        val field = RigViewModel::class.java.getDeclaredField("mutable").apply { isAccessible = true }
        val state = field.get(model) as MutableStateFlow<RigScreenState>
        state.value = state.value.copy(step = 4, job = RigJob.fromJson(JSONObject().put("id", jobId).put("state", "completed")))
    }
}
