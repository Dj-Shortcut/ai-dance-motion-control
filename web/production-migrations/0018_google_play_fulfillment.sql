-- Additive Google Play fulfillment. No existing order, ledger, invoice or
-- account row is rewritten. The existing funding exposure view is extended
-- below so Mollie and owner admission also retain Google obligations.
CREATE TABLE rig_google_play_intents (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 user_id TEXT NOT NULL CHECK(length(user_id)=38),
 request_id TEXT NOT NULL CHECK(request_id=id),
 product_id TEXT NOT NULL,
 credit_cents INTEGER NOT NULL CHECK(typeof(credit_cents)='integer' AND credit_cents IN (500,1000,2500)),
 mode TEXT NOT NULL CHECK(mode IN ('test','live')),
 package_name TEXT NOT NULL CHECK(package_name='dev.andyarijs.rig'),
 account_id TEXT NOT NULL CHECK(length(account_id)=64 AND account_id NOT GLOB '*[^0-9a-f]*'),
 snapshot_id TEXT NOT NULL REFERENCES rig_funding_snapshots(id),
 state TEXT NOT NULL CHECK(state IN ('prepared','verifying','pending','credited','complete','cancelled','expired','refund_required','refunded','review')),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
 expires_at INTEGER NOT NULL CHECK(expires_at=created_at+900000),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),
 CHECK((product_id='rig_credit_5' AND credit_cents=500) OR (product_id='rig_credit_10' AND credit_cents=1000) OR (product_id='rig_credit_25' AND credit_cents=2500)),
 UNIQUE(user_id,request_id),
 UNIQUE(id,user_id,product_id,mode,package_name,account_id,credit_cents)
);
CREATE UNIQUE INDEX rig_google_play_one_active_intent ON rig_google_play_intents(user_id)
 WHERE state IN ('prepared','verifying','pending','credited');
CREATE INDEX rig_google_play_intent_binding ON rig_google_play_intents(account_id,product_id,created_at,expires_at);
CREATE INDEX rig_google_play_intent_reserve ON rig_google_play_intents(state,expires_at);

-- Unverified submissions are encrypted retry work, not payment evidence. They
-- have no global token claim and cannot extend Fal stock beyond the intent TTL.
CREATE TABLE rig_google_play_attempts (
 intent_id TEXT NOT NULL REFERENCES rig_google_play_intents(id),
 token_hash TEXT NOT NULL CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
 sealed_token TEXT NOT NULL CHECK(length(sealed_token) BETWEEN 48 AND 8192),
 state TEXT NOT NULL CHECK(state IN ('queued','invalid','verified')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts)='integer' AND attempts>=0),
 next_check_at INTEGER NOT NULL,
 last_error TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(intent_id,token_hash)
);
CREATE INDEX rig_google_play_attempt_due ON rig_google_play_attempts(state,next_check_at);

-- Multiple valid Google tokens may reach one intent (two devices). Only the
-- separate immutable credit claim can consume its one wallet entitlement.
CREATE TABLE rig_google_play_receipts (
 token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
 intent_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 product_id TEXT NOT NULL,
 credit_cents INTEGER NOT NULL CHECK(typeof(credit_cents)='integer' AND credit_cents IN (500,1000,2500)),
 mode TEXT NOT NULL CHECK(mode IN ('test','live')),
 package_name TEXT NOT NULL CHECK(package_name='dev.andyarijs.rig'),
 account_id TEXT NOT NULL CHECK(length(account_id)=64 AND account_id NOT GLOB '*[^0-9a-f]*'),
 sealed_token TEXT NOT NULL CHECK(length(sealed_token) BETWEEN 48 AND 8192),
 state TEXT NOT NULL CHECK(state IN ('pending','verified','credited','refund_required','refunded','cancelled','reversed','review')),
 review_reason TEXT CHECK(review_reason IS NULL OR review_reason IN ('partial_refund','provider_mismatch','purchase_ambiguous','refund_unavailable','credit_conflict')),
 admitted_pending INTEGER NOT NULL DEFAULT 0 CHECK(admitted_pending IN (0,1)),
 purchased_at INTEGER,
 google_order_id TEXT,
 consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 purchase_state TEXT NOT NULL CHECK(purchase_state IN ('PURCHASED','PENDING','CANCELLED')),
 refundable_quantity INTEGER CHECK(refundable_quantity IN (0,1)),
 last_inspection_id TEXT NOT NULL CHECK(length(last_inspection_id)=36),
 verified_at INTEGER NOT NULL,
 consume_attempt_inspection TEXT,
 consume_attempted_at INTEGER,
 refund_attempt_inspection TEXT,
 refund_attempted_at INTEGER,
 finance_json TEXT CHECK(finance_json IS NULL OR (length(finance_json)<=32768 AND json_valid(finance_json) AND json_type(finance_json)='object')),
 next_check_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 FOREIGN KEY(intent_id,user_id,product_id,mode,package_name,account_id,credit_cents)
  REFERENCES rig_google_play_intents(id,user_id,product_id,mode,package_name,account_id,credit_cents)
);
CREATE INDEX rig_google_play_receipt_due ON rig_google_play_receipts(state,next_check_at);
CREATE INDEX rig_google_play_receipt_intent ON rig_google_play_receipts(intent_id,created_at);

