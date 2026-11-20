package dev.andyarijs.rig.billing

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PlayConfigurationTest {
    @Test fun completedCancellationUsesAFreshRequestButUncertainStatesKeepTheSameId() {
        val old = JSONObject().put("productId", "rig_credit_5").put("accountId", "account").put("intentId", "old-id")
        for (state in listOf("cancelled", "canceled", "refunded", "expired")) {
            val intent = JSONObject().put("state", state).put("recoveryPending", false)
            java.util.UUID.fromString(playPurchaseRequestId(old, intent, "rig_credit_5", "account"))
            intent.put("recoveryPending", true)
            assertEquals("old-id", playPurchaseRequestId(old, intent, "rig_credit_5", "account"))
        }
        assertEquals("old-id", playPurchaseRequestId(old, null, "rig_credit_5", "account"))
    }
    private fun config() = JSONObject().put("enabled", true).put("recoveryReady", true).put("currency", "EUR")
        .put("mode", "live").put("accountId", "a".repeat(64)).put("products", JSONArray().put(JSONObject()
            .put("productId", "rig_credit_5").put("creditsCents", 500).put("priceCents", 899)))

    @Test fun unconfiguredServerNeverOffersACharge() {
        val configuration = PlayConfiguration.parse(JSONObject().put("enabled", false))
        assertFalse(configuration.enabled)
        assertFalse(configuration.recoveryReady)
        assertTrue(configuration.products.isEmpty())
    }

    @Test fun disablingNewSalesKeepsReceiptRecoveryAvailable() {
        val configuration = PlayConfiguration.parse(config().put("enabled", false))
        assertFalse(configuration.enabled)
        assertTrue(configuration.recoveryReady)
        assertEquals(500L, configuration.products.single().creditsCents)
        assertEquals(899L, configuration.products.single().priceCents)
    }

    @Test fun accountCurrencyAndCreditFaceValueAreValidatedBeforeGoogleCheckout() {
        assertThrows(Exception::class.java) { PlayConfiguration.parse(config().put("accountId", "wrong-user")) }
        assertThrows(Exception::class.java) { PlayConfiguration.parse(config().put("currency", "USD")) }
        val wrongFace = config().apply { getJSONArray("products").getJSONObject(0).put("creditsCents", 900) }
        assertThrows(Exception::class.java) { PlayConfiguration.parse(wrongFace) }
        val unknownProduct = config().apply { getJSONArray("products").getJSONObject(0).put("productId", "unapproved_purchase") }
        assertThrows(Exception::class.java) { PlayConfiguration.parse(unknownProduct) }
    }

    @Test fun duplicateProductCannotChooseAnAmbiguousPrice() {
        val value = config().apply { getJSONArray("products").put(JSONObject(getJSONArray("products").getJSONObject(0).toString())) }
        assertThrows(Exception::class.java) { PlayConfiguration.parse(value) }
    }
}
