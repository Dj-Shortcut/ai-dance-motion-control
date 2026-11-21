package dev.andyarijs.rig

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.andyarijs.rig.media.DancePhotoAssessment
import dev.andyarijs.rig.media.NormalizedCrop
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class DancePhotoLifecycleTest {
    private data class PendingCheck(val frame: Long, val crop: NormalizedCrop, val reply: CompletableDeferred<DancePhotoAssessment>)

    @Test fun lateVideoFrameResultCannotReplaceEditedOrRestoredSelection() = runBlocking {
        val checks = Channel<PendingCheck>(Channel.UNLIMITED)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val video = File.createTempFile("dance-frame", ".mp4", instrumentation.targetContext.cacheDir)
        try {
            instrumentation.context.assets.open("native-media-fixture.mp4").use { input ->
                video.outputStream().use { input.copyTo(it) }
            }
            val check: AssessDancePhoto = { _, frame, crop ->
                val reply = CompletableDeferred<DancePhotoAssessment>()
                checks.send(PendingCheck(frame, crop, reply))
                // An already-started native detector can finish after the user chooses a new frame.
                withContext(NonCancellable) { withTimeout(10_000) { reply.await() } }
            }
            NativeViewModelFixture(signedIn = false, assessPhoto = check) { error("A local photo check made a network request") }.use { fixture ->
                withTimeout(30_000) {
                    fixture.onMain { fixture.model.select(Uri.fromFile(video), "subject") }
                    fixture.awaitState { it.subject != null && !it.busy }
                    val original = checks.receive()
                    assertEquals(0L, original.frame)
                    val crop = NormalizedCrop(0.1f, 0.15f, 0.9f, 0.85f)
                    val end = requireNotNull(fixture.model.state.value.subject).durationMs
                    fixture.onMain { fixture.model.frame(end); fixture.model.crop(true, crop) }
                    original.reply.complete(DancePhotoAssessment.FULL_BODY)
                    val edited = checks.receive()
                    assertEquals(end - 1, edited.frame)
                    assertEquals(crop, edited.crop)
                    assertNull(fixture.model.dancePhotoCheck.value)
                    edited.reply.complete(DancePhotoAssessment.PARTIAL_BODY)
                    val result = fixture.model.dancePhotoCheck.first { it != null }
                    assertEquals(DancePhotoAssessment.PARTIAL_BODY, result?.assessment)
                    assertEquals(fixture.model.state.value.dancePhotoSelection(), result?.selection)

                    fixture.recreate()
                    val restored = checks.receive()
                    assertEquals(edited.frame, restored.frame)
                    assertEquals(edited.crop, restored.crop)
                    assertNull(fixture.model.dancePhotoCheck.value)
                    restored.reply.complete(DancePhotoAssessment.PARTIAL_BODY)
                    assertEquals(DancePhotoAssessment.PARTIAL_BODY, fixture.model.dancePhotoCheck.first { it != null }?.assessment)
                }
            }
        } finally {
            video.delete()
        }
    }
}
