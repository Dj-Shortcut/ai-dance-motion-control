# RIG launch review

Historical review. For the implemented but activation-gated native credit
checkout added on 9 November, see [credits-release.md](credits-release.md).
The findings below describe the earlier deployment, not a fresh launch approval.

Reviewed 7 November 2026. Scope: the imported website, private Cloudflare
services, and the original Mac GUI. At that review the website used Mollie test
mode. The later production composition supports native credit checkout and a
background collector; the dated blockers below are not its current status.
Neither implementation nor CI proves a real Wero payment, Accountable delivery
or visual video acceptance. This review does not certify commercial readiness.

## Findings fixed in this branch

- **Wrong video model after a refresh or availability change.** The web UI now
  keeps an explicit video type in account-scoped storage. An unavailable edit
  model disables the selected edit instead of switching to human motion. The
  reviewed type appears on the price confirmation. Regression tests cover
  reload, account isolation, capability changes and stale quotes.
- **Repeated submission of a known incompatible photo.** A previously verified
  human-subject rejection now blocks the same owner's same image hash before
  another motion quote or credit reservation. The reservation transaction also
  checks it. Video editing and other owners/images remain available. Only a
  response explicitly proving that no generation started clears pending UI
  state; uncertain responses retain their recovery handle.
- **Owner blocked by an obsolete one-attempt test marker.** The normal owner
  flow now checks the exact funded job and quote against the existing ledger
  budget. Each price is explicitly confirmed and the final dispatch decision
  remains atomic. Historic test markers are not deleted or consulted. Tests
  cover successive confirmations, duplicates, insufficient balance, freezes,
  concurrent jobs and the independent sponsor budget.
- **Leaked browser tracks after recorder construction failure.** Video/audio
  tracks are now inside cleanup protection from their creation onward. Failure
  at audio capture, adding a track or constructing the recorder stops all
  previously created tracks and cannot upload media.
- **An MP4 header alone counted as a completed video.** Result storage now
  checks bounded container, track, codec-configuration, timing and media sample
  ranges before writing a new result. Ordinary and fragmented MP4 and B-frames
  are covered. Corrupt or truncated files never trigger settlement. Range
  lookup is logarithmic rather than repeatedly scanning every media block.
  This is structural validation, not a complete video decode. Unsupported or
  ambiguous output remains held for reconciliation, without an automatic
  refund. Large/concurrent production memory behavior remains unverified.

## Historical launch blockers from the earlier deployment

### P1: native website cannot sell credit packages yet

`web/frontend/multiuser/payments.js` deliberately skips package loading and
payment creation in the native ChatGPT Site. The separate Google test frontend
has a Mollie test checkout, but that does not make the native website a live
storefront. The payment services also default to TEST; the owner balance is a
fictitious test budget, not the owner's USD Fal account balance.

Done when: the native authenticated account can complete an approved live
Mollie payment, and an authenticated payment reconciliation grants the exact
credits once. Canceled, duplicate, refunded and chargeback events must be
exercised separately. No live key or real checkout is enabled by this PR.

### P1: completed videos depend on the browser polling

`web/generation.mjs` obtains and stores a finished provider result from the
client status route. `web/closed-video-worker.mjs` does not schedule a collector;
the background collector exists in a separate staging composition. A user who
closes the tab can return after provider retention expires and still have a
queued job with reserved credit.

Done when: a durable background collector stores the private result before
retention expires, survives restarts and duplicate delivery, and a closed-tab
test retrieves the completed video later without a second provider request.

### P1: an ambiguous provider submission lacks an operational recovery path

`web/generation.mjs` conservatively records `unknown` when Fal might have
accepted a request but the response was lost. `web/d1.mjs` prevents duplicate
spending and another active job, but no supported workflow resolves an unknown
submission with no provider request ID. Retrying or refunding blindly would be
unsafe; leaving the account locked indefinitely is also not a release outcome.

Done when: a documented provider reconciliation mechanism can prove accepted,
not accepted, or still unknown; an operator can safely resolve each state with
an audit trail and without double spending or unproved refunds.

### P2: provider input links need a complete lifetime and consumption policy

`web/rig-provider-inputs.mjs` uses job-bound HMAC capabilities, owned immutable
references, a six-hour expiry, and revocation after terminal settlement.
However, a queued or dispatched-unknown job has no proven shorter maximum wait.
Each authorized HEAD or small byte range also reads and hashes the entire
private object. The relay IP limit does not cap bytes or concurrent reads per
job/capability.

Done when: provider wait/expiry and recovery are defined, capabilities have a
bounded byte/concurrency budget, and request-log access/redaction is reviewed.
Do not fix this by making the input bucket public.

### P2: terminal error coverage remains deliberately narrow

Only observed, authenticated terminal failures are classified for automatic
refund. The observed missing-human-subject error is bound to the Pro motion
model; an equivalent Standard failure still needs a verified classification
and recovery path. Unknown HTTP responses must not be treated as proof of a
refund or retried as a fresh paid job.

## Verification limits

CI builds the website and Mac application and runs deterministic tests with
local D1/R2, mock providers and synthetic media. It has no Fal, Mollie or
Cloudflare production credentials and never creates a real video or payment.
Passing CI is evidence about these checks, not proof of live provider quality,
lip synchronization, real payment settlement or commercial readiness.

The new input transport was checked with the owner's real prepared files
without submitting a model request. A successful O3 output using that transport
has not yet been established. The most recent observed failed request still
used the human-motion model with the same incompatible dog image.
