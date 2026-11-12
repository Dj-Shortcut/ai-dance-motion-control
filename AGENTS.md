# RIG

Before changing the interface, read [the interface contract](docs/interface-contract.md).
The visual source is the original five-screen Claude canvas in
[docs/design-reference/claude-mobile](docs/design-reference/claude-mobile/canvas.json):
Start, photo/video, placement, make, result. Preserve that separate-screen flow;
do not turn it back into one long editor. The make screen uses the existing
description pop-out, styled as step 3 of 3.

The original canvas is a reference, not a backend contract. The user's later
instruction removes all example/idea tiles. Do not copy its three-second trial,
mock prices, countdowns, progress percentages, sign-in claims or simulated result
controls into the product. Use real capabilities, media, prices and job states.

Reuse the single sticky main action and the existing price/approval pop-outs.
Keep settings, crop and identity references under More options. After a matching
trial, the same main action continues the saved full selection and obtains a
fresh price and confirmation; never add a detached full-video generation button.
Preserve the user's own choices and the existing security and payment gates.

Verify behavior behind visible controls and inspect desktop and phone layouts.
Keep implementation, publication, local provider fixtures and actual paid output
acceptance distinct when reporting results.
