package dev.andyarijs.rig.security

import android.app.Activity
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import dev.andyarijs.rig.data.RigQuote
import dev.andyarijs.rig.data.RigRepository
import org.json.JSONObject

/** Uses the actual WebAuthn challenge and exact generation payload. A local
 * biometric prompt alone is never treated as authorization by RIG. Android's
 * signing-certificate origin must be approved on the server and in the Site's
 * Digital Asset Links; the server fails closed until both are configured. */
class RigDeviceSecurity(private val repository: RigRepository) {
    suspend fun status(owner: Boolean = false): JSONObject = repository.api.get(if (owner) "/owner/security" else "/security")

    suspend fun register(activity: Activity): JSONObject {
        val user = repository.requireSession().userId
        val challenge = repository.api.post("/security/registration/options", JSONObject().put("label", "Mijn Android-telefoon"))
        val response = CredentialManager.create(activity).createCredential(activity,
            CreatePublicKeyCredentialRequest(challenge.getJSONObject("publicKey").toString()))
        repository.checkUser(user)
        check(response is CreatePublicKeyCredentialResponse) { "De passkey is niet ingesteld." }
        return repository.api.post("/security/registration/verify", JSONObject().put("challengeId", challenge.getString("challengeId"))
            .put("credential", JSONObject(response.registrationResponseJson)))
    }

    suspend fun verify(activity: Activity, quote: RigQuote): JSONObject {
        check(quote.funding in setOf("credits", "owner-provider")) { "Deze video gebruikt geen apparaatbevestiging." }
        val user = repository.requireSession().userId
        val owner = quote.funding == "owner-provider"
        val challenge = repository.api.post(if (owner) "/owner/security/verification/options" else "/security/verification/options",
            JSONObject().put("operation", if (owner) "owner-generation" else "customer-generation").put("payload", quote.confirmationPayload()))
        val options = GetPublicKeyCredentialOption(challenge.getJSONObject("publicKey").toString())
        val response = CredentialManager.create(activity).getCredential(activity, GetCredentialRequest(listOf(options)))
        repository.checkUser(user)
        val credential = response.credential
        check(credential is PublicKeyCredential) { "Je apparaatbevestiging is niet afgerond." }
        return JSONObject().put("challengeId", challenge.getString("challengeId"))
            .put("credential", JSONObject(credential.authenticationResponseJson))
    }
}
