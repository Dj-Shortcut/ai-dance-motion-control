# RIG website and private test services

This is the source import of the current RIG consumer test. The root CLI and
native Mac application have separate entry points. Live billing is not enabled
by this source import or by CI.

## Reproducible local checks

Use Node 24.15.0 (`.nvmrc`), npm, FFmpeg and FFprobe:

```sh
npm ci
npm run check:syntax
npm run build -- --out-dir dist/site
npm run test:unit
npm run test:workerd
npm run test:media
```

The runner generates its own synthetic fixtures, uses local D1/R2 and injected
mock providers, and disables Miniflare's external metadata fetch. Production
keys, personal media and local sibling projects are unnecessary. These scripts
do not submit a Fal generation or a Mollie payment.

| Group | Purpose |
| --- | --- |
| `test:unit` | UI/session/model selection, consent, pricing, payments, provider parsing, result validation and build regression checks |
| `test:workerd` | Local Worker/D1 identity, credit reservation, idempotency, refund, sponsor and capability boundaries |
| `test:media` | FFmpeg-generated inputs, independent container/duration checks, normalization and media-service regressions |

The explicit test lists live in `scripts/test.mjs`. Historical `*-smoke.mjs`
and experiment helpers are preserved for source review and are not production
commands or CI entry points; some still refer to old local experiments.

## Build boundary

The Site build writes only to the selected output directory and creates its
hosting metadata there. It does not publish or modify a sibling checkout. The
default build has no existing Site project ID. An intentional Site deployment
must provide `--project-id` and use the hosting provider's authorized workflow.
Private service bindings and encrypted secrets belong to deployment
configuration, which is not included in this repository.

## Account and spending boundaries

In the legacy TEST environment, an owner may confirm videos against the RIG
ledger test budget and the per-video Fal estimate cap. An obsolete global
one-attempt marker no longer blocks that flow. Each dispatch still requires
the exact owned quote, reserved funds, an unfrozen account, no other active
request and the durable one-time dispatch decision. Testers with sponsored
credit keep their separate bounded grant.

The isolated production composition supports customer credit purchases through
Mollie. Customer videos reserve and debit their EUR RIG wallet. The server-pinned
production owner can instead use `owner-provider` funding with no Mollie purchase:
the website shows the current estimated USD Fal cost before confirmation and
does not display an invented Fal balance. Ownership comes only from the signed
Site identity and `RIG_PRODUCTION_OWNER_USER_ID`, never a browser role or request.

Apply `production-migrations/0002_owner_provider_funding.sql` before deploying
this owner route to an existing production DB. New owner quotes persist their
funding and confirmed estimate; `rig_owner_provider_usage` records the job
lifecycle without writing EUR reservations, refunds or credits. Existing quotes
default to `credits` and retain their original accounting. Owner changes block
new owner dispatch while previously queued jobs remain recoverable. Both routes
keep explicit price/transfer confirmation, freezes and the single-dispatch guard.

Neither the EUR RIG wallet nor the owner usage journal is the USD balance of an
external Fal account. Code and CI do not activate live billing or prove a real
payment settled. See the [launch review](../docs/launch-review.md) for the
commercial review checklist; its historical test notes are not live receipts.

## Checkout recovery

After a shopper chooses Bancontact, Mollie's verified `_links.checkout` may point
to its processor at `https://redirect.ppro.com/v0/pages/`. Server and browser
guards accept only that exact additional host/path with one bounded JWT-shaped
`redirection_token`, HTTPS and no credentials, nondefault port or fragment.
Other processor hosts, paths and redirect parameters stay rejected. The API
transport remains restricted to `api.mollie.com`; payment profile, mode, amount,
ownership and freeze checks still precede checkout delivery. Recovery reuses the
existing payment and never creates a second checkout or credits an unpaid order.

