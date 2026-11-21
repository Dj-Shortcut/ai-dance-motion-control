package dev.andyarijs.rig

import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.andyarijs.rig.media.NormalizedCrop
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class DancePhotoAdviceUiTest {
    @get:Rule val compose = createComposeRule()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test fun photoWithoutAPersonShowsAdviceAndStillAllowsPlacement() {
        val cache = instrumentation.targetContext.cacheDir
        val photo = File.createTempFile("empty-scene", ".png", cache)
        val motion = File.createTempFile("dance-motion", ".mp4", cache)
        try {
            val bitmap = Bitmap.createBitmap(480, 640, Bitmap.Config.ARGB_8888)
            try {
                bitmap.eraseColor(android.graphics.Color.GRAY)
                photo.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
            } finally { bitmap.recycle() }
            instrumentation.context.assets.open("native-media-fixture.mp4").use { input ->
                motion.outputStream().use { output -> input.copyTo(output) }
            }
            withAnonymousSelection(photo) { fixture ->
                awaitVisibleAdvice("Geen duidelijke lichaamshouding herkend")
                fixture.onMain { fixture.model.select(Uri.fromFile(motion), "motion") }
                fixture.awaitState { it.motion != null && !it.busy }
                compose.onNodeWithText("Verder").assertIsEnabled().performClick()
                compose.onNodeWithText("Waar gebeurt het?").assertIsDisplayed()
            }
        } finally {
            photo.delete()
            motion.delete()
        }
    }

    // Uses MediaPipe's public pose.jpg if supplied to this device. No test downloads media.
    @Test fun fullBodyPhotoAndItsUpperBodyCropGiveDifferentAdvice() {
        val path = InstrumentationRegistry.getArguments().getString("rigPosePhotoPath")
        assumeNotNull(path)
        val photo = File(requireNotNull(path))
        assertTrue("The supplied pose fixture must be readable", photo.canRead())
        withAnonymousSelection(photo) { fixture ->
            awaitVisibleAdvice("Dit beeld lijkt geschikt voor een dansvideo")
            fixture.onMain { fixture.model.crop(true, NormalizedCrop(0.14f, 0.18f, 0.86f, 0.63f)) }
            awaitVisibleAdvice("De houding is niet goed te zien")
        }
    }

    private fun withAnonymousSelection(photo: File, check: (NativeViewModelFixture) -> Unit) {
        NativeViewModelFixture(signedIn = false) { error("Unexpected server request during photo selection") }.use { fixture ->
            compose.setContent {
                RigApp(fixture.model, onLogin = {}, onConfirm = {}, onRegister = {}, onPurchase = {})
            }
            compose.onNodeWithText("Maak een video").performClick()
            fixture.onMain { fixture.model.select(Uri.fromFile(photo), "subject") }
            check(fixture)
        }
    }

    private fun awaitVisibleAdvice(text: String) {
        compose.waitUntil(45_000) {
            compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(text, substring = true).performScrollTo().assertIsDisplayed()
    }
}
