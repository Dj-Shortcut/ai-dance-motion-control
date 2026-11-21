package dev.andyarijs.rig

import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.andyarijs.rig.media.NativeMediaKind
import dev.andyarijs.rig.media.NativeMediaSource
import org.junit.Assert.assertTrue
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

    @Test fun cropPromptShowsLocalEditorAndScreenOneDisplaysTheSelectedPixels() {
        val requests = java.util.concurrent.atomic.AtomicInteger()
        NativeViewModelFixture(startPhoto = byteArrayOf(), download = { request ->
            if (request.url.encodedPath == "/api/native/start-photo" && request.method == "POST") requests.incrementAndGet()
            null
        }) { request -> throw AssertionError("Unexpected request: ${request.method} ${request.url.encodedPath}") }.use { fixture ->
            withSelectedPhoto(fixture) {
                compose.onNodeWithText("Bewerk mijn foto").performScrollTo().performClick()
                compose.onNodeWithTag("rig-start-photo-description").performTextInput("bijsnijden")
                compose.onNodeWithText("Kies de uitsnede").performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("rig-crop-canvas").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("rig-crop-canvas").performTouchInput {
                    swipe(Offset(5f, 5f), Offset(width * .60f, height * .12f), 450)
                }
                compose.onNodeWithText("Gebruik uitsnede").performClick()
                fixture.awaitState { it.subjectCrop.left > .45f }
                compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription("Gekozen uitsnede").fetchSemanticsNodes().isNotEmpty() }
                val preview = compose.onNodeWithContentDescription("Gekozen uitsnede").performScrollTo().captureToImage()
                val center = preview.toPixelMap()[preview.width / 2, preview.height / 2]
                assertTrue("The preview should show the blue portion actually selected", center.blue > .8f && center.red < .2f)
                assertEquals(0, requests.get())
            }
        }
    }

    @Test fun cropButtonWorksWithoutSponsoredPhotosAndCancelKeepsTheSelection() {
        NativeViewModelFixture(signedIn = false) { request ->
            throw AssertionError("Unexpected request: ${request.method} ${request.url.encodedPath}")
        }.use { fixture ->
            withSelectedPhoto(fixture) {
                compose.onNodeWithText("Bewerk mijn foto").assertDoesNotExist()
                compose.onNodeWithText("Foto bijsnijden").performScrollTo().performClick()
                compose.waitUntil(10_000) { compose.onAllNodesWithTag("rig-crop-canvas").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("Annuleren").performClick()
                assertEquals(dev.andyarijs.rig.media.NormalizedCrop.FULL, fixture.model.state.value.subjectCrop)
                compose.onNodeWithContentDescription("Gekozen beeld").performScrollTo().assertIsDisplayed()
            }
        }
    }

    private fun withSelectedPhoto(fixture: NativeViewModelFixture, verify: () -> Unit) {
        val file = File.createTempFile("crop-fixture-", ".jpg", compose.activity.cacheDir)
        try {
            val photo = Bitmap.createBitmap(600, 400, Bitmap.Config.ARGB_8888)
            try {
                photo.eraseColor(Color.RED)
                val canvas = android.graphics.Canvas(photo)
                canvas.drawRect(390f, 0f, 600f, 400f, android.graphics.Paint().apply { color = Color.BLUE })
                file.outputStream().use { check(photo.compress(Bitmap.CompressFormat.JPEG, 92, it)) }
            } finally { photo.recycle() }
            fixture.onMain { fixture.model.step(1); fixture.model.select(Uri.fromFile(file), "subject") }
            fixture.awaitState { it.subject?.uri == Uri.fromFile(file) && !it.busy }
            compose.setContent { RigApp(fixture.model, {}, {}, {}, {}) }
            verify()
        } finally { file.delete() }
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
