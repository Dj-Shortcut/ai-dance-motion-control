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

An owner may explicitly confirm successive videos against the existing RIG
ledger test budget and the per-video Fal estimate cap. An obsolete global
one-attempt marker no longer blocks that flow. Each dispatch still requires
the exact owned quote, reserved funds, an unfrozen account, no other active
request and the durable one-time dispatch decision. Testers with sponsored
credit keep their separate bounded grant.

The EUR RIG test budget is not the USD balance of an external Fal account.
The native Site still does not sell live Mollie packages. See the
[launch review](../docs/launch-review.md) for the unresolved commercial gates.

## Private five-second input transport

`RIG_O3_INLINE_INPUTS_ENABLED=yes` enables a bounded, owner-only O3 input path.
It applies only to the configured owner in owner access mode, with an
independently verified 4.9–5.1 second clip. The private media bytes are encoded
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
