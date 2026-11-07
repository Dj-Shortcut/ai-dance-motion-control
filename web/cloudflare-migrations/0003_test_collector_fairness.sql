-- Isolated owner test only. Do not apply without review.
CREATE TABLE IF NOT EXISTS rig_collector_attempts (
  job_id TEXT PRIMARY KEY REFERENCES rig_generation_jobs(id),
  last_attempt_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rig_collector_attempts_age ON rig_collector_attempts(last_attempt_at);
