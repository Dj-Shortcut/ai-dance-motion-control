# Google Play commerce: implementation and activation

Status on **19 November 2026**: Android billing, the production-worker composition,
atomic D1 fulfillment, provider authentication, recovery and owner evidence export
are implemented in source. Automated checks use synthetic Google replies and
local D1. No actual Google purchase, refund, bank settlement, Console catalog or
deployed activation is established by those checks. Purchases default **off**.
See [the Android release gates](android-release.md).

## Customer flow and price policy

Android uses `/android/`, Digital Goods and Payment Request through the browser's
verified Play Billing service. The ordinary website keeps Mollie. Android never
falls back to Mollie when Play is unavailable. Existing RIG credit remains usable
through the normal price-confirmed video flow.

Consumables `rig_credit_5`, `rig_credit_10`, `rig_credit_25` grant 500, 1000 and
2500 **EUR wallet cents**. Wallet value is separate from Google checkout price
and bank payout. The owner has **not approved real Google catalog prices yet**.
Values 899/1799/4499 in tests are synthetic fixtures, not recommended prices.

The server requires an approved EUR price policy. Before Google's purchase sheet,
the browser checks Google's actual currency and exact price and creates an owned,
funded intent. After payment, actual Google developer revenue after taxes and
fees must cover the entire wallet value. This preserves RIG's separate per-video
margin policy. Missing financial evidence causes review/retry, never an assumed
fee rate. First release planning is BE/NL and EUR; configure countries in Console.
A runtime EUR check alone does not enforce a buyer's country.

## Contracts

The signed Sites bridge supplies the authenticated RIG user. Browser payloads
cannot choose another user, wallet amount, payment realm or account binding.

| Operation | Contract |
| --- | --- |
| `GET /api/payments/google-play/config` | Unconfigured: `{enabled:false}`. Configured: `enabled`, `recoveryReady`, server `accountId`, products with approved price cents, EUR and `mode:"live"`. |
| `POST /api/payments/google-play/intents` | Exactly `{productId,requestId}` with UUID. Atomic admission reserves conservative supplier capacity before checkout. Repeated owned IDs recover their intent. |
| `POST /api/payments/google-play/confirm` | Exactly `{intentId,productId,purchaseToken}`. Encrypts retry material and verifies the owned purchase. `credited` means a durable wallet event, never pending/review. |
| `GET /api/payments/google-play/status` | Owned status; optional exact `?intentId=<UUID>`. No token in URLs. |
| `POST /api/payments/google-play/rtdn` | Independent Google OIDC and exact Pub/Sub subscription. Browser bridge identity cannot authenticate this route. |

There is no public test-mode parameter. Production composition defaults to live,
requires the matching physical DB realm and rejects license TEST purchases.

## Ownership, secrets and replay protection

The verifier calls only fixed package `dev.andyarijs.rig` at Google Publisher.
It checks SKU, quantity one, state, refundable quantity and test/live context.
Google's obfuscated account ID must match the server-bound RIG account. New
intents derive that ID by secret HMAC over site, realm, user and package. Recovery
uses the immutable ID saved on the owned intent, so HMAC rotation does not orphan
pending purchases. An extra browser `accountId` is rejected.

The documented Android Browser Helper billing 1.2.0 extension requires a 64-character
lowercase hexadecimal ID before checkout, then forwards it to Google's actual
`setObfuscatedAccountId` setter. Upstream drops that field. Native tests prove
parsing and forwarding; only a real Play receipt can prove the complete path.

Only provider reads mint private in-memory proof capabilities. A JSON copy,
notification or Orders record alone cannot grant credit. Globally unique token
hashes, immutable credit claims and ledger events prevent duplicate credit.
Multiple paid tokens for one intent cannot create multiple entitlements; the
extra purchase needs refund handling. D1 rechecks obligations and funding inside
admission/fulfillment transactions. Existing wallet/spend/freeze gates remain.

Runtime service-account secrets use RS256 OAuth with exact Android Publisher
scope and Google's fixed token endpoint. Reads/timeouts/cache are bounded and
redirects rejected. Retry tokens are AES-256-GCM encrypted and bound to package,
realm, token hash and key ID. Retain old encryption keys during outstanding
recovery. Unknown keys/tampering fail closed. Raw purchase/access tokens stay out
of public responses, reports, logs and browser persistence.

## Recovery, consumption and refunds

The **server** consumes after durable credit; the frontend never consumes. A
durable attempt marker precedes a write. Uncertain writes require a new Google
read; distinct inspection IDs prevent reusing one proof as a fresh inspection.

RTDN verifies Google RS256, expected verified email, exact audience and subscription.
It commits encrypted inbox delivery before ACK. Messages prompt provider reads;
they are not entitlement proof. Unsupported/test messages receive durable audit
records, and failed processing retries. Scheduled recovery also handles queued
confirmations and receipts.

