package dev.andyarijs.rig.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RigContractsTest {
    private val user = "u-12345678-1234-4123-8123-123456789abc"
    private val request = RigQuoteRequest("image-1", "video-1", "pro", "Neem de beweging van de bronvideo over.")
    private fun quote() = JSONObject().put("id", "quote-1").put("priceCents", 150).put("currency", "EUR")
        .put("approvalToken", "a".repeat(43)).put("idempotencyKey", "intent-1").put("durationSeconds", 5.5).put("billedSeconds", 6).put("quality", "pro")

    @Test fun tokenTransportHasNoArbitraryHostOrOwnerAdminPath() {
        assertTrue(RigApi.validPath("/session"))
        assertTrue(RigApi.validPath("/owner/security/verification/options"))
        assertTrue(RigApi.validPath("/generations/job-1/video"))
        assertFalse(RigApi.validPath("https://attacker.example/api/session"))
        assertFalse(RigApi.validPath("//attacker.example/session"))
        assertFalse(RigApi.validPath("/owner/security/registration/options"))
        assertFalse(RigApi.validPath("/owner/finance"))
        assertFalse(RigApi.validPath("/payments/checkout"))
        assertFalse(RigApi.validPath("/generations/../session"))
        assertFalse(RigApi.validPath("/generations/%2e%2e/video"))
        assertFalse(RigApi.validPath("/session?accessToken=secret"))
    }

    @Test fun freshQuoteMustHaveExactApprovalAndBilledDuration() {
        val result = RigQuote.fromJson(quote(), request)
        assertEquals(150L, result.priceCents)
        assertEquals("intent-1", result.confirmationPayload().getString("idempotencyKey"))
        assertFalse(result.confirmationPayload().has("approvalToken"))
        assertFalse(result.confirmationPayload().has("transferConsent"))
        for (bad in listOf(quote().put("approvalToken", "bad"), quote().put("billedSeconds", 5), quote().put("currency", "USD"), quote().put("quality", "standard"))) {
            assertThrows(Exception::class.java) { RigQuote.fromJson(bad, request) }
        }
    }

    @Test fun editRequiresTemporaryLinkConsentAndPreservesMotionMode() {
        val edit = request.copy(quality = "edit-standard")
        val json = edit.toJson()
        assertEquals(TEMPORARY_TRANSFER, json.getString("transferPolicy"))
        assertFalse(json.has("steadyCamera"))
        val result = RigQuote.fromJson(quote().put("quality", "edit-standard").put("transferPolicy", TEMPORARY_TRANSFER), edit)
        assertEquals(TEMPORARY_TRANSFER, result.confirmationPayload().getString("transferConsent"))
        assertThrows(Exception::class.java) { RigQuote.fromJson(quote().put("quality", "edit-standard"), edit) }
        assertThrows(Exception::class.java) { edit.copy(steadyCamera = true).toJson() }
    }

    @Test fun trialAndFullDraftSendIdenticalNormalizedSettings() {
        for (quality in listOf("pro", "standard", "edit-standard", "human-recast")) {
            val trial = request.copy(quality = quality, prompt = " \n  Behoud het licht.  \t")
            val quotePayload = trial.toJson()
            val draft = trial.fullDraft("trial-quote", "full-video", 15, 1250)
            assertEquals("Behoud het licht.", draft.getString("prompt"))
            assertEquals("full-video", draft.getString("fullVideoId"))
            assertEquals(15, draft.getInt("selectedSeconds"))
            assertEquals(1.25, draft.getDouble("originalStartSeconds"), 0.0)
            assertFalse(draft.has("videoId"))
            for (key in quotePayload.keys().asSequence().filter { it != "videoId" }) {
                assertEquals(key, quotePayload.get(key).toString(), draft.get(key).toString())
            }
            assertEquals(quotePayload.has("transferPolicy"), draft.has("transferPolicy"))
            assertEquals(quotePayload.has("steadyCamera"), draft.has("steadyCamera"))
        }
    }

    @Test fun humanRecastRequires1080pOnePortraitAndOriginalSound() {
        val recast = request.copy(quality = "human-recast")
        val json = quote().put("quality", "human-recast").put("durationSeconds", 6).put("billedSeconds", 6)
            .put("outputResolution", "1080P").put("transferPolicy", TEMPORARY_TRANSFER)
        assertEquals(6.0, RigQuote.fromJson(json, recast).durationSeconds, 0.0)
        assertThrows(Exception::class.java) { RigQuote.fromJson(json.put("outputResolution", "720P"), recast) }
        assertThrows(Exception::class.java) { recast.copy(keepSound = false).toJson() }
        assertThrows(Exception::class.java) { recast.copy(faceId = "face-1").toJson() }
    }

    @Test fun unsupportedCleanupWorkflowIsNeverPresentedAsOneCallGeneration() {
        assertThrows(Exception::class.java) { RigQuote.fromJson(quote().put("workflowVersion", "rig-workflow-v2"), request) }
    }

    @Test fun giftAndOwnFalFundingComeFromCapabilitiesRatherThanAClientGuess() {
        assertEquals("sponsored", RigQuote.fromJson(quote(), request, "sponsored").funding)
        val owner = quote().apply { remove("priceCents"); remove("currency") }
            .put("funding", "owner-provider").put("providerCurrency", "USD").put("providerEstimateUsdMicros", 1_800_000)
        val result = RigQuote.fromJson(owner, request, "owner-provider")
        assertNull(result.priceCents)
        assertEquals(1_800_000L, result.providerEstimateUsdMicros)
        assertThrows(Exception::class.java) { RigQuote.fromJson(owner, request, "credits") }
    }

    @Test fun onlyMatchingRelativeOwnedMediaPathIsAccepted() {
        val value = JSONObject().put("id", "job-1").put("state", "completed").put("videoPath", "/api/generations/job-1/video")
        assertTrue(RigJob.fromJson(value).completed)
        for (path in listOf("https://fal.media/file.mp4", "/api/generations/other/video", "//example.test/video.mp4")) {
            assertThrows(Exception::class.java) { RigJob.fromJson(value.put("videoPath", path)) }
        }
    }

    @Test fun jobRecoveryRemainsBoundToTheSameUserAndIntent() {
        val pending = PendingGeneration(user, "quote-1", "intent-1", "job-1")
        assertEquals(pending, PendingGeneration.fromJson(pending.toJson()))
        assertThrows(Exception::class.java) { PendingGeneration.fromJson(pending.toJson().put("userId", "owner")) }
        assertThrows(Exception::class.java) { PendingGeneration.fromJson(pending.toJson().put("jobId", "../../session")) }
    }

    @Test fun accountModeAndEuroBalanceComeFromTheServer() {
        val value = JSONObject().put("userId", user).put("balanceCents", 500).put("currency", "EUR").put("mode", "live").put("funding", "credits")
        assertEquals(500L, RigSession.fromJson(value).balanceCents)
        assertThrows(Exception::class.java) { RigSession.fromJson(value.put("balanceCents", -5)) }
        assertThrows(Exception::class.java) { RigSession.fromJson(value.put("balanceCents", 500).put("mode", "test")) }
    }
}
