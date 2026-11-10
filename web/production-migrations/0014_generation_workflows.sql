-- PROPOSAL ONLY. Do not apply before the orchestration/provider contract is reviewed.
-- Existing single-provider jobs and their settlement remain unchanged.
CREATE TABLE rig_generation_workflows (
 job_id TEXT PRIMARY KEY REFERENCES rig_generation_jobs(id),
 quote_id TEXT NOT NULL UNIQUE REFERENCES rig_generation_quotes(id),
 user_id TEXT NOT NULL,
 plan_version TEXT NOT NULL CHECK(plan_version='rig-workflow-v2'),
 base_step_id TEXT NOT NULL,
 plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64),
 plan_json TEXT NOT NULL,
 step_count INTEGER NOT NULL CHECK(step_count BETWEEN 2 AND 8),
 base_retail_cents INTEGER NOT NULL CHECK(base_retail_cents BETWEEN 1 AND 1200),
 cleanup_retail_cents INTEGER NOT NULL CHECK(cleanup_retail_cents BETWEEN 0 AND 1200),
 provider_estimate_usd_micros INTEGER NOT NULL CHECK(provider_estimate_usd_micros BETWEEN 1 AND 6000000),
 created_at INTEGER NOT NULL
);
CREATE TABLE rig_generation_workflow_steps (
 job_id TEXT NOT NULL REFERENCES rig_generation_workflows(job_id),
 step_id TEXT NOT NULL,
 step_index INTEGER NOT NULL CHECK(step_index BETWEEN 0 AND 7),
 step_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','authorized','queued','unknown','completed','failed','skipped')),
 dispatch_token TEXT UNIQUE,
 source_sha256 TEXT,
 input_sha256 TEXT,
 request_sha256 TEXT,
 fal_request_id TEXT UNIQUE,
 result_key TEXT,
 output_sha256 TEXT,
 output_metadata_json TEXT,
 failure_code TEXT,
 poll_token TEXT,
 poll_lease_until INTEGER,
 authorized_at INTEGER,
 submitted_at INTEGER,
 finalized_at INTEGER,
 PRIMARY KEY(job_id,step_id),
 UNIQUE(job_id,step_index),
 CHECK(state<>'prepared' OR (dispatch_token IS NULL AND fal_request_id IS NULL)),
 CHECK(state NOT IN ('authorized','unknown','queued','completed') OR dispatch_token IS NOT NULL),
 CHECK(state NOT IN ('queued','completed') OR fal_request_id IS NOT NULL),
 CHECK(state<>'completed' OR (result_key IS NOT NULL AND output_sha256 IS NOT NULL AND output_metadata_json IS NOT NULL)),
 CHECK(state<>'skipped' OR (dispatch_token IS NULL AND fal_request_id IS NULL))
);
CREATE INDEX rig_generation_workflow_steps_state ON rig_generation_workflow_steps(state,authorized_at);
CREATE TABLE rig_generation_workflow_settlements (
 job_id TEXT PRIMARY KEY REFERENCES rig_generation_workflows(job_id),
 outcome TEXT NOT NULL CHECK(outcome IN ('completed','partial','failed')),
 funding_kind TEXT NOT NULL CHECK(funding_kind IN ('credits','owner-provider')),
 base_step_id TEXT NOT NULL,
 provider_authorized_steps INTEGER NOT NULL CHECK(provider_authorized_steps BETWEEN 0 AND 8),
 provider_dispatched_steps INTEGER NOT NULL CHECK(provider_dispatched_steps BETWEEN 0 AND 8 AND provider_dispatched_steps<=provider_authorized_steps),
 reserved_cents INTEGER NOT NULL CHECK(reserved_cents BETWEEN 1 AND 1200),
 charged_cents INTEGER NOT NULL CHECK(charged_cents BETWEEN 0 AND 1200),
 refunded_cents INTEGER NOT NULL CHECK(refunded_cents BETWEEN 0 AND 1200),
 result_key TEXT,
 plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64),
 finalized_at INTEGER NOT NULL,
 CHECK(charged_cents+refunded_cents=reserved_cents),
 CHECK((outcome='failed' AND charged_cents=0 AND result_key IS NULL) OR
       (outcome='partial' AND charged_cents>0 AND refunded_cents>0 AND result_key IS NOT NULL) OR
       (outcome='completed' AND refunded_cents=0 AND result_key IS NOT NULL))
);
-- A non-provider edge between preclean and base. GET/read/upload never dispatch.
CREATE TABLE rig_generation_workflow_client_processing (
 job_id TEXT NOT NULL REFERENCES rig_generation_workflows(job_id),
 stage_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64),
 contract TEXT NOT NULL CHECK(contract='rig-client-mask-compose-v1'),
 before_step_id TEXT NOT NULL,
 clean_step_id TEXT NOT NULL,
 clean_sha256 TEXT NOT NULL CHECK(length(clean_sha256)=64),
 inputs_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('awaiting_client_processing','ready_to_advance','advanced')),
 output_key TEXT,
 output_sha256 TEXT,
 output_size INTEGER,
 output_metadata_json TEXT,
 advance_key TEXT,
 created_at INTEGER NOT NULL,
 uploaded_at INTEGER,
 advanced_at INTEGER,
 PRIMARY KEY(job_id,stage_id),
 UNIQUE(user_id,advance_key),
 CHECK(state='awaiting_client_processing' OR (output_key IS NOT NULL AND length(output_sha256)=64 AND output_size BETWEEN 32 AND 16777216 AND output_metadata_json IS NOT NULL)),
 CHECK((state='advanced' AND advance_key IS NOT NULL AND advanced_at IS NOT NULL) OR (state<>'advanced' AND advance_key IS NULL AND advanced_at IS NULL))
);
