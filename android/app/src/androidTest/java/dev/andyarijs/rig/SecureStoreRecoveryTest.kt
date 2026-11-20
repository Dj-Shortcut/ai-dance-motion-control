package dev.andyarijs.rig

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.andyarijs.rig.data.PendingGeneration
import dev.andyarijs.rig.data.RigSecureStore
import dev.andyarijs.rig.data.RigStorageUnavailable
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class SecureStoreRecoveryTest {
    @Test fun unavailableKeystorePreservesCiphertextAndDoesNotInventAReplacementKey() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefsName = "rig-test-${UUID.randomUUID()}"
        val prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
        val alias = "rig-test-${UUID.randomUUID()}"
        val unavailableAlias = "$alias-unavailable"
        val user = "u-12345678-1234-4123-8123-123456789abc"
        val original = RigSecureStore(context, prefsName, alias)
        val unavailable = RigSecureStore(context, prefsName, unavailableAlias)
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        try {
            val record = PendingGeneration(user, "quote-1", "intent-1")
            original.savePending(record)
            val ciphertext = prefs.getString("generation-$user", null)
            assertNotNull(ciphertext)
            assertThrows(RigStorageUnavailable::class.java) { unavailable.pending(user) }
            assertThrows(RigStorageUnavailable::class.java) { unavailable.write("login", JSONObject()) }
            assertFalse(keys.containsAlias(unavailableAlias))
            assertEquals(ciphertext, prefs.getString("generation-$user", null))
            assertEquals(record, original.pending(user))
        } finally {
            context.deleteSharedPreferences(prefsName)
            keys.deleteEntry(alias)
            if (keys.containsAlias(unavailableAlias)) keys.deleteEntry(unavailableAlias)
        }
    }
}
