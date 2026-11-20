package dev.andyarijs.rig.billing

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import dev.andyarijs.rig.data.RigApiException
import dev.andyarijs.rig.data.RigRepository
import dev.andyarijs.rig.data.RigStorageUnavailable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class RigCreditPackage(val productId: String, val creditsCents: Long, val priceCents: Long, val formattedPrice: String)

internal fun playPurchaseRequestId(previous: JSONObject?, intent: JSONObject?, productId: String, accountId: String): String {
    val finished = intent != null && !intent.optBoolean("recoveryPending") &&
        intent.optString("state") in setOf("expired", "refunded", "cancelled", "canceled")
    return if (!finished && previous != null && previous.optString("productId") == productId && previous.optString("accountId") == accountId) {
        previous.getString("intentId")
    } else UUID.randomUUID().toString()
}
data class RigBillingState(
    val loading: Boolean = false,
    val available: Boolean = false,
    val packages: List<RigCreditPackage> = emptyList(),
    val pending: Boolean = false,
    val message: String = "Aankopen via Google Play zijn nog niet beschikbaar.",
    val resumeProductId: String? = null,
)

internal data class ApprovedPlayProduct(val productId: String, val creditsCents: Long, val priceCents: Long)
internal data class PlayConfiguration(val enabled: Boolean, val recoveryReady: Boolean, val accountId: String?, val products: List<ApprovedPlayProduct>) {
    companion object {
        private val credits = mapOf("rig_credit_5" to 500L, "rig_credit_10" to 1000L, "rig_credit_25" to 2500L)
        fun parse(value: JSONObject): PlayConfiguration {
            if (!value.optBoolean("recoveryReady")) return PlayConfiguration(false, false, null, emptyList())
            require(value.getString("currency") == "EUR" && value.getString("mode") in setOf("live", "test"))
            val account = value.getString("accountId")
            require(Regex("^[a-f0-9]{64}$").matches(account))
            val array = value.getJSONArray("products")
            val products = (0 until array.length()).map { index ->
                val item = array.getJSONObject(index)
                ApprovedPlayProduct(item.getString("productId"), item.getLong("creditsCents"), item.getLong("priceCents")).also {
                    require(credits[it.productId] == it.creditsCents && it.priceCents in 1..100_000)
                }
            }
            require(products.map { it.productId }.distinct().size == products.size)
            return PlayConfiguration(value.optBoolean("enabled"), true, account, products)
        }
    }
}

/** Native Play checkout. The app never grants credit and never consumes or
 * acknowledges purchases. RIG verifies Google proof, credits once, and then
 * consumes server-side; an interrupted response remains recoverable. */
class RigPlayBilling(context: Context, private val repository: RigRepository, private val scope: CoroutineScope) {
    private val mutex = Mutex()
    private val mutableState = MutableStateFlow(RigBillingState())
    val state: StateFlow<RigBillingState> = mutableState.asStateFlow()
    private var closed = false
    private val billing = BillingClient.newBuilder(context.applicationContext)
        .setListener { result, _ ->
            scope.launch {
                if (closed) return@launch
                if (result.responseCode == BillingClient.BillingResponseCode.USER_CANCELED) {
                    mutableState.value = mutableState.value.copy(loading = false, message = "De Google-betaling is geannuleerd. Er is geen tegoed verondersteld.")
                }
                // Query the Play-owned receipt list rather than trusting a
                // callback to update a wallet or a now-changed RIG account.
                refresh()
            }
        }
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableAutoServiceReconnection()
        .build()

