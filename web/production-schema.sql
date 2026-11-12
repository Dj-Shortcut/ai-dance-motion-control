-- Fresh isolated production DB only; review before applying. No test rows or balances.
-- Apply to a dedicated D1 database. All values are integer units, never floats.
-- The administrator must explicitly insert exactly one row setting mode to
-- 'test' OR 'live'. Use completely separate DBs for test and live; never
-- change an existing environment row to live or reuse its balances.
-- Commercial funding coverage additionally requires
-- production-migrations/0015_funding_coverage.sql, with complete triggers.
-- Missing funding setup refuses new purchases; it never grants test coverage.
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

-- Additive owner-operation scope; preserve old challenges and all credentials.
CREATE TABLE rig_owner_security_challenges_v2 (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 64 AND operation NOT GLOB '*[^a-z-]*'),
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
CREATE INDEX rig_owner_security_challenges_v2_expiry ON rig_owner_security_challenges_v2(owner_id,expires_at);
INSERT INTO rig_owner_security_challenges_v2 SELECT * FROM rig_owner_security_challenges;

-- Manual handoff evidence only. No invoice is issued, payment sent or ledger
-- changed by this migration. Accountable remains the external source document.
CREATE TABLE rig_accounting_documents (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),
 order_id TEXT NOT NULL REFERENCES rig_orders(id),
 provider TEXT NOT NULL CHECK(provider='accountable'),
 external_invoice_reference TEXT NOT NULL,
 reference_key TEXT NOT NULL,
 document_date TEXT NOT NULL CHECK(length(document_date)=10),
 record_type TEXT NOT NULL CHECK(record_type IN ('invoice','accounting-entry')),
 delivery_status TEXT NOT NULL CHECK(delivery_status IN ('prepared','recorded-in-accountable','peppol-sent-manually')),
 note TEXT NOT NULL,
 replaces_document_id TEXT UNIQUE REFERENCES rig_accounting_documents(id),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 recorded_by TEXT NOT NULL,
 created_at INTEGER NOT NULL CHECK(created_at>=0)
);
CREATE UNIQUE INDEX rig_accounting_initial_document_order ON rig_accounting_documents(order_id) WHERE replaces_document_id IS NULL;
CREATE INDEX rig_accounting_documents_order ON rig_accounting_documents(order_id,created_at);
-- Preserve every reference ever used, including corrected ones. A reference
-- cannot silently migrate to another customer's purchase.
CREATE TABLE rig_accounting_references (
 reference_key TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES rig_orders(id),
 created_at INTEGER NOT NULL CHECK(created_at>=0)
);

-- Immutable operator investigation records. They do not release funds or
-- claim that an unknown provider request did not happen.
CREATE TABLE rig_owner_recovery_events (
 id TEXT PRIMARY KEY,
 idempotency_key TEXT NOT NULL UNIQUE,
 owner_id TEXT NOT NULL,
 case_kind TEXT NOT NULL CHECK(case_kind IN ('payment','generation')),
 case_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('note','payment-adopted')),
 status TEXT NOT NULL CHECK(status IN ('investigating','waiting-provider','reviewed','provider-linked')),
 note TEXT NOT NULL,
 provider_id TEXT,
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 evidence_json TEXT NOT NULL,
 created_at INTEGER NOT NULL CHECK(created_at>=0)
);
CREATE INDEX rig_owner_recovery_case ON rig_owner_recovery_events(case_kind,case_id,created_at);

-- Immutable receipt of a customer's request. This table never changes money.
CREATE TABLE rig_customer_support_requests (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 user_id TEXT NOT NULL CHECK(length(user_id)=38),
 order_id TEXT NOT NULL REFERENCES rig_orders(id),
 order_request_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key)=36),
 kind TEXT NOT NULL CHECK(kind IN ('withdrawal','payment-help')),
 message TEXT NOT NULL CHECK(length(message)<=1000),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 order_state_at_request TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
 credits INTEGER NOT NULL CHECK(typeof(credits)='integer' AND credits>0),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
 UNIQUE(user_id,idempotency_key)
);
CREATE INDEX rig_customer_support_by_user ON rig_customer_support_requests(user_id,created_at,id);
CREATE INDEX rig_customer_support_queue ON rig_customer_support_requests(created_at,id);

