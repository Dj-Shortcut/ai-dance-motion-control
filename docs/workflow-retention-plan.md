# Workflow retention: read-only proposal

No deletion worker, cron, lifecycle rule, storage permission or live database
change is created by this plan. No production inventory has been run. Existing
Fal temporary links keep their requested24-hour lifecycle. This document does
not extend retention or promise indefinite recovery.

## Inventory before any janitor

Use only an authenticated owner/operator capability and existing private
bindings. First check migration0014 availability; an absent table is a readiness
finding, never a reason to execute new-table queries on a flag-off old schema.
Read bounded pages and keep a private metadata-only receipt. Exclude prompts,
credentials, temporary provider URLs and source bytes from reports.

Inventory accepted parent/user/quote IDs, plan hash/version, settlement, every
step's state and official request ID, result keys/hashes, client-processing state,
and the bound source/mask/composed artifact references. Private object HEAD checks
can establish size, content type, cache policy, recorded identity/hash and
creation/expiry metadata; they do not independently hash the stored bytes.

Example read-only inventory, after migration availability is established:

```sql
SELECT w.job_id,w.user_id,w.quote_id,w.plan_version,w.plan_hash,
       j.state AS parent_state,j.created_at,j.finalized_at,
       s.outcome,s.finalized_at AS settled_at,
       cp.stage_id,cp.state AS client_state,cp.output_key,cp.output_sha256,
       CASE WHEN json_valid(w.plan_json)
            THEN json_extract(w.plan_json,'$.clientProcessing.source.id') END AS source_id,
       CASE WHEN json_valid(w.plan_json)
            THEN json_extract(w.plan_json,'$.clientProcessing.mask.id') END AS mask_id
FROM rig_generation_workflows w
JOIN rig_generation_jobs j ON j.id=w.job_id AND j.user_id=w.user_id
LEFT JOIN rig_generation_workflow_settlements s ON s.job_id=w.job_id
LEFT JOIN rig_generation_workflow_client_processing cp ON cp.job_id=w.job_id
WHERE w.job_id>?
ORDER BY w.job_id LIMIT 100;
```

Resolve step artifacts in another bounded query by an exact owned job ID. Never
enumerate another user's paths from a browser-supplied prefix. A future object
listing must remain limited to workflow prefixes and cross-check this durable
inventory. No listing or deletion is performed now.

## Classification, not authorization to delete

| Condition | Read-only decision |
| --- | --- |
| Unsettled, authorized, queued, unknown, or awaiting client processing | Keep/review. A retry, freeze or flag stop does not prove paid work ended. |
| Official request with uncertain provider outcome | Preserve and reconcile that same request; no expiry-based refund or new generation. |
| Exact final settlement plus completed base | Intermediate media may become candidates only under an approved policy; preserve the accepted result and financial/request journal. |
| Definitively failed workflow and final settlement | Rejected private output remains investigation evidence until an explicit retention policy applies. |
| Expired intake object without accepted workflow reference | Candidate under an approved intake-expiry policy; prove there is no accepted reference first. |
| Unreferenced content-addressed composed upload | Review as an unpaid orphan after an approved grace period; a client row may still be in flight. |
| Conflicting identity/hash metadata, missing object or unsupported schema | Review; never overwrite or delete evidence as a repair. |

No candidate authorizes deletion. A future janitor needs a reviewable dry-run
receipt and an immediate recheck of exact object version/etag and durable state
before any separately approved delete. Financial rows, provider IDs, settlements
and original files on the user's device are outside media cleanup. No final-result
expiry or orphan grace period is invented here.

## Paid pause versus24-hour intake expiry

The current exact input store rejects reads after its recorded24-hour expiry.
Keeping physical bytes alone does not make a paid browser pause resumable after
that deadline. Before activation, choose and disclose an explicit policy:

1. Before paid preclean, copy the exact accepted source/mask into a private
   job/plan/hash-bound namespace with a disclosed accepted-job retention window,
   or add an equally narrow database-proven accepted-workflow reader. This must
   not generally extend intake access or silently change retention promises.
2. Keep intake expiry, explain the resume deadline, and implement cancellation
   and settlement for a definitively never-started base if required media expires.
   Already incurred provider cleanup costs remain cost evidence; they never
   become free preparation or an assumed Fal refund.

Unknown submissions cannot use option2 as an expiry-based refund. Preserve
completed results privately before temporary Fal links expire. The adapter can
recover a lost D1 completion from verified write-once R2 metadata without a second
generation. Actual late-tab recovery, expiry handling and a reviewed retention
policy remain activation requirements.
