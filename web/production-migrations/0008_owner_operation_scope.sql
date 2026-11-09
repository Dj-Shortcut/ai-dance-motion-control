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
