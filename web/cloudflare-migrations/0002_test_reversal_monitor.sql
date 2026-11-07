-- Isolated test database only. Do not apply to a live database.
CREATE TABLE IF NOT EXISTS rig_reversal_monitor (
  order_id TEXT PRIMARY KEY REFERENCES rig_orders(id),
  payment_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processing','done')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  last_success_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rig_reversal_monitor_queue ON rig_reversal_monitor(state,next_at,lease_until);
