-- Additive, OFF by default. No money, credit, provider account or recharge is
-- created. Activation requires a separately reviewed account pin and policy.
CREATE TABLE rig_funding_policy (
 id INTEGER PRIMARY KEY CHECK(id=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 version TEXT NOT NULL,
 expected_username TEXT,
 buffer_usd_micros INTEGER NOT NULL CHECK(buffer_usd_micros BETWEEN 0 AND 1000000000000),
 max_snapshot_age_ms INTEGER NOT NULL CHECK(max_snapshot_age_ms BETWEEN 1000 AND 60000),
 updated_at INTEGER NOT NULL
);
INSERT INTO rig_funding_policy VALUES(1,0,'rig-funding-v1',NULL,6000000,60000,0);

CREATE TABLE rig_funding_snapshots (
 id TEXT PRIMARY KEY,
 funding_version TEXT NOT NULL,
 finance_version TEXT NOT NULL,
 finance_json TEXT NOT NULL CHECK(json_valid(finance_json)),
 username TEXT NOT NULL,
 balance_usd_micros INTEGER NOT NULL CHECK(balance_usd_micros BETWEEN 0 AND 1000000000000000),
 usd_micros_per_euro_cent INTEGER NOT NULL CHECK(usd_micros_per_euro_cent BETWEEN 1 AND 20000),
 buffer_usd_micros INTEGER NOT NULL CHECK(buffer_usd_micros BETWEEN 0 AND 1000000000000),
 fetched_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>fetched_at)
);
CREATE INDEX rig_funding_snapshot_expiry ON rig_funding_snapshots(expires_at);
CREATE TABLE rig_funding_admissions (
 order_id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 package_id TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 1000000),
 credit_cents INTEGER NOT NULL CHECK(credit_cents BETWEEN 1 AND 100000000),
 snapshot_id TEXT NOT NULL REFERENCES rig_funding_snapshots(id),
 created_at INTEGER NOT NULL,
 UNIQUE(user_id,request_id)
);

CREATE TABLE rig_owner_funding_admissions (
 job_id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 quote_id TEXT NOT NULL,
 estimated_usd_micros INTEGER NOT NULL CHECK(estimated_usd_micros BETWEEN 1 AND 1000000000000000),
 snapshot_id TEXT NOT NULL REFERENCES rig_funding_snapshots(id),
 created_at INTEGER NOT NULL
);