CREATE TABLE rig_google_play_credit_claims (
 intent_id TEXT PRIMARY KEY REFERENCES rig_google_play_intents(id),
 token_hash TEXT NOT NULL UNIQUE REFERENCES rig_google_play_receipts(token_hash),
 user_id TEXT NOT NULL,
 credit_cents INTEGER NOT NULL CHECK(typeof(credit_cents)='integer' AND credit_cents IN (500,1000,2500)),
 snapshot_id TEXT NOT NULL REFERENCES rig_funding_snapshots(id),
 finance_json TEXT NOT NULL CHECK(length(finance_json)<=32768 AND json_valid(finance_json) AND json_type(finance_json)='object'),
 created_at INTEGER NOT NULL
);
CREATE TABLE rig_google_play_reversals (
 token_hash TEXT PRIMARY KEY REFERENCES rig_google_play_receipts(token_hash),
 user_id TEXT NOT NULL,
 credit_cents INTEGER NOT NULL CHECK(typeof(credit_cents)='integer' AND credit_cents IN (500,1000,2500)),
 reason TEXT NOT NULL CHECK(reason IN ('refunded','voided','cancelled')),
 provider_reference TEXT,
 created_at INTEGER NOT NULL
);
CREATE TABLE rig_google_play_work_leases (
 work_id TEXT PRIMARY KEY,
 lease_token TEXT NOT NULL CHECK(length(lease_token)=36),
 expires_at INTEGER NOT NULL
);
CREATE TABLE rig_google_play_notifications (
 message_id TEXT PRIMARY KEY CHECK(length(message_id) BETWEEN 1 AND 200),
 kind TEXT NOT NULL CHECK(kind IN ('product','voided','test','unsupported')),
 mode TEXT NOT NULL CHECK(mode IN ('test','live')),
 token_hash TEXT CHECK(token_hash IS NULL OR (length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*')),
 product_id TEXT CHECK(product_id IS NULL OR product_id IN ('rig_credit_5','rig_credit_10','rig_credit_25')),
 order_id TEXT,
 sealed_token TEXT CHECK(sealed_token IS NULL OR length(sealed_token) BETWEEN 48 AND 8192),
 payload_hash TEXT CHECK(payload_hash IS NULL OR (length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*')),
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','complete','invalid')),
 next_check_at INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts)='integer' AND attempts>=0),
 last_error TEXT,
 refund_attempt_inspection TEXT,
 refund_attempted_at INTEGER,
 received_at INTEGER NOT NULL,
 completed_at INTEGER,
 CHECK((kind IN ('product','voided') AND token_hash IS NOT NULL AND sealed_token IS NOT NULL) OR (kind IN ('test','unsupported') AND token_hash IS NULL AND sealed_token IS NULL AND state='complete'))
);
CREATE INDEX rig_google_play_notification_due ON rig_google_play_notifications(state,next_check_at);
CREATE INDEX rig_google_play_notification_token ON rig_google_play_notifications(token_hash,refund_attempted_at);
CREATE TABLE rig_google_play_voided_cursor (
 id INTEGER PRIMARY KEY CHECK(id=1),
 mode TEXT NOT NULL CHECK(mode IN ('test','live')),
 completed_until_ms INTEGER,
 window_start_ms INTEGER NOT NULL,
 window_end_ms INTEGER NOT NULL CHECK(window_end_ms>=window_start_ms AND window_end_ms-window_start_ms<=2592000000),
 page_token TEXT CHECK(page_token IS NULL OR length(page_token) BETWEEN 1 AND 4096),
 updated_at INTEGER NOT NULL
);
-- A zero-row success / constrained failure gives D1 batches an explicit final
-- assertion. Successful batches never add a row to this table.
CREATE TABLE rig_google_play_assertions (value INTEGER NOT NULL CHECK(value=1));

-- Private license testing only: never read by a public/live billing route.
-- This allowance cannot be raised beyond EUR 100 and is not reusable by
-- spending or reversing earlier issued test credit. No Fal API is consulted.
CREATE TABLE rig_google_play_test_policy (
 id INTEGER PRIMARY KEY CHECK(id=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 budget_credit_cents INTEGER NOT NULL DEFAULT 0 CHECK(typeof(budget_credit_cents)='integer' AND budget_credit_cents BETWEEN 0 AND 10000),
 allowed_users_json TEXT NOT NULL DEFAULT '[]' CHECK(length(allowed_users_json)<=8192 AND json_valid(allowed_users_json) AND json_type(allowed_users_json)='array'),
 expires_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO rig_google_play_test_policy(id) VALUES(1);
CREATE VIEW rig_google_play_test_exposure AS SELECT
 COALESCE((SELECT SUM(credit_cents) FROM rig_google_play_credit_claims),0)
 +COALESCE((SELECT SUM(credit_cents) FROM rig_google_play_intents WHERE state IN ('prepared','verifying') AND expires_at>CAST(strftime('%s','now') AS INTEGER)*1000),0)
 +COALESCE((SELECT SUM(r.credit_cents) FROM rig_google_play_receipts r WHERE r.state IN ('pending','verified','credited','refund_required','review')
  AND NOT EXISTS(SELECT 1 FROM rig_google_play_credit_claims c WHERE c.token_hash=r.token_hash)),0) AS committed_credit_cents;

CREATE TRIGGER rig_google_play_intent_funding BEFORE INSERT ON rig_google_play_intents
 BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=NEW.mode)
   OR EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=NEW.user_id)
   OR NOT ((NEW.mode='live' AND EXISTS(SELECT 1 FROM rig_funding_valid_snapshots s WHERE s.snapshot_id=NEW.snapshot_id
    AND s.retail_liability_cents+NEW.credit_cents<=100000000000
    AND (s.retail_liability_cents+NEW.credit_cents)*s.usd_micros_per_euro_cent+s.provider_reserved_usd_micros+s.buffer_usd_micros<=s.balance_usd_micros))
    OR (NEW.mode='test' AND EXISTS(SELECT 1 FROM rig_google_play_test_policy p CROSS JOIN rig_google_play_test_exposure e
     WHERE p.id=1 AND p.enabled=1 AND p.expires_at>=CAST(strftime('%s','now') AS INTEGER)*1000
      AND e.committed_credit_cents+NEW.credit_cents<=p.budget_credit_cents
      AND EXISTS(SELECT 1 FROM json_each(p.allowed_users_json) u WHERE u.type='text' AND u.value=NEW.user_id))))
   THEN RAISE(ABORT,'RIG_GOOGLE_PLAY_FUNDING_REQUIRED') END;
 END;

CREATE TRIGGER rig_google_play_claim_funding BEFORE INSERT ON rig_google_play_credit_claims
 BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM rig_google_play_receipts r
   JOIN rig_google_play_intents i ON i.id=r.intent_id
   WHERE r.token_hash=NEW.token_hash AND r.intent_id=NEW.intent_id AND r.user_id=NEW.user_id
    AND r.credit_cents=NEW.credit_cents AND r.state='verified' AND r.purchase_state='PURCHASED'
    AND r.refundable_quantity=1 AND r.consumed=0
    AND r.purchased_at>=i.created_at-1000
    AND (r.purchased_at<=i.expires_at OR r.admitted_pending=1)
    AND EXISTS(SELECT 1 FROM rig_payment_environment WHERE id=1 AND mode=r.mode)
    AND NOT EXISTS(SELECT 1 FROM rig_frozen_accounts WHERE user_id=r.user_id)
    AND NOT EXISTS(SELECT 1 FROM rig_google_play_notifications n WHERE n.token_hash=r.token_hash AND n.refund_attempted_at IS NOT NULL)
    AND ((r.mode='live' AND EXISTS(SELECT 1 FROM rig_funding_valid_snapshots s WHERE s.snapshot_id=NEW.snapshot_id
     AND s.retail_liability_cents*s.usd_micros_per_euro_cent+s.provider_reserved_usd_micros+s.buffer_usd_micros<=s.balance_usd_micros))
     OR (r.mode='test' AND EXISTS(SELECT 1 FROM rig_google_play_test_policy p CROSS JOIN rig_google_play_test_exposure e
      WHERE p.id=1 AND p.enabled=1 AND p.expires_at>=CAST(strftime('%s','now') AS INTEGER)*1000
       AND e.committed_credit_cents<=p.budget_credit_cents
       AND EXISTS(SELECT 1 FROM json_each(p.allowed_users_json) u WHERE u.type='text' AND u.value=r.user_id)))))
   THEN RAISE(ABORT,'RIG_GOOGLE_PLAY_CREDIT_FUNDING_REQUIRED') END;
 END;

CREATE TRIGGER rig_google_play_credit_event BEFORE INSERT ON rig_ledger
 WHEN NEW.event_id LIKE 'google-play:%'
 BEGIN
  SELECT CASE WHEN NEW.order_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM rig_google_play_credit_claims c
   WHERE NEW.event_id='google-play:'||c.token_hash AND NEW.user_id=c.user_id AND NEW.delta=c.credit_cents)
   THEN RAISE(ABORT,'RIG_GOOGLE_PLAY_CLAIM_REQUIRED') END;
 END;
