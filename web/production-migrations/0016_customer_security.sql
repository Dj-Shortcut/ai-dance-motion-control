-- Customer verification is separate from owner authority. Keep enrolled rows
-- after revocation: a signed-in session cannot replace an existing passkey.
CREATE TABLE IF NOT EXISTS rig_customer_credentials (
 credential_id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL UNIQUE CHECK(length(user_id)=38),
 public_key TEXT NOT NULL,
 user_handle TEXT NOT NULL,
 counter INTEGER NOT NULL CHECK(counter BETWEEN 0 AND 9007199254740991),
 device_type TEXT NOT NULL CHECK(device_type IN ('singleDevice','multiDevice')),
 backed_up INTEGER NOT NULL CHECK(backed_up IN (0,1)),
 transports_json TEXT NOT NULL,
 label TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
 state TEXT NOT NULL CHECK(state IN ('active','revoked')),
 created_at INTEGER NOT NULL,
 activated_at INTEGER NOT NULL,
 last_verified_at INTEGER,
 revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS rig_customer_security_challenges (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL CHECK(length(user_id)=38),
 operation TEXT NOT NULL CHECK(operation IN ('registration','customer-generation')),
 challenge TEXT NOT NULL UNIQUE,
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 payload_json TEXT NOT NULL,
 quote_id TEXT,
 idempotency_key TEXT,
 quote_model TEXT,
 quote_input_json TEXT,
 quote_price_cents INTEGER,
 quote_pricing_version TEXT,
 quote_duration_seconds REAL,
 quote_expires_at INTEGER,
 label TEXT,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 attempted_at INTEGER,
 used_at INTEGER,
 use_token TEXT UNIQUE,
 credential_id TEXT,
 verified_counter INTEGER,
 CHECK(operation='registration' OR (
  quote_id IS NOT NULL AND idempotency_key IS NOT NULL AND quote_model IS NOT NULL
  AND quote_input_json IS NOT NULL AND quote_price_cents>0
  AND quote_pricing_version IS NOT NULL AND quote_duration_seconds BETWEEN 3 AND 30
  AND quote_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS rig_customer_security_challenges_expiry ON rig_customer_security_challenges(user_id,expires_at);
CREATE TABLE IF NOT EXISTS rig_customer_security_audit (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 event TEXT NOT NULL,
 operation TEXT NOT NULL,
 payload_hash TEXT,
 credential_id TEXT,
 challenge_id TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rig_customer_security_audit_user ON rig_customer_security_audit(user_id,created_at);
-- Rollout: install schema, deploy backend and client, verify them, then enable.
-- Once enabled the migration's trigger also blocks an older backend rollback.
CREATE TABLE IF NOT EXISTS rig_customer_security_policy (
 id INTEGER PRIMARY KEY CHECK(id=1),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
INSERT OR IGNORE INTO rig_customer_security_policy(id,enabled) VALUES(1,0);
-- Trigger intentionally lives in this migration, as with 0015 funding guards.
-- The combined schema is also consumed by legacy semicolon-only test loaders.
CREATE TRIGGER IF NOT EXISTS rig_customer_generation_verification
BEFORE INSERT ON rig_generation_jobs
WHEN EXISTS(SELECT 1 FROM rig_customer_security_policy WHERE id=1 AND enabled=1)
 AND EXISTS(SELECT 1 FROM rig_generation_quotes WHERE id=NEW.quote_id AND user_id=NEW.user_id AND funding_kind='credits')
BEGIN
 SELECT RAISE(ABORT,'Customer generation requires verified passkey')
 WHERE NOT EXISTS(
  SELECT 1 FROM rig_customer_security_challenges c
  JOIN rig_customer_credentials k ON k.user_id=c.user_id AND k.credential_id=c.credential_id
  JOIN rig_generation_quotes q ON q.id=c.quote_id AND q.user_id=c.user_id AND q.funding_kind='credits'
  WHERE c.operation='customer-generation' AND c.user_id=NEW.user_id AND c.quote_id=NEW.quote_id
   AND c.idempotency_key=NEW.idempotency_key
   AND json_valid(c.payload_json) AND json_extract(c.payload_json,'$.quoteId')=NEW.quote_id
   AND json_extract(c.payload_json,'$.idempotencyKey')=NEW.idempotency_key
   AND q.model=c.quote_model AND q.input_json=c.quote_input_json AND q.price_cents=c.quote_price_cents AND NEW.price_cents=q.price_cents
   AND q.pricing_version=c.quote_pricing_version AND q.duration_seconds=c.quote_duration_seconds
   AND q.expires_at=c.quote_expires_at AND q.expires_at>NEW.created_at
   AND c.used_at IS NOT NULL AND c.use_token IS NOT NULL AND c.attempted_at IS NULL
   AND c.used_at=NEW.created_at AND c.expires_at>NEW.created_at
   AND k.state='active' AND k.counter=c.verified_counter
   AND EXISTS(SELECT 1 FROM rig_sites_identities s
    WHERE s.site_id='appgprj_6aeec13b50448191b88da670dac8aa98' AND s.user_id=c.user_id)
   AND EXISTS(SELECT 1 FROM rig_customer_security_audit a
    WHERE a.user_id=c.user_id AND a.challenge_id=c.id AND a.credential_id=c.credential_id
     AND a.event='verification-consumed' AND a.operation='customer-generation' AND a.payload_hash=c.payload_hash)
 );
END;
