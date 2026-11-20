package dev.andyarijs.rig.data

import org.json.JSONObject

class RigStorageUnavailable(cause: Exception) : Exception(
    "RIG kan je beveiligde gegevens niet openen. Probeer het opnieuw voordat je een nieuwe opdracht start.", cause,
)

/** Persistence boundary. Android uses RigSecureStore; tests can model a
 * process restart against the exact same durable records without a real key. */
interface RigStore {
    /** Shared by all wrappers of the same durable store. */
    val transactionLock: Any get() = this
    fun write(name: String, value: JSONObject?)
    fun read(name: String): JSONObject?

    fun session(now: Long = System.currentTimeMillis()): NativeAuthSession? = synchronized(transactionLock) {
        val value = read("session") ?: return@synchronized null
        val session = runCatching { NativeAuthSession(value.getString("accessToken"), value.getLong("expiresAt"), value.getString("userId")) }.getOrNull()
        if (session == null || session.expiresAt <= now || !RIG_NATIVE_TOKEN.matches(session.accessToken) || !RIG_USER.matches(session.userId)) {
            write("session", null); return@synchronized null
        }
        session
    }

    fun saveSession(value: NativeAuthSession) = synchronized(transactionLock) {
        require(RIG_NATIVE_TOKEN.matches(value.accessToken) && RIG_USER.matches(value.userId) && value.expiresAt > System.currentTimeMillis())
        write("session", JSONObject().put("accessToken", value.accessToken).put("expiresAt", value.expiresAt).put("userId", value.userId))
    }

    fun clearSession() = synchronized(transactionLock) { write("session", null) }
    /** An expired request must never discard a newer successful login. */
    fun clearSessionIfMatches(accessToken: String): Boolean = synchronized(transactionLock) {
        if (read("session")?.optString("accessToken") != accessToken) return@synchronized false
        write("session", null)
        true
    }
    fun pending(userId: String): PendingGeneration? {
        val value = read("generation-$userId") ?: return null
        return try {
            PendingGeneration.fromJson(value).also { check(it.userId == userId) }
        } catch (error: Exception) { throw RigStorageUnavailable(error) }
    }
    fun savePending(value: PendingGeneration) = write("generation-${value.userId}", value.toJson())
    fun clearPending(userId: String) = write("generation-$userId", null)
}
