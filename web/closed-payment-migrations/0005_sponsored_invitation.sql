-- Closed test only. Exactly one 500-cent sponsored invitation per test DB.
-- No automatic expiry of reservations: uncertain provider work stays reserved.
CREATE TABLE rig_sponsored_invitation (
 id INTEGER PRIMARY KEY CHECK(id=1),
 code_hash TEXT NOT NULL UNIQUE CHECK(length(code_hash)=64),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 redeemed_by TEXT,
 redeemed_at INTEGER,
 CHECK((redeemed_by IS NULL AND redeemed_at IS NULL) OR (redeemed_by IS NOT NULL AND redeemed_at IS NOT NULL))
);
CREATE TABLE rig_sponsored_reservations (
 job_id TEXT PRIMARY KEY REFERENCES rig_generation_jobs(id),
 user_id TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0 AND amount_cents<=500),
 created_at INTEGER NOT NULL,
 released_at INTEGER
);
