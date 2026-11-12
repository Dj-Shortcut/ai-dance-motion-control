# Video processing contracts

Availability must come from the server's enabled workflow and a verified input
contract. A successful HTTP response proves completion, not visual acceptance.
The interface follows [the RIG interface contract](interface-contract.md) and
the five-screen [original Claude canvas](design-reference/claude-mobile/canvas.json):
Start → photo/video → placement → make → result. The source HTML files preserve
the design reference, including prototype-only material. The user's later
instruction removes all example tiles. Prototype prices, three-second trials,
countdowns, simulated completion and claims about signing in are not processing
contracts and must not be copied into the working app.

## Guided interface and backend binding

The four ordinary panels use `data-flow-screen="start|files|where|result"`.
The fifth screen, Make, reuses `briefDialog` as step 3 of 3. Do not replace this
with a long page containing every stage or introduce another generation form.
One sticky `prepare` action handles ordinary navigation and trial continuation.
Crop, precise start/duration, identity references and Settings remain available
under the collapsed More options control on the photo/video screen.

The placement choices describe different processing contracts: Motion animates
the chosen person in the photo setting; in-video replacement must use the
server-enabled editing or Recast contract. The previews use the selected local
photo/frame and source video. A placement card must not enable a public route,
choose a fallback provider, weaken access checks or promise visual acceptance.

The start/end sliders update the same real clip selection as the numeric
controls. Existing local decoding, normalization, model-specific duration limits
and crop/reference selection still apply. A long original phone video used for
choosing identity frames remains local; only the selected prepared assets enter
the existing upload and quote flow.

Trial/full plan cards only select the intended working duration. The current
contract uses five-second Motion/Edit trials and six-second Recast trials, not
the three seconds drawn in the original mockup. A trial is offered only when it
fits the source and is shorter than the full selection. Estimates come from the
real estimate endpoint; cleanup can defer the combined price until mask review.
Never substitute a placeholder price when the estimate is unavailable.

The single Make action requests preparation and the price. The existing upload,
quote and explicit generation confirmation bind the actual prepared input,
model, price, temporary-link consent and account funding. No paid request is
authorized merely by navigating, choosing a plan or opening the popup. Preserve
the normal customer credit checks and owner budget/device confirmation.
Customer estimates show the customer price; the owner's direct-provider view
may show its separate provider-cost estimate.

The result screen uses real queued/running/failed/completed state and the real
playable file. Do not invent provider percentages or an ETA. Saving downloads
that file; sharing is offered only after browser file-sharing capability checks.
Neither operation is another generation. `My videos` uses the existing recovery
facility and does not imply a separate unimplemented library.

## Existing routes

| Intended operation | Provider route | Actual controls | Acceptance status |
| --- | --- | --- | --- |
| Animate a person in the photo's setting using a movement video | Kling v3 Standard/Pro Motion Control | Image, movement video, video orientation, optional identity element, original sound | Existing route; assess each output against this intended operation |
| Creative changes to an existing video, including an animal character | Kling O3 Standard Edit | Video, identity references, description, original sound | Public editing remains disabled; the owner identity-only experiment failed scene/framing acceptance |
| Replace a person while keeping the source scene, camera and performance | H3 Max Recast, owner candidate only | Source video, one explicitly chosen portrait, fixed 1080P, realism and safety enabled | Not visually validated; owner validation only; no O3 fallback |

The earlier example tiles only selected modes and descriptions. They were not
separate provider workflows and have been removed at the user's request.

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

Optional priced text/overlay cleanup is implemented as an owner-only workflow:
local OCR and a reviewed mask, one combined quote, source inpainting, browser
composition with original audio, then 1080P Recast. It requires the exact server
capability, migration and supported browser APIs; customers cannot enable it.
See [text-removal-plan.md](text-removal-plan.md) for evidence and limitations.
The full local chain passes with provider fixtures. A separately accepted
cleanup composite does not prove a new full Recast result or autonomous removal
of every overlay; those real-output acceptance gates remain open.

## Continue after a short trial

A trial is its own explicitly priced generation, not a replacement for the
user's selected full duration. Keep the full draft while preparing a separate
five-second Motion/Edit working clip or six-second Recast working clip. Upload
and price the actual working clip, never the full-duration input by mistake.

After completion, show the playable trial on the result screen and reuse the
existing `prepare` action as the `Volledige versie maken` text link. Do not add
a second full-generation button below the result or in the completion popup.
Saving the file remains a separate download action. The continuation action
restores the chosen files, start, duration, crop, portrait/references,
description, audio and model in the existing description popup (step 3 of 3),
selects the full plan, then uses the
ordinary preparation, fresh quote and explicit confirmation. The trial is
billed separately; continuing never automatically purchases or submits the
full generation. Only a matching saved trial draft can offer this continuation;
an unknown older completed video is not relabelled or sold as a trial.

The same tab can retain references to the original local File objects. A real
reload retains only bounded account-scoped continuation metadata; it does not
silently persist large original videos or private media URLs. If the originals
are no longer held, request explicit re-selection and preserve the settings
that can be safely restored. Completion of an earlier job must not overwrite
a different draft the user has since started. Starting another draft is an
explicit result-screen action; it must stay blocked while a paid request is
active or its acceptance/status remains uncertain.

## Claims that are not separate processing steps

Keeping source audio does not establish correct lip synchronization. The current
steady-camera instruction is a prompt, not an independent camera tracker.
An ordinary generation prompt is not a cleanup pass. The separate owner-only
cleanup workflow uses an inspected mask; local OCR alone does not detect every
icon. Recast alone must not be advertised as a text remover.
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
