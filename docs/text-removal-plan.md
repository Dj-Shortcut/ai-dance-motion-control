# Optional text removal — requested, not implemented

The requested experience is one optional checkbox near the crop control, with
all planned provider processing included in the price before generation. The
checkbox must control actual processing; adding only a prompt or a disabled
visual control does not implement this request.

## Researched provider candidate

Fal's `bria/video/erase/prompt` is a dedicated detection/masking/inpainting step.
Its guide documents the category `text`; `bria/video/erase/mask` accepts an
explicit mask video. The observed provider rate is USD0.14 per processed second
(2026-11-10). Neither route has been visually validated for RIG.

Sources:
- https://fal.ai/learn/devs/bria-video-eraser-prompt-guide
- https://fal.ai/models/bria/video/erase/prompt/api
- https://fal.ai/models/bria/video/erase/mask/api
- https://docs.bria.ai/video-editing/editing/erase-object

All current and legacy variants document input shorter than five seconds and
default to automatic trimming. Never allow automatic trimming to silently cut a
RIG clip. Six- to fifteen-second videos require deliberate segmentation,
stitching and duration/frame/audio checks. Portrait handling and the upstream
750p limit must be verified before offering this on high-quality output.
Prompt detection does not establish that every letter was removed.

## Required processing contract

1. Generate the intended person/motion result, then remove text from that result.
   Do not regenerate it afterward and risk reintroducing overlays.
2. Before confirmation, bind the selected option, all model/settings, segment
   bounds, per-step prices and combined budget to one immutable quote.
3. Store each step's dispatch decision, Fal request ID, status and owned input/
   output hashes durably. The current single-Fal-ID job cannot simply submit a
   second model while retaining its existing completion/refund behavior.
4. Preserve the private intermediate result. The next step consumes only that
   owned result, never an arbitrary client-supplied URL.
5. Preserve the chosen audio and timing. Check visible text and collateral image
   changes before declaring cleanup successful. Do not hide a resolution drop.
6. Account for partial completion: if the base video succeeds but cleanup fails,
   retain the base video and handle the cleanup portion separately. An uncertain
   dispatch must not trigger an automatic paid retry or a premature refund.
7. Turning the option off must also remove unconditional cleanup instructions
   from the relevant generation prompt. No hidden cleanup costs when unselected.

The customer's euro price includes the configured margin and all planned steps.
The owner's direct-provider estimate shows the combined USD cost. Raw base rates
exclude possible segment overlap, rounding, masking and stitching costs; do not
present multiplication alone as a binding quote.
