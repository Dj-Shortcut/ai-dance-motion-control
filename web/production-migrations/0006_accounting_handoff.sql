-- Manual handoff evidence only. No invoice is issued, payment sent or ledger
-- changed by this migration. Accountable remains the external source document.
CREATE TABLE rig_accounting_documents (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),
 order_id TEXT NOT NULL REFERENCES rig_orders(id),
 provider TEXT NOT NULL CHECK(provider='accountable'),
 external_invoice_reference TEXT NOT NULL,
 reference_key TEXT NOT NULL,
 document_date TEXT NOT NULL CHECK(length(document_date)=10),
 record_type TEXT NOT NULL CHECK(record_type IN ('invoice','accounting-entry')),
 delivery_status TEXT NOT NULL CHECK(delivery_status IN ('prepared','recorded-in-accountable','peppol-sent-manually')),
 note TEXT NOT NULL,
 replaces_document_id TEXT UNIQUE REFERENCES rig_accounting_documents(id),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 recorded_by TEXT NOT NULL,
 created_at INTEGER NOT NULL CHECK(created_at>=0)
);
CREATE UNIQUE INDEX rig_accounting_initial_document_order ON rig_accounting_documents(order_id) WHERE replaces_document_id IS NULL;
CREATE INDEX rig_accounting_documents_order ON rig_accounting_documents(order_id,created_at);
-- Preserve every reference ever used, including corrected ones. A reference
-- cannot silently migrate to another customer's purchase.
CREATE TABLE rig_accounting_references (
 reference_key TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES rig_orders(id),
 created_at INTEGER NOT NULL CHECK(created_at>=0)
);
