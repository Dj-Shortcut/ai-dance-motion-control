-- Dedicated closed TEST database only. No automatic expiration or reclaim.
CREATE TABLE rig_media_work_lock (
  id INTEGER PRIMARY KEY CHECK(id=1),
  token TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','uncertain')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
