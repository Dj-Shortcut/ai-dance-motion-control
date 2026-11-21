package dev.andyarijs.rig

import android.app.Application
import androidx.lifecycle.viewModelScope
import androidx.test.platform.app.InstrumentationRegistry
import dev.andyarijs.rig.data.NativeAuthSession
import dev.andyarijs.rig.data.RigApi
import dev.andyarijs.rig.data.RigRepository
import dev.andyarijs.rig.data.RigStore
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap

/** The production ViewModel and repository run with an isolated store and in-process HTTP responses. */
internal class NativeViewModelFixture(
    funding: String = "credits",
    qualities: List<String> = listOf("pro", "standard"),
    signedIn: Boolean = true,
    setupStore: (RigStore) -> Unit = {},
    beforeRead: (String) -> Unit = {},
    download: (Request) -> ByteArray? = { null },
    respond: (Request) -> Pair<Int, JSONObject>,
) : Closeable {
    val user = "u-12345678-1234-4123-8123-123456789abc"
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as Application
    private val directory = Files.createTempDirectory(app.cacheDir.toPath(), "native-view-model").toFile()
    val store = object : RigStore {
        private val records = ConcurrentHashMap<String, String>()
        override fun read(name: String): JSONObject? {
            beforeRead(name)
            return records[name]?.let(::JSONObject)
        }
        override fun write(name: String, value: JSONObject?) {
            if (value == null) records.remove(name) else records[name] = value.toString()
        }
    }
    private val client = OkHttpClient.Builder().addInterceptor { chain ->
        val request = chain.request()
        val response = Response.Builder().request(request).protocol(Protocol.HTTP_1_1).message("Fixture")
        download(request)?.let { bytes ->
            return@addInterceptor response.code(200).body(bytes.toResponseBody("video/mp4".toMediaType())).build()
        }
        val (status, body) = when (request.url.encodedPath) {
            "/api/native/session" -> 200 to JSONObject().put("userId", store.session()?.userId).put("balanceCents", 500)
                .put("currency", "EUR").put("mode", "live").put("funding", funding)
            "/api/native/video-config" -> 200 to JSONObject().put("enabled", true).put("funding", funding)
                .put("qualities", JSONArray(qualities))
            else -> respond(request)
        }
        response.code(status).body(body.toString().toResponseBody("application/json".toMediaType())).build()
    }.build()
    private val repository = RigRepository(directory, directory, store, RigApi(store, client))
    lateinit var model: RigViewModel
        private set

    init {
        if (signedIn) store.saveSession(NativeAuthSession("rig_native_" + "s".repeat(43), System.currentTimeMillis() + 86_400_000, user))
        setupStore(store)
        recreate()
    }

    fun onMain(block: () -> Unit) = instrumentation.runOnMainSync(block)

    fun awaitState(predicate: (RigScreenState) -> Boolean): RigScreenState = runBlocking {
        withTimeout(30_000) { model.state.first(predicate) }
    }

    fun recreate() {
        onMain {
            if (::model.isInitialized) disposeModel()
            model = RigViewModel(app, repository)
        }
        val expectedUser = store.session()?.userId
        awaitState { it.session?.userId == expectedUser && !it.busy }
    }

    private fun disposeModel() {
        model.viewModelScope.cancel()
        model.billing.close()
    }

    override fun close() {
        onMain { disposeModel() }
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdown()
        directory.deleteRecursively()
    }
}
