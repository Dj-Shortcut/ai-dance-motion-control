# RIG owner verification

Customer purchases keep the existing account and payment checks. Reading the owner's financial report does not prompt for a passkey. Changing financial records or cost policy requires a fresh device-verified passkey assertion for that exact request. The only exception is lowering the daily Fal limit while keeping every other policy field unchanged; the server classifies this and the policy version is checked again by the write.

Direct owner-funded generation also requires a fresh assertion for its quote and request key. Customer-funded generation retains the prepaid ledger and shared provider-cost ceiling. No payment-provider payout operation is exposed by these features.

## First device

1. Open the production RIG origin directly in Chrome or Safari. In **Financiën**, choose to set up owner verification and personally complete the native device prompt.
2. The server verifies registration but stores the key as **pending**. A RIG cookie cannot approve or replace a key.
3. An independently authenticated Cloudflare administrator checks the exact candidate identifier and public-key fingerprint shown after that personal ceremony. Approve only that pending, unexpired candidate for the pinned owner. The release operator's `approve-device.py` performs these checks; it cannot create an enrollment window or replace an active key.
4. Refresh the security status. Every protected operation still needs a fresh signed assertion. Activation does not provide a reusable unlock token.

The relying-party identifier is exactly `rig-motion-studio.shortcutcomputerguy.chatgpt.site`. Cross-origin enrollment and parent-domain keys are not allowed. Device keys are held by the authenticator; RIG stores the public key. The server requires user verification. Synced passkeys with a zero counter are supported; one-use operation challenges remain mandatory.

## Atomic enforcement

`prepareOwnerMutation` verifies the WebAuthn assertion and returns prepared statements plus a SQL gate. Its caller MUST put those statements and the guarded state change in one D1 batch. A random per-use token, owner, operation, canonical request hash, expiration and credential counter bind the gate. Replaying an assertion cannot reuse the successful transaction's token. Existing accepted generation requests can be read or recovered without a new charge.

New privileged features must declare their exact operation and validated payload, provide a readable confirmation summary, and use the same atomic mutation gate. A browser flag or a recent-login timestamp is not authorization.

## Loss and recovery

There is no cookie-only key reset, deletion or recovery endpoint. If the first device is lost, use the independent Cloudflare administrator process, verify the operator outside the RIG session, revoke the old public key, and repeat exact-candidate enrollment. Do not approve an arbitrary pending candidate merely because it exists. Keep independent administrator access protected.

## Resource protection

Production media preparation has cumulative daily limits on attempts and admitted bytes, for each account and for the whole service. Admission is atomic and happens before the private backend buffers or transforms media. Unknown and failed admitted attempts remain counted. The owner has the same resource limits. This bounds preparation work; it is not a promise of zero hosting cost.

## Test boundary

Local fixtures use real WebAuthn cryptographic signatures but software test keys, fake identities and blocked provider transports. OWASP ZAP probes only the isolated loopback copy. Neither these tests nor an empty scanner result certify the complete production system. Real device enrollment, platform sign-in and a deliberately approved production operation remain separate checks.