References: [Mollie checkout flow](https://docs.mollie.com/docs/accepting-payments)
and [PPRO Bancontact redirects](https://developerhub.ppro.com/global-api/docs/belgium-local-acquiring).

## Private five-second input transport

The website's **Video bewerken** flow now offers the ordinary Mac/Fal transfer
after the price is known. Its confirmation explains that Fal's temporary
photo, source-video and result links can be opened by anyone holding the link.
The persisted O3 quote selects `fal-temporary-links-v1`; the final generation
request must explicitly confirm that same policy. The backend checks consent
before reserving credits or exporting media. Changing a private quote's policy
at confirmation is refused.

For this opted-in route, RIG uploads the exact owned, digest-verified prepared
bytes to new Fal CDN objects with a requested 24-hour expiry, verifies an
anonymous byte-for-byte readback, and sends the canonical URLs to O3 Edit.
It does not use the private R2 gateway or inline fallback for these requests.
The output uses the same requested expiry, is checked and copied into RIG's
existing private result bucket, and is served only through the owned job.
No provider key, temporary URL or upload capability is returned to the browser.
Price confirmation, one-dispatch guards, safety checks, no-retry behavior and
failure refunds remain in place. A closed or changed confirmation never grants
permission for another quote. Default API requests and human-motion videos
retain the existing private provider path.

The following owner-only inline path is retained for legacy private quotes;
it is not selected by the website's opted-in O3 flow:

`RIG_O3_INLINE_INPUTS_ENABLED=yes` enables a bounded, owner-only O3 input path.
It applies only to the configured owner in owner access mode, with an
independently verified 4.9–5.0 second clip. The private media bytes are encoded
directly into the Fal request after the quoted hashes and reserved funds have
been checked. JPEG input is capped at 1 MiB, MP4 at 3 MiB, and the complete
encoded request at 6 MiB. Exceeding a bound fails before dispatch and never
falls back to another upload or URL. Sponsored and motion paths are unchanged.

This uses the data-URI input described in the exact
[O3 API documentation](https://fal.ai/models/fal-ai/kling-video/o3/standard/video-to-video/edit/api#files)
to avoid external URL download compatibility problems. The private Fal ACL,
`X-Fal-Store-IO: 0`, safety checks and one-dispatch guard stay in
place. Mock-provider checks do not prove that the closed Kling backend accepts
this transport; only a customer-confirmed real result can establish that.

For selections above the three-second minimum, preparation requests a 60 ms
encoding margin and refuses output longer than the selected integer duration.
The price still uses the independently measured duration and rounds upward;
it never hides a 5.01-second file behind a five-second price.


## Automatic invoices and Accountable handoff

The optional `RIG_AUTOMATIC_INVOICES_ENABLED=yes` production feature requires
additive migrations `0011_automatic_invoices.sql`, `0012_purchase_billing.sql`
and `0013_invoice_delivery.sql`. Apply all three before enabling it. The fresh
production schema includes them. Do not enable on the legacy TEST database.

Checkout collects the legal buyer name/address and binds digital invoice
consent to the immutable purchase acceptance. A paid order plus its exact
credit event can issue one frozen snapshot and one sequential RIG invoice;
repeated webhooks, reconciliation and scheduled repair do not reissue it.
Legacy purchases without valid billing/consent or conflicting manual documents
require review. A failed video does not cancel the credit-purchase invoice.

Original PDFs use the private results bucket under `administration/invoices/`.
Do not apply media expiry rules to that prefix. PDFs are conditional-write
archived with snapshot and byte checksums; missing/corrupt original objects
require investigation, not silent recreation. Customer downloads are bound to
the authenticated order; the pinned owner can download originals/month ZIPs.

Accountable Free supports PDF email intake, followed by manual verification.
Zoho EU is optional and disabled until the owner completes its OAuth setup.
Store `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` and
`ZOHO_MAIL_ACCOUNT_ID` as encrypted Worker Secrets. The runtime needs the
`ZohoMail.messages.CREATE` scope; one-time account discovery may also need
`ZohoMail.accounts.READ`. Never request `messages.READ` or `ALL` for this flow.
The sender is pinned to `info@andyarijs.dev`, recipient to
`inkomsten@accountable.eu`, and token/mail hosts to Zoho EU. Enable
`RIG_ACCOUNTABLE_MAIL_ENABLED=yes`, `RIG_ACCOUNTABLE_ALIAS_CONFIRMED=yes` and
`RIG_ACCOUNTABLE_SENDER=info@andyarijs.dev` only after the owner finishes setup
and confirms the sender in Accountable. No paid mail subscription is created.

The outbox atomically claims each invoice before sending once. A send receipt
means accepted by Zoho, not booked by Accountable; an interrupted/uncertain
send requires manual checking rather than blind resend. No dummy invoices
should be emailed to test intake. See [the first-sale procedure](../docs/accountable-first-sale.md).
