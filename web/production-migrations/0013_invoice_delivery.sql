-- Private immutable PDF archive and a conservative one-attempt mail outbox.
-- These records do not assert that Accountable imported or validated anything.
CREATE TABLE rig_invoice_archives (
 invoice_id TEXT PRIMARY KEY REFERENCES rig_issued_invoices(id),
 storage_key TEXT NOT NULL UNIQUE,
 snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64),
 pdf_sha256 TEXT NOT NULL CHECK(length(pdf_sha256)=64),
 byte_length INTEGER NOT NULL CHECK(typeof(byte_length)='integer' AND byte_length BETWEEN 1 AND 3145728),
 created_at INTEGER NOT NULL
);
CREATE TABLE rig_invoice_mail_outbox (
 invoice_id TEXT PRIMARY KEY REFERENCES rig_issued_invoices(id),
 state TEXT NOT NULL CHECK(state IN ('sending','sent','unknown','failed')),
 attempt_token TEXT NOT NULL UNIQUE,
 pdf_sha256 TEXT NOT NULL CHECK(length(pdf_sha256)=64),
 started_at INTEGER NOT NULL,
 completed_at INTEGER,
 provider_message_id TEXT,
 last_error TEXT,
 CHECK(state<>'sent' OR provider_message_id IS NOT NULL)
);
CREATE INDEX rig_invoice_mail_outbox_state ON rig_invoice_mail_outbox(state,started_at);
-- Fair scheduling lets a damaged archive be investigated without holding up
-- the invoices for later purchases. No delivery claim is made by this table.
CREATE TABLE rig_invoice_delivery_attempts (
 invoice_id TEXT PRIMARY KEY REFERENCES rig_issued_invoices(id),
 last_checked_at INTEGER NOT NULL,
 last_state TEXT NOT NULL CHECK(last_state IN ('checking','archived','review','unavailable'))
);
