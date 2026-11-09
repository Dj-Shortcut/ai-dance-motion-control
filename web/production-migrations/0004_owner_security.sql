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
