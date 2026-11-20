package dev.andyarijs.rig.media

import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.lifecycle.ViewModelProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.andyarijs.rig.MainActivity
import dev.andyarijs.rig.RigViewModel
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Runs the actual Activity, native Compose screens, media decoding and crop gestures.
 * It deliberately stops before login/quotes; no fake login or paid generation. */
@RunWith(AndroidJUnit4::class)
class RigNativeUiTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun nativePhoneFlowRetainsFullSelectionAndPromptWithDraggableCrop() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val source = File(context.cacheDir, "ui-phone-video.mp4")
        InstrumentationRegistry.getInstrumentation().context.assets.open("native-media-fixture.mp4").use { input -> source.outputStream().use { input.copyTo(it) } }
        lateinit var model: RigViewModel
        compose.runOnUiThread { model = ViewModelProvider(compose.activity)[RigViewModel::class.java] }
        try {
            compose.onNodeWithText("Maak een video").assertIsDisplayed()
            screenshot("native-01-start")
            compose.onNodeWithText("Maak een video").performClick()
            compose.onNodeWithText("Kies je beeld.").assertIsDisplayed()
            // Selection uses the same real pipeline that the system picker invokes.
            compose.runOnUiThread { model.select(Uri.fromFile(source), "subject") }
            compose.waitUntil(30_000) { model.state.value.subject != null && !model.state.value.busy }
            compose.runOnUiThread { model.frame(4000); model.select(Uri.fromFile(source), "motion") }
            compose.waitUntil(30_000) { model.state.value.motion != null && !model.state.value.busy }
            assertNull(model.state.value.error)
            assertTrue(model.state.value.subject!!.durationMs > 8000)
            assertEquals(4000, model.state.value.frameMs)
            waitForNativePlayers()
            screenshot("native-02-selected-media")
            compose.onNodeWithText("Meer opties  +").performScrollTo().performClick()
            compose.onNodeWithText("Jouw beeld uitsnijden").performClick()
            compose.waitUntil(30_000) { compose.onAllNodesWithTag("rig-crop-canvas").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("rig-crop-canvas").performTouchInput {
                swipe(Offset(4f, 4f), Offset(width * .15f, height * .15f), 500)
            }
            screenshot("native-03-crop")
            compose.onNodeWithText("Gebruik uitsnede").performClick()
            compose.waitUntil { model.state.value.subjectCrop.left > 0f && model.state.value.subjectCrop.top > 0f }
            compose.onNodeWithText("Verder").performClick()
            compose.onNodeWithText("Waar gebeurt het?").assertIsDisplayed()
            compose.waitUntil(15_000) { compose.onAllNodesWithText("Beeld laden…").fetchSemanticsNodes().isEmpty() }
            screenshot("native-04-placement")
            compose.onNodeWithText("Verder").performClick()
            compose.onNodeWithText("Maak het van jou.").assertIsDisplayed()
            compose.onNode(hasSetTextAction()).performTextReplacement("Neem de dansbewegingen over, met dezelfde camera-afstand.")
            compose.onNodeWithText("Aanmelden en prijs bekijken").assertIsEnabled()
            assertTrue(model.state.value.prompt.startsWith("Neem de dansbewegingen"))
            assertEquals(source.name, model.state.value.motion!!.displayName)
            assertEquals(4000, model.state.value.frameMs)
            screenshot("native-05-prompt")
            // A native activity recreation must not discard an in-memory draft.
            compose.activityRule.scenario.recreate()
            compose.waitForIdle()
            compose.onNodeWithText("Maak het van jou.").assertIsDisplayed()
            compose.onNodeWithText("Aanmelden en prijs bekijken").assertIsEnabled()
        } finally { source.delete() }
    }

    private fun screenshot(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        compose.waitUntil(10_000) { instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == "dev.andyarijs.rig" }
        assertEquals("A system overlay must not hide the native app during visual QA.", "dev.andyarijs.rig", instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString())
        val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: return
        val file = File(instrumentation.targetContext.cacheDir, "$name.png")
        try { file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) } }
        finally { bitmap.recycle() }
    }

    private fun waitForNativePlayers() {
        compose.waitUntil(30_000) {
            var ready = false
            compose.runOnUiThread {
                val players = mutableListOf<androidx.media3.ui.PlayerView>()
                fun visit(view: android.view.View) {
                    if (view is androidx.media3.ui.PlayerView) players += view
                    if (view is android.view.ViewGroup) for (i in 0 until view.childCount) visit(view.getChildAt(i))
                }
                visit(compose.activity.window.decorView)
                ready = players.size >= 2 && players.all { it.player?.playbackState == androidx.media3.common.Player.STATE_READY }
            }
            ready
        }
    }
}
