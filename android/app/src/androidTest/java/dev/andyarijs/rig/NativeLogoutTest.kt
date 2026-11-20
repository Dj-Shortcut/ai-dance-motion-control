package dev.andyarijs.rig

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.andyarijs.rig.data.PendingGeneration
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeLogoutTest {
    @Test fun failedRemoteLogoutClearsAccountHistoryAndPlayableResultButPreservesPendingWork() {
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        NativeViewModelFixture(download = { request ->
            if (request.url.encodedPath == "/api/native/generations/job-1/video") {
                assets.open("native-media-fixture.mp4").use { it.readBytes() }
            } else null
        }) { request ->
            when (request.url.encodedPath) {
                "/api/native/generations/recent" -> 200 to JSONObject().put("id", "job-1").put("state", "completed")
                    .put("videoPath", "/api/generations/job-1/video")
                "/api/native/generations/job-1/draft" -> 200 to JSONObject().put("available", true)
                "/api/native/auth/logout" -> 503 to JSONObject().put("error", "Afmelden bij de server is tijdelijk niet beschikbaar.")
                else -> error("Onverwacht verzoek: ${request.url.encodedPath}")
            }
        }.use { f ->
            f.onMain { f.model.history(true) }
            val job = f.awaitState { it.history.isNotEmpty() && !it.busy }.history.single()
            f.onMain { f.model.open(job) }
            val result = f.awaitState { it.result != null && it.fullAvailable }
            assertTrue(result.result!!.length() > 0)
            f.store.savePending(PendingGeneration(f.user, "quote-2", "intent-2"))
            for (key in listOf("draft-${f.user}", "draft-login", "draft-anonymous")) f.store.write(key, JSONObject())

            f.onMain { f.model.logout() }
            val state = f.awaitState { it.error != null && !it.busy }
            assertEquals(RigScreenState(), state.copy(error = null))
            assertNull(f.store.session())
            for (key in listOf("draft-${f.user}", "draft-login", "draft-anonymous")) assertNull(f.store.read(key))
            assertEquals("intent-2", f.store.pending(f.user)?.idempotencyKey)
        }
    }
}
