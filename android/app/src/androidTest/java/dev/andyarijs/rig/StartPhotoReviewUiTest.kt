package dev.andyarijs.rig

import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.andyarijs.rig.media.NativeMediaKind
import dev.andyarijs.rig.media.NativeMediaSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File

@RunWith(AndroidJUnit4::class)
class StartPhotoReviewUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun renderedPhotoRequiresAnExplicitChoiceAndClosingDoesNotSelectIt() {
        val bitmap = Bitmap.createBitmap(360, 480, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(Color.BLUE)
        val jpeg = ByteArrayOutputStream().use { output ->
            try { check(bitmap.compress(Bitmap.CompressFormat.JPEG, 90, output)); output.toByteArray() }
            finally { bitmap.recycle() }
        }
        NativeViewModelFixture(startPhoto = jpeg) { request ->
            throw AssertionError("Unexpected request: ${request.method} ${request.url.encodedPath}")
        }.use { fixture ->
            fixture.onMain { fixture.model.step(1) }
            fixture.awaitState { it.startPhotoAvailable && it.step == 1 }
            compose.setContent { RigApp(fixture.model, {}, {}, {}, {}) }

            makeCharacter()
            assertNull(fixture.model.state.value.subject)
            compose.onNodeWithText("Sluiten").performClick()
            fixture.awaitState { it.startPhotoPreview == null }
            assertNull(fixture.model.state.value.subject)

            makeCharacter()
            val preview = fixture.awaitState { !it.busy && it.startPhotoPreview != null }.startPhotoPreview?.uri
            compose.onNodeWithText("Gebruik deze foto").performClick()
            val selected = fixture.awaitState { it.subject != null }
            assertEquals(preview, selected.subject?.uri)
            assertEquals(1, selected.step)
            assertNull(selected.quote)
        }
    }

    @Test fun anUnreadableImageCannotBeAccepted() {
        val missing = File(compose.activity.cacheDir, "nonexistent-start-photo.jpg")
        val photo = NativeMediaSource(Uri.fromFile(missing), NativeMediaKind.IMAGE, missing.name, "image/jpeg", null, 360, 480)
        compose.setContent {
            StartPhotoReviewDialog(photo, false, {}, { throw AssertionError("The unreadable image was accepted") }, {})
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Het voorbeeld kon niet worden geopend.", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Gebruik deze foto").assertIsNotEnabled()
        compose.onNodeWithText("Sluiten").assertIsDisplayed()
    }

    private fun makeCharacter() {
        compose.onNodeWithText("Maak een typetje").performClick()
        compose.onNodeWithTag("rig-start-photo-description").performTextInput("DJ op een plein")
        compose.onNodeWithText("Maak foto").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithContentDescription("Voorbeeld van je startfoto").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("Voorbeeld van je startfoto").assertIsDisplayed()
    }
}
