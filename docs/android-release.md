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

## Website association and login

Prefer browser-backed authentication over collecting ChatGPT credentials in an app-owned form. Custom Tabs share the selected browser's cookie state; a Trusted Web Activity (TWA) is browser-rendered and additionally verifies common ownership of the app and website. The Android host does not gain access to browser cookies. This architecture does **not** establish that RIG's real login/return flow has been tested. [Custom Tabs](https://developer.chrome.com/docs/android/custom-tabs), [TWA overview](https://developer.chrome.com/docs/android/trusted-web-activity).

If using TWA/App Links:

- [ ] Freeze the final package ID and identify each intended distribution certificate.
- [ ] Publish the exact package ID and **Play app signing certificate** fingerprint at `https://<RIG-host>/.well-known/assetlinks.json`. A local upload-key fingerprint alone is insufficient for Play installs. Keep debug associations out of the production association unless explicitly needed and reviewed.
- [ ] Verify that the current `chatgpt.site` host actually serves the association publicly over HTTPS as JSON, without a login wall or redirect. Hosting source changes alone are not evidence of public accessibility. Do not claim fullscreen TWA verification while the association is unavailable.
- [ ] Verify the installed app's domain association on a device, using the distribution artifact being tested. A toolbar fallback is a Custom Tab, not proof of a verified TWA.

[Website association configuration](https://developer.android.com/training/app-links/configure-assetlinks), [device verification](https://developer.android.com/training/app-links/verify-applinks).

Test the real ChatGPT sign-in, cancel/back behavior, return URL, logout, expired session, process recreation and screen-lock recovery on Android. Restrict claimed links to RIG's host; do not claim OpenAI authentication domains. Keep Fal/Mollie keys and bridge-signing secrets server-side.

For Play review, provide reusable reviewer access and clear English instructions through Console. Restricted features must be reviewable without the publisher manually supplying a fresh OTP each time. Use a separate ordinary reviewer account with bounded access; do not disclose the owner's credentials, remove customer verification, or grant administrative privileges. A safe reviewer-access solution for the platform-hosted login is still to be verified. [Reviewer sign-in requirements](https://support.google.com/googleplay/android-developer/answer/15748846?hl=en).

## Payment decision and activation gates

| Option | Required implementation before submission |
| --- | --- |
| Google Play credit purchases — selected | Integrate Play Billing and server-side purchase validation/crediting, idempotency, pending purchases, refunds/reversals and price display. Do not credit from an unverified client response. The current Mollie flow does not implement this. |
| Existing credit while purchases are unavailable | Allow login, balance, quoted price and generation using existing RIG credit. Show an honest unavailability message and no nonfunctional purchase button. Preserve the Android channel across login returns and later navigation; never fall back to Mollie. |
| EEA alternative billing, if separately chosen later | Enrollment, applicable agreements, regional eligibility, alternative-billing APIs and transaction reporting are required. An ordinary Mollie button is insufficient. |

Google permits consumption-only apps accessing services bought elsewhere. Selling digital credit inside a Play-distributed app normally requires Play Billing unless a permitted program applies. These rules also apply to browser-backed apps. Verify the final navigation rather than relying on the starting URL or a hidden button. [Payments guidance](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en).

For the EEA program, the current official page requires a registered business and reporting authorized alternative-billing transactions within 24 hours. Google fees remain payable in addition to the payment processor's charges. From 30 June 2026, its table lists **10% for the first US$1M annual earnings**; other tiers/conditions differ. Do not reuse older “standard fee minus 3/4 percentage points” estimates as a current universal rate. Recheck enrollment-specific terms and margin before enabling sales. [EEA alternative billing](https://support.google.com/googleplay/android-developer/answer/12348241?hl=en).

The existing RIG ledger, price confirmation, generation idempotency and spending protections must remain authoritative. No purchase or paid generation is established by an Android build or by this checklist.

The prepared `/android/` client uses the Digital Goods and Payment Request APIs only after authenticated server configuration enables them and the real Play service is available. It reads Google's localized prices and requires server-confirmed credit before consuming a purchase. **Native preparation tested:** the local, documented two-class extension to Android Browser Helper billing 1.2.0 requires the server binding and forwards it through the actual Google SDK account-ID setter. Eight native tests passed, including request capture and rejection before checkout. The upstream transport drops this field. Real Play receipt/account association remains a release gate; synthetic/native unit tests do not prove it. **Purchases remain disabled** pending the Google fulfillment, funding, refunds and accounting composition. [TWA billing integration](https://developer.chrome.com/docs/android/trusted-web-activity/receive-payments-play-billing).

## Account deletion and AI reports

- [ ] Provide a discoverable **RIG account deletion request** inside the app and a public web resource linked in Play's Data safety form. SSO account creation is within scope. Delete the RIG account/data, not the person's ChatGPT account. Explain any necessary security or legally retained financial records and handle downstream provider data appropriately. A fully automatic deletion is not required to initiate a request, but a working request path and fulfillment process are required. Existing implementation/fulfillment has not been verified here. [Account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en).
- [ ] Add a functional offensive-content report/flag action for AI results **without leaving the app**. Verify receipt and owner follow-up; a button, local toast or external `mailto:` alone does not establish this. Prevent prohibited generations and use reports to improve filtering. Existing payment-support forms do not automatically satisfy AI-content reporting. [AI-generated content policy](https://support.google.com/googleplay/android-developer/answer/13985936?hl=en).
- [ ] Check disclosures and Data safety against real name/email collection, media uploads, Fal processing, result retention and temporary media links. Do not describe media as private to RIG if a confirmed processing mode uses temporary bearer links.

## Evidence to attach to a release candidate

- Exact reviewed source commit, clean source status, build command/result, APK/AAB hashes, package/version/target SDK and signing-certificate identity.
- Emulator/device model, Android/browser version, installation result and public DAL/device-verification result.
- Observed login and session-recovery behavior; large photo/video selection, chosen-frame preparation, crop/reference settings, quote, price confirmation, result playback/download and trial-to-full continuation.
- Evidence that the selected billing policy survives every route; separate recorded authorization and bounded cost for any real purchase or Fal generation. Fixture tests do not establish a paid production flow.
- Account-deletion request, in-app AI report receipt and reviewer-access results; current Console declarations, test-track status and remaining blockers.

Do not mark a gate complete without its observable evidence. Building locally, deploying the website, uploading to Play, passing review and publicly releasing are separate outcomes.