    suspend fun refresh() = mutex.withLock {
        if (closed) return@withLock
        val user = try {
            repository.store.session()?.userId ?: run { mutableState.value = RigBillingState(message = "Meld je aan om je tegoed te bekijken."); return@withLock }
        } catch (error: RigStorageUnavailable) {
            mutableState.value = RigBillingState(pending = true, message = error.message.orEmpty())
            return@withLock
        }
        mutableState.value = mutableState.value.copy(loading = true)
        try {
            val config = configuration(user)
            if (!config.recoveryReady) { mutableState.value = RigBillingState(); return@withLock }
            connect()
            var intent = status(user)
            var unmatched = false
            for (purchase in purchases()) {
                repository.checkUser(user)
                if (!ownedPurchase(purchase, config)) { unmatched = true; continue }
                val product = purchase.products.single()
                val current = intent
                if (current == null || current.optString("productId") != product || current.optString("accountId") != config.accountId) { unmatched = true; continue }
                if (purchase.purchaseState in setOf(Purchase.PurchaseState.PURCHASED, Purchase.PurchaseState.PENDING)) {
                    intent = repository.api.post("/payments/google-play/confirm", JSONObject()
                        .put("intentId", current.getString("intentId")).put("productId", product).put("purchaseToken", purchase.purchaseToken))
                    repository.checkUser(user)
                }
            }
            if (intent != null && intent.optString("state") == "credited" && intent.optBoolean("consumed") && !intent.optBoolean("recoveryPending")) {
                repository.store.write("play-$user", null)
            }
            val blocked = unmatched || intent?.optBoolean("newPurchasesBlocked") == true
            val resumable = !unmatched && intent?.optString("state") == "prepared" && intent.optLong("expiresAt") > System.currentTimeMillis()
            val display = if (config.enabled && (!blocked || resumable)) offers(config).map { it.display }
                .filter { !resumable || it.productId == intent?.optString("productId") } else emptyList()
            repository.checkUser(user)
            mutableState.value = RigBillingState(available = config.enabled && (!blocked || resumable) && display.isNotEmpty(), packages = display,
                pending = blocked, message = when {
                    unmatched -> "Een bestaande Google-aankoop wordt nog gecontroleerd. Gebruik hetzelfde RIG-account en koop niet opnieuw."
                    intent?.optString("state") == "credited" -> if (blocked) "Je tegoed is bijgeschreven. De Google-afhandeling loopt nog." else "Je aankoop is bevestigd. Je actuele RIG-tegoed staat bij je account."
                    resumable -> "Je Google-betaling is nog niet afgerond. Je kunt hetzelfde pakket veilig hervatten."
                    blocked -> "Je aankoop wordt gecontroleerd. Koop niet opnieuw; je tegoed verschijnt na de bevestiging."
                    !config.enabled -> "Nieuwe Google Play-aankopen zijn nog niet beschikbaar. Bestaande aankopen blijven gecontroleerd."
                    display.isEmpty() -> "Deze tegoedpakketten zijn nog niet beschikbaar in Google Play."
                    else -> "Je betaalt veilig via Google Play. RIG schrijft je tegoed na de betaalbevestiging bij."
                }, resumeProductId = if (resumable) intent?.optString("productId") else null)
        } catch (error: CancellationException) { throw error } catch (error: Exception) {
            mutableState.value = RigBillingState(pending = pendingAfterFailure(user),
                message = if (error is RigStorageUnavailable || error is RigApiException && error.status == 401) error.message.orEmpty() else "Je aankoopstatus kon niet worden gecontroleerd. Koop niet opnieuw als je al hebt betaald.")
        }
    }

    suspend fun purchase(activity: Activity, productId: String) = mutex.withLock {
        if (closed) return@withLock
        val user = repository.requireSession().userId
        mutableState.value = mutableState.value.copy(loading = true, available = false)
        try {
            val config = configuration(user)
            check(config.enabled && config.recoveryReady) { "Google Play-aankopen zijn nog niet beschikbaar." }
            connect()
            val receipts = purchases()
            check(receipts.isEmpty()) { "Er is nog een Google-aankoop om te controleren. Koop niet opnieuw." }
            var intent = status(user)
            if (intent?.optBoolean("newPurchasesBlocked") == true) {
                // A dismissed, not-yet-paid sheet may be explicitly reopened;
                // pending/credited/refund purchases may never be charged again.
                check(intent.optString("state") == "prepared" && intent.optString("productId") == productId && intent.optLong("expiresAt") > System.currentTimeMillis()) {
                    "Je bestaande aankoop wordt nog gecontroleerd. Koop niet opnieuw."
                }
            }
            // ProductDetails are refreshed immediately before showing Google's
            // sheet; only the server-approved exact EUR amount is accepted.
            val offer = offers(config).singleOrNull { it.display.productId == productId }
                ?: throw IllegalStateException("Dit pakket heeft nog geen bevestigde Google-prijs.")
            repository.checkUser(user)
            if (intent == null || intent.optString("state") != "prepared" || intent.optLong("expiresAt") <= System.currentTimeMillis()) {
                val old = repository.store.read("play-$user")
                val requestId = playPurchaseRequestId(old, intent, productId, requireNotNull(config.accountId))
                repository.store.write("play-$user", JSONObject().put("intentId", requestId).put("productId", productId).put("accountId", config.accountId))
                intent = repository.api.post("/payments/google-play/intents", JSONObject().put("productId", productId).put("requestId", requestId))
            }
            require(intent.getString("productId") == productId && intent.getString("accountId") == config.accountId && intent.getString("state") == "prepared" &&
                intent.getLong("creditsCents") == offer.display.creditsCents && intent.getLong("expiresAt") > System.currentTimeMillis()) { "Deze aankoop kon niet veilig worden voorbereid." }
            repository.store.write("play-$user", JSONObject().put("intentId", intent.getString("intentId")).put("productId", productId).put("accountId", config.accountId))
            repository.checkUser(user)
            val productParams = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(offer.details)
                .apply { offer.offerToken?.let(::setOfferToken) }.build()
            mutableState.value = RigBillingState(pending = true, message = "Rond je aankoop af in het beveiligde Google Play-scherm.")
            val result = withContext(Dispatchers.Main.immediate) {
                repository.checkUser(user)
                billing.launchBillingFlow(activity, BillingFlowParams.newBuilder().setProductDetailsParamsList(listOf(productParams))
                    .setObfuscatedAccountId(config.accountId!!).build())
            }
            check(result.responseCode == BillingClient.BillingResponseCode.OK) { "Google Play kon het betaalscherm niet openen. Controleer je aankoopstatus voordat je opnieuw probeert." }
        } catch (error: CancellationException) { throw error } catch (error: Exception) {
            mutableState.value = RigBillingState(pending = pendingAfterFailure(user),
                message = error.message?.takeIf { it.length < 250 && !it.contains("http") } ?: "De aankoop kon niet worden gestart. Controleer eerst je aankoopstatus.")
        }
    }

