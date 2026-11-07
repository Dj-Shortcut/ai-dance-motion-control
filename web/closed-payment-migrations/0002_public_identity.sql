-- New identity table for a separate future public database. Do not apply to
-- the owner test database or production without a reviewed migration plan.
CREATE TABLE rig_external_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (issuer, subject)
);

-- A coarse pre-authentication circuit breaker shared by all app instances.
-- A proper edge/IP limiter is still required for any real deployment.
CREATE TABLE rig_public_auth_rate (
  scope TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  requests INTEGER NOT NULL CHECK (requests > 0)
);
