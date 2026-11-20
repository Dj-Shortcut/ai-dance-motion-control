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
class RigSecureStore internal constructor(context: Context, storageName: String, private val alias: String) : RigStore {
    constructor(context: Context) : this(context, "rig_native_private_v1", "rig_native_store_v1")
    companion object { private val sharedLock = Any() }
    override val transactionLock: Any get() = sharedLock
    private val preferences = context.getSharedPreferences(storageName, Context.MODE_PRIVATE)

    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        check(create && preferences.all.isEmpty()) { "Opslagsleutel niet beschikbaar." }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }

    override fun write(name: String, value: JSONObject?) = synchronized(transactionLock) {
        require(Regex("^[a-zA-Z0-9_-]{1,150}$").matches(name))
        val editor = preferences.edit()
        if (value == null) editor.remove(name) else {
            try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(create = true)); updateAAD(name.toByteArray()) }
                val encrypted = cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8))
                val packed = JSONObject().put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                    .put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                editor.putString(name, packed.toString())
            } catch (error: Exception) { throw RigStorageUnavailable(error) }
        }
        check(editor.commit()) { "Je beveiligde opdracht kon niet worden bewaard. Er is niets gestart." }
    }

    override fun read(name: String): JSONObject? = synchronized(transactionLock) {
        try {
            val packed = preferences.getString(name, null) ?: return@synchronized null
            val value = JSONObject(packed)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key(create = false), GCMParameterSpec(128, Base64.decode(value.getString("iv"), Base64.NO_WRAP)))
                updateAAD(name.toByteArray())
            }
            JSONObject(String(cipher.doFinal(Base64.decode(value.getString("ciphertext"), Base64.NO_WRAP)), Charsets.UTF_8))
        } catch (error: Exception) { throw RigStorageUnavailable(error) }
    }

}
