-- Immutable operator investigation records. They do not release funds or
-- claim that an unknown provider request did not happen.
CREATE TABLE rig_owner_recovery_events (
 id TEXT PRIMARY KEY,
 idempotency_key TEXT NOT NULL UNIQUE,
 owner_id TEXT NOT NULL,
 case_kind TEXT NOT NULL CHECK(case_kind IN ('payment','generation')),
 case_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('note','payment-adopted')),
 status TEXT NOT NULL CHECK(status IN ('investigating','waiting-provider','reviewed','provider-linked')),
 note TEXT NOT NULL,
 provider_id TEXT,
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 evidence_json TEXT NOT NULL,
 created_at INTEGER NOT NULL CHECK(created_at>=0)
);
CREATE INDEX rig_owner_recovery_case ON rig_owner_recovery_events(case_kind,case_id,created_at);
