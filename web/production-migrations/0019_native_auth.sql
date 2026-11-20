-- Additive native login. Codes and session credentials are stored only hashed.
-- The existing Sites identity remains the sole owner of a RIG wallet and jobs.
CREATE TABLE IF NOT EXISTS rig_native_login_codes (
 code_hash TEXT PRIMARY KEY CHECK(length(code_hash)=64),
 site_id TEXT NOT NULL,
 subject_hash TEXT NOT NULL CHECK(length(subject_hash)=64),
 user_id TEXT NOT NULL CHECK(length(user_id)=38),
 challenge TEXT NOT NULL CHECK(length(challenge)=43),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 consumed_at INTEGER,
 consumed_token_hash TEXT CHECK(consumed_token_hash IS NULL OR length(consumed_token_hash)=64),
 CHECK((consumed_at IS NULL AND consumed_token_hash IS NULL) OR (consumed_at IS NOT NULL AND consumed_token_hash IS NOT NULL)),
 FOREIGN KEY(site_id,subject_hash) REFERENCES rig_sites_identities(site_id,subject_hash)
);
CREATE INDEX IF NOT EXISTS rig_native_login_codes_user ON rig_native_login_codes(user_id,expires_at);
CREATE TABLE IF NOT EXISTS rig_native_sessions (
 token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
 site_id TEXT NOT NULL,
 subject_hash TEXT NOT NULL CHECK(length(subject_hash)=64),
 user_id TEXT NOT NULL CHECK(length(user_id)=38),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 revoked_at INTEGER,
 FOREIGN KEY(site_id,subject_hash) REFERENCES rig_sites_identities(site_id,subject_hash)
);
CREATE INDEX IF NOT EXISTS rig_native_sessions_user ON rig_native_sessions(user_id,expires_at);
-- A failed claim must roll back the whole D1 batch, including code consumption.
CREATE TABLE IF NOT EXISTS rig_native_auth_assertions (value INTEGER NOT NULL CHECK(value=1));
