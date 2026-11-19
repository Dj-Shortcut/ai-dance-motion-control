import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {purchaseForGooglePlayProof} from './google-play-purchases.mjs';
import {googlePlayFulfillmentFixture,USER,OTHER,sealedToken,financial} from './google-play-fulfillment-fixture.mjs';

test('0018 preserves existing objects/data and only extends payable exposure with Google obligations',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  assert.equal(await f.store.schemaReady(),true);const after=await f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'rig_%' ORDER BY name").all();
  for(const row of f.beforeSchema){if(row.name==='rig_funding_exposure')continue;assert.deepEqual(after.results.find(x=>x.name===row.name),row);}
  const source=await readFile(new URL('./production-migrations/0018_google_play_fulfillment.sql',import.meta.url),'utf8');assert.doesNotMatch(source,/\b(?:DROP TABLE|ALTER TABLE|DELETE FROM|UPDATE rig_(?:orders|ledger|purchase))\b/i);
  assert.deepEqual(await f.counts(),{orders:0,ledger:0,claims:0,receipts:0});assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_google_play_assertions').first()).n,0);
 }finally{await f.mf.dispose()}
});
test('prepare is deterministic and idempotent without extending expiry; request conflicts and second active intent are refused',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const a=await f.prepare(),b=await f.prepare({requestId:a.intentId});assert.equal(a.intentId,b.intentId);assert.equal(a.expiresAt,b.expiresAt);assert.equal(a.state,'prepared');assert.equal(a.consumed,false);
  await assert.rejects(f.prepare({requestId:a.intentId,userId:OTHER}),{code:'play_intent_conflict'});await assert.rejects(f.prepare({requestId:a.intentId,productId:'rig_credit_10',creditsCents:1000}),{code:'play_intent_conflict'});
  await assert.rejects(f.prepare(),{code:'play_funding_unavailable'});assert.deepEqual((await f.store.ownedStatus({userId:OTHER,intentId:a.intentId})),{intent:null});
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_google_play_intents').first()).n,1);
 }finally{await f.mf.dispose()}
});
test('fresh snapshot plus intent insert serializes two customers against the same Fal stock',async()=>{
 const f=await googlePlayFulfillmentFixture({balance:9});try{
  const outcomes=await Promise.allSettled([f.prepare(),f.prepare({userId:OTHER})]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_google_play_intents').first()).n,1);
  assert.equal((await f.db.prepare('SELECT payable_order_cents n FROM rig_funding_exposure').first()).n,500);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_funding_snapshots').first()).n,1,'rejected admission leaves no orphan snapshot');
 }finally{await f.mf.dispose()}
});
test('Google reservations are visible to the existing Mollie and owner admission views',async()=>{
 const f=await googlePlayFulfillmentFixture({balance:9});try{
  await f.prepare();const snapshot=await f.snapshot(9);await f.db.batch(snapshot.before);
  const row=await f.db.prepare('SELECT * FROM rig_funding_valid_snapshots WHERE snapshot_id=?').bind(snapshot.snapshotId).first();assert.equal(row.retail_liability_cents,500);
  assert.ok(row.retail_liability_cents*row.usd_micros_per_euro_cent+row.provider_reserved_usd_micros+row.buffer_usd_micros<row.balance_usd_micros);
  await assert.rejects(f.prepareMollie({userId:OTHER,orderId:crypto.randomUUID(),requestId:crypto.randomUUID(),pkg:{id:'five',amountCents:500,credits:500}}),e=>e.code==='funding_capacity');
 }finally{await f.mf.dispose()}
});
test('unverified retry tokens expire their backing hold; verified Google pending retains its obligation',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const i=await f.prepare(),{proof}=await f.inspect({state:'PENDING'}),p=purchaseForGooglePlayProof(proof);
  await f.store.queueVerification({intentId:i.intentId,userId:USER,productId:i.productId,tokenHash:p.tokenHash,sealedToken});await f.backdate(i.intentId);
  assert.equal((await f.db.prepare('SELECT payable_order_cents n FROM rig_funding_exposure').first()).n,0);
  const expired=(await f.store.ownedStatus({userId:USER,intentId:i.intentId})).intent;assert.equal(expired.state,'expired');assert.equal(expired.newPurchasesBlocked,false);
  const j=await f.prepare();assert.notEqual(j.intentId,i.intentId);await f.store.observeVerifiedPurchase({intentId:j.intentId,proof,sealedToken});await f.backdate(j.intentId);
  assert.equal((await f.db.prepare('SELECT payable_order_cents n FROM rig_funding_exposure').first()).n,500);assert.equal((await f.store.ownedStatus({userId:USER,intentId:j.intentId})).intent.state,'pending');
 }finally{await f.mf.dispose()}
});
test('Google-proven payment credits once, preserving backing and never making a Mollie order',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const i=await f.prepare(),{proof}=await f.inspect();const [a,b]=await Promise.all([f.grant(i.intentId,proof),f.grant(i.intentId,proof)]);
  assert.equal(a.state,'credited');assert.equal(b.state,'credited');assert.deepEqual(await f.counts(),{orders:0,ledger:1,claims:1,receipts:1});
  const exposure=await f.db.prepare('SELECT positive_wallet_cents,payable_order_cents FROM rig_funding_exposure').first();assert.deepEqual(exposure,{positive_wallet_cents:500,payable_order_cents:0});
  assert.equal((await f.db.prepare('SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?').bind(USER).first()).n,500);
 }finally{await f.mf.dispose()}
});
test('two paid tokens for one intent give one credit and a separate refund, without replacing the primary result',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const i=await f.prepare(),a=await f.inspect(),b=await f.inspect();await f.grant(i.intentId,a.proof);
  const extra=await f.grant(i.intentId,b.proof);assert.equal(extra.state,'credited');assert.equal(extra.refundPending,true);assert.equal(extra.newPurchasesBlocked,true);
  assert.deepEqual(await f.counts(),{orders:0,ledger:1,claims:1,receipts:2});assert.equal((await f.store.getReceipt(purchaseForGooglePlayProof(b.proof).tokenHash)).state,'refund_required');
  const returned=await f.inspect({token:b.token,refundableQuantity:0});await f.store.observeVerifiedPurchase({intentId:i.intentId,proof:returned.proof,sealedToken});
  assert.equal((await f.store.ownedStatus({userId:USER,intentId:i.intentId})).intent.state,'credited');assert.equal((await f.db.prepare('SELECT SUM(delta) n FROM rig_ledger').first()).n,500);
 }finally{await f.mf.dispose()}
});
test('late/uncovered/ineligible/consumed payments enter explicit refund recovery, never silent wallet failure',async()=>{
 for(const kind of ['late','capacity','financial','consumed','frozen']){
  const f=await googlePlayFulfillmentFixture();try{
   const i=await f.prepare();if(kind==='late')await f.backdate(i.intentId);if(kind==='frozen')await f.db.prepare("INSERT INTO rig_frozen_accounts(user_id,reason) VALUES(?,'fixture')").bind(USER).run();
   const {proof}=await f.inspect({consumed:kind==='consumed'}),result=await f.grant(i.intentId,proof,{...(kind==='capacity'?{funding:await f.snapshot(6)}:{}),...(kind==='financial'?{creditAllowed:false}:{})});
   assert.equal(result.state,'refund_pending',kind);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_google_play_credit_claims').first()).n,0);
  }finally{await f.mf.dispose()}
 }
});
test('paid within original window can recover after offline TTL using new funding; proven pending allows delayed settlement',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const i=await f.prepare(),expired=await f.backdate(i.intentId),p=await f.inspect({purchasedAt:expired-100});assert.equal((await f.grant(i.intentId,p.proof)).state,'credited');
 }finally{await f.mf.dispose()}
 const g=await googlePlayFulfillmentFixture();try{
  const i=await g.prepare(),pending=await g.inspect({state:'PENDING'});await g.store.observeVerifiedPurchase({intentId:i.intentId,proof:pending.proof,sealedToken});await g.backdate(i.intentId);
  const paid=await g.inspect({token:pending.token});assert.equal((await g.grant(i.intentId,paid.proof)).state,'credited');
 }finally{await g.mf.dispose()}
});
test('refund after spending makes one negative ledger event, preserves history and freezes an indebted account',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const i=await f.prepare(),paid=await f.inspect();await f.grant(i.intentId,paid.proof);await f.db.prepare('INSERT INTO rig_ledger(event_id,user_id,delta) VALUES(?,?,?)').bind('fixture-spend',USER,-400).run();
  const refund=await f.inspect({token:paid.token,refundableQuantity:0});await f.store.observeVerifiedPurchase({intentId:i.intentId,proof:refund.proof,sealedToken});await f.store.observeVerifiedPurchase({intentId:i.intentId,proof:refund.proof,sealedToken});
  assert.equal((await f.db.prepare('SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?').bind(USER).first()).n,-400);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_google_play_reversals').first()).n,1);assert.ok(await f.db.prepare('SELECT user_id FROM rig_frozen_accounts WHERE user_id=?').bind(USER).first());
  assert.equal((await f.store.ownedStatus({userId:USER,intentId:i.intentId})).intent.state,'refunded');assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,3);
 }finally{await f.mf.dispose()}
});
test('partial-refund review freezes credited wallet without inventing a full reversal',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const i=await f.prepare(),paid=await f.inspect(),p=purchaseForGooglePlayProof(paid.proof);await f.grant(i.intentId,paid.proof);
  await f.store.markReview({tokenHash:p.tokenHash,financial,reason:'partial_refund',freeze:true});assert.equal((await f.db.prepare('SELECT SUM(delta) n FROM rig_ledger').first()).n,500);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_google_play_reversals').first()).n,0);assert.ok(await f.db.prepare('SELECT user_id FROM rig_frozen_accounts WHERE user_id=?').bind(USER).first());
  const state=(await f.store.ownedStatus({userId:USER,intentId:i.intentId})).intent;assert.equal(state.state,'credited');assert.equal(state.recoveryPending,true);assert.equal(state.newPurchasesBlocked,true);
 }finally{await f.mf.dispose()}
});
test('transient financial-read review recovers with fresh money evidence, while partial-refund freeze remains',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const i=await f.prepare(),paid=await f.inspect(),p=purchaseForGooglePlayProof(paid.proof);await f.store.observeVerifiedPurchase({intentId:i.intentId,proof:paid.proof,sealedToken});await f.store.markReview({tokenHash:p.tokenHash,reason:'purchase_ambiguous'});
  assert.equal((await f.grant(i.intentId,paid.proof)).state,'credited');assert.equal((await f.store.getReceipt(p.tokenHash)).state,'credited');
  await f.store.markReview({tokenHash:p.tokenHash,reason:'partial_refund',freeze:true});await f.grant(i.intentId,paid.proof);
  assert.equal((await f.store.getReceipt(p.tokenHash)).state,'review');assert.ok(await f.db.prepare('SELECT user_id FROM rig_frozen_accounts WHERE user_id=?').bind(USER).first());
 }finally{await f.mf.dispose()}
});
test('a globally claimed token cannot move to another user or be relabelled as another admission',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const i=await f.prepare(),paid=await f.inspect();await f.grant(i.intentId,paid.proof);const j=await f.prepare({userId:OTHER}),forged=await f.inspect({userId:OTHER,token:paid.token});
  await assert.rejects(f.store.observeVerifiedPurchase({intentId:j.intentId,proof:forged.proof,sealedToken}),{code:'play_token_conflict'});assert.equal((await f.counts()).ledger,1);
 }finally{await f.mf.dispose()}
});
test('wrong database environment refuses mutations and forged proof JSON cannot establish a receipt',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const i=await f.prepare(),paid=await f.inspect();await assert.rejects(f.store.observeVerifiedPurchase({intentId:i.intentId,proof:JSON.parse(JSON.stringify(paid.proof)),sealedToken}));
  await f.db.prepare("UPDATE rig_payment_environment SET mode='test'").run();await assert.rejects(f.store.queueVerification({intentId:i.intentId,userId:USER,productId:i.productId,tokenHash:purchaseForGooglePlayProof(paid.proof).tokenHash,sealedToken}),{code:'play_environment'});assert.equal(await f.store.schemaReady(),false);
  assert.equal((await f.counts()).ledger,0);assert.equal((await f.counts()).receipts,0);
 }finally{await f.mf.dispose()}
});
test('one provider inspection permits one consume/refund write; another authoritative read is required',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const i=await f.prepare(),paid=await f.inspect(),p=purchaseForGooglePlayProof(paid.proof);await f.grant(i.intentId,paid.proof);
  assert.equal(await f.store.markConsumptionAttempt({tokenHash:p.tokenHash,inspectionId:p.inspectionId}),true);assert.equal(await f.store.markConsumptionAttempt({tokenHash:p.tokenHash,inspectionId:p.inspectionId}),false);
  const read=await f.inspect({token:paid.token});await f.store.observeVerifiedPurchase({intentId:i.intentId,proof:read.proof,sealedToken});assert.equal(await f.store.markConsumptionAttempt({tokenHash:p.tokenHash,inspectionId:purchaseForGooglePlayProof(read.proof).inspectionId}),true);
  const consumed=await f.inspect({token:paid.token,consumed:true});await f.store.recordConsumed({proof:consumed.proof});assert.equal((await f.store.ownedStatus({userId:USER,intentId:i.intentId})).intent.consumed,true);
  const next=await f.prepare();assert.notEqual(next.intentId,i.intentId);
 }finally{await f.mf.dispose()}
});
test('observing consumed credit atomically completes its intent even if processing stops before recordConsumed',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const i=await f.prepare(),paid=await f.inspect();await f.grant(i.intentId,paid.proof);const consumed=await f.inspect({token:paid.token,consumed:true});
  await f.store.observeVerifiedPurchase({intentId:i.intentId,proof:consumed.proof,sealedToken});
  assert.equal((await f.store.getIntent(i.intentId,USER)).state,'complete');const p=(await f.store.ownedStatus({userId:USER,intentId:i.intentId})).intent;assert.equal(p.consumed,true);assert.equal(p.newPurchasesBlocked,false);assert.notEqual((await f.prepare()).intentId,i.intentId);
 }finally{await f.mf.dispose()}
});
test('encrypted notification inbox is durable/idempotent and does not credit on PubSub authority alone',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const descriptor={messageId:'notice1',kind:'product',tokenHash:'a'.repeat(64),productId:'rig_credit_5',orderId:null,mode:'live',packageName:'dev.andyarijs.rig'};
  assert.equal(await f.store.noteNotification({descriptor,sealedToken}),true);assert.equal(await f.store.noteNotification({descriptor,sealedToken}),false);await assert.rejects(f.store.noteNotification({descriptor:{...descriptor,tokenHash:'b'.repeat(64)},sealedToken}),{code:'play_notification_conflict'});
  const due=await f.store.due();assert.equal(due.notifications.length,1);assert.equal(due.notifications[0].sealed_token,sealedToken);assert.equal((await f.counts()).ledger,0);await f.store.finishNotification({messageId:'notice1'});assert.equal((await f.store.due()).notifications.length,0);
 }finally{await f.mf.dispose()}
});
test('voided catchup cursor never advances on unfinished page or backwards; leases exclude concurrent workers',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  const now=Date.now(),start=now-3600000;await f.store.saveVoidedCursor({completedUntilMs:null,windowStartMs:start,windowEndMs:now,pageToken:'page1',now});
  assert.equal((await f.store.getVoidedCursor()).completedUntilMs,null);await assert.rejects(f.store.saveVoidedCursor({completedUntilMs:now,windowStartMs:start,windowEndMs:now,pageToken:'page2',now}),{code:'play_voided_cursor'});
  await f.store.saveVoidedCursor({completedUntilMs:now,windowStartMs:start,windowEndMs:now,pageToken:null,now});assert.equal((await f.store.getVoidedCursor()).completedUntilMs,now);
  await assert.rejects(f.store.saveVoidedCursor({completedUntilMs:now-1000,windowStartMs:start,windowEndMs:now,pageToken:null,now}),{code:'play_voided_cursor'});
  const lease=await f.store.acquireLease({workId:'voided'});assert.ok(lease);assert.equal(await f.store.acquireLease({workId:'voided'}),null);await f.store.releaseLease({workId:'voided',leaseToken:lease});assert.ok(await f.store.acquireLease({workId:'voided'}));
 }finally{await f.mf.dispose()}
});
