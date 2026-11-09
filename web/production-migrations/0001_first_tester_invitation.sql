-- Apply only to the isolated production DB. No source code or balance is seeded.
-- The operator must invalidate the exact still-unclaimed TEST invitation first.
CREATE TABLE IF NOT EXISTS rig_production_invitation (
 id INTEGER PRIMARY KEY CHECK(id=1),
 code_hash TEXT NOT NULL UNIQUE CHECK(length(code_hash)=64),
 amount_cents INTEGER NOT NULL CHECK(amount_cents=500),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 source_environment_id TEXT NOT NULL CHECK(source_environment_id='rig-public-test-v1'),
 source_invitation_id INTEGER NOT NULL CHECK(source_invitation_id=1),
 source_invalidated_at INTEGER NOT NULL CHECK(source_invalidated_at>0 AND source_invalidated_at<=created_at),
 redeemed_by TEXT,
 redeemed_at INTEGER,
 CHECK((redeemed_by IS NULL AND redeemed_at IS NULL) OR (redeemed_by IS NOT NULL AND redeemed_at IS NOT NULL))
);