    private fun pendingAfterFailure(user: String) = try {
        repository.store.read("play-$user") != null
    } catch (_: RigStorageUnavailable) { true }

    private suspend fun configuration(user: String): PlayConfiguration = PlayConfiguration.parse(repository.api.get("/payments/google-play/config")).also { repository.checkUser(user) }

    private suspend fun status(user: String): JSONObject? {
        val local = repository.store.read("play-$user")
        val id = local?.optString("intentId")?.takeIf { Regex("^[a-f0-9-]{36}$").matches(it) }
        val value = repository.api.get("/payments/google-play/status" + if (id == null) "" else "?intentId=$id")
        repository.checkUser(user)
        return value.optJSONObject("intent")
    }

    private fun ownedPurchase(purchase: Purchase, config: PlayConfiguration): Boolean = purchase.products.size == 1 && purchase.quantity == 1 &&
        config.products.any { it.productId == purchase.products.single() } && purchase.accountIdentifiers?.obfuscatedAccountId == config.accountId

    private data class Offer(val details: ProductDetails, val offerToken: String?, val display: RigCreditPackage)
    private suspend fun offers(config: PlayConfiguration): List<Offer> {
        if (config.products.isEmpty()) return emptyList()
        val query = QueryProductDetailsParams.newBuilder().setProductList(config.products.map {
            QueryProductDetailsParams.Product.newBuilder().setProductId(it.productId).setProductType(BillingClient.ProductType.INAPP).build()
        }).build()
        val details = withTimeout(20_000) { suspendCancellableCoroutine<List<ProductDetails>> { continuation ->
            billing.queryProductDetailsAsync(query) { result, response ->
                if (!continuation.isActive) return@queryProductDetailsAsync
                if (result.responseCode == BillingClient.BillingResponseCode.OK) continuation.resume(response.productDetailsList)
                else continuation.resumeWithException(IllegalStateException("Google Play kon de prijzen niet controleren."))
            }
        } }
        return details.mapNotNull { detail ->
            val approved = config.products.singleOrNull { it.productId == detail.productId } ?: return@mapNotNull null
            val matching = detail.oneTimePurchaseOfferDetailsList.orEmpty().filter { it.priceCurrencyCode == "EUR" && it.priceAmountMicros == approved.priceCents * 10_000 }
            // Ambiguous/discounter offers must not select an unexpected amount.
            val offer = matching.singleOrNull() ?: return@mapNotNull null
            Offer(detail, offer.offerToken, RigCreditPackage(approved.productId, approved.creditsCents, approved.priceCents, offer.formattedPrice))
        }.sortedBy { it.display.creditsCents }
    }

    private suspend fun purchases(): List<Purchase> = withTimeout(20_000) { suspendCancellableCoroutine { continuation ->
        billing.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build()) { result, list ->
            if (!continuation.isActive) return@queryPurchasesAsync
            if (result.responseCode == BillingClient.BillingResponseCode.OK) continuation.resume(list)
            else continuation.resumeWithException(IllegalStateException("Je Google-aankopen konden niet worden gecontroleerd."))
        }
    } }

    private suspend fun connect() {
        if (billing.isReady) return
        withTimeout(20_000) { suspendCancellableCoroutine<Unit> { continuation ->
            billing.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(result: BillingResult) {
                    if (!continuation.isActive) return
                    if (result.responseCode == BillingClient.BillingResponseCode.OK) continuation.resume(Unit)
                    else continuation.resumeWithException(IllegalStateException("Google Play is niet beschikbaar op dit apparaat."))
                }
                override fun onBillingServiceDisconnected() { /* automatic reconnect; never retry a purchase */ }
            })
        } }
    }

    fun close() { closed = true; billing.endConnection() }
}
