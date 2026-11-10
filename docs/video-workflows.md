# Video processing contracts

An idea tile is a draft description, not evidence that its result is supported.
Availability must come from the server's enabled workflow and a verified input
contract. A successful HTTP response proves completion, not visual acceptance.

## Existing routes

| Intended operation | Provider route | Actual controls | Acceptance status |
| --- | --- | --- | --- |
| Animate a person in the photo's setting using a movement video | Kling v3 Standard/Pro Motion Control | Image, movement video, video orientation, optional identity element, original sound | Existing route; assess each output against this intended operation |
| Creative changes to an existing video, including an animal character | Kling O3 Standard Edit | Video, identity references, description, original sound | Public editing remains disabled; the owner identity-only experiment failed scene/framing acceptance |
| Replace a person while keeping the source scene, camera and performance | H3 Max Recast, owner candidate only | Source video, one explicitly chosen portrait, fixed 1080P, realism and safety enabled | Not visually validated; owner validation only; no O3 fallback |

The current dance/grandma ideas select Motion and a description. The band/film
ideas originally selected the same O3 Edit route with different descriptions.
They were not four independently implemented provider workflows.

## Human Recast candidate

- `human-recast` is distinct from `edit-standard`; stored model/contract/portrait,
  resolution and price must agree at confirmation and dispatch.
- Only the pinned owner using direct provider funding may enable the candidate.
  Public/customer access must remain denied, including crafted API requests.
- One portrait describes one replacement person. Extra photos must not silently
  become additional people. Preserve unused angle selections locally for Motion.
- Use the selected source footage and a short mapping instruction. Do not add a
  whole-scene recreation prompt or general image/style references.
- The provider requires at least five verified seconds. The current normalizer
  deliberately shortens the requested working clip slightly. The first candidate
  therefore explicitly selects at least six seconds; a 4.92-second asset cannot
  be accepted as five seconds or silently padded/reused.
- Compute the model-specific provider estimate before confirmation. The provider
  pricing API's `units` are not seconds. The pinned 1080P billing contract must be
  verified separately and reject unknown rates, units or resolutions.
- Preserve the existing owner budget, passkey, quote binding, idempotency, input
  hashes, per-quote temporary-link consent and 24-hour media lifecycle.
- Poll the request in its own provider namespace. Existing Kling jobs must remain
  readable and recoverable without resubmission.

## Quality defaults

The operator explicitly prefers higher quality over a lower price. Motion Pro
is the default, including file preparation when quality is omitted. A customer's
explicit Standard choice remains explicit. Human Recast uses fixed 1080P with
its own resolution-bound price and provider-contract version; an old unstarted
768P quote must be priced and confirmed again. Already accepted 768P jobs remain
recoverable under their original contract.

The reviewed provider rate for Recast 1080P is USD0.45 per output second (2026-11-10),
so a six-second estimate is USD2.70. Keep the existing spending limits: a more
expensive configuration must fail visibly when it exceeds a limit, never lower
quality or raise the limit automatically. Better resolution is not proof of
correct identity, motion or framing; real-output acceptance is still required.

Optional priced text removal is tracked in `text-removal-plan.md`; it is not yet
an available processing stage or a claim that every output is text-free.

## Claims that are not separate processing steps

Keeping source audio does not establish correct lip synchronization. The current
steady-camera instruction is a prompt, not an independent camera tracker.
The current text-removal instruction is a prompt, not OCR, a removal mask or a
verified cleanup pass. Recast alone must not be advertised as a text remover.
Human Recast must not be advertised as an animal replacement workflow.

## Required real-output acceptance

Before public enablement, inspect an owner-approved result against the exact
quoted source and portrait: replacement identity, source setting, shot size,
camera motion, body/facial performance, timing, occlusions, cuts and source audio.
Record each unmet requirement, including unwanted visible text. Passing schema,
unit, browser or access-control tests does not close this acceptance gate.

No automatic paid retry, provider fallback or additional cleanup generation is
authorized by a failed result. Each new paid attempt needs its own shown price
and the normal confirmation.
