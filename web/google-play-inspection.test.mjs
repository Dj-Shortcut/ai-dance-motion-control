import test from 'node:test';
import assert from 'node:assert/strict';
import {createGooglePlayPurchaseVerifier,purchaseForGooglePlayProof,notificationPurchaseForGooglePlayProof,receiptForGooglePlayProof} from './google-play-purchases.mjs';
import {purchaseFixture,USER,now,key,siteId,catalog} from './google-play-test-fixture.mjs';

test('private pending/cancelled inspector retains verified bound identity without minting credit receipt',async()=>{
 for(const state of ['PENDING','CANCELLED']){
  const f=await purchaseFixture({mutate:body=>{body.purchaseStateContext.purchaseState=state;delete body.purchaseCompletionTime;delete body.acknowledgementState;delete body.productLineItem[0].productOfferDetails.refundableQuantity;delete body.productLineItem[0].productOfferDetails.consumptionState;}});
  const proof=await f.verifier.inspect(f.input),purchase=purchaseForGooglePlayProof(proof);
  assert.equal(purchase.state,state);assert.equal(purchase.userId,USER);assert.equal(purchase.accountId,f.accountId);assert.equal(purchase.productId,'rig_credit_5');assert.equal(purchase.purchasedAt,null);assert.equal(purchase.consumed,null);assert.equal(purchase.refundableQuantity,null);assert.equal(purchase.verifiedAt,now);assert.match(purchase.inspectionId,/^[a-f0-9-]{36}$/);
  assert.throws(()=>receiptForGooglePlayProof(proof),{code:'play_proof'});assert.throws(()=>purchaseForGooglePlayProof(JSON.parse(JSON.stringify(proof))),{code:'play_proof'});
 }
});
test('zero refundable quantity is a verified purchased reversal candidate, never fresh credit',async()=>{
 const f=await purchaseFixture({mutate:body=>{body.productLineItem[0].productOfferDetails.refundableQuantity=0;}}),proof=await f.verifier.inspect(f.input);
 assert.equal(purchaseForGooglePlayProof(proof).refundableQuantity,0);assert.equal(purchaseForGooglePlayProof(proof).state,'PURCHASED');assert.throws(()=>receiptForGooglePlayProof(proof),{code:'play_proof'});await assert.rejects(f.verifier.verify(f.input),{code:'play_product'});
});
test('each actual successful Google reread has unique inspection ID; JSON does not forge one',async()=>{
 const f=await purchaseFixture(),a=await f.verifier.inspect(f.input),b=await f.verifier.inspect(f.input);
 assert.notEqual(purchaseForGooglePlayProof(a).inspectionId,purchaseForGooglePlayProof(b).inspectionId);assert.equal(f.calls.length,2);assert.throws(()=>purchaseForGooglePlayProof({...b}),{code:'play_proof'});
});
test('unknown notification token may locate server account, but lookup is not a wallet entitlement',async()=>{
 const f=await purchaseFixture(),proof=await f.verifier.inspectForNotification({purchaseToken:f.input.purchaseToken}),lookup=notificationPurchaseForGooglePlayProof(proof);
 assert.equal(lookup.accountId,f.accountId);assert.equal(lookup.productId,'rig_credit_5');assert.equal(lookup.mode,'live');assert.equal(lookup.state,'PURCHASED');assert.equal(lookup.purchasedAt,Date.parse(f.body.purchaseCompletionTime));assert.equal(lookup.verifiedAt,now);assert.ok(!JSON.stringify(proof).includes(f.input.purchaseToken));assert.equal(Object.hasOwn(lookup,'userId'),false);
 assert.throws(()=>purchaseForGooglePlayProof(proof),{code:'play_proof'});assert.throws(()=>receiptForGooglePlayProof(proof),{code:'play_proof'});assert.throws(()=>notificationPurchaseForGooglePlayProof(JSON.parse(JSON.stringify(proof))),{code:'play_proof'});
 await assert.rejects(f.verifier.inspectForNotification({purchaseToken:f.input.purchaseToken,productId:'rig_credit_25'}),{code:'play_product'});
 const missing=await purchaseFixture({mutate:body=>{delete body.obfuscatedExternalAccountId}});await assert.rejects(missing.verifier.inspectForNotification({purchaseToken:missing.input.purchaseToken}),{code:'play_account'});
});
test('pending/cancelled notification lookups still require Google test/live separation',async()=>{
 const f=await purchaseFixture({mutate:body=>{body.testPurchaseContext={fopType:'TEST'};body.purchaseStateContext.purchaseState='CANCELLED';}});
 await assert.rejects(f.verifier.inspectForNotification({purchaseToken:f.input.purchaseToken}),{code:'play_environment'});
});
test('notification lookup exposes only validated provider order ID, nullable if absent; caller cannot inject an order',async()=>{
 for(const orderId of [undefined,'GPA.fixture-verified-order']){
  const f=await purchaseFixture({mutate:body=>{if(orderId!==undefined)body.orderId=orderId}}),proof=await f.verifier.inspectForNotification({purchaseToken:f.input.purchaseToken});
  assert.equal(notificationPurchaseForGooglePlayProof(proof).orderId,orderId??null);
  await assert.rejects(f.verifier.inspectForNotification({purchaseToken:f.input.purchaseToken,orderId:'GPA.client-injected'}),{code:'play_input'});
 }
 for(const orderId of ['',null,123,'x'.repeat(513),'GPA.bad\norder']){
  const f=await purchaseFixture({mutate:body=>{body.orderId=orderId}});
  await assert.rejects(f.verifier.inspectForNotification({purchaseToken:f.input.purchaseToken}),{code:'play_response'});
  await assert.rejects(f.verifier.inspect(f.input),{code:'play_response'});
 }
});
test('server consumption requires a fresh inspection; uncertain old write is reconciled through a new Google read',async()=>{
 const f=await purchaseFixture();let at=now;
 const verifier=createGooglePlayPurchaseVerifier({enabled:true,mode:'live',accountKey:key,siteId,catalog,now:()=>at,getAccessToken:async()=> 'fixture_access_token_123456789',network:async(url,options)=>{
  f.calls.push({url,method:options.method});return options.method==='POST'?new Response(null,{status:204}):Response.json(f.body);
 }});
 const proof=await verifier.verify(f.input),r=receiptForGooglePlayProof(proof),entitlement={state:'credited',tokenHash:r.tokenHash,userId:USER,creditsCents:500,eventId:'google-play:'+r.tokenHash};
 at+=60001;await assert.rejects(verifier.consume(proof,entitlement),{code:'play_consume_reinspect'});assert.equal(f.calls.filter(x=>x.method==='POST').length,0);
 const fresh=await verifier.verify(f.input);assert.equal((await verifier.consume(fresh,entitlement)).state,'consumed');assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
});


test('a stored owned intent binding survives server HMAC rotation without accepting a browser account override',async()=>{
 const f=await purchaseFixture();
 const verifier=createGooglePlayPurchaseVerifier({enabled:true,mode:'live',accountKey:key+'-rotated',siteId,catalog,now:()=>now,getAccessToken:async()=> 'fixture_access_token_123456789',network:async()=>Response.json(f.body)});
 await assert.rejects(verifier.inspect(f.input),{code:'play_account'});
 const p=await verifier.inspectOwned(f.input,{accountId:f.accountId});assert.equal(purchaseForGooglePlayProof(p).accountId,f.accountId);assert.equal(purchaseForGooglePlayProof(p).userId,USER);
 await assert.rejects(verifier.inspectOwned({...f.input,accountId:f.accountId},{accountId:f.accountId}),{code:'play_input'});
 await assert.rejects(verifier.inspectOwned(f.input,{accountId:'a'.repeat(64)}),{code:'play_account'});
 await assert.rejects(verifier.inspectOwned(f.input,{accountId:f.accountId,mode:'test'}),{code:'play_binding'});
});
