# Native Android account and API contract

The Android interface is native Kotlin/Compose. Only account sign-in uses the
system browser. No website UI or WebView is embedded in the app.

## Account continuity

The app opens the existing Sites host at `/native/signin?challenge=<S256>&state=<random>`.
The platform authenticates its existing ChatGPT account. After explicit consent,
RIG returns a one-use, five-minute authorization code through the fixed
`dev.andyarijs.rig://auth/callback?code=...&state=...` callback. PKCE and the app's
persisted state protect the callback. A client-selected redirect is never used.

`POST https://rig-api.shortcut-computerguy.workers.dev/api/native/auth/exchange`
accepts exactly `{code,codeVerifier}` and returns
`{accessToken,tokenType:"Bearer",expiresAt,userId,currency:"EUR",mode:"live"}`.
The token is `rig_native_` plus 43 base64url characters, 30 days, server revocable,
stored only SHA-256 hashed in D1 and encrypted with Android Keystore on-device.
There is no refresh token. `POST /api/native/auth/logout` with bearer and `{}`
revokes only the current native session.

An authorization is issued only for a signed Site identity. Native session reads
join that same existing site/subject/user tuple. No email account linking, role
input, mode override, separate wallet or provider secret is introduced.

## Private transport and spending gates

`nativeApiPath()` is an explicit subset: owned video/upload/quote/generation/draft
routes, customer passkey operations, Google Play purchase operations, plus owner
security status and verification for `owner-generation` only. Native has no
Mollie checkout, financial administration, key enrollment for the owner, internal
API, raw provider route or arbitrary URL relay.

The public relay strips platform/Sites identity headers and cookies. Native
requests must have no browser Origin; bearer is required except the exchange.
The private service hashes and validates that bearer, then internally signs the
existing Sites protocol with its stored subject hash. Existing handlers still
verify tenant, identity, budgets, resource lease, ownership, exact quote, funds,
margin, temporary transfer consent, passkey proof and atomic job/ledger fencing.

Native uploads send the exact prepared-byte SHA-256 in
`x-rig-native-body-sha256`. Existing preparation admission and its shared lease
occur before reading the upload stream, then the exact body digest is verified.
The local original large phone video is not submitted as an identity image.

Quote responses contain `approvalToken` and `idempotencyKey`, as the website does.
They authorize no spending without the customer's fresh operation-bound passkey.
Owner jobs keep existing direct-Fal funding and the independent owner key; the
app cannot enroll or approve a new owner key.

## Native passkey trust

The ONLY native proof origin is `android:apk-key-hash:<base64url SHA256 cert>`
derived from the server's public `RIG_NATIVE_ANDROID_SIGNING_SHA256` binding.
A module-private transport capability enables that origin only after native
session authentication. Ordinary web requests keep the exact existing Site
origin, including when a signing certificate is configured. RP ID stays the
existing RIG Sites hostname. UV is always required. Native `crossOrigin` may be
absent (the Android default) or false; true and `topOrigin` remain rejected.

Sites DAL must list `delegate_permission/common.get_login_creds` for the exact
package and verified installed signing certificate. The public certificate is
not a secret and never a client-supplied trust override.

## Current native feature gate

Direct Pro/standard motion, configured video editing and direct 1080P Human
Recast use the existing handlers. The native interface prefers the already
configured Recast route for person replacement, using one portrait, original
audio and a 6–15 second fragment. It does not enable a provider flag or silently
change to another model. Multi-step cleanup remains excluded; native requests
containing workflow/cleanup markers and confirmation of stored workflow quotes
are rejected. Existing website workflows remain unchanged.

The native owner header reads only GET `/api/native/provider-balance`. The server
checks the pinned owner before consulting Fal and returns only verified
`availableUsdMicros`, USD currency and the observation/freshness times. Customers
retain their own EUR wallet and cannot read provider credit. The owner amount is
plain text, updates only while the app is foregrounded and becomes unavailable
when stale or unreadable; a failure never manufactures zero credit.

Verification lives in `native-auth.test.mjs`, `native-auth-workerd.test.mjs` and
`production-ingress.test.mjs`. Tests cover real D1 redemption races/replay,
expiry/revocation, account isolation, forged headers, strict route filtering,
actual signed Android/WebAuthn proofs for customer and owner, UV, exact quote
binding, and resource admission before upload reads. Fixture provider handlers
are inert; passing these tests does not claim a real paid Android generation or
Google purchase has been accepted.
