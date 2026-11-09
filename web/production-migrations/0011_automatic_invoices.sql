-- Automatic invoices are independent immutable documents, not Accountable or
-- Peppol confirmations. Counters and issuance commit in the same D1 batch.
CREATE TABLE rig_invoice_counters (
 issue_year INTEGER PRIMARY KEY CHECK(typeof(issue_year)='integer' AND issue_year BETWEEN 2000 AND 9999),
 next_sequence INTEGER NOT NULL CHECK(typeof(next_sequence)='integer' AND next_sequence BETWEEN 1 AND 1000000000000)
);
CREATE TABLE rig_issued_invoices (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 order_id TEXT NOT NULL UNIQUE REFERENCES rig_orders(id),
 user_id TEXT NOT NULL CHECK(length(user_id)=38),
 order_request_id TEXT NOT NULL CHECK(length(order_request_id) BETWEEN 12 AND 80),
 invoice_number TEXT NOT NULL UNIQUE,
 issue_year INTEGER NOT NULL CHECK(typeof(issue_year)='integer' AND issue_year BETWEEN 2000 AND 9999),
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND 999999999999),
 issued_date TEXT NOT NULL CHECK(length(issued_date)=10),
 issued_at INTEGER NOT NULL CHECK(typeof(issued_at)='integer' AND issued_at>0),
 currency TEXT NOT NULL CHECK(currency='EUR'),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 1000000),
 credit_cents INTEGER NOT NULL CHECK(typeof(credit_cents)='integer' AND credit_cents BETWEEN 1 AND 100000000),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
 snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
 UNIQUE(issue_year,sequence),
 CHECK(invoice_number='RIG-'||issue_year||'-'||printf('%06d',sequence)),
 CHECK(substr(issued_date,1,4)=CAST(issue_year AS TEXT))
);
CREATE INDEX rig_issued_invoices_customer ON rig_issued_invoices(user_id,issued_at,id);
-- Fair bounded read-repair scheduling only. These rows are not invoices and
-- their presence never means a payment, cash refund or credit note exists.
CREATE TABLE rig_invoice_issuance_attempts (
 order_id TEXT PRIMARY KEY REFERENCES rig_orders(id),
 last_checked_at INTEGER NOT NULL CHECK(typeof(last_checked_at)='integer' AND last_checked_at>0),
 last_state TEXT NOT NULL,
 last_reason TEXT
);
