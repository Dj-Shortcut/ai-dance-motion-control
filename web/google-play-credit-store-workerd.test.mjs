// Actual isolated D1 transactions; synthetic Google responses only. This schema
// is a test fixture, NOT a production migration or a valid funding policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {createGooglePlayCreditStore} from './google-play-credit-store.mjs';
import {purchaseFixture,USER,OTHER,now} from './google-play-test-fixture.mjs';
async function fixture({admission=true,paymentMode='live',purchaseOptions}={}){
 const purchase=await purchaseFixture(purchaseOptions),proof=await purchase.verifier.verify(purchase.input),receipt=proof.receipt,id=crypto.randomUUID();
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:['DB']}),db=await mf.getD1Database('DB');
 const sql=`CREATE TABLE rig_payment_environment(id INTEGER PRIMARY KEY,mode TEXT NOT NULL);CREATE TABLE rig_ledger(event_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,order_id TEXT,delta INTEGER NOT NULL);CREATE TABLE rig_google_play_receipts(token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),user_id TEXT NOT NULL,product_id TEXT NOT NULL,credit_cents INTEGER NOT NULL CHECK(credit_cents>0),mode TEXT NOT NULL CHECK(mode IN ('test','live')),package_name TEXT NOT NULL,account_id TEXT NOT NULL,purchased_at INTEGER NOT NULL,google_order_id TEXT,state TEXT NOT NULL CHECK(state IN ('credited','consumed','reversal_review')),verified_at INTEGER NOT NULL);CREATE TABLE admission_fixture(admission_id TEXT PRIMARY KEY,user_id TEXT,product_id TEXT,credit_cents INTEGER,mode TEXT,package_name TEXT,account_id TEXT,expires_at INTEGER);CREATE VIEW rig_google_play_valid_admissions AS SELECT * FROM admission_fixture;`;
 for(const statement of sql.split(';').filter(Boolean))await db.prepare(statement).run();
 await db.prepare('INSERT INTO rig_payment_environment VALUES(1,?)').bind(paymentMode).run();
 if(admission)await db.prepare('INSERT INTO admission_fixture VALUES(?,?,?,?,?,?,?,?)').bind(id,USER,receipt.productId,receipt.creditsCents,receipt.mode,receipt.packageName,receipt.accountId,now+60000).run();
 return {mf,db,proof,receipt,id,purchase,store:createGooglePlayCreditStore(db),creditOptions:{admissionId:id,now},async count(){return {receipts:(await db.prepare('SELECT COUNT(*) n FROM rig_google_play_receipts').first()).n,ledger:(await db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n}}};
}
test('fresh completed purchase is claimed and credited atomically once, without a Mollie order',async()=>{
 const f=await fixture();try{
  const first=await f.store.credit(f.proof,f.creditOptions),second=await f.store.credit(f.proof,f.creditOptions);
  assert.deepEqual(first,second);assert.equal(first.state,'credited');assert.equal(first.creditsCents,500);assert.deepEqual(await f.count(),{receipts:1,ledger:1});
  const row=await f.db.prepare('SELECT * FROM rig_ledger').first();assert.equal(row.order_id,null);assert.equal(row.delta,500);assert.equal(row.event_id,'google-play:'+f.receipt.tokenHash);
 }finally{await f.mf.dispose()}
});
test('parallel duplicate confirmation has exactly one durable receipt and ledger credit',async()=>{
 const f=await fixture();try{const result=await Promise.all([f.store.credit(f.proof,f.creditOptions),f.store.credit(f.proof,f.creditOptions)]);assert.deepEqual(result[0],result[1]);assert.deepEqual(await f.count(),{receipts:1,ledger:1});}finally{await f.mf.dispose()}
});
test('missing, expired or wrong-user admission and mismatched payment environment leave no half-credit',async()=>{
 for(const options of [{admission:false},{paymentMode:'test'},{}]){
  const f=await fixture(options);try{
   if(!Object.keys(options).length)await f.db.prepare('UPDATE admission_fixture SET expires_at=?').bind(now).run();
   await assert.rejects(f.store.credit(f.proof,f.creditOptions),{code:'play_credit_unconfirmed'});assert.deepEqual(await f.count(),{receipts:0,ledger:0});
  }finally{await f.mf.dispose()}
 }
 const f=await fixture();try{await f.db.prepare('UPDATE admission_fixture SET user_id=?').bind(OTHER).run();await assert.rejects(f.store.credit(f.proof,f.creditOptions),{code:'play_credit_unconfirmed'});assert.deepEqual(await f.count(),{receipts:0,ledger:0});}finally{await f.mf.dispose()}
});
test('missing future funding view cannot become an unconditional credit fallback',async()=>{
 const f=await fixture();try{await f.db.prepare('DROP VIEW rig_google_play_valid_admissions').run();await assert.rejects(f.store.credit(f.proof,f.creditOptions),{code:'play_credit_unconfirmed'});assert.deepEqual(await f.count(),{receipts:0,ledger:0});}finally{await f.mf.dispose()}
});
test('conflicting existing ledger event aborts the entire new receipt transaction',async()=>{
 const f=await fixture();try{
  await f.db.prepare('INSERT INTO rig_ledger VALUES(?,?,NULL,?)').bind('google-play:'+f.receipt.tokenHash,OTHER,500).run();
  await assert.rejects(f.store.credit(f.proof,f.creditOptions),{code:'play_credit_unconfirmed'});assert.deepEqual(await f.count(),{receipts:0,ledger:1});
  assert.equal((await f.db.prepare('SELECT user_id FROM rig_ledger').first()).user_id,OTHER);
 }finally{await f.mf.dispose()}
});
test('a token can never be reassigned to another user or altered amount, even after admission',async()=>{
 const f=await fixture();try{
  await f.store.credit(f.proof,f.creditOptions);await f.db.prepare('UPDATE rig_google_play_receipts SET user_id=?').bind(OTHER).run();
  await assert.rejects(f.store.credit(f.proof,f.creditOptions),{code:'play_receipt_conflict'});assert.deepEqual(await f.count(),{receipts:1,ledger:1});
 }finally{await f.mf.dispose()}
});
test('browser copies of a verifier result cannot reach a wallet operation',async()=>{
 const f=await fixture();try{await assert.rejects(f.store.credit(JSON.parse(JSON.stringify(f.proof)),f.creditOptions),{code:'play_proof'});assert.deepEqual(await f.count(),{receipts:0,ledger:0});}finally{await f.mf.dispose()}
});
test('already-consumed token cannot mint a new credit, while known credit can reconcile consumed state',async()=>{
 const f=await fixture({purchaseOptions:{mutate:b=>{b.productLineItem[0].productOfferDetails.consumptionState='CONSUMPTION_STATE_CONSUMED'}}});try{await assert.rejects(f.store.credit(f.proof,f.creditOptions),{code:'play_already_consumed'});assert.deepEqual(await f.count(),{receipts:0,ledger:0});}finally{await f.mf.dispose()}
 const g=await fixture();try{
  await g.store.credit(g.proof,g.creditOptions);await assert.rejects(g.store.recordConsumed(g.proof),{code:'play_consume_unverified'});
  const again=await purchaseFixture({mutate:b=>{b.productLineItem[0].productOfferDetails.consumptionState='CONSUMPTION_STATE_CONSUMED'}}),proof=await again.verifier.verify(again.input);
  assert.equal((await g.store.credit(proof,g.creditOptions)).state,'credited');await g.store.recordConsumed(proof);assert.equal((await g.db.prepare('SELECT state FROM rig_google_play_receipts').first()).state,'consumed');assert.deepEqual(await g.count(),{receipts:1,ledger:1});
 }finally{await g.mf.dispose()}
});