-- Immutable evidence of the price/terms and buyer's stated country before checkout.
-- This does not assign a VAT treatment or issue a fiscal invoice.
CREATE TABLE rig_purchase_acceptances (
 user_id TEXT NOT NULL CHECK(typeof(user_id)='text' AND length(user_id)=38),
 request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(request_id)=36),
 version TEXT NOT NULL CHECK(typeof(version)='text' AND length(version) BETWEEN 1 AND 100),
 buyer_country TEXT NOT NULL CHECK(buyer_country IN ('BE','NL')),
 customer_type TEXT NOT NULL CHECK(customer_type='consumer'),
 package_id TEXT NOT NULL CHECK(typeof(package_id)='text' AND length(package_id) BETWEEN 1 AND 40),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 1000000),
 credits INTEGER NOT NULL CHECK(typeof(credits)='integer' AND credits BETWEEN 1 AND 100000000),
 currency TEXT NOT NULL CHECK(currency='EUR'),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 seller_json TEXT NOT NULL CHECK(json_valid(seller_json) AND json_type(seller_json)='object'),
 terms_text TEXT NOT NULL CHECK(typeof(terms_text)='text' AND length(terms_text) BETWEEN 1 AND 65536),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
 PRIMARY KEY(user_id,request_id)
);

-- 0011_automatic_invoices.sql
-- Automatic invoices are independent immutable documents, not Accountable or
-- Peppol confirmations. Counters and issuance commit in the same D1 batch.
CREATE TABLE rig_invoice_counters (
 issue_year INTEGER PRIMARY KEY CHECK(typeof(issue_year)='integer' AND issue_year BETWEEN 2000 AND 9999),
 next_sequence INTEGER NOT NULL CHECK(typeof(next_sequence)='integer' AND next_sequence BETWEEN 1 AND 1000000000000)
);
CREATE TABLE rig_issued_invoices (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 order_id TEXT NOT NULL UNIQUE REFERENCES rig_orders(id),
 user_id TEXT NOT NULL CHECK(length(user_id)=38),
 order_request_id TEXT NOT NULL CHECK(length(order_request_id) BETWEEN 12 AND 80),
 invoice_number TEXT NOT NULL UNIQUE,
 issue_year INTEGER NOT NULL CHECK(typeof(issue_year)='integer' AND issue_year BETWEEN 2000 AND 9999),
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 999999999999),
 issued_date TEXT NOT NULL CHECK(length(issued_date)=10),
 issued_at INTEGER NOT NULL CHECK(typeof(issued_at)='integer' AND issued_at>0),
 currency TEXT NOT NULL CHECK(currency='EUR'),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 1000000),
 credit_cents INTEGER NOT NULL CHECK(typeof(credit_cents)='integer' AND credit_cents BETWEEN 1 AND 100000000),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
 snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
 UNIQUE(issue_year,sequence),
 CHECK(invoice_number='RIG-'||issue_year||'-'||printf('%06d',sequence)),
 CHECK(substr(issued_date,1,4)=CAST(issue_year AS TEXT))
);
CREATE INDEX rig_issued_invoices_customer ON rig_issued_invoices(user_id,issued_at,id);
-- Fair bounded read-repair scheduling only. These rows are not invoices and
-- their presence never means a payment, cash refund or credit note exists.
CREATE TABLE rig_invoice_issuance_attempts (
 order_id TEXT PRIMARY KEY REFERENCES rig_orders(id),
 last_checked_at INTEGER NOT NULL CHECK(typeof(last_checked_at)='integer' AND last_checked_at>0),
 last_state TEXT NOT NULL,
 last_reason TEXT
);

