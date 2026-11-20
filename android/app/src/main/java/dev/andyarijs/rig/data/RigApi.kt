package dev.andyarijs.rig.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Bearer credentials go only to the fixed RIG API. In particular redirects
 * are disabled so an upstream media URL can never receive the session token. */
class RigApi internal constructor(private val store: RigStore, client: OkHttpClient = secureClient()) {
    private data class RequestSession(val credential: NativeAuthSession, val bound: Boolean)
    private val client = client.newBuilder().addNetworkInterceptor { chain ->
        val request = chain.request()
        request.tag(RequestSession::class.java)?.takeIf { it.bound }?.let { checkSession(it.credential) }
        chain.proceed(request)
    }.build()
    companion object {
        private fun secureClient() = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS).writeTimeout(120, TimeUnit.SECONDS)
        .callTimeout(180, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).build()

        const val BASE = "https://rig-api.shortcut-computerguy.workers.dev/api/native"
        fun validPath(path: String): Boolean {
            if (path.length !in 1..500 || path.any { it == '\\' || it == '#' || it == '%' || it == '\r' || it == '\n' } || path.contains("..")) return false
            val plain = path.substringBefore('?')
            val query = path.substringAfter('?', "")
            if (query.isNotEmpty() && !(plain == "/payments/google-play/status" && Regex("^intentId=[a-f0-9-]{36}$").matches(query))) return false
            return plain in setOf("/session", "/video-config", "/provider-balance", "/assets", "/generation-quotes", "/generations", "/generations/recent", "/video-drafts", "/auth/exchange", "/auth/logout", "/security", "/security/registration/options", "/security/registration/verify", "/security/verification/options", "/owner/security", "/owner/security/verification/options", "/payments/google-play/config", "/payments/google-play/intents", "/payments/google-play/confirm", "/payments/google-play/status") ||
                Regex("^/generations/[A-Za-z0-9_-]{1,100}(/video|/draft)?$").matches(plain) ||
                Regex("^/generation-intents/[A-Za-z0-9_-]{1,100}/reconcile$").matches(plain) ||
                Regex("^/video-drafts/[A-Za-z0-9_-]{1,100}/assets/[A-Za-z0-9_-]{1,100}$").matches(plain)
        }
    }

    suspend fun get(path: String, session: NativeAuthSession? = null): JSONObject = json("GET", path, session = session)
    suspend fun post(path: String, data: JSONObject = JSONObject(), session: NativeAuthSession? = null): JSONObject = json("POST", path, data, session = session)
    suspend fun exchange(code: String, verifier: String): JSONObject = json("POST", "/auth/exchange", JSONObject().put("code", code).put("codeVerifier", verifier), authenticated = false)

    private suspend fun json(method: String, path: String, data: JSONObject? = null, authenticated: Boolean = true, session: NativeAuthSession? = null): JSONObject = withContext(Dispatchers.IO) {
        require(path != "/provider-balance" || method == "GET") { "Het Fal-saldo kan alleen worden gelezen." }
        val body = data?.toString()?.toRequestBody("application/json; charset=utf-8".toMediaType())?.let {
            if (path == "/auth/exchange") OneShotBody(it) else it
        }
        val request = builder(path, authenticated, session).method(method, body).build()
        var headersStarted = false
        val transport = if (authenticated) client else client.newBuilder().eventListener(object : EventListener() {
            override fun requestHeadersStart(call: Call) { headersStarted = true }
        }).build()
        try { transport.newCall(request).execute().use { response ->
            val raw = response.body?.source()?.apply { request(1_048_577) }?.buffer?.readByteArray()
            if (raw == null || raw.size > 1_048_576) throw IOException("RIG kon het antwoord niet veilig lezen.")
            val result = runCatching { JSONObject(String(raw, Charsets.UTF_8)) }.getOrNull()
            if (!response.isSuccessful) throw failure(response.code, result ?: JSONObject(), request)
            result ?: throw RigApiException(response.code, null, "De dienst is tijdelijk niet beschikbaar. Probeer de status later opnieuw.")
        } } catch (error: IOException) {
            if (!authenticated) throw RigTransportException(!headersStarted, "Je aanmelding kon niet worden bevestigd. Controleer je verbinding.", error)
            throw error
        }
    }

    suspend fun upload(kind: String, file: File, durationSeconds: Int? = null, keepSound: Boolean = true, session: NativeAuthSession = requireSession()): JSONObject = withContext(Dispatchers.IO) {
        checkSession(session)
        require(kind in setOf("image", "video", "face", "angle"))
        require(file.isFile && file.length() in 1..16L * 1024 * 1024) { "Je gekozen fragment kon niet worden voorbereid. Het bronbestand wordt niet geüpload." }
        if (kind == "video") require(durationSeconds != null && durationSeconds in 3..30)
        // These are the media agent's normalized bytes, never the original 4K file.
        val body = object : RequestBody() {
            override fun contentType() = (if (kind == "video") "video/mp4" else "image/jpeg").toMediaType()
            override fun contentLength() = file.length()
            override fun writeTo(sink: BufferedSink) {
                checkSession(session)
                file.inputStream().use { input -> val buffer = ByteArray(64 * 1024); while (true) { val n = input.read(buffer); if (n < 0) break; sink.write(buffer, 0, n) } }
            }
        }
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer = ByteArray(64 * 1024); while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) } }
        val sha256 = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
        val request = builder("/assets", session = session).header("X-Rig-Asset-Kind", kind).header("X-Rig-Native-Body-Sha256", sha256).apply {
            if (kind == "video") { header("X-Rig-Duration-Seconds", durationSeconds.toString()); header("X-Rig-Keep-Sound", keepSound.toString()) }
        }.post(body).build()
        client.newCall(request).execute().use { response ->
            val raw = response.body?.source()?.apply { request(65_537) }?.buffer?.readByteArray()
            if (raw == null || raw.size > 65_536) throw IOException("Het voorbereide bestand kon niet worden gecontroleerd.")
            val result = runCatching { JSONObject(String(raw, Charsets.UTF_8)) }.getOrNull() ?: throw IOException("Het voorbereide bestand kon niet worden gecontroleerd.")
            if (!response.isSuccessful) throw failure(response.code, result, request)
            result
        }
    }

    suspend fun download(path: String, destination: File, maxBytes: Long = 150L * 1024 * 1024, session: NativeAuthSession = requireSession()): File = withContext(Dispatchers.IO) {
        require(Regex("^/generations/[A-Za-z0-9_-]{1,100}/video$").matches(path) || Regex("^/video-drafts/[A-Za-z0-9_-]{1,100}/assets/[A-Za-z0-9_-]{1,100}$").matches(path))
        val temp = File.createTempFile("rig-download-", ".part", destination.absoluteFile.parentFile)
        try {
            val request = builder(path, session = session).get().build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw failure(response.code, JSONObject(), request)
                val body = response.body ?: throw IOException("Je video is nog niet beschikbaar.")
                if (body.contentLength() > maxBytes) throw IOException("Je video kon niet veilig worden opgeslagen.")
                var total = 0L
                temp.outputStream().use { output -> body.byteStream().use { input ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) { val n = input.read(buffer); if (n < 0) break; total += n; if (total > maxBytes) throw IOException("Je video kon niet veilig worden opgeslagen."); output.write(buffer, 0, n) }
                } }
                if (total == 0L) throw IOException("Je video is nog niet beschikbaar.")
            }
            checkSession(session)
            if (!temp.renameTo(destination)) throw IOException("Je video kon niet worden opgeslagen.")
            destination
        } finally { temp.delete() }
    }

    internal fun requireSession(): NativeAuthSession = store.session() ?: throw RigApiException(401, "login_required", "Meld je aan om verder te gaan.")

    internal fun checkSession(expected: NativeAuthSession) {
        if (requireSession() != expected) throw RigSessionReplacedException()
    }

    private fun builder(path: String, authenticated: Boolean = true, session: NativeAuthSession? = null): Request.Builder {
        require(validPath(path)) { "Ongeldige RIG-aanvraag." }
        return Request.Builder().url(BASE + path).header("Accept", "application/json").header("Cache-Control", "no-store").apply {
            if (authenticated) {
                val credential = session?.also(::checkSession) ?: requireSession()
                header("Authorization", "Bearer ${credential.accessToken}")
                tag(RequestSession::class.java, RequestSession(credential, bound = session != null))
            }
        }
    }

    private fun failure(status: Int, body: JSONObject, request: Request): Exception {
        if (status == 401) request.tag(RequestSession::class.java)?.let { used ->
            val replaced = synchronized(store.transactionLock) {
                val current = store.session()
                if (current?.accessToken == used.credential.accessToken) store.clearSessionIfMatches(used.credential.accessToken)
                current != null && current.accessToken != used.credential.accessToken
            }
            // The view layer also reacts to 401 by showing a logged-out UI.
            // An obsolete response is not a failure of the newer credential.
            if (replaced) return RigSessionReplacedException()
        }
        // Server messages are bounded plain text; never surface upstream URLs,
        // request payloads or a stack trace in the customer's interface.
        val message = body.optString("error").takeIf { it.length in 1..400 && !it.contains("https://") && !it.contains("http://") }
            ?: if (status == 401) "Meld je opnieuw aan om verder te gaan." else "RIG is tijdelijk niet beschikbaar. Controleer de bestaande opdracht voordat je opnieuw begint."
        return RigApiException(status, body.optString("code").takeIf { it.isNotBlank() }, message)
    }

}

private class OneShotBody(private val body: RequestBody) : RequestBody() {
    override fun contentType() = body.contentType()
    override fun contentLength() = body.contentLength()
    override fun isOneShot() = true
    override fun writeTo(sink: BufferedSink) = body.writeTo(sink)
}

/** Only "before request headers" proves that the one-use code was not sent.
 * A 503 or lost response can follow a successful server exchange. */
class RigTransportException(val definitelyUnsubmitted: Boolean, message: String, cause: IOException) : IOException(message, cause)
class RigSessionReplacedException : Exception("Je aanmelding is intussen vernieuwd. De oude aanvraag is gestopt.")
