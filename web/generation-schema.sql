-- Apply alongside rig-v2-payments/schema.sql. UTC timestamps are epoch milliseconds.
CREATE TABLE IF NOT EXISTS rig_generation_quotes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_json TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  pricing_version TEXT NOT NULL,
  duration_seconds REAL NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rig_generation_quotes_user ON rig_generation_quotes(user_id);
CREATE TABLE IF NOT EXISTS rig_generation_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  quote_id TEXT NOT NULL UNIQUE REFERENCES rig_generation_quotes(id),
  idempotency_key TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  state TEXT NOT NULL CHECK(state IN ('submitting','queued','unknown','completed','failed')),
  fal_request_id TEXT,
  result_key TEXT,
  failure_code TEXT,
  finalized_at INTEGER,
  poll_token TEXT,
  poll_lease_until INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS rig_generation_jobs_user ON rig_generation_jobs(user_id);

CREATE TABLE IF NOT EXISTS rig_generation_cancelled_intents (user_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,quote_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,idempotency_key));