-- 0012_purchase_billing.sql
-- A buyer identity is captured before provider checkout, atomically with terms.
-- This table does not itself issue an invoice or prove payment.
CREATE UNIQUE INDEX rig_purchase_acceptance_billing_hash
 ON rig_purchase_acceptances(user_id,request_id,request_hash);
CREATE TABLE rig_purchase_billing (
 user_id TEXT NOT NULL CHECK(typeof(user_id)='text' AND length(user_id)=38),
 request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(request_id)=36),
 name TEXT NOT NULL CHECK(typeof(name)='text' AND length(name) BETWEEN 1 AND 120),
 street TEXT NOT NULL CHECK(typeof(street)='text' AND length(street) BETWEEN 3 AND 180),
 postal_code TEXT NOT NULL CHECK(typeof(postal_code)='text' AND length(postal_code) BETWEEN 4 AND 7),
 city TEXT NOT NULL CHECK(typeof(city)='text' AND length(city) BETWEEN 1 AND 100),
 country TEXT NOT NULL CHECK(country IN ('BE','NL')),
 electronic_delivery TEXT NOT NULL CHECK(electronic_delivery='rig-download-v1'),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
 PRIMARY KEY(user_id,request_id),
 FOREIGN KEY(user_id,request_id,request_hash) REFERENCES rig_purchase_acceptances(user_id,request_id,request_hash)
);
CREATE TABLE rig_billing_profiles (
 user_id TEXT PRIMARY KEY CHECK(typeof(user_id)='text' AND length(user_id)=38),
 name TEXT NOT NULL CHECK(typeof(name)='text' AND length(name) BETWEEN 1 AND 120),
 street TEXT NOT NULL CHECK(typeof(street)='text' AND length(street) BETWEEN 3 AND 180),
 postal_code TEXT NOT NULL CHECK(typeof(postal_code)='text' AND length(postal_code) BETWEEN 4 AND 7),
 city TEXT NOT NULL CHECK(typeof(city)='text' AND length(city) BETWEEN 1 AND 100),
 country TEXT NOT NULL CHECK(country IN ('BE','NL')),
 electronic_delivery TEXT NOT NULL CHECK(electronic_delivery='rig-download-v1'),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>0)
);

-- 0013_invoice_delivery.sql
-- Private immutable PDF archive and a conservative one-attempt mail outbox.
-- These records do not assert that Accountable imported or validated anything.
CREATE TABLE rig_invoice_archives (
 invoice_id TEXT PRIMARY KEY REFERENCES rig_issued_invoices(id),
 storage_key TEXT NOT NULL UNIQUE,
 snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64),
 pdf_sha256 TEXT NOT NULL CHECK(length(pdf_sha256)=64),
 byte_length INTEGER NOT NULL CHECK(typeof(byte_length)='integer' AND byte_length BETWEEN 1 AND 3145728),
 created_at INTEGER NOT NULL
);
CREATE TABLE rig_invoice_mail_outbox (
 invoice_id TEXT PRIMARY KEY REFERENCES rig_issued_invoices(id),
 state TEXT NOT NULL CHECK(state IN ('sending','sent','unknown','failed')),
 attempt_token TEXT NOT NULL UNIQUE,
 pdf_sha256 TEXT NOT NULL CHECK(length(pdf_sha256)=64),
 started_at INTEGER NOT NULL,
 completed_at INTEGER,
 provider_message_id TEXT,
 last_error TEXT,
 CHECK(state<>'sent' OR provider_message_id IS NOT NULL)
);
CREATE INDEX rig_invoice_mail_outbox_state ON rig_invoice_mail_outbox(state,started_at);
-- Fair scheduling lets a damaged archive be investigated without holding up
-- the invoices for later purchases. No delivery claim is made by this table.
CREATE TABLE rig_invoice_delivery_attempts (
 invoice_id TEXT PRIMARY KEY REFERENCES rig_issued_invoices(id),
 last_checked_at INTEGER NOT NULL,
 last_state TEXT NOT NULL CHECK(last_state IN ('checking','archived','review','unavailable'))
);

-- Generation workflow foundation v2 (inactive until separately integrated).
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
