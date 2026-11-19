// Provider fixtures only. No real Google credential, API or purchase is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGooglePlayPurchaseVerifier,googlePlayAccountId,googlePlayCatalog,receiptForGooglePlayProof,GOOGLE_PLAY_PACKAGE} from './google-play-purchases.mjs';
import {USER,OTHER,now,key,siteId,token,catalog,purchaseFixture} from './google-play-test-fixture.mjs';

test('Google foundation is disabled by default without consulting credentials or network',async()=>{
 const v=createGooglePlayPurchaseVerifier({network:()=>{throw Error('unexpected network')}});assert.equal(v.enabled,false);
 await assert.rejects(v.verify({}),{code:'play_setup'});await assert.rejects(v.accountId(USER),{code:'play_setup'});
});
test('catalog is bounded and server-owned; credit amounts cannot be supplied by a client',()=>{
 assert.equal(googlePlayCatalog(catalog).length,3);
 for(const value of [[],catalog.slice(1),[...catalog,catalog[0]],catalog.map((p,i)=>i? p:{...p,creditsCents:500000}),catalog.map((p,i)=>i? p:{...p,price:5})])assert.throws(()=>googlePlayCatalog(value),{code:'play_catalog'});
});
test('account binding is private, stable, mode/site/user separated, and exactly 64 hex characters',async()=>{
 const a=await googlePlayAccountId({key,userId:USER,siteId,mode:'live'});assert.match(a,/^[a-f0-9]{64}$/);
 for(const delta of [{userId:OTHER},{siteId:siteId+'_other'},{mode:'test'},{key:key+'other'}])assert.notEqual(await googlePlayAccountId({key,userId:USER,siteId,mode:'live',...delta}),a);
 assert.equal(await googlePlayAccountId({key,userId:USER,siteId,mode:'live'}),a);
 await assert.rejects(googlePlayAccountId({key:'short',userId:USER,siteId,mode:'live'}),{code:'play_binding'});
});
test('only a strict completed Google purchase produces an immutable verified receipt and no orderId requirement',async()=>{
 const f=await purchaseFixture(),proof=await f.verifier.verify(f.input),r=receiptForGooglePlayProof(proof);
 assert.equal(proof.state,'verified');assert.equal(r.creditsCents,500);assert.equal(r.userId,USER);assert.equal(r.orderId,null);assert.match(r.tokenHash,/^[a-f0-9]{64}$/);assert.equal(r.consumed,false);assert.equal(Object.isFrozen(r),true);
 assert.doesNotMatch(JSON.stringify(proof),/purchase-token|access_token|binding-key/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');
 assert.throws(()=>receiptForGooglePlayProof(JSON.parse(JSON.stringify(proof))),{code:'play_proof'});
});
test('pending and cancelled purchases never create an entitlement capability',async()=>{
 for(const state of ['PENDING','CANCELLED']){
  const f=await purchaseFixture({mutate:b=>{b.purchaseStateContext.purchaseState=state;delete b.purchaseCompletionTime;b.productLineItem[0].productOfferDetails.refundableQuantity=0;}});
  const proof=await f.verifier.verify(f.input);assert.equal(proof.state,state.toLowerCase());assert.throws(()=>receiptForGooglePlayProof(proof),{code:'play_proof'});
 }
});
test('wrong user, SKU, quantity, refunded quantity, unknown state and unknown acknowledgement fail closed',async()=>{
 const mutations=[b=>{b.obfuscatedExternalAccountId='a'.repeat(64)},b=>{b.productLineItem[0].productId='rogue_credit'},b=>{b.productLineItem.push(b.productLineItem[0])},b=>{b.productLineItem[0].productOfferDetails.quantity=2},b=>{b.productLineItem[0].productOfferDetails.refundableQuantity=0},b=>{b.productLineItem[0].productOfferDetails.rentOfferDetails={}},b=>{b.productLineItem[0].productOfferDetails.preorderOfferDetails={}},b=>{b.productLineItem[0].productOfferDetails.consumptionState='unknown'},b=>{b.purchaseStateContext.purchaseState='unspecified'},b=>{b.acknowledgementState='unknown'},b=>{b.purchaseCompletionTime='2099-01-01T00:00:00Z'}];
 for(const mutate of mutations){const f=await purchaseFixture({mutate});await assert.rejects(f.verifier.verify(f.input));assert.equal(f.calls.length,1);}
});
test('test purchases are physically distinguishable and cannot mint live receipt proofs',async()=>{
 const live=await purchaseFixture({mutate:b=>{b.testPurchaseContext={fopType:'TEST'}}});await assert.rejects(live.verifier.verify(live.input),{code:'play_environment'});
 const testMode=await purchaseFixture({mode:'test'});assert.equal(receiptForGooglePlayProof(await testMode.verifier.verify(testMode.input)).mode,'test');
 const fake=await purchaseFixture({mode:'test',mutate:b=>{delete b.testPurchaseContext}});await assert.rejects(fake.verifier.verify(fake.input),{code:'play_environment'});
});
test('browser input cannot inject user, amounts, unknown products or an oversized token',async()=>{
 const f=await purchaseFixture();
 for(const delta of [{creditsCents:500000},{userId:'attacker'},{productId:'unknown'},{purchaseToken:'a'.repeat(4097)},{purchaseToken:token+'\n'}])await assert.rejects(f.verifier.verify({...f.input,...delta}),{code:'play_input'});
 assert.equal(f.calls.length,0);
});
test('token characters are encoded as one opaque path segment, never a URL/query override',async()=>{
 const f=await purchaseFixture();await f.verifier.verify({...f.input,purchaseToken:'opaque/../token?test=1#fragment'});
 assert.ok(f.calls[0].url.endsWith('opaque%2F..%2Ftoken%3Ftest%3D1%23fragment'));assert.equal(new URL(f.calls[0].url).search,'');
});
test('redirects, errors, non-JSON and oversized responses cannot produce proof or leak raw token',async()=>{
 const responses=[()=>new Response(null,{status:302,headers:{location:'https://attacker.invalid/'}}),()=>Response.json({error:token},{status:401}),()=>new Response('{}',{headers:{'content-type':'text/html'}}),()=>new Response('a'.repeat(32769),{headers:{'content-type':'application/json'}}),()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'999999'}})];
 for(const response of responses){const f=await purchaseFixture({response});await assert.rejects(f.verifier.verify(f.input),e=>!String(e).includes(token));}
 const f=await purchaseFixture({networkError:true});await assert.rejects(f.verifier.verify(f.input),e=>e.code==='play_provider'&&!String(e).includes(token));
});
test('consume requires exact durable entitlement and runs at most once per proof',async()=>{
 const f=await purchaseFixture(),proof=await f.verifier.verify(f.input),r=proof.receipt;
 const entitlement={state:'credited',tokenHash:r.tokenHash,userId:USER,creditsCents:500,eventId:'google-play:'+r.tokenHash};
 for(const delta of [{state:'verified'},{userId:OTHER},{creditsCents:2500},{eventId:'untrusted'}])await assert.rejects(f.verifier.consume(proof,{...entitlement,...delta}),{code:'play_entitlement'});
 assert.equal(f.calls.length,1);assert.equal((await f.verifier.consume(proof,entitlement)).state,'consumed');assert.equal((await f.verifier.consume(proof,entitlement)).state,'already_consumed');assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
});
test('an uncertain consumption write is not repeated blindly; re-verification is required',async()=>{
 const f=await purchaseFixture({consumeResponse:()=>Response.json({error:'uncertain'},{status:503})}),proof=await f.verifier.verify(f.input),r=proof.receipt;
 const credited={state:'credited',tokenHash:r.tokenHash,userId:USER,creditsCents:500,eventId:'google-play:'+r.tokenHash};
 await assert.rejects(f.verifier.consume(proof,credited),{code:'play_consume_uncertain'});await assert.rejects(f.verifier.consume(proof,credited),{code:'play_consume_uncertain'});assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
});
test('a proof minted by another verifier cannot consume through a different account or credential adapter',async()=>{
 const a=await purchaseFixture(),b=await purchaseFixture(),proof=await a.verifier.verify(a.input),r=proof.receipt;
 await assert.rejects(b.verifier.consume(proof,{state:'credited',tokenHash:r.tokenHash,userId:USER,creditsCents:500,eventId:'google-play:'+r.tokenHash}),{code:'play_entitlement'});
 assert.equal(b.calls.length,0);
});