CREATE TRIGGER rig_google_play_reversal_event BEFORE INSERT ON rig_ledger
 WHEN NEW.event_id LIKE 'google-play-reversal:%'
 BEGIN
  SELECT CASE WHEN NEW.order_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM rig_google_play_reversals r
   JOIN rig_google_play_credit_claims c ON c.token_hash=r.token_hash AND c.user_id=r.user_id AND c.credit_cents=r.credit_cents
   WHERE NEW.event_id='google-play-reversal:'||r.token_hash AND NEW.user_id=r.user_id AND NEW.delta=-r.credit_cents)
   THEN RAISE(ABORT,'RIG_GOOGLE_PLAY_REVERSAL_REQUIRED') END;
 END;

-- The full existing exposure SQL follows, changing only payable_order_cents.

DROP VIEW rig_funding_exposure;
CREATE VIEW rig_funding_exposure AS SELECT
 COALESCE((SELECT SUM(balance) FROM (SELECT SUM(delta) balance FROM rig_ledger GROUP BY user_id HAVING SUM(delta)>0)),0) AS positive_wallet_cents,
 COALESCE((SELECT SUM(-r.delta) FROM rig_ledger r WHERE r.order_id IS NULL AND r.event_id LIKE 'reserve:%' AND r.delta<0
  AND NOT EXISTS(SELECT 1 FROM rig_ledger f WHERE f.user_id=r.user_id AND f.order_id IS NULL AND
   ((f.event_id='settle:'||substr(r.event_id,9) AND f.delta=0) OR (f.event_id='release:'||substr(r.event_id,9) AND f.delta=-r.delta)))),0) AS held_retail_cents,
 COALESCE((SELECT SUM(o.credits) FROM rig_orders o WHERE o.state NOT IN ('failed','expired','canceled','reversal_review')
  AND NOT EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='credit:'||o.id AND l.order_id=o.id AND l.user_id=o.user_id AND l.delta=o.credits)),0)
 +COALESCE((SELECT SUM(i.credit_cents) FROM rig_google_play_intents i WHERE i.state IN ('prepared','verifying') AND i.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000),0)
 +COALESCE((SELECT SUM(r.credit_cents) FROM rig_google_play_receipts r WHERE r.state IN ('pending','verified','credited','refund_required','review')
  AND NOT EXISTS(SELECT 1 FROM rig_ledger l WHERE l.event_id='google-play:'||r.token_hash AND l.user_id=r.user_id AND l.order_id IS NULL AND l.delta=r.credit_cents)),0) AS payable_order_cents,
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

CREATE TABLE rig_google_play_schema (id INTEGER PRIMARY KEY CHECK(id=1),version TEXT NOT NULL CHECK(version='rig-google-play-v1'));
INSERT INTO rig_google_play_schema VALUES(1,'rig-google-play-v1');
