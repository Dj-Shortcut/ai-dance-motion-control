# Private input delivery to fal

The O3 request reached fal, then failed with `input_value_error`: the input
file could not be accessed. The exact stored MP4 was downloaded privately,
matched its stored SHA-256 and decoded completely with FFmpeg. Its H.264/AAC,
720 x 1280 dimensions, frame rate and five-second duration meet the published
O3 input contract. This does not identify which remote downloader failed.

An independent request to the current `workers.dev` delivery host reproduced
Cloudflare 1010 with the default Python urllib client; other clients reached
the application. Cloudflare documents this browser-integrity restriction on
managed hostnames. Worker GET/hash checks cannot establish access from every
downstream provider. This is evidence of an incompatible delivery path, not
proof of the exact downloader used for this particular failed request.

## Opt-in R2 delivery

With `RIG_R2_INPUTS_ENABLED=yes`, only O3 editing uses a private delivery copy
and a signed S3 GET. There is no fallback to another transport after failure.
The existing owner, quote, reservation, freeze, idempotency and dispatch
checks still apply. Motion control keeps its existing transport.

The private media service verifies the owned source manifest and exact bytes,
then conditionally writes an opaque `.jpg` or `.mp4` copy under
`rig-inputs/provider/`. No owner ID, source filename or source manifest is
copied into its HTTP metadata. That prefix is covered by the existing input
bucket's one-day lifecycle. Original user files are not changed.

The private video service signs a GET for that exact copy using the EU S3
endpoint, for one hour. It verifies an anonymous complete GET and byte range,
including exact bytes/hash, before dispatch. Signed URLs and credentials are
never returned in browser/MCP responses or logged. The bucket remains private;
no public bucket, custom domain or paid plan is required.

Configuration on the private video Worker:

- `RIG_R2_INPUTS_ENABLED=yes`
- `RIG_R2_INPUTS_ACCOUNT_ID`: the existing Cloudflare account ID
- `RIG_R2_INPUTS_BUCKET`: the existing EU input bucket
- Encrypted secrets `RIG_R2_INPUTS_ACCESS_KEY_ID` and
  `RIG_R2_INPUTS_SECRET_ACCESS_KEY`: an R2 Object Read credential scoped only
  to the input bucket. Do not use an account-wide administrator credential.

The media Worker needs no new credential. It writes through its existing
private R2 binding. Enabling R2 delivery with incomplete configuration fails
closed before generation. Test and live payments are unchanged.

## Verification boundaries

A presigned GET is bound to its HTTP method: HEAD may return 403. Do not claim
HEAD support or weaken signature checks to simulate it. A signed link remains
usable until its one-hour expiry unless its copy object or credential is
removed; a subsequent database freeze alone cannot revoke it. The unsigned
object stays private. Physical lifecycle deletion can lag the one-day limit.

Local tests do not establish acceptance by fal/Kling. Before another paid
submission, verify the actual delivery path with synthetic private objects.
A successful, explicitly confirmed five-second O3 output remains the final
generation gate. Do not automatically repeat a failed or uncertain job.

References:

- [Cloudflare error 1010](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2 API tokens and EU endpoints](https://developers.cloudflare.com/r2/api/tokens/)
- [Kling O3 edit input contract](https://fal.ai/models/fal-ai/kling-video/o3/standard/video-to-video/edit/api)
