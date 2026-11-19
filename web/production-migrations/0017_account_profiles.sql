-- Additive profile/activity tracking from the signed Sites producer only.
-- Existing rig_sites_identities.created_at remains the first authenticated visit.
-- Historical identities have no invented name, email or activity timestamp.
CREATE TABLE IF NOT EXISTS rig_account_profiles (
 site_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES rig_sites_identities(user_id),
 display_name TEXT CHECK(display_name IS NULL OR length(display_name) BETWEEN 1 AND 120),
 email TEXT CHECK(email IS NULL OR length(email) BETWEEN 3 AND 254),
 last_active_at INTEGER NOT NULL CHECK(last_active_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(site_id,user_id)
);
CREATE INDEX IF NOT EXISTS rig_sites_identities_overview
 ON rig_sites_identities(site_id,created_at DESC,user_id ASC);
