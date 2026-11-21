package dev.andyarijs.rig

import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(AndroidJUnit4::class)
class VideoPlacementLoginTest {
    @get:Rule val compose = createComposeRule()
    private val prompt = "Behoud de scène uit mijn video."

    @Test fun anonymousVideoSelectionQuotesRecastAfterLogin() = checkVideoQuote("human-recast")

    @Test fun anonymousVideoSelectionQuotesStandardEditAfterLogin() = checkVideoQuote("edit-standard")

    private fun checkVideoQuote(quality: String) {
        withSignedInSelection(listOf("pro", quality)) { fixture, uploads, quotes ->
            val selection = fixture.model.state.value
            assertEquals(quality, selection.quality)
            assertEquals(prompt, selection.prompt)
            assertEquals("portret.jpg", selection.subject?.displayName)
            assertEquals("voorbeeld.mp4", selection.motion?.displayName)
            compose.onNodeWithText("Bekijk de prijs").assertIsEnabled().performClick()
            val priced = fixture.awaitState { !it.busy && (it.quote != null || it.error != null) }
            assertNull(priced.error)
            compose.onNodeWithText("Je video bevestigen").assertIsDisplayed()
            compose.onNodeWithText("Bevestig en genereer").assertIsNotEnabled()
            assertEquals(listOf("image", "video"), uploads)
            val request = quotes.single()
            assertEquals(quality, request.getString("quality"))
            assertEquals("upload-image", request.getString("imageId"))
            assertEquals("upload-video", request.getString("videoId"))
            assertEquals(prompt, request.getString("prompt"))
            assertEquals("fal-temporary-links-v1", request.getString("transferPolicy"))
        }
    }

    @Test fun unsupportedAccountMustChooseAgainBeforePreparingMediaOrPrice() {
        withSignedInSelection(listOf("pro")) { fixture, uploads, quotes ->
            compose.onNodeWithText("Waar gebeurt het?").assertIsDisplayed()
            compose.onNodeWithText("In de video").assertIsNotEnabled()
            compose.onNodeWithText("Verder").assertIsNotEnabled()
            fixture.onMain { fixture.model.prepareQuote() }
            fixture.awaitState { !it.busy && it.error != null }
            assertEquals(emptyList<String>(), uploads)
            assertEquals(emptyList<JSONObject>(), quotes)
            compose.onNodeWithText("Op je foto").performClick()
            compose.onNodeWithText("Verder").assertIsEnabled().performClick()
            compose.onNodeWithText("Bekijk de prijs").assertIsEnabled()
            assertEquals(prompt, fixture.model.state.value.prompt)
        }
    }

    @Test fun lateStartCanBeCorrectedWithoutLosingTheVideoChoice() {
        withSignedInSelection(listOf("pro", "human-recast"), startMs = 4_000L) { fixture, uploads, quotes ->
            compose.onNodeWithText("Waar gebeurt het?").assertIsDisplayed()
            compose.onNodeWithText("In de video").assertIsSelected()
            compose.onNodeWithText("Verder").assertIsNotEnabled()
            compose.onNodeWithText("Gebruik de laatste 6 seconden").performScrollTo().performClick()
            val state = fixture.model.state.value
            assertEquals("human-recast", state.quality)
            assertEquals(requireNotNull(state.motion).durationMs - 6_000L, state.startMs)
            assertEquals(6, state.duration)
            compose.onNodeWithText("Verder").assertIsEnabled().performClick()
            compose.onNodeWithText("Bekijk de prijs").assertIsEnabled()
            assertEquals(emptyList<String>(), uploads)
            assertEquals(emptyList<JSONObject>(), quotes)
        }
    }

    private fun withSignedInSelection(
        qualities: List<String>,
        startMs: Long = 0L,
        checkSelection: (NativeViewModelFixture, List<String>, List<JSONObject>) -> Unit,
    ) {
        val uploads = CopyOnWriteArrayList<String>()
        val quotes = CopyOnWriteArrayList<JSONObject>()
        NativeViewModelFixture(funding = "sponsored", qualities = qualities, signedIn = false) { request ->
            when (request.url.encodedPath) {
                "/api/native/auth/exchange" -> 200 to JSONObject().put("accessToken", "rig_native_" + "a".repeat(43))
                    .put("tokenType", "Bearer").put("userId", "u-12345678-1234-4123-8123-123456789abc")
                    .put("expiresAt", System.currentTimeMillis() + 86_400_000).put("currency", "EUR").put("mode", "live")
                "/api/native/assets" -> {
                    val kind = requireNotNull(request.header("X-Rig-Asset-Kind"))
                    uploads.add(kind)
                    200 to JSONObject().put("id", "upload-$kind").put("kind", kind).put("status", "ready")
                }
                "/api/native/generation-quotes" -> {
                    val payload = JSONObject(Buffer().also { requireNotNull(request.body).writeTo(it) }.readUtf8())
                    quotes.add(payload)
                    200 to JSONObject().put("id", "quote-video").put("priceCents", 210).put("currency", "EUR")
                        .put("approvalToken", "a".repeat(43)).put("idempotencyKey", "intent-video")
                        .put("quality", payload.getString("quality")).put("durationSeconds", 8).put("billedSeconds", 8)
                        .put("transferPolicy", "fal-temporary-links-v1").put("outputResolution", "1080P")
                }
                else -> error("Unexpected request ${request.method} ${request.url.encodedPath}")
            }
        }.use { fixture ->
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            val directory = Files.createTempDirectory(instrumentation.targetContext.cacheDir.toPath(), "placement").toFile()
            try {
                val photo = File(directory, "portret.jpg")
                val bitmap = Bitmap.createBitmap(720, 720, Bitmap.Config.ARGB_8888)
                try { photo.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it)) } }
                finally { bitmap.recycle() }
                val video = File(directory, "voorbeeld.mp4")
                instrumentation.context.assets.open("native-media-fixture.mp4").use { input -> video.outputStream().use { input.copyTo(it) } }

                compose.setContent {
                    RigApp(fixture.model, onLogin = { fixture.model.beginLogin() },
                        onConfirm = { fail("No generation may start") }, onRegister = { fail("No registration may start") },
                        onPurchase = { fail("No purchase may start") })
                }
                compose.onNodeWithText("Maak een video").performClick()
                fixture.onMain { fixture.model.select(Uri.fromFile(photo), "subject") }
                fixture.awaitState { it.subject != null && !it.busy }
                fixture.onMain { fixture.model.select(Uri.fromFile(video), "motion") }
                fixture.awaitState { it.motion != null && !it.busy }
                if (startMs > 0) fixture.onMain { fixture.model.timing(startMs, 3) }
                compose.onNodeWithText("Verder").performClick()
                compose.onNodeWithText("In de video").assertIsEnabled().performClick()
                compose.onNodeWithText("In de video").assertIsSelected()
                compose.onNodeWithText("Verder").performClick()
                compose.onNode(hasSetTextAction()).performTextReplacement(prompt)
                compose.onNodeWithText("Aanmelden en prijs bekijken").performClick()
                val state = requireNotNull(fixture.store.read("login")).getString("state")
                val callback = Uri.parse("dev.andyarijs.rig://auth/callback?code=${"c".repeat(43)}&state=$state")
                runBlocking(Dispatchers.Main) { fixture.model.completeLogin(callback) }
                assertEquals(fixture.user, fixture.model.state.value.session?.userId)
                checkSelection(fixture, uploads, quotes)
            } finally { directory.deleteRecursively() }
        }
    }
}
