-- Additive request receipts only. Nothing here deletes an account, changes a
-- wallet, revokes a session, hides a result or decides a content report.
CREATE TABLE IF NOT EXISTS rig_account_service_requests (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 site_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES rig_sites_identities(user_id),
 type TEXT NOT NULL CHECK(type IN ('account-deletion','video-report')),
 job_id TEXT REFERENCES rig_generation_jobs(id),
 reason TEXT CHECK(reason IS NULL OR reason IN ('sexual','violence','hate','unsafe','other')),
 details TEXT NOT NULL CHECK(length(details)<=1000),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','declined')),
 created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
 UNIQUE(site_id,user_id,id,request_hash),
 CHECK((type='account-deletion' AND job_id IS NULL AND reason IS NULL AND details='') OR
       (type='video-report' AND job_id IS NOT NULL AND reason IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS rig_account_service_pending_duplicate
 ON rig_account_service_requests(site_id,user_id,type,request_hash) WHERE status='pending';
CREATE INDEX IF NOT EXISTS rig_account_service_queue
 ON rig_account_service_requests(site_id,status,created_at,id);
CREATE INDEX IF NOT EXISTS rig_account_service_own
 ON rig_account_service_requests(site_id,user_id,type,created_at DESC,id DESC);
-- A retried receipt has the same identity even when another request key was
-- used to report the same pending case. Aliases bind the exact original body.
CREATE TABLE IF NOT EXISTS rig_account_service_request_keys (
 site_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 case_id TEXT NOT NULL,
 created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(site_id,user_id,request_id),
 FOREIGN KEY(site_id,user_id,case_id,request_hash)
  REFERENCES rig_account_service_requests(site_id,user_id,id,request_hash)
);
