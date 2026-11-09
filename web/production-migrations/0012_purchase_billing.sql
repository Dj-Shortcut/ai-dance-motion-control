-- A buyer identity is captured before provider checkout, atomically with terms.
-- This table does not itself issue an invoice or prove payment.
CREATE UNIQUE INDEX rig_purchase_acceptance_billing_hash
 ON rig_purchase_acceptances(user_id,request_id,request_hash);
CREATE TABLE rig_purchase_billing (
 user_id TEXT NOT NULL CHECK(typeof(user_id)='text' AND length(user_id)=38),
 request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(request_id)=36),
 name TEXT NOT NULL CHECK(typeof(name)='text' AND length(name) BETWEEN 1 AND 120),
 street TEXT NOT NULL CHECK(typeof(street)='text' AND length(street) BETWEEN 3 AND 180),
 postal_code TEXT NOT NULL CHECK(typeof(postal_code)='text' AND length(postal_code) BETWEEN 4 AND 7),
 city TEXT NOT NULL CHECK(typeof(city)='text' AND length(city) BETWEEN 1 AND 100),
 country TEXT NOT NULL CHECK(country IN ('BE','NL')),
 electronic_delivery TEXT NOT NULL CHECK(electronic_delivery='rig-download-v1'),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
 PRIMARY KEY(user_id,request_id),
 FOREIGN KEY(user_id,request_id,request_hash) REFERENCES rig_purchase_acceptances(user_id,request_id,request_hash)
);
CREATE TABLE rig_billing_profiles (
 user_id TEXT PRIMARY KEY CHECK(typeof(user_id)='text' AND length(user_id)=38),
 name TEXT NOT NULL CHECK(typeof(name)='text' AND length(name) BETWEEN 1 AND 120),
 street TEXT NOT NULL CHECK(typeof(street)='text' AND length(street) BETWEEN 3 AND 180),
 postal_code TEXT NOT NULL CHECK(typeof(postal_code)='text' AND length(postal_code) BETWEEN 4 AND 7),
 city TEXT NOT NULL CHECK(typeof(city)='text' AND length(city) BETWEEN 1 AND 100),
 country TEXT NOT NULL CHECK(country IN ('BE','NL')),
 electronic_delivery TEXT NOT NULL CHECK(electronic_delivery='rig-download-v1'),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>0)
);
