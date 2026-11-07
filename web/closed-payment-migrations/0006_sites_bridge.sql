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
