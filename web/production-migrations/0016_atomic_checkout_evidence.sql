-- Retain purchase and funding evidence only when an exact admitted order owns it.
-- Copying through rig_orders safely removes legacy rows from rejected attempts.
CREATE UNIQUE INDEX IF NOT EXISTS rig_order_checkout_evidence_owner
 ON rig_orders(id,user_id,request_id);

CREATE TABLE rig_purchase_acceptances_owned (
 order_id TEXT NOT NULL,
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
 PRIMARY KEY(user_id,request_id),
 UNIQUE(order_id),
 UNIQUE(order_id,user_id,request_id,request_hash),
 FOREIGN KEY(order_id,user_id,request_id) REFERENCES rig_orders(id,user_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO rig_purchase_acceptances_owned(order_id,user_id,request_id,version,buyer_country,customer_type,package_id,amount_cents,credits,currency,request_hash,seller_json,terms_text,created_at)
 SELECT o.id,a.user_id,a.request_id,a.version,a.buyer_country,a.customer_type,a.package_id,a.amount_cents,a.credits,a.currency,a.request_hash,a.seller_json,a.terms_text,a.created_at
 FROM rig_purchase_acceptances a JOIN rig_orders o ON o.user_id=a.user_id AND o.request_id=a.request_id;

CREATE TABLE rig_purchase_billing_owned (
 order_id TEXT NOT NULL,
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
 UNIQUE(order_id),
 FOREIGN KEY(order_id,user_id,request_id,request_hash) REFERENCES rig_purchase_acceptances_owned(order_id,user_id,request_id,request_hash)
);
INSERT INTO rig_purchase_billing_owned(order_id,user_id,request_id,name,street,postal_code,city,country,electronic_delivery,request_hash,created_at)
 SELECT a.order_id,b.user_id,b.request_id,b.name,b.street,b.postal_code,b.city,b.country,b.electronic_delivery,b.request_hash,b.created_at
 FROM rig_purchase_billing b JOIN rig_purchase_acceptances_owned a
  ON a.user_id=b.user_id AND a.request_id=b.request_id AND a.request_hash=b.request_hash;

DROP TABLE rig_purchase_billing;
DROP TABLE rig_purchase_acceptances;
ALTER TABLE rig_purchase_acceptances_owned RENAME TO rig_purchase_acceptances;
ALTER TABLE rig_purchase_billing_owned RENAME TO rig_purchase_billing;
CREATE UNIQUE INDEX rig_purchase_acceptance_billing_hash
 ON rig_purchase_acceptances(user_id,request_id,request_hash);
DELETE FROM rig_billing_profiles
 WHERE NOT EXISTS(SELECT 1 FROM rig_purchase_acceptances a WHERE a.user_id=rig_billing_profiles.user_id);

-- Funding snapshots and admissions used the same write-before-order batch. Rebuild
-- the admission table with deferred order ownership and remove unowned snapshots.
DROP TRIGGER rig_funding_order_admission;
DROP VIEW rig_funding_valid_admissions;
CREATE TABLE rig_funding_admissions_owned (
 order_id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 package_id TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 1000000),
 credit_cents INTEGER NOT NULL CHECK(credit_cents BETWEEN 1 AND 100000000),
 snapshot_id TEXT NOT NULL REFERENCES rig_funding_snapshots(id),
 created_at INTEGER NOT NULL,
 UNIQUE(user_id,request_id),
 FOREIGN KEY(order_id,user_id,request_id) REFERENCES rig_orders(id,user_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO rig_funding_admissions_owned(order_id,user_id,request_id,package_id,amount_cents,credit_cents,snapshot_id,created_at)
 SELECT a.order_id,a.user_id,a.request_id,a.package_id,a.amount_cents,a.credit_cents,a.snapshot_id,a.created_at
 FROM rig_funding_admissions a JOIN rig_orders o
  ON o.id=a.order_id AND o.user_id=a.user_id AND o.request_id=a.request_id;
DROP TABLE rig_funding_admissions;
ALTER TABLE rig_funding_admissions_owned RENAME TO rig_funding_admissions;
DELETE FROM rig_funding_snapshots
 WHERE NOT EXISTS(SELECT 1 FROM rig_funding_admissions a WHERE a.snapshot_id=rig_funding_snapshots.id)
 AND NOT EXISTS(SELECT 1 FROM rig_owner_funding_admissions a WHERE a.snapshot_id=rig_funding_snapshots.id);

CREATE VIEW rig_funding_valid_admissions AS
 SELECT a.order_id,a.user_id,a.request_id,a.package_id,a.amount_cents,a.credit_cents,a.snapshot_id
 FROM rig_funding_admissions a JOIN rig_funding_valid_snapshots s ON s.snapshot_id=a.snapshot_id
 WHERE CASE WHEN s.retail_liability_cents+a.credit_cents<=100000000000
  THEN (s.retail_liability_cents+a.credit_cents)*s.usd_micros_per_euro_cent+s.provider_reserved_usd_micros+s.buffer_usd_micros<=s.balance_usd_micros
  ELSE 0 END;

CREATE TRIGGER rig_funding_order_admission BEFORE INSERT ON rig_orders
 WHEN EXISTS(SELECT 1 FROM rig_funding_policy WHERE id=1 AND enabled=1)
 BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM rig_funding_valid_admissions a
   WHERE a.order_id=NEW.id AND a.user_id=NEW.user_id AND a.request_id=NEW.request_id
    AND a.package_id=NEW.package_id AND a.amount_cents=NEW.amount_cents AND a.credit_cents=NEW.credits)
   THEN RAISE(ABORT,'RIG_FUNDING_COVERAGE_REQUIRED') END;
 END;
