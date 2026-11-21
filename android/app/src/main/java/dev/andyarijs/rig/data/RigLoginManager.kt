package dev.andyarijs.rig.data

import android.net.Uri
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.net.URI
import java.util.Base64

/** The browser is used only for the existing trusted RIG sign-in screen.
 * The callback contains a one-use code, never the app's bearer credential. */
class RigLoginManager(private val store: RigStore, private val api: RigApi) {
    private val lock = Mutex()

    fun beginLogin(): Uri = Uri.parse(beginAuthorization())

    internal fun beginAuthorization(): String {
        val verifier = random()
        val state = random()
        synchronized(store.transactionLock) {
            store.write("login-completed", null)
            store.write("login", JSONObject().put("verifier", verifier).put("state", state).put("createdAt", System.currentTimeMillis()).put("phase", "ready"))
        }
        return "$SIGN_IN?flow=app-link-v1&challenge=${challenge(verifier)}&state=$state"
    }

    suspend fun completeCallback(uri: Uri): NativeAuthSession = completeCallbackString(uri.toString())

    internal suspend fun completeCallbackString(callback: String): NativeAuthSession = lock.withLock {
        val values = parseCallback(callback) ?: throw IllegalArgumentException("Dit is geen geldige RIG-aanmelding. Meld je opnieuw aan.")
        val state = values.getValue("state")
        val codeHash = hash(values.getValue("code"))
        val prepared = synchronized(store.transactionLock) {
            completedSession(state, codeHash)?.let { return@withLock it }
            val pending = store.read("login") ?: throw IllegalStateException("Deze aanmelding is verlopen. Meld je opnieuw aan.")
            require(same(state, pending.getString("state"))) { "Deze aanmelding hoort niet bij dit apparaat." }
            val age = System.currentTimeMillis() - pending.getLong("createdAt")
            // The identity-provider interaction can precede issuance of the
            // server's five-minute code. Keep this local transaction 15 minutes.
            require(age in 0..15 * 60 * 1000) { "Deze aanmelding is verlopen. Meld je opnieuw aan." }
            check(pending.optString("phase", "ready") == "ready") {
                "De vorige aanmelding kon niet worden bevestigd. Start een nieuwe aanmelding in RIG."
            }
            // Durable before network I/O. Process death or a lost response must
            // never cause an automatic second exchange of this one-use code.
            pending.put("phase", "inflight").put("codeHash", codeHash)
            store.write("login", pending)
            pending
        }
        try {
            val result = api.exchange(values.getValue("code"), prepared.getString("verifier"))
            require(result.getString("tokenType") == "Bearer" && result.getString("currency") == "EUR" && result.getString("mode") == "live")
            val session = NativeAuthSession(result.getString("accessToken"), result.getLong("expiresAt"), result.getString("userId"))
            require(session.expiresAt > System.currentTimeMillis() && session.expiresAt <= System.currentTimeMillis() + 31L * 24 * 60 * 60 * 1000)
            synchronized(store.transactionLock) {
                val current = store.read("login")
                check(current?.optString("state") == state && current.optString("codeHash") == codeHash && current.optString("phase") == "inflight") {
                    "Deze aanmelding is vervangen. Gebruik de nieuwste aanmelding in RIG."
                }
                // Write the non-secret completion binding BEFORE the session.
                // A crash after the session commit can then recognize the same
                // callback without requesting another token or reviving one.
                store.write("login-completed", JSONObject().put("state", state).put("codeHash", codeHash)
                    .put("sessionHash", hash(session.accessToken)).put("userId", session.userId).put("completedAt", System.currentTimeMillis()))
                store.saveSession(session)
                clearCompletedLogin()
            }
            session
        } catch (error: Exception) {
            synchronized(store.transactionLock) {
                val current = store.read("login")
                if (current?.optString("state") == state && current.optString("codeHash") == codeHash && current.optString("phase") == "inflight") {
                    // A 503 is uncertain too: a relay can fail after the server
                    // consumed the code. Preserve PKCE but require a fresh login.
                    current.put("phase", if (error is RigTransportException && error.definitelyUnsubmitted) "ready" else "uncertain")
                    store.write("login", current)
                }
            }
            throw error
        }
    }

    /** Idempotence is limited to this exact completed transaction and the
     * already-held, still-current credential. It never recovers a lost token. */
    private fun completedSession(state: String, codeHash: String): NativeAuthSession? {
        val completed = store.read("login-completed") ?: return null
        if (completed.optString("state") != state || completed.optString("codeHash") != codeHash ||
            System.currentTimeMillis() - completed.optLong("completedAt") !in 0..5 * 60_000L) return null
        val pending = store.read("login")
        if (pending != null && pending.optString("state") != state) return null
        val session = store.session() ?: return null
        if (completed.optString("userId") != session.userId || !same(completed.optString("sessionHash"), hash(session.accessToken))) return null
        if (pending?.optString("state") == state) clearCompletedLogin()
        return session
    }

    // These callers hold the transaction lock and have verified the completion
    // binding. A matching callback can retry cleanup after a storage failure.
    private fun clearCompletedLogin() {
        try { store.write("login", null) } catch (_: Exception) { }
    }

    companion object {
        const val SIGN_IN = "https://rig-motion-studio.shortcutcomputerguy.chatgpt.site/native/signin"
        const val CALLBACK = "https://rig-motion-studio.shortcutcomputerguy.chatgpt.site/native/callback"
        private fun random(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also(SecureRandom()::nextBytes))
        private fun hash(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.US_ASCII)).joinToString("") { "%02x".format(it.toInt() and 255) }
        private fun same(a: String, b: String) = MessageDigest.isEqual(a.toByteArray(Charsets.US_ASCII), b.toByteArray(Charsets.US_ASCII))
        fun challenge(verifier: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        fun validCallback(uri: Uri): Boolean = parseCallback(uri.toString()) != null
        internal fun parseCallback(value: String): Map<String, String>? = runCatching {
            val uri = URI(value)
            require(uri.scheme == "https" && uri.host == "rig-motion-studio.shortcutcomputerguy.chatgpt.site" &&
                uri.rawPath == "/native/callback" && uri.rawUserInfo == null && uri.port == -1 && uri.rawFragment == null)
            val parts = (uri.rawQuery ?: "").split('&')
            require(parts.size == 2 && parts.all { Regex("^(code|state)=[A-Za-z0-9_-]{43}$").matches(it) })
            val fields = parts.associate { it.substringBefore('=') to it.substringAfter('=') }
            require(fields.keys == setOf("code", "state"))
            fields
        }.getOrNull()
    }
}
