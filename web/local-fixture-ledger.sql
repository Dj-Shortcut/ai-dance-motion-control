-- Synthetic local balances only; never provision as a live payment ledger.
CREATE TABLE rig_fixture_ledger (event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, delta INTEGER NOT NULL);
CREATE INDEX rig_fixture_ledger_user ON rig_fixture_ledger(user_id);
