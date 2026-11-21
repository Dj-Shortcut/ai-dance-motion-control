# RIG Android / Google Play release preparation

Requirements checked against the official sources linked below on **19 November 2026**. Recheck them before submission: Play requirements and billing programs can change. This document records release gates, not proof that they have passed. Google decides whether to approve an app.

The user chose to prepare for Google Play now and to use **Google Play purchases in Android**. The ordinary website keeps **Mollie**. The Android entry must not fall back to Mollie. Existing RIG credit remains usable while Google purchases are unavailable. Alternative-billing enrollment and prices have not been changed.

## Build output is not a store release

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Compiled project / automated checks | The checked source compiles and the stated checks pass | Installation, login, video processing or Play approval |
| Signed debug APK | A development package can be installed on an appropriate test device | Production signing, verified domain association or store readiness |
| Signed release APK | An installable package signed by the identified certificate | A Play submission or a successful real-device workflow |
| Signed AAB | A publishing bundle for Play; record its upload certificate and SHA-256 | A directly installable APK, completed Play declarations or approval |
| Closed/internal Play test | The uploaded release is available to its permitted testers | Public production availability |
| Production approval and published listing | Google accepted that submission and published the release | Automatic approval of future updates |

Android packages must be signed. For a new Play app, use an AAB and Play App Signing: the developer's **upload key** signs uploads; Google's **app signing key** signs the APKs users install. Keep keystores/passwords outside Git and retain a secure backup. Do not confuse a local upload/debug certificate with the Play-distributed certificate. [Signing guide](https://developer.android.com/studio/publish/app-signing), [AAB and Play App Signing](https://developer.android.com/guide/app-bundle/faq).

## Account, target and testing gates

- [ ] Confirm the user's actual Play Console account type and verification status; these are currently unknown. Choose the type that matches the real publisher, rather than choosing a type to avoid testing requirements.
- [ ] The user completes registration agreements, payment and identity verification. Play currently charges **US$25 once**. An organization account normally requires a D-U-N-S number; do not assume a Belgian sole trader already has the required registration evidence. [Registration](https://support.google.com/googleplay/android-developer/answer/6112435?hl=en), [required information](https://support.google.com/googleplay/android-developer/answer/13628312?hl=en).
- [ ] Target **Android 16 / API 36 or higher** for a new phone app under the requirement effective 31 August 2026. Verify the built manifest, not just a build-script variable. [Target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en).
- [ ] If the publisher uses a personal account created after 13 November 2023, complete a closed test with at least **12 testers continuously opted in for 14 days**, then apply for production access. The minimum elapsed period is not a guaranteed launch date; Google also reviews the testing information. [Testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465).
- [ ] Complete the actual store listing, content rating, target audience, privacy policy, app access and Data safety declarations from implemented behavior. Record Console outcomes and any remaining review tasks.

## Native implementation (20 November 2026)

Version 0.2.0 replaces the browser wrapper with Kotlin/Jetpack Compose screens.
Only external sign-in uses Custom Tabs, with a single-use PKCE code returned to
the certificate-verified HTTPS `/native/callback` App Link on the fixed RIG Sites
host. The native API reuses the existing private RIG price, funding, passkey and
generation gates; credentials never reach a WebView. The active build no longer
contains browser payment services. The exact native signing certificate must be
associated using `delegate_permission/common.handle_all_urls` and
`delegate_permission/common.get_login_creds`; web passkey origins remain separate.
The prior TWA evidence and browser/Digital Goods checks below describe the old
wrapper, not proof that the new native workflow has been accepted on a phone.
Google Console, actual purchase tests and the remaining store requirements
still apply. See [the native client contract](../android/README.md).

## Website association and login

Prefer browser-backed authentication over collecting ChatGPT credentials in an app-owned form. Custom Tabs share the selected browser's cookie state; a Trusted Web Activity (TWA) is browser-rendered and additionally verifies common ownership of the app and website. The Android host does not gain access to browser cookies. This architecture does **not** establish that RIG's real login/return flow has been tested. [Custom Tabs](https://developer.chrome.com/docs/android/custom-tabs), [TWA overview](https://developer.chrome.com/docs/android/trusted-web-activity).

For the native callback App Link (and any TWA use):

- [ ] Freeze the final package ID and identify each intended distribution certificate.
- [ ] Publish the exact package ID and **Play app signing certificate** fingerprint at `https://<RIG-host>/.well-known/assetlinks.json`. A local upload-key fingerprint alone is insufficient for Play installs. Keep debug associations out of the production association unless explicitly needed and reviewed.
- [ ] Verify that the current `chatgpt.site` host actually serves the association publicly over HTTPS as JSON, without a login wall or redirect. Hosting source changes alone are not evidence of public accessibility. Do not claim fullscreen TWA verification while the association is unavailable.
- [ ] Verify the installed app's domain association on a device, using the distribution artifact being tested. A toolbar fallback is a Custom Tab, not proof of a verified TWA.

[Website association configuration](https://developer.android.com/training/app-links/configure-assetlinks), [device verification](https://developer.android.com/training/app-links/verify-applinks).

Test the real ChatGPT sign-in, cancel/back behavior, return URL, logout, expired session, process recreation and screen-lock recovery on Android. Restrict claimed links to RIG's host; do not claim OpenAI authentication domains. Keep Fal/Mollie keys and bridge-signing secrets server-side.

For Play review, provide reusable reviewer access and clear English instructions through Console. Restricted features must be reviewable without the publisher manually supplying a fresh OTP each time. Use a separate ordinary reviewer account with bounded access; do not disclose the owner's credentials, remove customer verification, or grant administrative privileges. A safe reviewer-access solution for the platform-hosted login is still to be verified. [Reviewer sign-in requirements](https://support.google.com/googleplay/android-developer/answer/15748846?hl=en).

## Payment decision and activation gates

The selected channel is **Google Play consumable credit purchases on Android**;
the ordinary website keeps Mollie. Existing RIG credit remains usable when Play
purchases are unavailable. Preserve the Android channel through login returns and
navigation; never fall back to Mollie or offer an unconfigured purchase sheet.
Alternative billing enrollment is not part of this implementation.

Google's payments rules also apply to browser-backed apps. Digital purchases
normally require Play Billing unless an applicable program permits otherwise.
[Payments guidance](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en),
[TWA billing integration](https://developer.chrome.com/docs/android/trusted-web-activity/receive-payments-play-billing).

Implemented source includes Digital Goods/Payment Request, mandatory native account
binding, authenticated server verification, atomic funded fulfillment, encrypted
retry material, backend-only consumption, pending/cancelled recovery, authenticated
RTDN, Voided Purchases and refund/reversal handling. Owner-only Google financial
evidence is distinct from Mollie invoices and from actual bank settlement. The
[commerce contract and configuration](google-play-billing-foundation.md) records
the exact routes, defaults, credentials and private license-test harness.

**Customer purchases remain off by default.** Fixture/native/D1 tests are not
proof of an actual purchase or a published store app. Activation still requires:

- [ ] Console registration/approval and the exact `dev.andyarijs.rig` package,
  consumable catalog and approved countries. Initial planning is BE/NL, EUR.
- [ ] Owner-approved actual Google prices for the three wallet values (€5/€10/€25).
  Synthetic 899/1799/4499-cent fixture prices are not recommendations. Actual
  after-tax/fee Google revenue must cover wallet face value before credit.
- [ ] Scoped Publisher credentials, token keyring/HMAC, authenticated Pub/Sub and
  production schema/bindings. Enable processing separately from new sales;
  stopping sales must keep recovery running.
- [ ] Play-distributed certificate/domain association and real device/browser
  billing availability. The local ABH two-class extension passes the mandatory
  account ID to Google's SDK; verify that binding in a real Play receipt.
- [ ] Actual license-tester purchase, pending/cancellation, duplicate confirmation,
  consumed-purchase recovery and refund in the isolated test DB/harness. TEST
  receipts must never credit the live wallet. Missing Orders remains review.
- [ ] First live purchase and settlement reconciliation, with separately recorded
  approval for that real payment. Google revenue exports are not complete
  Accountable/Peppol bookkeeping or proof of payout.

## Account deletion and AI reports

- [ ] Provide a discoverable **RIG account deletion request** inside the app and a public web resource linked in Play's Data safety form. SSO account creation is within scope. Delete the RIG account/data, not the person's ChatGPT account. Explain any necessary security or legally retained financial records and handle downstream provider data appropriately. A fully automatic deletion is not required to initiate a request, but a working request path and fulfillment process are required. Existing implementation/fulfillment has not been verified here. [Account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en).
- [ ] Add a functional offensive-content report/flag action for AI results **without leaving the app**. Verify receipt and owner follow-up; a button, local toast or external `mailto:` alone does not establish this. Prevent prohibited generations and use reports to improve filtering. Existing payment-support forms do not automatically satisfy AI-content reporting. [AI-generated content policy](https://support.google.com/googleplay/android-developer/answer/13985936?hl=en).
- [ ] Check disclosures and Data safety against real name/email collection, media uploads, Fal processing, result retention and temporary media links. Do not describe media as private to RIG if a confirmed processing mode uses temporary bearer links.
- [ ] Include the Android photo check in the Play Data safety declaration. The bundled ML Kit pose detector processes the selected image or video frame, body landmarks and assessment on the device. Google documents collection of app and device information, per-installation identifiers, image format and dimensions, timing and error codes for diagnostics and usage analytics. Pose detection also uses Firebase Remote Config and Firebase Installations for configuration diagnostics. The app links to the RIG privacy page for this disclosure. [ML Kit privacy](https://developers.google.com/ml-kit/terms), [ML Kit Android data disclosure](https://developers.google.com/ml-kit/android-data-disclosure).

## Evidence to attach to a release candidate

- Exact reviewed source commit, clean source status, build command/result, APK/AAB hashes, package/version/target SDK and signing-certificate identity.
- Emulator/device model, Android/browser version, installation result and public DAL/device-verification result.
- Observed login and session-recovery behavior; large photo/video selection, chosen-frame preparation, crop/reference settings, quote, price confirmation, result playback/download and trial-to-full continuation.
- Evidence that the selected billing policy survives every route; separate recorded authorization and bounded cost for any real purchase or Fal generation. Fixture tests do not establish a paid production flow.
- Account-deletion request, in-app AI report receipt and reviewer-access results; current Console declarations, test-track status and remaining blockers.

Do not mark a gate complete without its observable evidence. Building locally, deploying the website, uploading to Play, passing review and publicly releasing are separate outcomes.

## Gratis startfoto's voor testers

De Android-fotostap kan een personage maken op basis van een beschrijving of de gekozen foto bewerken. De gebruiker beslist of die het resultaat bewaart of als startfoto gebruikt. De fotobewerking stuurt alleen de gekozen, genormaliseerde foto naar de OpenAI Images API. De bestaande videobevestiging start desgewenst pas daarna een Fal-opdracht. Neem het gebruik van OpenAI als verwerker op in de toepasselijke privacy-informatie voor de proef.

Activeer de proef pas na migratie `0021_start_photos.sql`, publicatie van de aangepaste relay en privéworker, en installatie van de Android-build. Stel op de privéworker `RIG_OPENAI_IMAGES_KEY` in als geheim van het bedoelde OpenAI-project. Gebruik daarnaast `RIG_START_PHOTO_TESTERS` (kommagescheiden RIG-gebruikers-ID's), `RIG_START_PHOTO_EXPIRES_AT` (ISO 8601 met tijdzone) en `RIG_START_PHOTO_MAX_ATTEMPTS` (maximaal aantal aanvragen voor de hele proef). Zonder geldige configuratie biedt de app de proef niet aan.

De server reserveert vóór verzending één beurt. Er zijn maximaal drie aanvragen per tester, gedeeld door beide fotokeuzes, en een onafhankelijk totaalplafond. Een onzekere aanvraag wordt niet opnieuw verstuurd. De reserveringen blijven meetellen bij een wijziging van de einddatum of testerslijst. De server bewaart geen beschrijvingen of foto’s voor deze functie. Het previewbestand staat tijdelijk op het toestel, en ‘Bewaar foto’ schrijft het naar de locatie van de gebruiker.

## Cutover to verified Android sign-in

Treat the Sites deployment and Android update as one release. Publish the
certificate association first, then verify the new signed build in a test rollout.
Make the update available to all installed testers through their existing
distribution channel before switching the production sign-in endpoint. Record
the installed version and a successful sign-in on the new build before widening
the rollout.

The new app sends the `app-link-v1` flow marker. Once Sites switches, older builds
and previously opened consent forms without that marker receive update instructions
before Sites issues a code. Existing app sessions do not use the callback until
the user needs to sign in again. If Android opens the HTTPS callback in the
browser, the page explains how to enable supported links and restart sign-in
from RIG. The old custom scheme is retired at cutover.
