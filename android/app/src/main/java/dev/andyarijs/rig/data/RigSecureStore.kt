package dev.andyarijs.rig.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Small app-private records encrypted with a non-exportable Android Keystore key.
 * Auto backup is disabled in the manifest; neither provider keys nor passkey
 * private keys ever enter this store. Payment tokens are recovered from Play. */
class RigSecureStore(context: Context) : RigStore {
    private val preferences = context.getSharedPreferences("rig_native_private_v1", Context.MODE_PRIVATE)
    private val alias = "rig_native_store_v1"

    @Synchronized private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }

    @Synchronized override fun write(name: String, value: JSONObject?) {
        require(Regex("^[a-zA-Z0-9_-]{1,150}$").matches(name))
        val editor = preferences.edit()
        if (value == null) editor.remove(name) else {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()); updateAAD(name.toByteArray()) }
            val encrypted = cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8))
            val packed = JSONObject().put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP))
            editor.putString(name, packed.toString())
        }
        check(editor.commit()) { "Je beveiligde opdracht kon niet worden bewaard. Er is niets gestart." }
    }

    @Synchronized override fun read(name: String): JSONObject? {
        val packed = preferences.getString(name, null) ?: return null
        return try {
            val value = JSONObject(packed)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(value.getString("iv"), Base64.NO_WRAP)))
                updateAAD(name.toByteArray())
            }
            JSONObject(String(cipher.doFinal(Base64.decode(value.getString("ciphertext"), Base64.NO_WRAP)), Charsets.UTF_8))
        } catch (_: Exception) {
            // Never fall back to plaintext or keep a partially decrypted token.
            preferences.edit().remove(name).commit()
            null
        }
    }

}
