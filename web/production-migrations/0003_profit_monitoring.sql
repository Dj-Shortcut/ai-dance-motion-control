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
