# Text and overlays — owner workflow and acceptance gates

The intended control is **Verwijder tekst en overlays**, beside the crop control
in the existing popout. It includes subtitles, account labels, watermarks,
logos, social icons, counters and playback controls. Actual scene objects such
as a phone in a person's hand must not be treated as screen controls.

This branch connects the popout to real owned source/mask routes, a combined
quote and a durable two-provider workflow. Deployment and activation are separate
gates: it stays hidden without the exact owner capability, optional migration and
required local browser APIs. Customers cannot enable this owner validation path.
A prompt instruction alone does not establish that text was removed.

## Observed capability, 2026-11-10

An owner-approved cleanup proof used an already completed clip; its primary
person-replacement generation was not purchased again. The source was
768 × 1344, 24 fps, 142 frames, 5.916667 seconds of video plus original AAC audio.

- `fal-ai/sam-3/video` with `prompt: "text"` completed, but all 142 mask frames
  were black. This candidate failed text coverage and is not the production
  detector. Its result was not sent as a usable mask to the inpainting model.
- Local Tesseract OCR plus **visually selected** screen-overlay rectangles
  produced the replacement mask. Face and phone/hand exclusions were also
  deliberately selected. This proves a controlled mask can work; it does not
  prove autonomous detection of all text or icons.
- `fal-ai/ltx-2.3-quality/inpaint` completed once with that mask, the exact
  142-frame/24 fps clock, 30 steps, maximum quality, prompt expansion off, audio
  generation off and safety on. Its output retained the dimensions, count and
  timing. The inspected start/middle/end showed the letters and screen icons
  removed. Some reconstructed background shading remains visible.
- The raw inpaint output subtly changed image details outside the selected
  regions. The accepted browser proof therefore combined the cleaned regions
  with the original video using the reviewed sharp mask boundary and copied the
  original AAC packets. A separate earlier local proof used feathered edges;
  that is not the file the owner accepted.
  Video presentation timestamps, audio timestamps and original audio bytes were
  compared. The final H.264 encode is lossy: no pixel-identical output claim.
- A separate actual-browser gate decoded and encoded all 142 frames, then
  verified the same frame timestamps and durations with zero differences. OCR
  ran from self-hosted resources. This gate's fixed rectangle tested timing,
  **not** automatic text detection or the finished website path.
- The owner accepted the actual browser composite. Its original and resulting
  AAC decode to identical PCM; the strict server inspector also accepts its
  actual presentation clock and codec geometry.
- The actual portable Site build loaded its local OCR worker, core and language
  files under the worker-only Wasm policy, detected25 text boxes, and terminated
  both normal/canceled workers. No external request or provider job was needed.
- A real irregular working clip was locally normalized to150 frames at30 fps,
  exactly5 seconds. Its121-sample audio gap required one explicit local AAC-LC
  256k preparation encode. That newly prepared source passes the strict server
  inspector, including a5-second audio timeline. After this preparation boundary,
  browser composition still requires exact AAC bytes/configuration/timing.

The individual private proof receipts and media stay outside the repository.
No further provider generation is authorized by this document.

## Screen-recording crop is a separate free preparation step

The requested automatic crop concerns the **reference screen recording**, not
its uploaded identity photo. It proposes the actual video rectangle, excluding
browser/app bars, unused borders and controls outside that rectangle. Display
it in the crop popout and retain drag handles for correction. Do not silently
reframe a person or change the requested camera distance.

OCR alone cannot distinguish every icon or locate the true video rectangle.
Uncertain proposals require review. Anything overlaid inside the video still
needs the selected cleanup, not a crop through the person's face or body.

## Chosen processing order

1. Locally choose/trim/crop, then privately prepare the bounded working clip.
   Original large phone files remain local. Read back the **exact** normalized
   owned clip before making its paired mask; normalizing again afterward would
   invalidate the frame clock and hash binding.
2. Detect text locally, propose optional overlay regions and let the user
   inspect/correct them in the popout. Icons need actual selection or detection;
   OCR does not establish icon coverage. No paid Fal request before price consent.
3. Price the complete source-cleanup plus primary-generation plan, including
   conservative rounding, configured margin/failure buffer and all budget caps.
   The customer sees the total euro price; the owner funding path retains the
   combined private Fal estimate. Bind source/mask hashes, exact timing,
   settings, plan and transfer consent into one immutable quote.
4. After confirmation, reserve once and execute source inpainting once.
   Preserve its result privately. Recombine with the owned source and original
   audio before the main generation, with exact count/timing/dimension checks.
   Browser composition may pause at `awaiting_client_processing`; reopening
   resumes from private artifacts and never resubmits the paid cleanup.
5. Explicitly advance the already approved plan after the composed artifact
   passes server verification. Run the primary generation with that cleaned
   working clip. Inspect the result; no automatic paid retry or unpriced second
   cleanup if overlays are reintroduced.
6. Keep every request ID and dispatch decision durable. A definitive failure
   before/of the main generation refunds the customer's full retail hold while
   retaining any already-incurred cleanup provider cost in the owner's journal.
   An ambiguous provider submission is not automatically refunded or repeated.

For an already finished video, an explicitly priced result-cleanup operation may
reuse it. Do not buy the primary generation again. Optional postcleanup failure
must retain the base video and settle only its prequoted addon separately.

## Billing and provider contract

Live schema/pricing were checked on 2026-11-10:

- LTX Quality inpaint: USD0.0024075 per **megapixel**; 9–481 frames, 1–60 fps.
  Billing dimensions differ from a per-second video model. The initial narrow
  parser/contract accepts exact constant 24, 25 or 30 fps clocks only. No hidden
  trimming or frame padding to fit the provider limit.
- The quote estimates `ceil(width × height × frameCount / 1,000,000)` megapixels
  and rounds USD micro-units upward. This is a conservative quote convention,
  not evidence of the provider's final rounding or actual charged cost.
- The 142-frame proof used approximately USD0.354 of estimated LTX processing;
  the failed SAM detector adds approximately USD0.045. The final provider charge
  was not returned by request history. Local composition/audio copying added no
  further Fal request.

`web/overlay-cleanup-contract.mjs` pins the endpoint, live rate/unit, fixed
quality settings, owned hashes and combined US$6 maximum. The owner-only
`workflow-runtime.mjs` and `workflow-http.mjs` use it for real source-cleanup
plus1080p Recast quotes. SAM is excluded from that price. Turning the option off
also removes unconditional cleanup
instructions from its generation prompt; there must be no hidden cleanup cost.

Primary sources:

- https://fal.ai/models/fal-ai/ltx-2.3-quality/inpaint/api
- https://fal.ai/models/fal-ai/sam-3/video/api

## Deployment and acceptance boundaries

Owned normalized-clip readback, exact paired-mask storage, overlay review,
combined price/approval, durable multi-step runner, resumable browser composition,
and trusted artifact/timing/audio validation are implemented and regression-tested.
The actual website must still pass its explicit owner generation/visual acceptance
before broadening availability. GET status requests cannot dispatch
new paid work. Keep storage private, temporary transfer consent explicit and
owner passkey/daily/per-job limits intact. Do not enable a cosmetic checkbox in
place of these gates.

Accepted source, mask and portrait copies are bound to job, plan and content
hash in existing private storage before any paid step. Existing24-hour intake
expiry does not strand an already accepted workflow. Scheduled collection polls
only existing known provider requests and never advances a new paid step.

The native FFmpeg processor proof is a tested optional fallback outside the
repository; no Container, new hosting plan or broader Cloudflare permission was
activated for it. Browser composition is the first integration path.
