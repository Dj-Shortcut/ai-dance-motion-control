package dev.andyarijs.rig.data

import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap

class RigAccountRequestsTest {
    private val user = "u-12345678-1234-4123-8123-123456789abc"
    private val other = "u-87654321-4321-4321-8321-cba987654321"
    private val requestId = "11111111-1111-4111-8111-111111111111"
    private val jobId = "22222222-2222-4222-8222-222222222222"
    private val receiptId = "33333333-3333-4333-8333-333333333333"

    @Test fun requestsCarryOnlyTheExplicitRequestAndKeepGenerationAndLoginRecords() = runBlocking {
        val seen = mutableListOf<Pair<String, JSONObject>>()
        withRepository { request, _ ->
            assertEquals("Bearer rig_native_" + "s".repeat(43), request.header("Authorization"))
            assertEquals("POST", request.method)
            val body = request.body!!.let { body -> okio.Buffer().also { body.writeTo(it) }.readUtf8() }.let(::JSONObject)
            seen += request.url.encodedPath to body
            201 to receipt(if (request.url.encodedPath.endsWith("/reports")) VIDEO_REPORT_REQUEST else ACCOUNT_DELETION_REQUEST)
        }.use { fixture ->
            val before = fixture.store.session()
            fixture.store.savePending(PendingGeneration(user, "quote-existing", "intent-existing", "job-existing"))
            val deletion = fixture.repository.requestAccountDeletion(requestId)
            val report = fixture.repository.reportVideo(jobId, requestId, RigContentReportReason.UNSAFE, " Schadelijk voorbeeld ")
            assertEquals(ACCOUNT_DELETION_REQUEST, deletion.type)
            assertEquals(jobId, report.jobId)
            assertEquals(before, fixture.store.session())
            assertEquals("job-existing", fixture.store.pending(user)?.jobId)
            assertEquals(listOf("/api/native/account-deletion-requests", "/api/native/generations/$jobId/reports"), seen.map { it.first })
            assertEquals(setOf("requestId"), seen[0].second.keys().asSequence().toSet())
            assertEquals(setOf("requestId", "reason", "details"), seen[1].second.keys().asSequence().toSet())
            assertEquals("unsafe", seen[1].second.getString("reason"))
            assertEquals("Schadelijk voorbeeld", seen[1].second.getString("details"))
        }
    }

    @Test fun aRetryKeepsTheSameRequestIdAndUsesTheServersCanonicalReceipt() = runBlocking {
        val ids = mutableListOf<String>()
        withRepository { request, _ ->
            val body = okio.Buffer().also { request.body!!.writeTo(it) }.readUtf8().let(::JSONObject)
            ids += body.getString("requestId")
            200 to receipt(ACCOUNT_DELETION_REQUEST).put("replayed", ids.size > 1)
        }.use { fixture ->
            val first = fixture.repository.requestAccountDeletion(requestId)
            val second = fixture.repository.requestAccountDeletion(requestId)
            assertEquals(listOf(requestId, requestId), ids)
            assertEquals(first.id, second.id)
            assertFalse(first.replayed)
            assertTrue(second.replayed)
        }
    }

    @Test fun accountChangesBeforeTransmissionPreventTheRequest() {
        var calls = 0
        withRepository { _, _ -> calls++; 201 to receipt(ACCOUNT_DELETION_REQUEST) }.use { fixture ->
            val captured = fixture.repository.requireSession()
            fixture.store.saveSession(NativeAuthSession("rig_native_" + "n".repeat(43), captured.expiresAt, other))
            assertThrows(RigSessionReplacedException::class.java) {
                runBlocking { fixture.repository.requestAccountDeletion(requestId, captured) }
            }
            assertEquals(0, calls)
            assertEquals(other, fixture.store.session()?.userId)
        }
    }

    @Test fun accountChangesDuringTheResponseCannotExposeTheOldReceipt() {
        withRepository { _, store ->
            store.saveSession(NativeAuthSession("rig_native_" + "n".repeat(43), System.currentTimeMillis() + 60_000, other))
            201 to receipt(ACCOUNT_DELETION_REQUEST)
        }.use { fixture ->
            assertThrows(RigSessionReplacedException::class.java) {
                runBlocking { fixture.repository.requestAccountDeletion(requestId) }
            }
            assertEquals(other, fixture.store.session()?.userId)
        }
    }

    @Test fun requestValidationFailsBeforeAnyHttpRequest() {
        var calls = 0
        withRepository { _, _ -> calls++; 201 to receipt(VIDEO_REPORT_REQUEST) }.use { fixture ->
            for (bad in listOf("https://example.test/context", "www.example.test", "regel\nregel", "\u0000", "x".repeat(1001))) {
                assertThrows(IllegalArgumentException::class.java) {
                    runBlocking { fixture.repository.reportVideo(jobId, requestId, RigContentReportReason.OTHER, bad) }
                }
            }
            assertThrows(IllegalArgumentException::class.java) {
                runBlocking { fixture.repository.reportVideo("../../session", requestId, RigContentReportReason.OTHER, "") }
            }
            assertThrows(IllegalArgumentException::class.java) {
                runBlocking { fixture.repository.requestAccountDeletion("not-a-uuid") }
            }
            assertEquals(0, calls)
        }
    }