-- Negative wallets cannot offset another customer's spendable credit. A hold
-- remains a retail obligation until its exact owned settle/release is present.
-- Creating payments count even without a payment ID; a timeout is not proof
-- that Mollie refused the request. Exact credited purchases are not counted a
-- second time here, even if the order state update is delayed.
CREATE VIEW rig_funding_exposure AS SELECT
 COALESCE((SELECT SUM(balance) FROM (SELECT SUM(delta) balance FROM rig_ledger GROUP BY user_id HAVING SUM(delta)>0)),0) AS positive_wallet_cents,
 COALESCE((SELECT SUM(-r.delta) FROM rig_ledger r WHERE r.order_id IS NULL AND r.event_id LIKE 'reserve:%' AND r.delta<0
  AND NOT EXISTS(SELECT 1 FROM rig_ledger f WHERE f.user_id=r.user_id AND f.order_id IS NULL AND
   ((f.event_id='settle:'||substr(r.event_id,9) AND f.delta=0) OR (f.event_id='release:'||substr(r.event_id,9) AND f.delta=-r.delta)))),0) AS held_retail_cents,
 COALESCE((SELECT SUM(o.credits) FROM rig_orders o WHERE o.state NOT IN ('failed','expired','canceled','reversal_review')
  AND NOT EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='credit:'||o.id AND l.order_id=o.id AND l.user_id=o.user_id AND l.delta=o.credits)),0) AS payable_order_cents,
 COALESCE((SELECT SUM(MAX(c.provider_estimate_usd_micros,
   CASE WHEN json_valid(q.input_json) AND json_type(q.input_json,'$.providerEstimateUsdMicros')='integer'
    THEN MAX(0,json_extract(q.input_json,'$.providerEstimateUsdMicros')) ELSE 0 END,
   COALESCE((SELECT SUM(CASE WHEN json_type(s.value,'$.providerEstimateUsdMicros')='integer'
    THEN MAX(0,json_extract(s.value,'$.providerEstimateUsdMicros')) ELSE 0 END)
    FROM json_each(CASE WHEN json_valid(q.input_json) THEN q.input_json ELSE '{}' END,'$.workflow.steps') s),0)))
  FROM rig_generation_costs c LEFT JOIN rig_generation_jobs j ON j.id=c.job_id
  LEFT JOIN rig_generation_quotes q ON q.id=c.quote_id AND q.user_id=c.user_id
  WHERE c.authorized_at>=CAST(strftime('%s','now') AS INTEGER)*1000-5400000
   OR j.id IS NULL OR j.state NOT IN ('completed','failed') OR j.finalized_at IS NULL
   OR j.finalized_at>=CAST(strftime('%s','now') AS INTEGER)*1000-5400000
   OR EXISTS(SELECT 1 FROM rig_owner_provider_usage u WHERE u.job_id=c.job_id AND u.user_id=c.user_id
    AND u.finalized_at>=CAST(strftime('%s','now') AS INTEGER)*1000-5400000)
   OR (CASE WHEN json_valid(q.input_json) THEN json_type(q.input_json,'$.workflow')='object' ELSE 0 END
    AND NOT ((c.funding_kind='owner-provider' AND EXISTS(SELECT 1 FROM rig_owner_provider_usage u
     WHERE u.job_id=c.job_id AND u.quote_id=c.quote_id AND u.user_id=c.user_id AND u.state=j.state
      AND u.state IN ('completed','failed') AND u.finalized_at IS NOT NULL AND u.estimated_usd_micros=c.provider_estimate_usd_micros))
     OR (c.funding_kind='credits' AND EXISTS(SELECT 1 FROM rig_ledger l WHERE l.user_id=c.user_id AND l.order_id IS NULL
      AND ((l.event_id='settle:'||c.job_id AND l.delta=0) OR (l.event_id='release:'||c.job_id AND l.delta=j.price_cents))))))),0)
 +COALESCE((SELECT SUM(u.estimated_usd_micros) FROM rig_owner_provider_usage u WHERE u.state='authorized'
  AND NOT EXISTS(SELECT 1 FROM rig_generation_costs c WHERE c.job_id=u.job_id)),0) AS provider_reserved_usd_micros;

-- Recomputed by SQLite in the SAME transaction as the order INSERT. The
-- integer coefficient is rounded upwards by the trusted server with BigInt.
-- Conservative recent-provider cover intentionally overlaps held retail; the
-- Fal API does not promise when a deduction becomes visible in its balance.
-- Whole confirmed workflow plans remain covered through every phase, using
-- immutable quote JSON rather than optional workflow tables. Terminal parents
-- with no finalization remain uncertain; a late completion starts its own
-- conservative 90-minute window instead of reusing the old authorization time.
CREATE VIEW rig_funding_valid_snapshots AS
 SELECT s.id AS snapshot_id,s.balance_usd_micros,s.usd_micros_per_euro_cent,s.buffer_usd_micros,
  e.positive_wallet_cents+e.held_retail_cents+e.payable_order_cents AS retail_liability_cents,e.provider_reserved_usd_micros
 FROM rig_funding_snapshots s
 JOIN rig_funding_policy p ON p.id=1 AND p.enabled=1
 JOIN rig_finance_policy f ON f.id=1
 CROSS JOIN rig_funding_exposure e
 WHERE EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode='live')
 AND p.version=s.funding_version AND p.expected_username=s.username AND p.buffer_usd_micros=s.buffer_usd_micros
 AND s.expires_at-s.fetched_at=p.max_snapshot_age_ms
 AND s.fetched_at<=CAST(strftime('%s','now') AS INTEGER)*1000+1000
 AND s.expires_at>=CAST(strftime('%s','now') AS INTEGER)*1000
 AND f.version=s.finance_version AND json_extract(s.finance_json,'$.version')=f.version
 AND json_extract(s.finance_json,'$.eurPerUsdMicros')=f.eur_per_usd_micros
 AND json_extract(s.finance_json,'$.providerVatBps')=f.provider_vat_bps
 AND json_extract(s.finance_json,'$.paymentFeeBps')=f.payment_fee_bps
 AND json_extract(s.finance_json,'$.failureBufferBps')=f.failure_buffer_bps
 AND json_extract(s.finance_json,'$.preparationCents')=f.preparation_cents
 AND json_extract(s.finance_json,'$.minMarginBps')=f.min_margin_bps
 AND json_extract(s.finance_json,'$.dailyProviderLimitUsdMicros')=f.daily_provider_limit_usd_micros
 AND json_extract(s.finance_json,'$.minPriceCents')=f.min_price_cents
 AND json_extract(s.finance_json,'$.minProPriceCents')=f.min_pro_price_cents
 AND CASE WHEN typeof(e.positive_wallet_cents)='integer' AND e.positive_wallet_cents BETWEEN 0 AND 100000000000
  AND typeof(e.held_retail_cents)='integer' AND e.held_retail_cents BETWEEN 0 AND 100000000000
  AND typeof(e.payable_order_cents)='integer' AND e.payable_order_cents BETWEEN 0 AND 100000000000
  AND typeof(e.provider_reserved_usd_micros)='integer' AND e.provider_reserved_usd_micros BETWEEN 0 AND 1000000000000000
  AND e.positive_wallet_cents+e.held_retail_cents+e.payable_order_cents<=100000000000
  THEN 1 ELSE 0 END;

