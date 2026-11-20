package dev.andyarijs.rig

import android.graphics.Bitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.andyarijs.rig.data.RigJob
import dev.andyarijs.rig.data.RigQuoteRequest
import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class TrialContinuationTest {
    @Test fun promptEditsAndRestartRequoteTheOwnedFullClip() {
        fun id() = UUID.randomUUID().toString()
        val job = RigJob.fromJson(JSONObject().put("id", id()).put("state", "completed"))
        val draftId = id()
        val selection = RigQuoteRequest(id(), id(), "pro", "De originele tekst.", faceId = id(), angleIds = listOf(id()))
        val assetPath = "/video-drafts/$draftId/assets/"
        val video = InstrumentationRegistry.getInstrumentation().context.assets.open("native-media-fixture.mp4").use { it.readBytes() }
        val bitmap = Bitmap.createBitmap(360, 360, Bitmap.Config.ARGB_8888)
        val image = ByteArrayOutputStream().use { output ->
            check(bitmap.compress(Bitmap.CompressFormat.JPEG, 90, output))
            output.toByteArray()
        }
        bitmap.recycle()
        val downloads = CopyOnWriteArrayList<String>()
        val requests = CopyOnWriteArrayList<JSONObject>()
        val draftReads = AtomicInteger()
        val fixture = NativeViewModelFixture(download = { request ->
            val path = request.url.encodedPath.removePrefix("/api/native")
            when (path) {
                "/generations/${job.id}/video", assetPath + selection.videoId -> video
                assetPath + selection.imageId, assetPath + selection.faceId, assetPath + selection.angleIds.single() -> image
                else -> null
            }?.also { downloads.add(path) }
        }) { request ->
            when (request.url.encodedPath.substringAfter("/api/native")) {
                "/generations/${job.id}/draft" -> if (draftReads.incrementAndGet() == 1) 503 to JSONObject()
                    else 200 to JSONObject().put("available", true)
                    .put("selectedSeconds", 9).put("request", selection.toJson())
                    .put("assets", JSONObject().put("video", JSONObject().put("path", "/api" + assetPath + selection.videoId)))
                "/generation-quotes" -> {
                    val body = Buffer().also { requireNotNull(request.body).writeTo(it) }
                    requests.add(JSONObject(body.readUtf8()))
                    200 to JSONObject().put("id", "quote-" + requests.size).put("priceCents", 210)
                        .put("currency", "EUR").put("approvalToken", "a".repeat(43))
                        .put("idempotencyKey", "intent-" + requests.size).put("quality", "pro")
                        .put("durationSeconds", 8.96).put("billedSeconds", 9)
                }
                "/security" -> 200 to JSONObject().put("configured", true)
                else -> error("Unexpected request " + request.url.encodedPath)
            }
        }
        try {
            fixture.onMain { fixture.model.open(job) }
            val failedLookup = fixture.awaitState { it.draftLookupFailed }
            val playable = requireNotNull(failedLookup.result)
            assertTrue(playable.isFile)
            fixture.onMain { fixture.model.retryDraftLookup() }
            val recovered = fixture.awaitState { it.fullAvailable && !it.busy }
            assertFalse(recovered.draftLookupFailed)
            assertEquals(playable, recovered.result)
            assertEquals(listOf("/generations/${job.id}/video"), downloads)
            assertTrue(requests.isEmpty())
            fixture.onMain { fixture.model.continueFull() }
            val opened = fixture.awaitState { it.step == 3 && !it.busy }
            assertEquals(9, opened.duration)
            assertTrue(requireNotNull(opened.motion).durationMs in 8900L..8999L)
            assertEquals(selection.prompt, opened.prompt)
            val draftKey = "draft-" + fixture.user
            val saved = requireNotNull(fixture.store.read(draftKey)).getJSONObject("fullRequest")
            assertEquals(selection, RigQuoteRequest.fromJson(saved))
            fixture.onMain {
                fixture.model.prompt("  Ander licht.  ")
                fixture.model.trial(false)
                fixture.model.prepareQuote()
            }
            fixture.awaitState { it.quote != null && !it.busy }
            fixture.recreate()
            assertEquals("  Ander licht.  ", fixture.model.state.value.prompt)
            assertNull(fixture.model.state.value.quote)
            fixture.onMain { fixture.model.prepareQuote() }
            fixture.awaitState { it.quote != null && !it.busy }
            assertEquals(2, requests.size)
            for (payload in requests) {
                assertEquals(selection.copy(prompt = "Ander licht."), RigQuoteRequest.fromJson(payload))
            }
            assertEquals(listOf("/generations/${job.id}/video", assetPath + selection.imageId, assetPath + selection.videoId,
                assetPath + selection.faceId, assetPath + selection.angleIds.single()), downloads)
            fixture.onMain { fixture.model.timing(0, 7) }
            val draft = requireNotNull(fixture.store.read(draftKey))
            assertFalse(draft.has("fullRequest"))
            assertNull(fixture.model.state.value.quote)
        } finally {
            fixture.close()
        }
    }
}
