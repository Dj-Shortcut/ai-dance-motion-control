package dev.andyarijs.rig.data

import org.json.JSONObject

/** An owner-only read from Fal, independent of the customer's euro wallet.
 * A failed or expired read has no balance value; it must never become zero. */
data class RigProviderBalance(
    val availableUsdMicros: Long,
    val currency: String,
    val fetchedAt: Long,
    val expiresAt: Long,
) {
    fun isFresh(now: Long = System.currentTimeMillis()): Boolean = fetchedAt <= now + 5_000 && expiresAt > now

    companion object {
        fun fromJson(value: JSONObject, now: Long = System.currentTimeMillis()): RigProviderBalance {
            require(value.get("currency") == "USD") { "Het Fal-saldo kon niet worden gecontroleerd." }
            val available = value.safeInteger("availableUsdMicros")
            val fetched = value.safeInteger("fetchedAt")
            val expires = value.safeInteger("expiresAt")
            require(available >= 0 && fetched > 0 && expires > fetched && expires - fetched <= 60_000) {
                "Het Fal-saldo kon niet worden gecontroleerd."
            }
            return RigProviderBalance(available, "USD", fetched, expires).also {
                require(it.isFresh(now)) { "Het Fal-saldo is nog niet bijgewerkt. Probeer straks opnieuw." }
            }
        }
    }
}
