# Google Play purchase foundation — inactive

Status on 19 November 2026: server verification and an atomic D1 credit adapter
are implemented and tested with synthetic Google replies. They are not imported
by the production commerce worker, do not create tables or routes, and have not
processed an actual Google purchase. The existing website and Mollie ledger are
unchanged. An Android build is not evidence of a functioning Play purchase.

## Contract

The planned authenticated configuration endpoint is
`GET /api/payments/google-play/config`. Its current safe response is
`{ "enabled": false }`. A future enabled response supplies a server-derived
64-character `accountId` and `products: [{ productId, creditsCents }]`.

`POST /api/payments/google-play/confirm` must accept exactly `productId` and
`purchaseToken`; the server obtains the user identity from the existing verified
Sites context. A successful `state: "credited"` means a durable, actual wallet
credit, not merely a verified receipt. Never return that state for a pending,
unconfigured or unfulfilled transaction. No active confirmation route is added
by this foundation.

Configured product IDs are `rig_credit_5`, `rig_credit_10`, and `rig_credit_25`,
mapped to 500, 1000, and 2500 EUR wallet cents. These are entitlement amounts,
not an invented Google checkout price, gross revenue or bank settlement.
Localized checkout prices come from Google, with the owner's separate approval
of the Play catalog and margin. Browser-supplied credit amounts are refused.

## Implemented boundary

`web/google-play-purchases.mjs` makes only fixed-package Google Publisher calls
to `dev.andyarijs.rig`, using an explicitly supplied server OAuth provider and
transport. It bounds provider reads, rejects redirects and validates the exact
SKU, one-unit purchase, refund eligibility, purchase state and test/live realm.
It requires Google's returned account binding to match the server HMAC of the
authenticated RIG user, site, package and realm. Missing binding is a refusal.
Neither an email address nor a browser user ID establishes ownership.

Only a successful `PURCHASED` result creates a private, in-memory receipt
capability. Pending/cancelled responses cannot reach the credit adapter. A JSON
copy is not a capability. No raw purchase token or OAuth token appears in the
returned receipt or error messages. Consumption requires the exact durable
credit entitlement; an uncertain write is not automatically repeated. The
caller must re-read Google before another attempt.

`web/google-play-credit-store.mjs` requires the separately installed
`rig_google_play_receipts` table and **reviewed**
`rig_google_play_valid_admissions` funding view. A single D1 batch claims the
globally unique purchase-token hash and adds one `google-play:<hash>` wallet
event. Cross-user/conflicting events and expired/missing admissions roll the
batch back. A consumed token may recover its own existing entitlement, but may
not create a new credit. This module never inserts a Mollie order or invoice.
The adapter deliberately fails when its future schema is absent.

## Required before activation

1. Register the exact Play package and catalog, grant a narrowly scoped server
   credential the needed Android Publisher access, and implement/review its
   OAuth token provider. No credential or test purchase is supplied here.
2. The local Android module now calls
   `BillingFlowParams.Builder.setObfuscatedAccountId` with the mandatory server
   binding; eight native parsing/SDK-capture tests passed. Upstream ABH billing
   1.2.0 silently drops this extra field, so the two-class extension must remain
   covered when updating dependencies. Verify an actual Play receipt against
   the server binding before activation. Never remove that verification.
3. Add a separately reviewed migration and atomic Google-specific funding
   admission. The funding exposure must include unpaid/pending Google purchase
   commitments, with correct expiry/reconciliation, before opening a purchase
   sheet. The fixture view in the D1 tests is not a production funding policy.
4. Bind admission rows to `admission_id`, user, product, EUR credit amount,
   mode, package, account binding and expiry, and recompute capacity within
   the transaction. Keep live and test in separate databases.
5. Implement authenticated RTDN delivery plus periodic recovery/Voided Purchases
   reconciliation. Verify events with Google; a Pub/Sub notification alone is
   not proof of payment. Reversals must respect credit already spent and the
   existing account-freeze/review policy, rather than inventing a refund or
   deleting accounting history. Store encrypted retry material if required;
   do not put purchase tokens in logs, public/user-visible URLs, public artifacts
   or browser storage. The pinned Publisher API token path is a server-only call.
   Choose one consumption owner: the prepared frontend consumes only after a
   credited response; this server foundation also offers a server-consumption
   method. Do not activate both blindly. Prefer durable server recovery and
   return its actual consumption result to the client.
6. Add Google-specific revenue, fees, VAT/merchant settlement and accounting
   reconciliation. Google's receipt/settlement must not also trigger an ordinary
   Mollie customer invoice. The current owner finance/invoice queries are
   Mollie-oriented and do not prove Google sales are accounted for.
7. Exercise a real license-tester purchase, pending purchase, cancellation,
   duplicated confirmation, consumed-purchase recovery and refund, with the
   actual published certificate/domain association and the native account
   binding. Only then enable purchases for customers.

## Sources checked

- [Google product purchase v2 resource](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.productsv2)
  defines purchase states, account binding, product/offer quantities and
  test context. Order IDs are optional; purchase token hashes are the replay key.
- [Verification endpoint](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.productsv2/getproductpurchasev2)
  and [server consumption](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products/consume)
  define the pinned HTTPS request paths and server OAuth scope.
- [Google billing security guidance](https://developer.android.com/google/play/billing/security)
  requires legitimate completed purchases before entitlement, explains account
  mapping, unique-token handling, and recommends server verification/consumption.
