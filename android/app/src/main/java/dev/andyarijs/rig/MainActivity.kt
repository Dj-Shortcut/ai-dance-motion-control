package dev.andyarijs.rig

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.viewModels
import androidx.lifecycle.lifecycleScope
import androidx.browser.customtabs.CustomTabsIntent
import kotlinx.coroutines.launch

/** The browser is used only for the external identity provider, never for RIG screens. */
class MainActivity : ComponentActivity() {
    private val model: RigViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        handleCallback(intent)
        setContent { RigApp(model, onLogin = {
            runCatching { CustomTabsIntent.Builder().build().launchUrl(this, model.beginLogin()) }
                .onFailure { model.showError(it) }
        }, onConfirm = { lifecycleScope.launch { model.confirm(this@MainActivity) } },
            onRegister = { lifecycleScope.launch { model.register(this@MainActivity) } },
            onPurchase = { id -> lifecycleScope.launch { model.purchase(this@MainActivity, id) } }) }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); handleCallback(intent) }
    override fun onResume() { super.onResume(); model.resume() }
    private fun handleCallback(intent: Intent?) {
        val uri = intent?.data ?: return
        if (intent.action != Intent.ACTION_VIEW) return
        // RigLoginManager checks the exact callback, state, expiry and PKCE verifier.
        lifecycleScope.launch { model.completeLogin(uri) }
        intent.data = null
    }
}