CREATE VIEW rig_funding_valid_admissions AS
 SELECT a.order_id,a.user_id,a.request_id,a.package_id,a.amount_cents,a.credit_cents,a.snapshot_id
 FROM rig_funding_admissions a JOIN rig_funding_valid_snapshots s ON s.snapshot_id=a.snapshot_id
 WHERE CASE WHEN s.retail_liability_cents+a.credit_cents<=100000000000
  THEN (s.retail_liability_cents+a.credit_cents)*s.usd_micros_per_euro_cent+s.provider_reserved_usd_micros+s.buffer_usd_micros<=s.balance_usd_micros
  ELSE 0 END;

CREATE VIEW rig_owner_valid_funding_admissions AS
 SELECT a.job_id,a.user_id,a.quote_id,a.estimated_usd_micros,a.snapshot_id
 FROM rig_owner_funding_admissions a JOIN rig_funding_valid_snapshots s ON s.snapshot_id=a.snapshot_id
 WHERE s.retail_liability_cents*s.usd_micros_per_euro_cent+s.provider_reserved_usd_micros+s.buffer_usd_micros+a.estimated_usd_micros<=s.balance_usd_micros;

-- Rollout guard: once policy is enabled, older code cannot bypass admission.
-- Existing orders, webhooks, credits, refunds and status updates are untouched.
CREATE TRIGGER rig_funding_order_admission BEFORE INSERT ON rig_orders
 WHEN EXISTS(SELECT 1 FROM rig_funding_policy WHERE id=1 AND enabled=1)
 BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM rig_funding_valid_admissions a
   WHERE a.order_id=NEW.id AND a.user_id=NEW.user_id AND a.request_id=NEW.request_id
    AND a.package_id=NEW.package_id AND a.amount_cents=NEW.amount_cents AND a.credit_cents=NEW.credits)
   THEN RAISE(ABORT,'RIG_FUNDING_COVERAGE_REQUIRED') END;
 END;

-- Once commercial coverage is enabled, an older owner-generation worker cannot
-- spend customer-backed stock without the same serialized, bound admission.
CREATE TRIGGER rig_owner_funding_admission BEFORE INSERT ON rig_owner_provider_usage
 WHEN EXISTS(SELECT 1 FROM rig_funding_policy WHERE id=1 AND enabled=1)
 BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM rig_owner_valid_funding_admissions a
   WHERE a.job_id=NEW.job_id AND a.user_id=NEW.user_id AND a.quote_id=NEW.quote_id
    AND a.estimated_usd_micros=NEW.estimated_usd_micros)
   THEN RAISE(ABORT,'RIG_OWNER_FUNDING_REQUIRED') END;
 END;