    @Test fun unicodeLimitUsesCodepointsAndOptionalDetailsAreActuallyOptional() {
        val body = videoReportBody(requestId, RigContentReportReason.OTHER, "🐕".repeat(1000))
        assertEquals(1000, body.getString("details").codePointCount(0, body.getString("details").length))
        assertFalse(videoReportBody(requestId, RigContentReportReason.HATE, "   ").has("details"))
    }

    @Test fun receiptsCannotClaimDeletionOrAnotherJobOrAnUnverifiedStatus() {
        val valid = receipt(ACCOUNT_DELETION_REQUEST)
        assertEquals(receiptId, RigAccountRequestReceipt.fromJson(valid, ACCOUNT_DELETION_REQUEST).id)
        for (bad in listOf(
            JSONObject(valid.toString()).put("actionPerformed", true),
            JSONObject(valid.toString()).put("actionPerformed", "false"),
            JSONObject(valid.toString()).put("replayed", "false"),
            JSONObject(valid.toString()).put("status", "completed"),
            JSONObject(valid.toString()).put("createdAt", -1),
            JSONObject(valid.toString()).put("jobId", jobId),
            JSONObject(valid.toString()).put("acknowledgement", "Open https://example.test"),
        )) assertThrows(IllegalArgumentException::class.java) { RigAccountRequestReceipt.fromJson(bad, ACCOUNT_DELETION_REQUEST) }
        assertThrows(IllegalArgumentException::class.java) {
            RigAccountRequestReceipt.fromJson(receipt(VIDEO_REPORT_REQUEST), VIDEO_REPORT_REQUEST, requestId)
        }
    }

    @Test fun ownDeletionHistoryIsBoundedAndCannotContainVideoReports() = runBlocking<Unit> {
        withRepository { request, _ ->
            assertEquals("GET", request.method)
            200 to JSONObject().put("requests", JSONArray().put(receipt(ACCOUNT_DELETION_REQUEST))).put("limit", 20)
        }.use { fixture -> assertEquals(listOf(receiptId), fixture.repository.accountDeletionRequests().map { it.id }) }
        withRepository { _, _ ->
            200 to JSONObject().put("requests", JSONArray().put(receipt(VIDEO_REPORT_REQUEST))).put("limit", 20)
        }.use { fixture ->
            assertThrows(IllegalArgumentException::class.java) { runBlocking { fixture.repository.accountDeletionRequests() } }
        }
    }

    @Test fun onlyTheExactNativeRequestPathsAndMethodsArePermitted() {
        assertTrue(RigApi.validPath("/account-deletion-requests"))
        assertTrue(RigApi.validPath("/generations/$jobId/reports"))
        for (path in listOf("/account-deletion-requests?", "/generations/$jobId/reports?", "/account-deletion-requests?user=someone", "/generations/../../session/reports", "/generations/not-a-uuid/reports", "/generations/$jobId/reports/other", "/admin/account-deletion-requests"))
            assertFalse(path, RigApi.validPath(path))
        withRepository { _, _ -> error("Invalid method must not reach HTTP") }.use { fixture ->
            assertThrows(IllegalArgumentException::class.java) { runBlocking { fixture.repository.api.get("/generations/$jobId/reports") } }
        }
    }

    private fun receipt(type: String) = JSONObject().put("id", receiptId).put("type", type).put("status", "pending")
        .put("createdAt", System.currentTimeMillis() - 1_000).put("replayed", false)
        .put("acknowledgement", "Je verzoek is ontvangen.").put("actionPerformed", false)
        .apply { if (type == VIDEO_REPORT_REQUEST) put("jobId", jobId) }

    private fun withRepository(respond: (Request, RigStore) -> Pair<Int, JSONObject>): Fixture {
        val records = ConcurrentHashMap<String, String>()
        val store = object : RigStore {
            override fun read(name: String) = records[name]?.let(::JSONObject)
            override fun write(name: String, value: JSONObject?) { if (value == null) records.remove(name) else records[name] = value.toString() }
        }
        store.saveSession(NativeAuthSession("rig_native_" + "s".repeat(43), System.currentTimeMillis() + 60_000, user))
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val (status, data) = respond(chain.request(), store)
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status).message("Fixture")
                .body(data.toString().toResponseBody("application/json".toMediaType())).build()
        }.build()
        val directory = Files.createTempDirectory("rig-account-requests").toFile()
        return Fixture(RigRepository(directory, directory, store, RigApi(store, client)), store) {
            client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll(); directory.deleteRecursively()
        }
    }

    private class Fixture(val repository: RigRepository, val store: RigStore, val close: () -> Unit) : AutoCloseable {
        override fun close() = close.invoke()
    }
}
