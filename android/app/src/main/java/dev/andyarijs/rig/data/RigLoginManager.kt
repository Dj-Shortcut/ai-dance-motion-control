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
        store.write("login", JSONObject().put("verifier", verifier).put("state", state).put("createdAt", System.currentTimeMillis()))
        return "$SIGN_IN?challenge=${challenge(verifier)}&state=$state"
    }

    suspend fun completeCallback(uri: Uri): NativeAuthSession = completeCallbackString(uri.toString())

    internal suspend fun completeCallbackString(callback: String): NativeAuthSession = lock.withLock {
        val values = parseCallback(callback) ?: throw IllegalArgumentException("Dit is geen geldige RIG-aanmelding. Meld je opnieuw aan.")
        val pending = store.read("login") ?: throw IllegalStateException("Deze aanmelding is verlopen. Meld je opnieuw aan.")
        val state = values.getValue("state")
        val expected = pending.getString("state")
        require(MessageDigest.isEqual(state.toByteArray(), expected.toByteArray())) { "Deze aanmelding hoort niet bij dit apparaat." }
        val age = System.currentTimeMillis() - pending.getLong("createdAt")
        // The browser may need a fresh identity-provider sign-in. Its PKCE
        // transaction lasts longer than the server's five-minute *issued code*.
        require(age in 0..15 * 60 * 1000) { "Deze aanmelding is verlopen. Meld je opnieuw aan." }
        val verifier = pending.getString("verifier")
        // A competing deep-link callback cannot redeem this transaction again.
        store.write("login", null)
        val result = api.exchange(values.getValue("code"), verifier)
        require(result.getString("tokenType") == "Bearer" && result.getString("currency") == "EUR" && result.getString("mode") == "live")
        val session = NativeAuthSession(result.getString("accessToken"), result.getLong("expiresAt"), result.getString("userId"))
        require(session.expiresAt > System.currentTimeMillis() && session.expiresAt <= System.currentTimeMillis() + 31L * 24 * 60 * 60 * 1000)
        store.saveSession(session)
        session
    }

    companion object {
        const val SIGN_IN = "https://rig-motion-studio.shortcutcomputerguy.chatgpt.site/native/signin"
        private fun random(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also(SecureRandom()::nextBytes))
        fun challenge(verifier: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        fun validCallback(uri: Uri): Boolean = parseCallback(uri.toString()) != null
        internal fun parseCallback(value: String): Map<String, String>? = runCatching {
            val uri = URI(value)
            require(uri.scheme == "dev.andyarijs.rig" && uri.host == "auth" && uri.rawPath == "/callback" && uri.rawUserInfo == null && uri.port == -1 && uri.rawFragment == null)
            val parts = (uri.rawQuery ?: "").split('&')
            require(parts.size == 2 && parts.all { Regex("^(code|state)=[A-Za-z0-9_-]{43}$").matches(it) })
            val fields = parts.associate { it.substringBefore('=') to it.substringAfter('=') }
            require(fields.keys == setOf("code", "state"))
            fields
        }.getOrNull()
    }
}
