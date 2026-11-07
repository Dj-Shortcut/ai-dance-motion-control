-- Deploy through schema migrations. No runtime schema creation.
CREATE TABLE IF NOT EXISTS rig_rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  requests INTEGER NOT NULL CHECK(requests > 0)
);
