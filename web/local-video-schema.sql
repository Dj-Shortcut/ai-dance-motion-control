-- Local mock-only metadata. Not a production media store.
CREATE TABLE rig_fixture_assets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,r2key TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,duration REAL);
CREATE INDEX rig_fixture_assets_user ON rig_fixture_assets(user_id);
CREATE TABLE rig_fixture_fal_dispatch(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
