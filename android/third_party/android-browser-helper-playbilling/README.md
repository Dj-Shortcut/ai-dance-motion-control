# Android Browser Helper Play Billing — RIG account binding

This is the official Apache-2.0 `playbilling` module, version **1.2.0**, from
Google's `android-browser-helper-2.7.4` tag at commit
`601087701eb941a76335c58593dac9f87d2a49b0`.

All 34 upstream source/license files are listed in `UPSTREAM.json`, with their
upstream paths, Git blob SHA-1, original SHA-256 and local SHA-256. The original
copyright headers and `LICENSE` are retained. **Only two upstream Java classes
are changed**, recorded in `RIG.patch`; all other upstream bytes are unchanged.

## Why the two changes are necessary

The official billing module does not forward `obfuscatedAccountId` from the
Payment Request method data to Google's `BillingFlowParams`. RIG's server
requires the Google purchase receipt's `obfuscatedExternalAccountId` to match
its account-bound HMAC. Without this extension, Google could charge a buyer for
an unbound receipt that RIG must refuse to credit.

- `MethodData`: requires a JSON string `obfuscatedAccountId` of exactly 64
  lowercase hexadecimal characters. Missing, mistyped or malformed values
  return `null`; the unchanged official `PaymentActivity` rejects that result
  before connecting to billing or showing a purchase sheet. Top-level Android
  Intent extras are not an alternative source for this binding.
- `PlayBillingWrapper`: checks the binding again and calls the real SDK's
  `BillingFlowParams.Builder.setObfuscatedAccountId`. A package-private
  constructor accepts a mock SDK client for isolated unit tests. The production
  factory and its static testing hooks are unchanged.

The native check validates format, not ownership. RIG's server remains solely
responsible for verifying its own account HMAC against Google's receipt,
purchase state and product, and for idempotent crediting. No secret is added to
Android and no JavaScript bridge or WebView is introduced.

Official `PaymentVerifier`, `PaymentActivity`, `PaymentService`, Digital Goods
handlers and browser/certificate verification are unchanged. The app declares
no additional trusted web origins. A valid account-looking string by itself
does not authenticate a caller or grant RIG credit.

## Build adapter and tests

The local `build.gradle` pins Android Browser Helper 2.7.4, AndroidX Browser
1.10.0 and Google Play Billing 8.3.0, matching the upstream release catalog.
`manifest/AndroidManifest.xml` is an empty adapter for AGP 8's namespace rule;
the original package-only upstream manifest is retained unchanged as evidence.
This module replaces the Maven `com.google.androidbrowserhelper:billing`
dependency, so two versions of the same classes must not be packaged together.

Run:

```sh
./gradlew :rigPlayBilling:testDebugUnitTest :app:assembleDebug :app:bundleRelease :app:lintRelease
```

The eight tests exercise real JSON/Intent parsing, reject missing/invalid
bindings, and capture an actual Google `BillingFlowParams` at a mock SDK client.
The capture compares the real account field with a reference builder, so it
also catches accidental forwarding as a profile ID. It opens no store,
connects to no billing service, and starts no payment. This does not replace
testing with a real Play test account and a signed Play release.
