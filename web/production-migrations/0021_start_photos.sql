-- Keep only quota reservations. Prompts and photos are not persisted by this service.
CREATE TABLE IF NOT EXISTS rig_start_photo_attempts (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rig_start_photo_attempts_user ON rig_start_photo_attempts(user_id);