Voided Purchases uses a durable page cursor and overlapping completed windows.
A page advances after committed reversals. Google exposes a 30-day seen-time
window: monitor collector failures; this is not unlimited accounting history.
Full verified refunds/cancellations/voids append compensating ledger entries;
spent credit may freeze the account rather than erase history. Partial money
refunds require review/freeze, not a whole-wallet reversal. Quantity refunds
support only the one-unit contract. Google documents no refund idempotency key:
record attempts durably, reread and reconcile uncertain writes before retrying.
Pausing new sales must leave processing/recovery enabled.

## Configuration: default off

| Setting | Purpose |
| --- | --- |
| `RIG_GOOGLE_PLAY_PROCESSING_ENABLED=yes` | Configured processing/recovery. Keep enabled when pausing new sales. Missing/default is off. |
| `RIG_GOOGLE_PLAY_SALES_ENABLED=yes` | New intents. Missing/default is off. |
| `RIG_GOOGLE_PLAY_PRICES` | JSON `{version:"rig-play-prices-v1",currency:"EUR",products:[{productId,creditsCents,priceCents},...]}` with exactly the three approved products. |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (Secret) | Narrowly authorized Publisher service account and private key, JSON. |
| `RIG_GOOGLE_PLAY_ACCOUNT_HMAC_KEY` (Secret) | Account binding for new intents. |
| `RIG_GOOGLE_PLAY_TOKEN_KEYS_JSON` (Secret) | JSON keyring `{keyId:base64url_32_byte_key}`. Retain required old keys. |
| `RIG_GOOGLE_PLAY_TOKEN_KEY_ID` | Current encryption key ID. |
| `RIG_GOOGLE_PLAY_PUBSUB_EMAIL` | Exact push-auth service-account email. |
| `RIG_GOOGLE_PLAY_PUBSUB_AUDIENCE` | Verified bridge origin plus `/api/payments/google-play/rtdn`. |
| `RIG_GOOGLE_PLAY_PUBSUB_SUBSCRIPTION` | Exact `projects/.../subscriptions/...`. |

Apply reviewed migration `0018_google_play_fulfillment.sql` only to the intended
DB after preceding migrations. Keep the verified production site/bridge/tenant
and its live DB separate from test. Never put credentials into Git/chat/artifacts.

## Private license-test harness

`createGooglePlayLicenseTestHarness` in `web/google-play-license-harness.mjs` is a
private operator library, **not a deployed service or public HTTP handler**. It
reuses the same controller with static test mode. It requires distinct physical
test/production DB UUIDs and a small operator allowlist. Every action checks the
test DB mode and expiring default-off `rig_google_play_test_policy` before reading
provider secrets or network. SQL caps lifetime claims plus outstanding holds at
at most 10,000 cents. No Fal, video, media or Mollie operation is exposed.

Only payment config/intents/confirmation/status and bounded collection are allowed.
The fixed `.invalid` Request namespace is internal, not a website. License TEST
receipts remain bound to the test user/SKU. Actual Google zero-value license
orders may credit this bounded **test wallet**; their reported amounts remain
zero and are marked license-test evidence. Missing Orders/revenue stays review;
no payment, financial source or settlement is invented.

Local unit/D1 tests establish isolation/composition with synthetic providers.
Real acceptance needs Console approval, signed test-track build, verified domain,
test products, allowlisted policy/operator and scoped runtime credentials. Run
purchase/pending/cancellation/recovery/refund cases there before customer sales.
An offline fixture is not a real Google acceptance run.

## Finance evidence and remaining gates

The owner Google report/CSV preserves exact Orders units/nanos, immutable
credit-grant snapshots, later refunds and wallet events. Derived fees require
complete unrefunded gross/tax/net evidence. Missing values stay unknown.
Developer revenue is **not a reconciled bank payout** and wallet issuance is not
a second cash sale. This is source evidence for Accountable, not a complete tax
journal. No Mollie invoice, automatic Accountable import or Peppol delivery is
fabricated for a Google order.

Before activation: approve actual prices/net coverage; finish Console package,
catalog and BE/NL settings; configure scoped Publisher and authenticated Pub/Sub;
verify distribution certificate/domain/login; run isolated real license tests;
review migration/deployment evidence; reconcile the first real sale and settlement
separately. Account deletion, AI reporting and reviewer access remain store gates.

## Primary sources checked

- [Product v2](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.productsv2), [verification](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.productsv2/getproductpurchasev2), [consume](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products/consume) and [billing security](https://developer.android.com/google/play/billing/security): ownership, state, test context and entitlements.
- [Orders](https://developers.google.com/android-publisher/api-ref/rest/v3/orders) and [refund](https://developers.google.com/android-publisher/api-ref/rest/v3/orders/refund): Money, revenue and refund states; no documented refund idempotency key.
- [Voided list](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.voidedpurchases/list) and [resource](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.voidedpurchases): window, pagination and quantity refunds.
- [RTDN](https://developer.android.com/google/play/billing/rtdn-reference), [Pub/Sub push authentication](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions), [service-account OAuth](https://developers.google.com/identity/protocols/oauth2/service-account): notifications, identity and token exchange.
