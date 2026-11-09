-- Immutable evidence of the price/terms and buyer's stated country before checkout.
-- This does not assign a VAT treatment or issue a fiscal invoice.
CREATE TABLE rig_purchase_acceptances (
 user_id TEXT NOT NULL CHECK(typeof(user_id)='text' AND length(user_id)=38),
 request_id TEXT NOT NULL CHECK(typeof(request_id)='text' AND length(request_id)=36),
 version TEXT NOT NULL CHECK(typeof(version)='text' AND length(version) BETWEEN 1 AND 100),
 buyer_country TEXT NOT NULL CHECK(buyer_country IN ('BE','NL')),
 customer_type TEXT NOT NULL CHECK(customer_type='consumer'),
 package_id TEXT NOT NULL CHECK(typeof(package_id)='text' AND length(package_id) BETWEEN 1 AND 40),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 1000000),
 credits INTEGER NOT NULL CHECK(typeof(credits)='integer' AND credits BETWEEN 1 AND 100000000),
 currency TEXT NOT NULL CHECK(currency='EUR'),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
 seller_json TEXT NOT NULL CHECK(json_valid(seller_json) AND json_type(seller_json)='object'),
 terms_text TEXT NOT NULL CHECK(typeof(terms_text)='text' AND length(terms_text) BETWEEN 1 AND 65536),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0),
 PRIMARY KEY(user_id,request_id)
);
