# Owner generation workflow

The production service registers a separately gated owner workflow through
`workflow-http.mjs` and `workflow-runtime.mjs`. It uses the existing funding,
passkey, approval, private media and budget controls. It is unavailable until
the additive0014 migration and exact owner cleanup/Recast flags are present;
customer workflows remain disabled. Deployment and real model acceptance must
be established separately from local database/provider-adapter regression tests.

## Immutable plan and paid dispatch

`quote.input.workflow` uses `version: 'rig-workflow-v2'`, a canonical SHA-256
`planHash`, `baseStepId`, retail splits, and two to eight linear provider steps.
Exactly one step is the primary `base`; preceding steps are `preclean`, following
steps are optional `postcleanup`. Each step binds its endpoint, queue family,
provider contract, exact settings, dependency, conservative USD estimate and
retail allocation. The parent model is the primary step's model. All step totals
must equal the quote totals. Existing maximums remain US$6 provider estimate and
€12 reserved retail per job; daily limits are read from the current policy.

The controller must validate the selected real provider contracts and trusted
media before creating this plan. The generic store cannot prove model suitability
or current provider prices. Neither a browser checkbox nor client metadata can
create a plan.

Integration order:

1. Create and confirm one combined quote with existing transfer consent and,
   for owner funding, the standard device proof. Call existing `jobs.begin` once
   to reserve the entire retail amount; initialize the workflow from that exact
   accepted quote.
2. Call existing `jobs.authorizeDispatch` once for the combined provider budget.
   Never call it separately for a cleanup step. Initialize before this call so
   legacy dispatch-budget queries can recognize an unfinished workflow.
3. For each paid step, resolve and inspect owned input bytes, build the exact
   payload, then call `authorizeStep` with source/input/request digests.
   Only `{authorized:true, dispatchToken}` permits one provider POST by that
   winning caller. Every new paid step re-reads a genuine current production
   context, current owner pin, account freeze, accepted funding, cost snapshot,
   dependency, and shared daily budget. Never reuse the immutable context as the
   fresh policy reader.
4. Persist the official request ID with `markSubmitted`. An ambiguous POST must
   become `unknown`, not be retried or refunded. A late response may attach its
   original request ID using its original dispatch token. `recoverAuthorized`
   conservatively marks orphan authorizations unknown; call it only after the
   original handler is known to have ended, not during a live dispatch.
5. Poll known request IDs with the step poll lease. Download, inspect and save
   the actual owned output before `markCompleted`; do not accept a remote URL as
   a result. The exact private step key is
   `rig-workflow-results/<jobId>/<stepId>.mp4`. `markFailed` requires a definitive
   terminal answer for the same known request. Unknown outcomes stay held for
   reconciliation. Never turn a timeout into a paid retry.
  Store compact output metadata (at most8192 canonical-JSON characters), not
  the inspector's full per-packet/per-frame arrays. `workflowClientMedia`
  supplies the compact bound clock and AAC digests.
6. Skip only never-dispatched prepared steps, then call `finalize` when all
   steps are definitively terminal. Completed/partial parents are `completed`;
   settlement metadata distinguishes the outcome.

## Source cleanup and browser composition

An optional hash-bound `plan.clientProcessing` describes one non-provider edge
between an immediately preceding preclean and the primary base:

```js
{
  id: 'compose', contract: 'rig-client-mask-compose-v1',
  beforeStepId: 'base', cleanFromStepId: 'preclean',
  source: {id, sha256}, mask: {id, sha256},
  media: {
    width, height, frameCount, fpsNumerator, fpsDenominator,
    timelineSha256, hasAudio,
    audio: null // or {packetSha256, timelineSha256, codecConfigSha256}
  }
}
```

The source and mask must each occur exactly once in accepted `quote.input.refs`.
All clocks, geometry, zero-start presentation timestamps and audio digests come
from inspection of held server-owned bytes, not from browser assertions. The
clean artifact comes exclusively from the completed bound preclean step.

`createProductionWorkflowClientStores` requires genuine production context and
the workflow store. It has no provider/network client. Private callbacks are:

- `readOwnedArtifact({userId,jobId,stageId,role,reference}) -> Uint8Array`.
  `reference` is constructed by the server from an accepted input ID or the exact
  stored workflow result/composed key. Resolve input ownership in the production
  namespace, bound/stream the R2 read before allocation, never follow a URL.
  Return a fresh exclusively held non-shared byte array and do not mutate it
  while inspection or the response uses it; avoid redundant large buffer copies.
