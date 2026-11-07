-- Apply to a dedicated D1 database. All values are integer units, never floats.
-- The administrator must explicitly insert exactly one row setting mode to
-- 'test' OR 'live'. Use completely separate DBs for test and live; never
-- change an existing environment row to live or reuse its balances.
CREATE TABLE IF NOT EXISTS rig_payment_environment (
  id INTEGER PRIMARY KEY CHECK (id=1),
  mode TEXT NOT NULL CHECK (mode IN ('test','live'))
);
CREATE TABLE IF NOT EXISTS rig_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  credits INTEGER NOT NULL CHECK (credits > 0),
  payment_id TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'creating',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, request_id)
);
CREATE TABLE IF NOT EXISTS rig_ledger (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  order_id TEXT REFERENCES rig_orders(id),
  delta INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rig_frozen_accounts (
  user_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS rig_ledger_user ON rig_ledger(user_id);
-- Fixture-only payment intent cancellation tombstones, scoped to owner.
CREATE TABLE IF NOT EXISTS rig_payment_cancelled_intents (
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id,request_id)
);
-- One in-flight or manually reviewed purchase per account. The provider
-- request is made only after this constraint has accepted the order. SQLite
-- enforces this atomically even for distinct idempotency keys.
CREATE UNIQUE INDEX IF NOT EXISTS rig_one_unresolved_order_per_user
  ON rig_orders(user_id)
  WHERE state IN ('creating','open','unknown','credit_pending_review');
-- Durable, internal outbox for Mollie payments that must be reviewed or canceled
-- following an account freeze. Never expose this table as a browser route.
CREATE TABLE IF NOT EXISTS rig_cancel_requests (
  order_id TEXT PRIMARY KEY REFERENCES rig_orders(id),
  user_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','done','review')),
  lease_token TEXT,
  lease_until INTEGER,
  delete_attempted INTEGER NOT NULL DEFAULT 0 CHECK(delete_attempted IN (0,1)),
  reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rig_cancel_state ON rig_cancel_requests(state,lease_until);
-- Durable status verification after a confirmed cancellation. The record is
-- separate from the cancellation attempt so a crash cannot lose reconciliation.
CREATE TABLE IF NOT EXISTS rig_cancel_reconcile (
 order_id TEXT PRIMARY KEY REFERENCES rig_orders(id),
 payment_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processing','done','review')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 next_at INTEGER NOT NULL,
 lease_token TEXT,
 lease_until INTEGER,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rig_cancel_reconcile_queue ON rig_cancel_reconcile(state,next_at,lease_until);
