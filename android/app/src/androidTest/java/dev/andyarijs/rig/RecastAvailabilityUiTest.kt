package dev.andyarijs.rig

import android.graphics.Bitmap
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** The real app and ViewModel receive the owner's flat config through the
 * in-process HTTP fixture. Every request is intercepted; no provider, quote,
 * generation or purchase is invoked. Media processing is intentionally absent
 * from this focused availability/options regression test. */
@RunWith(AndroidJUnit4::class)
class RecastAvailabilityUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun ownerWithRecastButNoEditStandardCanChooseVideoAndGetsOnlySupported1080pOptions() {
        val fixture = ownerRecastFixture()
        try {
            fixture.onMain {
                fixture.model.timing(0, 3)
                fixture.model.keepSound(false)
                fixture.model.step(2)
            }
            assertEquals(listOf("pro", "human-recast"), fixture.model.state.value.config!!.qualities)
            compose.setContent {
                RigApp(fixture.model, onLogin = { fail("No login is part of this test") },
                    onConfirm = { fail("No video may be submitted") }, onRegister = { fail("No device registration may start") },
                    onPurchase = { fail("No purchase may start") })
            }
            compose.onNodeWithText("Waar gebeurt het?").assertIsDisplayed()
            compose.onNodeWithText("In de video").assertIsDisplayed()
            compose.onNodeWithText("Videobewerking is nog niet beschikbaar voor je account.").assertDoesNotExist()
            compose.onNodeWithText("In de video").performClick()
            val selected = fixture.awaitState { it.quality == "human-recast" }
            assertEquals(6, selected.duration)
            assertTrue(selected.keepSound)
            screenshot("recast-where-available")

            compose.onNodeWithText("Verder").performClick()
            compose.onNodeWithText("Maak het van jou.").assertIsDisplayed()
            compose.onNodeWithText("In de video · 1080p").assertIsDisplayed()
            screenshot("recast-brief-1080p")
            compose.onNodeWithText("Meer opties  +").performScrollTo().performClick()
            compose.onNodeWithText("Met het geluid van de video").assertIsDisplayed()
            compose.onNodeWithText("Geluid van de video behouden").assertDoesNotExist()
            compose.onNodeWithText("Gezicht en hoeken").assertDoesNotExist()
            compose.onNodeWithText("Close-up kiezen").assertDoesNotExist()
            compose.onNodeWithText("Hoek kiezen").assertDoesNotExist()
            compose.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch)).assertCountEquals(0)
            assertNull(fixture.model.state.value.error)
            screenshot("recast-supported-options")
        } finally { fixture.close() }
    }

    @Test fun recastKeepsSixToFifteenSecondsAndSourceAudioEvenAfterStaleInputs() {
        val fixture = ownerRecastFixture()
        try {
            fixture.onMain {
                fixture.model.timing(0, 30)
                fixture.model.keepSound(false)
                fixture.model.quality("human-recast")
            }
            assertEquals(15, fixture.model.state.value.duration)
            assertTrue(fixture.model.state.value.keepSound)
            fixture.onMain { fixture.model.timing(0, 3); fixture.model.keepSound(false) }
            assertEquals(6, fixture.model.state.value.duration)
            assertTrue(fixture.model.state.value.keepSound)
            fixture.onMain { fixture.model.timing(0, 30) }
            assertEquals(15, fixture.model.state.value.duration)
            assertEquals("human-recast", fixture.model.state.value.quality)
            assertNull(fixture.model.state.value.error)
        } finally { fixture.close() }
    }

    private fun ownerRecastFixture(): NativeViewModelFixture {
        val now = System.currentTimeMillis()
        return NativeViewModelFixture(funding = "owner-provider", qualities = listOf("pro", "human-recast")) { request ->
            check(request.method == "GET" && request.url.encodedPath == "/api/native/provider-balance") {
                "Unexpected request: ${request.method} ${request.url.encodedPath}"
            }
            200 to JSONObject().put("availableUsdMicros", 12_340_000).put("currency", "USD")
                .put("fetchedAt", now).put("expiresAt", now + 30_000)
        }
    }

    private fun screenshot(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        compose.waitUntil(10_000) { instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == "dev.andyarijs.rig" }
        val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: error("The native screenshot is unavailable")
        try {
            File(instrumentation.targetContext.cacheDir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        } finally { bitmap.recycle() }
    }
}
