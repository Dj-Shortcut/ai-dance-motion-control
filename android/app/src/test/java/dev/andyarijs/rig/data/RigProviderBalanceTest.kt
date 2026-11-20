package dev.andyarijs.rig.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RigProviderBalanceTest {
    private val now = 1_795_000_000_000L
    private fun payload() = JSONObject().put("availableUsdMicros", 9_370_000).put("currency", "USD")
        .put("fetchedAt", now - 1000).put("expiresAt", now + 29_000)

    @Test fun verifiedProviderDollarsAreSeparateFromCustomerEuroCredits() {
        val balance = RigProviderBalance.fromJson(payload(), now)
        assertEquals(9_370_000L, balance.availableUsdMicros)
        assertEquals("USD", balance.currency)
        assertTrue(balance.isFresh(now))
        assertFalse(balance.isFresh(now + 29_000))
    }

    @Test fun anActualValidatedZeroIsAcceptedButMissingOrFractionalAmountsAreNotZero() {
        assertEquals(0L, RigProviderBalance.fromJson(payload().put("availableUsdMicros", 0), now).availableUsdMicros)
        for (invalid in listOf(payload().apply { remove("availableUsdMicros") }, payload().put("availableUsdMicros", JSONObject.NULL),
            payload().put("availableUsdMicros", "9370000"), payload().put("availableUsdMicros", 9_370_000.5), payload().put("availableUsdMicros", -1),
            payload().put("availableUsdMicros", 9_007_199_254_740_992L), payload().put("currency", "EUR"))) {
            assertThrows(Exception::class.java) { RigProviderBalance.fromJson(invalid, now) }
        }
    }

    @Test fun staleFutureAndUnboundedCacheLifetimesCannotBeShownAsCurrentMoney() {
        for (invalid in listOf(payload().put("expiresAt", now), payload().put("fetchedAt", now + 5001).put("expiresAt", now + 10_000),
            payload().put("expiresAt", now + 60_000), payload().put("fetchedAt", 0), payload().put("expiresAt", now - 2000))) {
            assertThrows(Exception::class.java) { RigProviderBalance.fromJson(invalid, now) }
        }
    }

    @Test fun providerBalanceHasOnlyTheFixedAuthenticatedRoute() {
        assertTrue(RigApi.validPath("/provider-balance"))
        assertFalse(RigApi.validPath("/provider-balance?userId=owner"))
        assertFalse(RigApi.validPath("/provider-balance?apiKey=secret"))
        assertFalse(RigApi.validPath("https://api.fal.ai/v1/balance"))
    }
}
