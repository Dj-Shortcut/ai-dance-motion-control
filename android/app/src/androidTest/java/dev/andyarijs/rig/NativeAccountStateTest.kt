package dev.andyarijs.rig

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.andyarijs.rig.data.PendingGeneration
import dev.andyarijs.rig.data.RigLoginManager
import dev.andyarijs.rig.data.RigStorageUnavailable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(AndroidJUnit4::class)
class NativeAccountStateTest {
    @Test fun expiredAccountDoesNotOverwriteTheNextAccountsDraft() {
        val nextUser = "u-12345678-1234-4123-8123-123456789abd"
        NativeViewModelFixture { request ->
            when (request.url.encodedPath) {
                "/api/native/generations/recent" -> 401 to JSONObject().put("error", "Meld je opnieuw aan.")
                "/api/native/auth/exchange" -> 200 to JSONObject().put("accessToken", "rig_native_" + "n".repeat(43))
                    .put("tokenType", "Bearer").put("userId", nextUser).put("expiresAt", System.currentTimeMillis() + 86_400_000)
                    .put("currency", "EUR").put("mode", "live")
                else -> error("Onverwacht pad: ${request.url.encodedPath}")
            }
        }.use { f ->
            f.store.write("draft-$nextUser", JSONObject().put("prompt", "Tweede account").put("expiresAt", System.currentTimeMillis() + 600_000))
            f.onMain { f.model.prompt("Eerste account"); f.model.history(true) }
            val expired = f.awaitState { it.session == null && it.error != null && !it.busy }
            assertEquals("", expired.prompt)
            f.onMain { f.model.beginLogin() }
            assertNull(f.store.read("draft-login"))
            val loginState = f.store.read("login")!!.getString("state")
            val callback = Uri.parse("${RigLoginManager.CALLBACK}?code=${"c".repeat(43)}&state=$loginState")
            runBlocking(Dispatchers.Main) { f.model.completeLogin(callback) }
            assertEquals(nextUser, f.model.state.value.session?.userId)
            assertEquals("Tweede account", f.model.state.value.prompt)
            assertEquals("Eerste account", f.store.read("draft-${f.user}")?.getString("prompt"))
        }
    }

    @Test fun backgroundErrorKeepsForegroundWorkBusyUntilItFinishes() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        NativeViewModelFixture {
            entered.countDown()
            check(release.await(20, TimeUnit.SECONDS))
            200 to JSONObject()
        }.use { f ->
            try {
                f.onMain { f.model.history(true) }
                assertTrue(entered.await(10, TimeUnit.SECONDS))
                f.onMain { f.model.showError(IOException("Achtergrondcontrole onderbroken.")); f.model.prompt("Verkeerde bewerking") }
                val state = f.model.state.value
                assertTrue(state.busy)
                assertEquals("Video’s ophalen", state.stage)
                assertEquals("", state.prompt)
            } finally { release.countDown() }
            f.awaitState { !it.busy }
        }
    }

    @Test fun unavailableSecureRecordKeepsPendingAndCanReconcileAfterRecovery() {
        val unavailable = AtomicBoolean(false)
        NativeViewModelFixture(beforeRead = { name ->
            if (unavailable.get() && name.startsWith("generation-")) throw RigStorageUnavailable(IOException("Fixture"))
        }) { request ->
            check(request.url.encodedPath == "/api/native/generation-intents/intent-1/reconcile")
            200 to JSONObject().put("id", "job-1").put("state", "queued")
        }.use { f ->
            f.store.savePending(PendingGeneration(f.user, "quote-1", "intent-1"))
            f.onMain { f.model.showError(IOException("Controleer de aanvraag.")) }
            assertTrue(f.model.state.value.pendingSubmission)
            unavailable.set(true)
            f.onMain { f.model.checkSubmission() }
            val failed = f.awaitState { !it.busy && it.error?.contains("beveiligde gegevens") == true }
            assertTrue(failed.pendingSubmission)
            unavailable.set(false)
            assertEquals("intent-1", f.store.pending(f.user)?.idempotencyKey)
            f.onMain { f.model.checkSubmission() }
            f.awaitState { it.job?.id == "job-1" && !it.pendingSubmission }
        }
    }

    @Test fun accountDraftCanBeRestoredAfterAReadFailure() {
        val unavailable = AtomicBoolean(true)
        NativeViewModelFixture(setupStore = { store ->
            val user = requireNotNull(store.session()).userId
            store.write("draft-$user", JSONObject().put("prompt", "Mijn bewaarde selectie")
                .put("expiresAt", System.currentTimeMillis() + 60_000))
        }, beforeRead = { name ->
            if (name.startsWith("draft-u-") && unavailable.get()) throw RigStorageUnavailable(IOException("Fixture"))
        }) { request -> error("Onverwacht pad: ${request.url.encodedPath}") }.use { f ->
            assertTrue(f.model.state.value.error?.contains("beveiligde gegevens") == true)
            unavailable.set(false)
            f.onMain { f.model.resume() }
            f.awaitState { it.prompt == "Mijn bewaarde selectie" }
        }
    }
}
