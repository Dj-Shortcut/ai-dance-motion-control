-- Immutable receipt of a customer's request. This table never changes money.
CREATE TABLE rig_customer_support_requests (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 user_id TEXT NOT NULL CHECK(length(user_id)=38),
 order_id TEXT NOT NULL REFERENCES rig_orders(id),
 order_request_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key)=36),
 kind TEXT NOT NULL CHECK(kind IN ('withdrawal','payment-help')),
 message TEXT NOT NULL CHECK(length(message)<=1000),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 order_state_at_request TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
 credits INTEGER NOT NULL CHECK(typeof(credits)='integer' AND credits>0),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
 UNIQUE(user_id,idempotency_key)
);
CREATE INDEX rig_customer_support_by_user ON rig_customer_support_requests(user_id,created_at,id);
CREATE INDEX rig_customer_support_queue ON rig_customer_support_requests(created_at,id);
