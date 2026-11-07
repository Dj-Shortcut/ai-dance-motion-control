# Source provenance

- Repository baseline: `5bfa113704231bb11b1cc5e9782c5d554c341195` on `main`.
  The root Node CLI is retained, with its original MIT license.
- `web/`: consumer test source imported from the local RIG release candidate
  after the video-type and known-photo rejection fixes of 7 November 2026.
  This contains the website, backend modules, schemas and local test fixtures.
  Generated bundles are marked as generated for review.
- `macos/`: the current local Mac GUI source, rather than the older deliverable
  copy. Its own provenance note records the import and offline validation.

Original local sources were preserved. This branch does not include local
credentials, Node dependency folders, Cloudflare state, user photos/videos,
private recovery receipts, account reset scripts or production deployment
configuration. CI builds isolated artifacts; it does not publish or change
the running website.
