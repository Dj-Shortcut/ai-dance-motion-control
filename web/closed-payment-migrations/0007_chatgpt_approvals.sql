CREATE TABLE rig_chatgpt_approvals (
 token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
 user_id TEXT NOT NULL,
 quote_id TEXT NOT NULL REFERENCES rig_generation_quotes(id),
 idempotency_key TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 used_at INTEGER
);
CREATE INDEX rig_chatgpt_approvals_quote ON rig_chatgpt_approvals(user_id,quote_id);
