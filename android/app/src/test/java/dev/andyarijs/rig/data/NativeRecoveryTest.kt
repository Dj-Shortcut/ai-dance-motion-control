package dev.andyarijs.rig.data

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import java.net.UnknownHostException

class NativeRecoveryTest {
    private val user = "u-12345678-1234-4123-8123-123456789abc"
    private lateinit var server: MockWebServer
    private lateinit var directory: File
    private lateinit var store: TestStore
    private lateinit var api: RigApi
    private lateinit var client: OkHttpClient

    @Before fun setup() {
        server = MockWebServer().apply { start() }
        directory = Files.createTempDirectory("rig-native-test").toFile()
        store = TestStore().apply { saveSession(NativeAuthSession("rig_native_" + "s".repeat(43), System.currentTimeMillis() + 86_400_000, user)) }
        client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
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

    @Test fun switchingAccountBetweenPreparedAssetsStopsTheRemainingRequests() = runBlocking {
        val session = requireNotNull(store.session())
        val prepared = File(directory, "prepared.jpg").apply { writeBytes(byteArrayOf(1, 2)) }
        server.enqueue(response(JSONObject().put("id", "first-image").put("kind", "image").put("status", "ready")))
        val repo = repository()
        assertEquals("first-image", repo.upload("image", prepared, session = session))
        assertEquals("Bearer " + session.accessToken, server.takeRequest().getHeader("Authorization"))
        val other = NativeAuthSession("rig_native_" + "o".repeat(43), session.expiresAt, "u-12345678-1234-4123-8123-123456789abd")
        store.saveSession(other)
        assertTrue(runCatching { repo.upload("face", prepared, session = session) }.exceptionOrNull() is RigSessionReplacedException)
        val selection = RigQuoteRequest("first-image", "video-1", prompt = "Neem de beweging over.")
        assertTrue(runCatching { repo.quote(selection, session) }.exceptionOrNull() is RigSessionReplacedException)
        assertTrue(runCatching { repo.saveDraft(JSONObject(), session) }.exceptionOrNull() is RigSessionReplacedException)
        assertEquals(1, server.requestCount)
    }

    @Test fun changedCredentialAfterHashingStopsUploadBeforeTransmission() = runBlocking {
        val session = requireNotNull(store.session())
        val replacement = session.copy(accessToken = "rig_native_" + "n".repeat(43))
        val changingClient = client.newBuilder().addInterceptor { chain ->
            store.saveSession(replacement)
            chain.proceed(chain.request())
        }.build()
        val prepared = File(directory, "prepared.jpg").apply { writeBytes(byteArrayOf(1, 2)) }
        val failure = runCatching { RigApi(store, changingClient).upload("image", prepared, session = session) }.exceptionOrNull()
        assertTrue(failure is RigSessionReplacedException)
        assertEquals(0, server.requestCount)
        assertEquals(replacement, store.session())
    }

    @Test fun overlappingDownloadsHaveIndependentTemporaryFiles() = runBlocking {
        val firstStarted = CountDownLatch(1)
        val secondStarted = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val releaseSecond = CountDownLatch(1)
        val count = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (count.incrementAndGet() == 1) {
                    firstStarted.countDown()
                    check(releaseFirst.await(10, TimeUnit.SECONDS))
                    return MockResponse().setResponseCode(503)
                }
                secondStarted.countDown()
                check(releaseSecond.await(10, TimeUnit.SECONDS))
                return MockResponse().setBody("complete video")
            }
        }
        val path = "/generations/job-1/video"
        val target = File(directory, "video.mp4")
        val first = async(Dispatchers.IO) { runCatching { api.download(path, target) } }
        try {
            check(firstStarted.await(5, TimeUnit.SECONDS))
            val second = async(Dispatchers.IO) { api.download(path, target) }
            check(secondStarted.await(5, TimeUnit.SECONDS))
            assertEquals(2, directory.listFiles().orEmpty().count { it.extension == "part" })
            releaseFirst.countDown()
            assertTrue(first.await().isFailure)
            assertEquals(1, directory.listFiles().orEmpty().count { it.extension == "part" })
            releaseSecond.countDown()
            assertEquals("complete video", second.await().readText())
            assertArrayEquals(arrayOf(target), directory.listFiles())
        } finally {
            releaseFirst.countDown()
            releaseSecond.countDown()
        }
    }

    @Test fun accountChangeWhileMediaIsInFlightDiscardsTheOldResult() = runBlocking {
        val initial = requireNotNull(store.session())
        val other = NativeAuthSession("rig_native_" + "o".repeat(43), initial.expiresAt, "u-12345678-1234-4123-8123-123456789abd")
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                store.saveSession(other)
                return if (request.path == "/api/native/assets") response(JSONObject().put("id", "asset-1").put("status", "ready"))
                    else MockResponse().setBody("video")
            }
        }
        val prepared = File(directory, "prepared.jpg").apply { writeBytes(byteArrayOf(1, 2)) }
        assertTrue(runCatching { repository().upload("image", prepared, session = initial) }.exceptionOrNull() is RigSessionReplacedException)
        assertEquals("Bearer " + initial.accessToken, server.takeRequest().getHeader("Authorization"))

        store.saveSession(initial)
        val target = File(directory, "result.mp4")
        assertTrue(runCatching { api.download("/generations/job-1/video", target, session = initial) }.exceptionOrNull() is RigSessionReplacedException)
        assertEquals("Bearer " + initial.accessToken, server.takeRequest().getHeader("Authorization"))
        assertFalse(target.exists())
        assertArrayEquals(arrayOf(prepared), directory.listFiles())
    }

    @Test fun pkceSurvivesRestartAndCompletedCallbackIsIdempotentWithoutAnotherExchange() = runBlocking {
        val manager = RigLoginManager(store, api)
        val target = manager.beginAuthorization()
        val pending = store.read("login")!!
        // A slower first ChatGPT sign-in is valid: the server issues its
        // short-lived code only after that browser interaction has completed.
        store.write("login", JSONObject(pending.toString()).put("createdAt", System.currentTimeMillis() - 6 * 60_000L))
        assertTrue(target.contains("challenge=" + RigLoginManager.challenge(pending.getString("verifier"))))
        val state = pending.getString("state")
        val callback = "${RigLoginManager.CALLBACK}?code=${"c".repeat(43)}&state=$state"
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
        assertEquals(completed, RigLoginManager(store, api).completeCallbackString(callback))
        assertEquals(1, server.requestCount)
        store.saveSession(NativeAuthSession("rig_native_" + "b".repeat(43), System.currentTimeMillis() + 86_400_000, user))
        assertTrue(runCatching { RigLoginManager(store, api).completeCallbackString(callback) }.isFailure)
        assertEquals(1, server.requestCount)
    }

    private fun beginCallback(manager: RigLoginManager): String {
        manager.beginAuthorization()
        return "${RigLoginManager.CALLBACK}?code=${"c".repeat(43)}&state=${store.read("login")!!.getString("state")}"
    }

    private fun successfulExchange() = response(JSONObject().put("accessToken", "rig_native_" + "n".repeat(43))
        .put("tokenType", "Bearer").put("userId", user).put("expiresAt", System.currentTimeMillis() + 86_400_000).put("currency", "EUR").put("mode", "live"))

    @Test fun delayed401FromAnOldCredentialCannotClearOrLogOutTheNewSession() = runBlocking {
        val seen = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse { seen.countDown(); check(release.await(5, TimeUnit.SECONDS)); return response(JSONObject().put("error", "Meld opnieuw aan."), 401) }
        }
        val oldRequest = async(Dispatchers.IO) { runCatching { api.get("/session") } }
        check(withContext(Dispatchers.IO) { seen.await(5, TimeUnit.SECONDS) })
        val fresh = NativeAuthSession("rig_native_" + "f".repeat(43), System.currentTimeMillis() + 86_400_000, user)
        store.saveSession(fresh)
        release.countDown()
        assertTrue(oldRequest.await().exceptionOrNull() is RigSessionReplacedException)
        assertEquals(fresh, store.session())
    }

    @Test fun unsentExchangePreservesPkceAndRetriesOnlyAfterAnExplicitCallback() = runBlocking {
        val attempts = AtomicInteger()
        val beforeHeaders = client.newBuilder().addInterceptor { chain ->
            if (attempts.getAndIncrement() == 0) throw UnknownHostException("offline fixture")
            chain.proceed(chain.request())
        }.build()
        val authApi = RigApi(store, beforeHeaders)
        val manager = RigLoginManager(store, authApi)
        val callback = beginCallback(manager)
        val verifier = store.read("login")!!.getString("verifier")
        val failure = runCatching { manager.completeCallbackString(callback) }.exceptionOrNull()
        assertTrue(failure is RigTransportException && failure.definitelyUnsubmitted)
        assertEquals("ready", store.read("login")!!.getString("phase"))
        assertEquals(verifier, store.read("login")!!.getString("verifier"))
        assertEquals(0, server.requestCount)
        assertEquals(1, attempts.get())
        server.enqueue(successfulExchange())
        RigLoginManager(store, authApi).completeCallbackString(callback)
        assertEquals(1, server.requestCount)
        assertEquals(2, attempts.get())
    }

    @Test fun service503RetainsPkceButNeverBlindlyRepostsTheOneUseCode() = runBlocking {
        val manager = RigLoginManager(store, api)
        val callback = beginCallback(manager)
        val verifier = store.read("login")!!.getString("verifier")
        server.enqueue(response(JSONObject().put("error", "Tijdelijk niet beschikbaar."), 503).setHeader("Retry-After", "0"))
        server.enqueue(successfulExchange())
        assertTrue(runCatching { manager.completeCallbackString(callback) }.exceptionOrNull() is RigApiException)
        assertEquals("uncertain", store.read("login")!!.getString("phase"))
        assertEquals(verifier, store.read("login")!!.getString("verifier"))
        assertTrue(runCatching { RigLoginManager(store, api).completeCallbackString(callback) }.isFailure)
        assertEquals(1, server.requestCount)
    }

    @Test fun cleanupFailureAfterCommitDoesNotFailOrRepeatTheSignIn() = runBlocking {
        val manager = RigLoginManager(store, api)
        val callback = beginCallback(manager)
        store.failLoginDeletion = true
        server.enqueue(successfulExchange())
        val session = manager.completeCallbackString(callback)
        assertEquals(session, store.session())
        assertNotNull(store.read("login"))
        assertEquals(session, RigLoginManager(store, api).completeCallbackString(callback))
        store.failLoginDeletion = false
        assertEquals(session, RigLoginManager(store, api).completeCallbackString(callback))
        assertNull(store.read("login"))
        assertEquals(1, server.requestCount)
    }

    @Test fun lostSuccessResponseCannotCauseAnotherExchangeAfterProcessRestart() = runBlocking {
        val callback = beginCallback(RigLoginManager(store, api))
        server.enqueue(successfulExchange().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        val failure = runCatching { RigLoginManager(store, api).completeCallbackString(callback) }.exceptionOrNull()
        assertTrue(failure is RigTransportException && !failure.definitelyUnsubmitted)
        assertEquals("uncertain", store.read("login")!!.getString("phase"))
        assertTrue(runCatching { RigLoginManager(store, api).completeCallbackString(callback) }.isFailure)
        assertEquals(1, server.requestCount)
        assertNull(store.read("login-completed"))
    }

    @Test fun aNewLoginTransactionCannotBeOverwrittenByAnOlderExchangeResponse() = runBlocking {
        store.clearSession()
        val seen = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse { seen.countDown(); check(release.await(5, TimeUnit.SECONDS)); return successfulExchange() }
        }
        val oldManager = RigLoginManager(store, api)
        val callback = beginCallback(oldManager)
        val oldExchange = async(Dispatchers.IO) { runCatching { oldManager.completeCallbackString(callback) } }
        check(withContext(Dispatchers.IO) { seen.await(5, TimeUnit.SECONDS) })
        RigLoginManager(store, api).beginAuthorization()
        val next = store.read("login")!!.getString("state")
        release.countDown()
        assertTrue(oldExchange.await().isFailure)
        assertNull(store.session())
        assertEquals(next, store.read("login")!!.getString("state"))
        assertEquals("ready", store.read("login")!!.getString("phase"))
    }

    @Test fun callbackRejectsInjectedHostsFragmentsDuplicateAndEncodedFields() {
        val code = "c".repeat(43)
        val state = "s".repeat(43)
        assertNotNull(RigLoginManager.parseCallback("${RigLoginManager.CALLBACK}?code=$code&state=$state"))
        for (bad in listOf("dev.andyarijs.rig://auth/callback?code=$code&state=$state", "https://attacker.invalid/native/callback?code=$code&state=$state",
            "https://rig-motion-studio.shortcutcomputerguy.chatgpt.site/evil/callback?code=$code&state=$state",
            "${RigLoginManager.CALLBACK}?code=$code&code=$code", "${RigLoginManager.CALLBACK}?code=$code&state=$state#token",
            "${RigLoginManager.CALLBACK}?%63ode=$code&state=$state")) assertNull(RigLoginManager.parseCallback(bad))
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

    private fun providerBalancePayload() = JSONObject().put("availableUsdMicros", 9_370_000).put("currency", "USD")
        .put("fetchedAt", System.currentTimeMillis()).put("expiresAt", System.currentTimeMillis() + 30_000)

    @Test fun providerBalanceUsesOnlyAnAuthenticatedGetAndNeverAWriteOrFallback() = runBlocking {
        server.enqueue(response(providerBalancePayload()))
        assertEquals(9_370_000L, repository().providerBalance().availableUsdMicros)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/native/provider-balance", request.path)
        assertEquals("Bearer rig_native_" + "s".repeat(43), request.getHeader("Authorization"))
        assertTrue(runCatching { api.post("/provider-balance") }.exceptionOrNull() is IllegalArgumentException)
        assertEquals(1, server.requestCount)
    }

    @Test fun providerBalanceDeniedOrUnavailableDoesNotInventZeroOrEndAValidSession() = runBlocking {
        for (status in listOf(403, 503)) {
            server.enqueue(response(JSONObject().put("error", "Het saldo is niet beschikbaar."), status))
            val error = runCatching { repository().providerBalance() }.exceptionOrNull()
            assertTrue(error is RigApiException && error.status == status)
            assertNotNull(store.session())
        }
        assertEquals(2, server.requestCount)
    }

    @Test fun aLateOwnerBalanceCannotLeakIntoAnotherSignedInAccount() = runBlocking {
        val seen = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse { seen.countDown(); check(release.await(5, TimeUnit.SECONDS)); return response(providerBalancePayload()) }
        }
        val oldRequest = async(Dispatchers.IO) { runCatching { repository().providerBalance() } }
        check(withContext(Dispatchers.IO) { seen.await(5, TimeUnit.SECONDS) })
        val otherUser = "u-12345678-1234-4123-8123-123456789abd"
        store.saveSession(NativeAuthSession("rig_native_" + "o".repeat(43), System.currentTimeMillis() + 86_400_000, otherUser))
        release.countDown()
        assertTrue(oldRequest.await().isFailure)
        assertEquals(otherUser, store.session()!!.userId)
    }

    @Test fun directRecastQuoteUsesTheConfiguredRouteWithoutAnO3FallbackOrGeneration() = runBlocking {
        server.enqueue(response(JSONObject().put("enabled", true).put("funding", "owner-provider")
            .put("qualities", org.json.JSONArray(listOf("pro", "human-recast")))))
        server.enqueue(response(JSONObject().put("id", "recast-quote-1").put("quality", "human-recast")
            .put("durationSeconds", 6).put("billedSeconds", 6).put("outputResolution", "1080P")
            .put("funding", "owner-provider").put("providerCurrency", "USD").put("providerEstimateUsdMicros", 2_700_000)
            .put("transferPolicy", "fal-temporary-links-v1").put("approvalToken", "a".repeat(43)).put("idempotencyKey", "intent-recast-1")))
        val request = RigQuoteRequest("portrait-1", "source-video-1", "human-recast", "Vervang de persoon door mij; behoud de beweging, camera en mondbeweging.", keepSound = true)
        val result = repository().quote(request)
        assertEquals("human-recast", result.raw.getString("quality"))
        assertEquals("1080P", result.raw.getString("outputResolution"))
        assertEquals("/api/native/video-config", server.takeRequest().path)
        val outgoing = server.takeRequest()
        assertEquals("POST", outgoing.method)
        assertEquals("/api/native/generation-quotes", outgoing.path)
        val body = JSONObject(outgoing.body.readUtf8())
        assertEquals("human-recast", body.getString("quality"))
        assertEquals("portrait-1", body.getString("imageId"))
        assertEquals("source-video-1", body.getString("videoId"))
        assertTrue(body.getBoolean("keepSound"))
        assertTrue(body.isNull("faceId"))
        assertEquals(0, body.getJSONArray("angleIds").length())
        assertFalse(body.has("cleanupMaskId"))
        assertFalse(body.has("workflowVersion"))
        assertEquals(2, server.requestCount)
    }

    private class TestStore : RigStore {
        private val values = mutableMapOf<String, String>()
        var failLoginDeletion = false
        override fun write(name: String, value: JSONObject?) {
            if (failLoginDeletion && name == "login" && value == null) throw IllegalStateException("Fixture storage error")
            if (value == null) values.remove(name) else values[name] = value.toString()
        }
        override fun read(name: String): JSONObject? = values[name]?.let(::JSONObject)
    }
}
