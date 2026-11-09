# RIG credit checkout — 9 November 2026

The native ChatGPT Site now has an implemented production checkout path. This
does not mean live sales are enabled. Activation requires a verified Mollie live
key/profile, an isolated production D1 tenant, the production signing secret and
an explicit server-side switch. Never change the mode of the old test database.

## Customer flow

The existing credit popout offers operator-configured packages. Initial server
configuration prepares EUR 5, 10 and 25 packages with equal credit in eurocents.
The browser supplies only a package identifier and its own durable request ID;
it cannot choose the price, amount of credit, account or checkout URL. Before
leaving for Mollie, the browser verifies that the same account remains signed in.

The Mollie return URL is only navigation. Credits are awarded after the server
retrieves the actual payment, validates live mode, pinned profile, order metadata,
EUR amount and reversal lists. One ledger event awards each purchase once.
Canceled/failed payments award nothing. Reversals freeze the account and reverse
the credited purchase once, including partial/uncertain reversals pending review.
This is deliberately conservative; it is not an automated partial-refund policy.

Paid and test wallets are physically separate. Switching the Site's realm gives
the same ChatGPT subject a production identity and a clean purchased balance.
The old owner's fictitious balance and sponsored allowance are not copied.
The tester's previously promised gift needs its own audited promotional grant
to his verified production identity if the production realm is enabled.

Generation uses the same production wallet and authenticated identity as checkout.
The server quotes the price before confirmation, reserves it atomically, and
permits one dispatch. Automatic refunds require exact ledger evidence; an
ambiguous provider submission keeps the reservation and recovery handle.
No new paid Fal request is needed to test this implementation locally.

## Service composition

- Site: `rig-sites-app.mjs`, separate production bridge configuration and key.
- Public relay: `production-ingress.mjs`, no secrets, DB or storage. Only signed
  app routes, the exact Mollie webhook and expiring media capabilities pass.
- Private service: `production-commerce-worker.mjs` inside the existing private
  video worker. Payment/profile/key access never reaches the Site or browser.
- Database: fresh `production-schema.sql` in distinct `PRODUCTION_DB`. Physical
  binding IDs must be checked at deployment; JS object inequality is insufficient.
- Scheduler: `production-collector.mjs`, bounded multiuser queued-result collection
  and known-payment reconciliation. It never creates a payment or Fal job. It
  rotates across users and checks already-paid orders for missed reversals.
- Existing private media and EU result buckets retain their access rules.

Production generation requires a server-created branded capability after tenant
validation. A browser flag, plain object, test database or legacy test credential
cannot opt the shared adapters into spending a live wallet. User/session limits,
the public relay limiter and a durable global webhook limit bound requests.

## Recovery and release gate

When a verified payment ID is known but checkout fails, keep that ID and reconcile
the same owned purchase. A missing ID after a possibly accepted creation remains
`unknown`; do not make a fresh payment or resend creation blindly. Mollie's
idempotency retention is limited. An operator must investigate the original
Mollie order metadata and record a reviewed outcome. Never infer payment from a
redirect, browser-supplied status or customer screenshot.

The unit/workerd tests cover actual Site-to-relay-to-private-service composition
with local D1 and fake providers, duplicate callbacks, account isolation, frozen
accounts, invalid checkout recovery, production reservations/refunds and bounded
background work. They do not prove real Mollie receipt, merchant activation or
a successful video through the live website.

Before opening paid sales, confirm the live key belongs to the pinned RIG profile,
enabled payment methods and current website; verify scheduler/private deployment;
then have the owner complete a small real checkout and confirm exact credit once.
Video acceptance is a separate pending check. Customer terms/privacy information,
refund/support procedure and commercial pricing review remain release work.

Provider references:

- <https://docs.mollie.com/reference/create-payment>
- <https://docs.mollie.com/reference/webhooks>
- <https://docs.mollie.com/reference/api-idempotency>
