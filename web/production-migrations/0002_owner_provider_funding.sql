-- Existing quotes/jobs remain credit-funded. Do not import a Fal balance or
-- create purchased RIG credit for provider-funded owner usage.
ALTER TABLE rig_generation_quotes ADD COLUMN funding_kind TEXT NOT NULL DEFAULT 'credits'
  CHECK(funding_kind IN ('credits','owner-provider'));
CREATE TABLE rig_owner_provider_usage (
  job_id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL UNIQUE REFERENCES rig_generation_quotes(id),
  user_id TEXT NOT NULL,
  estimated_usd_micros INTEGER NOT NULL CHECK(estimated_usd_micros > 0),
  state TEXT NOT NULL CHECK(state IN ('authorized','completed','failed')),
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  CHECK((state='authorized' AND finalized_at IS NULL) OR
    (state IN ('completed','failed') AND finalized_at IS NOT NULL))
);
