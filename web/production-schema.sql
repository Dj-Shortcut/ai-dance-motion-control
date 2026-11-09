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
  funding_kind TEXT NOT NULL DEFAULT 'credits' CHECK(funding_kind IN ('credits','owner-provider')),
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

-- Owner usage is a provider-cost journal, never a purchased-credit wallet.
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

-- Additive production-only reporting and conservative spend controls.
-- No order, customer balance or provider secret is created or changed.
CREATE TABLE rig_finance_policy (
 id INTEGER PRIMARY KEY CHECK(id=1), version TEXT NOT NULL,
 eur_per_usd_micros INTEGER NOT NULL CHECK(eur_per_usd_micros BETWEEN 500000 AND 2000000),
 provider_vat_bps INTEGER NOT NULL CHECK(provider_vat_bps BETWEEN 0 AND 3000),
 payment_fee_bps INTEGER NOT NULL CHECK(payment_fee_bps BETWEEN 0 AND 3000),
 failure_buffer_bps INTEGER NOT NULL CHECK(failure_buffer_bps BETWEEN 0 AND 10000),
 preparation_cents INTEGER NOT NULL CHECK(preparation_cents BETWEEN 0 AND 500),
 min_margin_bps INTEGER NOT NULL CHECK(min_margin_bps BETWEEN 0 AND 9000),
 daily_provider_limit_usd_micros INTEGER NOT NULL CHECK(daily_provider_limit_usd_micros BETWEEN 100000 AND 1000000000),
 min_price_cents INTEGER NOT NULL CHECK(min_price_cents BETWEEN 1 AND 1200),
 min_pro_price_cents INTEGER NOT NULL CHECK(min_pro_price_cents BETWEEN 1 AND 1200),
 updated_at INTEGER NOT NULL
);
INSERT INTO rig_finance_policy VALUES(1,'rig-margin-2026-11-09-v1',1000000,2100,1000,1000,5,3000,10000000,100,125,0);
CREATE TABLE rig_finance_policy_history (
 version TEXT PRIMARY KEY, policy_json TEXT NOT NULL, changed_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE rig_generation_costs (
 job_id TEXT PRIMARY KEY REFERENCES rig_generation_jobs(id),
 quote_id TEXT NOT NULL UNIQUE REFERENCES rig_generation_quotes(id), user_id TEXT NOT NULL,
 funding_kind TEXT NOT NULL CHECK(funding_kind IN ('credits','owner-provider')),
 provider_estimate_usd_micros INTEGER NOT NULL CHECK(provider_estimate_usd_micros>0),
 budget_day TEXT NOT NULL, authorized_at INTEGER NOT NULL, snapshot_json TEXT NOT NULL
);
CREATE INDEX rig_generation_costs_day ON rig_generation_costs(budget_day);
CREATE TABLE rig_finance_expenses (
 id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
 category TEXT NOT NULL CHECK(category IN ('fal-charge','fal-topup','mollie','hosting','other','refund')),
 expense_date TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>=0 AND amount_cents<=100000000),
 note TEXT NOT NULL, job_id TEXT REFERENCES rig_generation_jobs(id),
 replaces_expense_id TEXT UNIQUE REFERENCES rig_finance_expenses(id),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64), created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
 CHECK((category='fal-charge' AND job_id IS NOT NULL) OR (category<>'fal-charge' AND job_id IS NULL)),
 CHECK(amount_cents>0 OR category='fal-charge' OR replaces_expense_id IS NOT NULL)
);
CREATE UNIQUE INDEX rig_finance_initial_job_charge ON rig_finance_expenses(job_id) WHERE category='fal-charge' AND replaces_expense_id IS NULL;
CREATE INDEX rig_finance_expenses_date ON rig_finance_expenses(expense_date);

-- Owner passkeys and one-use, exact-operation verification. No money changes.
CREATE TABLE rig_owner_credentials (
 candidate_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 credential_id TEXT NOT NULL UNIQUE,
 public_key TEXT NOT NULL,
 user_handle TEXT NOT NULL,
 counter INTEGER NOT NULL CHECK(counter>=0 AND counter<=9007199254740991),
 device_type TEXT NOT NULL CHECK(device_type IN ('singleDevice','multiDevice')),
 backed_up INTEGER NOT NULL CHECK(backed_up IN (0,1)),
 transports_json TEXT NOT NULL,
 label TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
 state TEXT NOT NULL CHECK(state IN ('pending','active','revoked','rejected')),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 activated_at INTEGER,
 last_verified_at INTEGER,
 revoked_at INTEGER
);
CREATE INDEX rig_owner_credentials_owner_state ON rig_owner_credentials(owner_id,state);
CREATE TABLE rig_owner_security_challenges (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('registration','finance-policy','finance-expense','owner-generation')),
 challenge TEXT NOT NULL UNIQUE,
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 payload_json TEXT NOT NULL,
 label TEXT,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 attempted_at INTEGER,
 used_at INTEGER,
 use_token TEXT UNIQUE,
 credential_id TEXT,
 verified_counter INTEGER
);
CREATE INDEX rig_owner_security_challenges_expiry ON rig_owner_security_challenges(owner_id,expires_at);
CREATE TABLE rig_owner_security_audit (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 event TEXT NOT NULL,
 operation TEXT NOT NULL,
 payload_hash TEXT,
 credential_id TEXT,
 candidate_id TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX rig_owner_security_audit_owner ON rig_owner_security_audit(owner_id,created_at);

-- An admitted media preparation is an attempt, never a refundable wallet cost.
-- No automatic deletion/release: failed and uncertain work stays counted.
CREATE TABLE rig_preparation_reservations (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 user_id TEXT NOT NULL CHECK(length(user_id)=38),
 budget_day TEXT NOT NULL CHECK(length(budget_day)=10),
 bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 1 AND 16777216),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0)
);
CREATE INDEX rig_preparation_user_day ON rig_preparation_reservations(budget_day,user_id);
