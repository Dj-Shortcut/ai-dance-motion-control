-- Fresh isolated production DB only; review before applying. No test rows or balances.
-- Apply to a dedicated D1 database. All values are integer units, never floats.
-- The administrator must explicitly insert exactly one row setting mode to
-- 'test' OR 'live'. Use completely separate DBs for test and live; never
-- change an existing environment row to live or reuse its balances.
CREATE TABLE IF NOT EXISTS rig_payment_environment (
  id INTEGER PRIMARY KEY CHECK (id=1),
  mode TEXT NOT NULL CHECK (mode IN ('test','live'))
);
CREATE TABLE IF NOT EXISTS rig_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  credits INTEGER NOT NULL CHECK (credits > 0),
  payment_id TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'creating',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, request_id)
);
CREATE TABLE IF NOT EXISTS rig_ledger (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  order_id TEXT REFERENCES rig_orders(id),
  delta INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rig_frozen_accounts (
  user_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS rig_ledger_user ON rig_ledger(user_id);
-- Fixture-only payment intent cancellation tombstones, scoped to owner.
CREATE TABLE IF NOT EXISTS rig_payment_cancelled_intents (
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id,request_id)
);
-- One in-flight or manually reviewed purchase per account. The provider
-- request is made only after this constraint has accepted the order. SQLite
-- enforces this atomically even for distinct idempotency keys.
CREATE UNIQUE INDEX IF NOT EXISTS rig_one_unresolved_order_per_user
  ON rig_orders(user_id)
  WHERE state IN ('creating','open','unknown','credit_pending_review');
-- Durable, internal outbox for Mollie payments that must be reviewed or canceled
-- following an account freeze. Never expose this table as a browser route.
CREATE TABLE IF NOT EXISTS rig_cancel_requests (
  order_id TEXT PRIMARY KEY REFERENCES rig_orders(id),
  user_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','done','review')),
  lease_token TEXT,
  lease_until INTEGER,
  delete_attempted INTEGER NOT NULL DEFAULT 0 CHECK(delete_attempted IN (0,1)),
  reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rig_cancel_state ON rig_cancel_requests(state,lease_until);
-- Durable status verification after a confirmed cancellation. The record is
-- separate from the cancellation attempt so a crash cannot lose reconciliation.
CREATE TABLE IF NOT EXISTS rig_cancel_reconcile (
 order_id TEXT PRIMARY KEY REFERENCES rig_orders(id),
 payment_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processing','done','review')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 next_at INTEGER NOT NULL,
 lease_token TEXT,
 lease_until INTEGER,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rig_cancel_reconcile_queue ON rig_cancel_reconcile(state,next_at,lease_until);
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
-- Deploy through schema migrations. No runtime schema creation.
CREATE TABLE IF NOT EXISTS rig_rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  requests INTEGER NOT NULL CHECK(requests > 0)
);
-- Apply through the hosting migration mechanism. Never create tables on request.
CREATE TABLE rig_gateway_nonces (nonce TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE INDEX rig_gateway_nonces_created ON rig_gateway_nonces(created_at);
CREATE TABLE rig_staging_lease(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,expires_at INTEGER NOT NULL);
-- Test-only shared media lease. Apply by controlled migration, not per request.
CREATE TABLE rig_sites_signer_lease(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,expires_at INTEGER NOT NULL);

-- Deliberately no mode seed. Production D1 must be provisioned independently.

-- Existing dedicated consumer TEST database only. No account/email auto-link.
CREATE TABLE rig_sites_identities (
 site_id TEXT NOT NULL,
 subject_hash TEXT NOT NULL CHECK(length(subject_hash)=64),
 user_id TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(site_id,subject_hash)
);
CREATE TABLE rig_sites_bridge_nonces (
 site_id TEXT NOT NULL,
 nonce TEXT NOT NULL CHECK(length(nonce)=32),
 expires_at INTEGER NOT NULL,
 PRIMARY KEY(site_id,nonce)
);
CREATE INDEX rig_sites_bridge_nonce_expiry ON rig_sites_bridge_nonces(expires_at);

CREATE TABLE rig_production_tenant (id INTEGER PRIMARY KEY CHECK(id=1), environment_id TEXT NOT NULL UNIQUE, mode TEXT NOT NULL CHECK(mode='live'), site_id TEXT NOT NULL, site_origin TEXT NOT NULL, bridge_origin TEXT NOT NULL, mollie_profile TEXT NOT NULL, webhook_url TEXT NOT NULL);

-- Production-private preprocessing exclusion; no automatic expiry or unlock.
CREATE TABLE rig_media_work_lock (
 id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','uncertain')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE rig_chatgpt_approvals (
 token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),user_id TEXT NOT NULL,
 quote_id TEXT NOT NULL REFERENCES rig_generation_quotes(id),idempotency_key TEXT NOT NULL,
 expires_at INTEGER NOT NULL,used_at INTEGER
);
CREATE INDEX rig_chatgpt_approvals_quote ON rig_chatgpt_approvals(user_id,quote_id);
CREATE TABLE rig_collector_attempts (
 job_id TEXT PRIMARY KEY REFERENCES rig_generation_jobs(id),last_attempt_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX rig_collector_attempts_age ON rig_collector_attempts(last_attempt_at);
CREATE TABLE rig_payment_reconciliation_attempts (
 order_id TEXT PRIMARY KEY REFERENCES rig_orders(id),last_attempt_at INTEGER NOT NULL
);
CREATE INDEX rig_payment_reconciliation_attempts_age ON rig_payment_reconciliation_attempts(last_attempt_at);

-- One separately audited, previously authorized promotional invitation.
-- Never seed this from an account balance or leave the TEST code spendable.
CREATE TABLE IF NOT EXISTS rig_production_invitation (
 id INTEGER PRIMARY KEY CHECK(id=1),
 code_hash TEXT NOT NULL UNIQUE CHECK(length(code_hash)=64),
 amount_cents INTEGER NOT NULL CHECK(amount_cents=500),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 source_environment_id TEXT NOT NULL CHECK(source_environment_id='rig-public-test-v1'),
 source_invitation_id INTEGER NOT NULL CHECK(source_invitation_id=1),
 source_invalidated_at INTEGER NOT NULL CHECK(source_invalidated_at>0 AND source_invalidated_at<=created_at),
 redeemed_by TEXT,
 redeemed_at INTEGER,
 CHECK((redeemed_by IS NULL AND redeemed_at IS NULL) OR (redeemed_by IS NOT NULL AND redeemed_at IS NOT NULL))
);