- `putOwnedOutput({userId,jobId,stageId,key,bytes,sha256})`.
  Store these exact held bytes privately, with content-addressed write-once
  semantics. No public bucket or temporary provider link is needed here. Return
  only after R2 confirms the write. Preserve composed keys until their workflow
  outcome/retention policy allows removal. Concurrent discarded unpaid uploads
  can leave orphan content-addressed objects; the eventual reaper must remove
  those without touching referenced artifacts.

`prepareAwaiting` verifies source/clean/mask bytes with `inspectWorkflowMp4` and
saves one immutable private manifest. The public projection can be
`awaiting_client_processing`; the existing parent database state remains queued.
`get` and `getArtifact` are private reads and never submit, authorize or advance
a paid step. A reopened tab can download the same three artifacts and recompose
without repeating the preclean provider job.

`uploadOutput` reads at most16MiB/1024 chunks with a15-second stream deadline, verifies the
actual output SHA-256, exact frame timeline/geometry, and unchanged original AAC
packet/config/timing hashes, then records `ready_to_advance`. This is structural
and packet evidence, **not proof that pixels outside the mask were preserved**.
Only explicit authenticated POST `advance` can mark this exact output advanced;
it records a durable idempotency key and checks current owner/freeze/funding.
It does not itself dispatch. A POST controller may then call normal
`authorizeStep`; its atomic guard requires the exact advanced plan/clean/output
hash and rechecks the spending controls. Use the clean hash as `sourceHash`,
composed output hash as `inputHash`, and payload hash as `requestHash`. Never
advance from a GET, a polling handler, an artifact download, or upload alone.

Role limits are source16MiB, clean64MiB, mask2MiB, composed output16MiB. These
are internal normalized artifacts, not limits on original phone media. The
inspector accepts only a deliberately narrow supported H264/AAC MP4 subset.
Unsupported input must fail before charging/dispatch where possible; do not
silently transcode, shorten, lower quality or increase these limits.

## Settlement and financial hooks

- Failure before or of the primary base returns **all reserved retail**, even
  when paid preclean work already cost Fal credit. Preserve those request IDs
  and conservative provider cost authorization; never label it free preparation
  or assume Fal issued a refund.
- Only a completed base followed by definitive optional postcleanup failure or
  cancellation gives a partial outcome. Keep the base result and return the
  quoted postcleanup addon exactly once.
- Unknown provider status gives neither an automatic refund nor a new request.
- Owner-provider funding never creates RIG ledger credit. A customer refund
  does not refill provider authorization. Step JSON retains per-step estimates;
  these are not claimed actual Fal charges. Actual cost reconciliation remains
  a separate accounting task.

`workflow-finance.mjs` provides a pure validated net-retail hook and SQL
fragments. Before activation, integrate the settlement join and `charged_cents`
into **both earned spend and reflected promotional-credit allocation** in owner
finance before enabling customer-funded workflows; the validation candidate is
owner-only. Legacy dispatch and owner finance now share a conservative budget
predicate: unknown/submitting jobs and queued parents without an official
provider ID remain held across UTC days. With the cleanup flag enabled, explicit
unfinished workflow/settlement proof is included too. The flag-off path references
no new table and works on an unmigrated database. The new workflow step store
also checks the conservative unfinished total. Do not make flag-off runtime query
an unapplied table.

## Still required before activation

Root-owned integration remains: migration rehearsal/backups and explicit apply;
trusted quote builder/provider price preflight; accepted combined consent and
device-proof binding; exact provider payload/export implementation; bounded
private R2 ownership readers/writers; private manifest/download/upload/POST
advance routes with CSRF/session/content-type/rate/preparation-quota checks;
frontend adapter, compatible WebCodecs capability gate and understandable pause
recovery; orchestration/poll/reconciliation workers; net customer-workflow finance;
retention for paused artifacts; cancellation and abandoned
known-unstarted-base settlement; safe public status/error formatter; and a visual
end-to-end acceptance test. Generic legacy preparation-failure/refund/status
handlers must never process a workflow parent as a single provider job.

The server must not claim pixel attestation from uploaded composition metadata.
Route/form security, callback storage correctness, browser output quality, actual
provider behavior/costs, live D1 migration and recovery across a real deployment
are not established by these local store tests. No cloud publication or paid
generation was performed for this foundation.

See `workflow-retention-plan.md` for the read-only inventory and unresolved
retention boundaries. It creates no janitor, lifecycle rule or deletion policy.
