-- Apply through the hosting migration mechanism. Never create tables on request.
CREATE TABLE rig_gateway_nonces (nonce TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE INDEX rig_gateway_nonces_created ON rig_gateway_nonces(created_at);
