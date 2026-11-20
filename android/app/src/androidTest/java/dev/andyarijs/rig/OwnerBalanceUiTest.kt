package dev.andyarijs.rig

import android.graphics.Bitmap
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.andyarijs.rig.data.RigProviderBalance
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Isolated native component tests with explicit synthetic amounts. This host
 * has no ViewModel, repository, session, account fixture or network client. */
@RunWith(AndroidJUnit4::class)
class OwnerBalanceUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun positiveProviderBalanceUsesDollarsAndNeverActsAsACreditPurchaseButton() {
        show(fresh(12_340_000))
        assertUsdAmount("12,34")
        assertPassiveLabel()
        screenshot("owner-balance-positive")
    }

    @Test fun verifiedZeroIsDisplayedAsAnActualUsdZero() {
        show(fresh(0))
        assertUsdAmount("0,00")
        assertPassiveLabel()
        screenshot("owner-balance-zero")
    }

    @Test fun loadingDoesNotInventAZeroBalance() {
        show(null, loading = true)
        assertUnavailableAmount()
        assertPassiveLabel()
        screenshot("owner-balance-loading")
    }

    @Test fun failedRefreshRemovesThePreviousAmountRatherThanReplacingItWithZero() {
        val balance = mutableStateOf<RigProviderBalance?>(fresh(45_670_000))
        compose.setContent { HeaderHarness { RigOwnerBalance(balance.value) } }
        assertUsdAmount("45,67")
        compose.runOnIdle { balance.value = null }
        assertUnavailableAmount()
        assertFalse(balanceText().contains("45,67"))
        assertPassiveLabel()
        screenshot("owner-balance-unavailable")
    }

    @Test fun anExpiredProviderReadingCannotBePresentedAsAnUpToDateAmount() {
        val now = System.currentTimeMillis()
        show(RigProviderBalance(78_900_000, "USD", now - 90_000, now - 30_000))
        assertUnavailableAmount()
        assertFalse(balanceText().contains("78,90"))
        assertPassiveLabel()
        screenshot("owner-balance-expired")
    }

    @Test fun anOnscreenReadingStopsBeingAnAmountWhenItsFreshnessWindowExpires() {
        val now = System.currentTimeMillis()
        show(RigProviderBalance(23_450_000, "USD", now, now + 3_000))
        assertUsdAmount("23,45")
        compose.waitUntil(6_000) { !balanceText().contains("23,45") }
        assertUnavailableAmount()
        assertPassiveLabel()
        screenshot("owner-balance-expired-live")
    }

    private fun fresh(micros: Long): RigProviderBalance {
        val now = System.currentTimeMillis()
        return RigProviderBalance(micros, "USD", now, now + 30_000)
    }

    private fun show(balance: RigProviderBalance?, loading: Boolean = false) {
        compose.setContent { HeaderHarness { RigOwnerBalance(balance, loading) } }
        compose.onNodeWithTag(TAG).assertIsDisplayed()
    }

    private fun assertUsdAmount(amount: String) {
        val label = balanceText()
        assertTrue("The native header must identify the provider balance as US dollars: $label", label.contains("US$") || label.contains("USD"))
        assertTrue("The amount must use Belgian Dutch formatting: $label", label.contains(amount))
        assertFalse("Fal dollars must never be labeled as RIG euro credit.", label.contains("€") || label.contains("RIG-tegoed"))
    }

    private fun assertUnavailableAmount() {
        val label = balanceText()
        assertTrue("The header must explain that the reading is unavailable or loading.", label.isNotBlank())
        assertFalse("An unavailable balance is not a verified zero.", label.contains("0,00") || label.contains("0.00"))
        assertFalse("An unavailable reading must not use the customer credit currency.", label.contains("€"))
    }

    private fun assertPassiveLabel() {
        compose.onNodeWithTag(TAG).assertIsDisplayed().assert(SemanticsMatcher.keyNotDefined(SemanticsActions.OnClick))
    }

    private fun balanceText(): String {
        val node = compose.onNodeWithTag(TAG).fetchSemanticsNode()
        fun strings(node: androidx.compose.ui.semantics.SemanticsNode): List<String> {
            val own = if (node.config.contains(SemanticsProperties.Text)) node.config[SemanticsProperties.Text].map { it.text } else emptyList()
            return own + node.children.flatMap { strings(it) }
        }
        return strings(node).joinToString(" ")
    }

    private fun screenshot(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        compose.waitUntil(10_000) { instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == "dev.andyarijs.rig" }
        val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: error("No native display screenshot was available.")
        try {
            File(instrumentation.targetContext.cacheDir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        } finally { bitmap.recycle() }
    }

    companion object { private const val TAG = "rig-owner-balance" }
}

/** A narrow phone header is deliberate: this makes truncation visible without
 * creating a synthetic logged-in account or exercising a provider endpoint. */
@Composable
private fun HeaderHarness(balance: @Composable () -> Unit) {
    val foreground = Color(0xffeef2f0)
    MaterialTheme(colorScheme = darkColorScheme(primary = Color(0xff8fe3b8), background = Color(0xff101416), surface = Color(0xff1a2023), onSurface = foreground)) {
        Surface(Modifier.fillMaxSize(), color = Color(0xff101416)) {
            Column(Modifier.statusBarsPadding().padding(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(32.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("RIG.", modifier = Modifier.weight(1f), fontSize = 25.sp, fontWeight = FontWeight.Bold, color = foreground)
                    balance()
                    TextButton(onClick = {}) { Text("Account") }
                }
            }
        }
    }
}
