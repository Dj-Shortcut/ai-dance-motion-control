-- Test-only shared media lease. Apply by controlled migration, not per request.
CREATE TABLE rig_sites_signer_lease(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,expires_at INTEGER NOT NULL);
