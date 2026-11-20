package dev.andyarijs.rig.data

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class NativeRecoveryTest {
    private val user = "u-12345678-1234-4123-8123-123456789abc"
    private lateinit var server: MockWebServer
    private lateinit var directory: File
    private lateinit var store: TestStore
    private lateinit var api: RigApi

    @Before fun setup() {
        server = MockWebServer().apply { start() }
        directory = Files.createTempDirectory("rig-native-test").toFile()
        store = TestStore().apply { saveSession(NativeAuthSession("rig_native_" + "s".repeat(43), System.currentTimeMillis() + 86_400_000, user)) }
        val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .addInterceptor { chain ->
                val original = chain.request()
                // Production constructs the fixed HTTPS RIG URL; only this
                // injected test transport redirects to a local mock server.
                val local = server.url(original.url.encodedPath + (original.url.encodedQuery?.let { "?$it" } ?: ""))
                chain.proceed(original.newBuilder().url(local).build())
            }.build()
        api = RigApi(store, client)
    }

    @After fun cleanup() { server.shutdown(); directory.deleteRecursively() }
    private fun repository() = RigRepository(directory, directory, store, api)
    private fun response(value: JSONObject, status: Int = 200) = MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(value.toString())
    private fun quote() = RigQuote.fromJson(JSONObject().put("id", "quote-1").put("priceCents", 100).put("currency", "EUR")
        .put("durationSeconds", 6).put("billedSeconds", 6).put("quality", "pro").put("approvalToken", "a".repeat(43)).put("idempotencyKey", "intent-1"),
        RigQuoteRequest("image-1", "video-1", "pro", "Neem de beweging over."))

    @Test fun acceptedButLostResponseSurvivesProcessRestartWithoutAnotherGeneration() = runBlocking {
        server.enqueue(response(JSONObject().put("error", "Status is tijdelijk niet beschikbaar."), 503))
        val first = repository()
        val failure = runCatching { first.submit(quote(), JSONObject().put("challengeId", "proof")) }.exceptionOrNull()
        assertTrue(failure is RigApiException)
        assertEquals("intent-1", store.pending(user)?.idempotencyKey)
        val sent = server.takeRequest()
        assertEquals("/api/native/generations", sent.path)
        assertEquals("intent-1", JSONObject(sent.body.readUtf8()).getString("idempotencyKey"))
        assertEquals("Bearer rig_native_" + "s".repeat(43), sent.getHeader("Authorization"))

        server.enqueue(response(JSONObject().put("id", "job-1").put("state", "queued")))
        val restarted = repository()
        assertEquals("job-1", restarted.recoverPending()?.id)
        val recovered = server.takeRequest()
        assertEquals("/api/native/generation-intents/intent-1/reconcile", recovered.path)
        assertEquals("quote-1", JSONObject(recovered.body.readUtf8()).getString("quoteId"))
        assertEquals("job-1", store.pending(user)?.jobId)
        assertEquals(2, server.requestCount)
    }

    @Test fun uncertainSubmissionBlocksRepeatedConfirmEvenAfterNewRepository() = runBlocking {
        server.enqueue(response(JSONObject().put("error", "Tijdelijk niet beschikbaar."), 503))
        runCatching { repository().submit(quote(), JSONObject()) }
        val duplicate = runCatching { repository().submit(quote(), JSONObject()) }.exceptionOrNull()
        assertTrue(duplicate is IllegalStateException)
        assertEquals(1, server.requestCount)
    }

    @Test fun completedRecoveryClearsOnlyTheCurrentAccountsPendingMarker() = runBlocking {
        store.savePending(PendingGeneration(user, "quote-1", "intent-1", "job-1"))
        val other = "u-12345678-1234-4123-8123-123456789abd"
        store.savePending(PendingGeneration(other, "quote-2", "intent-2", "job-2"))
        server.enqueue(response(JSONObject().put("id", "job-1").put("state", "completed").put("videoPath", "/api/generations/job-1/video")))
        assertTrue(repository().recoverPending()!!.completed)
        assertNull(store.pending(user))
        assertNotNull(store.pending(other))
        assertEquals("/api/native/generations/job-1", server.takeRequest().path)
    }

    @Test fun temporaryFailureKeepsSessionWhile401KeepsOnlyDurableRecovery() = runBlocking {
        store.savePending(PendingGeneration(user, "quote-1", "intent-1"))
        server.enqueue(response(JSONObject().put("error", "Later opnieuw proberen."), 503))
        runCatching { api.get("/session") }
        assertNotNull(store.session())
        server.enqueue(response(JSONObject().put("error", "Meld opnieuw aan."), 401))
        runCatching { api.get("/session") }
        assertNull(store.session())
        assertNotNull(store.pending(user))
    }

    @Test fun redirectNeverForwardsBearerToAnotherEndpoint() = runBlocking {
        server.enqueue(response(JSONObject(), 302).setHeader("Location", "https://attacker.invalid/steal"))
        val failure = runCatching { api.get("/session") }.exceptionOrNull()
        assertTrue(failure is RigApiException && failure.status == 302)
        assertEquals(1, server.requestCount)
        assertNotNull(store.session())
    }

    @Test fun uploadHashesOnlyTheExactPreparedBytes() = runBlocking {
        val bytes = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 10, 20, 30, 0xff.toByte(), 0xd9.toByte())
        val prepared = File(directory, "prepared.jpg").apply { writeBytes(bytes) }
        server.enqueue(response(JSONObject().put("id", "asset-1").put("kind", "image").put("status", "ready")))
        assertEquals("asset-1", repository().upload("image", prepared))
        val request = server.takeRequest()
        assertArrayEquals(bytes, request.body.readByteArray())
        assertEquals(bytes.size.toString(), request.getHeader("Content-Length"))
        val expected = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
        assertEquals(expected, request.getHeader("X-Rig-Native-Body-Sha256"))
        assertEquals("image/jpeg", request.getHeader("Content-Type"))
    }

    @Test fun pkceVerifierAndStateSurviveRestartAndCallbackIsOneUse() = runBlocking {
        val manager = RigLoginManager(store, api)
        val target = manager.beginAuthorization()
        val pending = store.read("login")!!
        // A slower first ChatGPT sign-in is valid: the server issues its
        // short-lived code only after that browser interaction has completed.
        store.write("login", JSONObject(pending.toString()).put("createdAt", System.currentTimeMillis() - 6 * 60_000L))
        assertTrue(target.contains("challenge=" + RigLoginManager.challenge(pending.getString("verifier"))))
        val state = pending.getString("state")
        val callback = "dev.andyarijs.rig://auth/callback?code=${"c".repeat(43)}&state=$state"
        val wrong = callback.replace("state=$state", "state=${"w".repeat(43)}")
        assertTrue(runCatching { RigLoginManager(store, api).completeCallbackString(wrong) }.isFailure)
        assertEquals(0, server.requestCount)
        server.enqueue(response(JSONObject().put("accessToken", "rig_native_" + "n".repeat(43)).put("tokenType", "Bearer").put("userId", user)
            .put("expiresAt", System.currentTimeMillis() + 86_400_000).put("currency", "EUR").put("mode", "live")))
        val completed = RigLoginManager(store, api).completeCallbackString(callback)
        assertEquals("rig_native_" + "n".repeat(43), completed.accessToken)
        val exchange = server.takeRequest()
        assertEquals("/api/native/auth/exchange", exchange.path)
        assertNull(exchange.getHeader("Authorization"))
        assertEquals(pending.getString("verifier"), JSONObject(exchange.body.readUtf8()).getString("codeVerifier"))
        assertNull(store.read("login"))
        assertTrue(runCatching { RigLoginManager(store, api).completeCallbackString(callback) }.isFailure)
        assertEquals(1, server.requestCount)
    }

    @Test fun callbackRejectsInjectedHostsFragmentsDuplicateAndEncodedFields() {
        val code = "c".repeat(43)
        val state = "s".repeat(43)
        assertNotNull(RigLoginManager.parseCallback("dev.andyarijs.rig://auth/callback?code=$code&state=$state"))
        for (bad in listOf("https://auth/callback?code=$code&state=$state", "dev.andyarijs.rig://evil/callback?code=$code&state=$state",
            "dev.andyarijs.rig://auth/callback?code=$code&code=$code", "dev.andyarijs.rig://auth/callback?code=$code&state=$state#token",
            "dev.andyarijs.rig://auth/callback?%63ode=$code&state=$state")) assertNull(RigLoginManager.parseCallback(bad))
    }

    @Test fun sessionAcceptsOnlyTheDedicatedNativeTokenRealmAndDropsExpiredTokens() {
        assertNotNull(store.session())
        assertThrows(IllegalArgumentException::class.java) {
            store.saveSession(NativeAuthSession("s".repeat(43), System.currentTimeMillis() + 86_400_000, user))
        }
        val expired = store.read("session")!!.put("expiresAt", System.currentTimeMillis() - 1)
        store.write("session", expired)
        store.savePending(PendingGeneration(user, "quote-1", "intent-1"))
        assertNull(store.session())
        assertNotNull(store.pending(user))
    }

    private class TestStore : RigStore {
        private val values = mutableMapOf<String, String>()
        override fun write(name: String, value: JSONObject?) { if (value == null) values.remove(name) else values[name] = value.toString() }
        override fun read(name: String): JSONObject? = values[name]?.let(::JSONObject)
    }
}
