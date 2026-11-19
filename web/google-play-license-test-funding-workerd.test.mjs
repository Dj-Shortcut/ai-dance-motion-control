// A physically separate synthetic D1. No Google/Fal network and no real money.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGooglePlayFulfillmentStore} from './google-play-fulfillment-store.mjs';
import {createGooglePlayPurchaseVerifier,googlePlayAccountId} from './google-play-purchases.mjs';
import {prepareGooglePlayLicenseTestFunding} from './google-play-license-test-funding.mjs';
import {googlePlayFulfillmentFixture,USER,OTHER,sealedToken,financial} from './google-play-fulfillment-fixture.mjs';
const key='fixture-license-binding-key-never-real-secret',siteId='appgprj_fixture_rig';
const catalog=[{productId:'rig_credit_5',creditsCents:500},{productId:'rig_credit_10',creditsCents:1000},{productId:'rig_credit_25',creditsCents:2500}];
async function testEnvironment(){
 const f=await googlePlayFulfillmentFixture();await f.db.prepare("UPDATE rig_payment_environment SET mode='test'").run();const store=createGooglePlayFulfillmentStore(f.db,{mode:'test'});
 async function activate(){await f.db.prepare('UPDATE rig_google_play_test_policy SET enabled=1,budget_credit_cents=500,allowed_users_json=?,expires_at=? WHERE id=1').bind(JSON.stringify([USER]),Date.now()+86400000).run();}
 const snapshot=()=>prepareGooglePlayLicenseTestFunding({DB:f.db});
 const accountId=await googlePlayAccountId({key,userId:USER,siteId,mode:'test'});
 const prepare=async(userId=USER)=>store.prepareIntent({userId,requestId:crypto.randomUUID(),productId:'rig_credit_5',creditsCents:500,accountId:await googlePlayAccountId({key,userId,siteId,mode:'test'}),funding:await snapshot()});
 async function proof({token='fixture-license-token-1234567890',consumed=false,refunded=false}={}){
  const body={kind:'androidpublisher#productPurchaseV2',obfuscatedExternalAccountId:accountId,purchaseStateContext:{purchaseState:'PURCHASED'},testPurchaseContext:{fopType:'TEST'},productLineItem:[{productId:'rig_credit_5',productOfferDetails:{quantity:1,refundableQuantity:refunded?0:1,consumptionState:consumed?'CONSUMPTION_STATE_CONSUMED':'CONSUMPTION_STATE_YET_TO_BE_CONSUMED'}}],purchaseCompletionTime:new Date(Date.now()-20).toISOString(),acknowledgementState:consumed?'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED':'ACKNOWLEDGEMENT_STATE_PENDING',orderId:financial.orderId};
  const verifier=createGooglePlayPurchaseVerifier({enabled:true,mode:'test',accountKey:key,siteId,catalog,getAccessToken:async()=> 'fixture_google_license_access_123456789',network:async()=>Response.json(body)});
  return verifier.inspect({userId:USER,productId:'rig_credit_5',purchaseToken:token});
 }
 return {...f,store,activate,snapshot,prepareTest:prepare,testProof:proof};
}
test('license funding refuses live databases and disabled/expired test policy, with no Fal read',async()=>{
 const live=await googlePlayFulfillmentFixture();try{await assert.rejects(prepareGooglePlayLicenseTestFunding({DB:live.db}),{code:'play_license_test_setup'});assert.equal(live.calls.length,0);}finally{await live.mf.dispose()}
 const f=await testEnvironment();try{
  await assert.rejects(f.snapshot(),{code:'play_license_test_setup'});await f.activate();const funded=await f.snapshot();assert.equal(funded.before.length,1);assert.equal(f.calls.length,0);
  await f.db.prepare('UPDATE rig_google_play_test_policy SET expires_at=?').bind(Date.now()-1).run();await assert.rejects(f.snapshot(),{code:'play_license_test_setup'});
 }finally{await f.mf.dispose()}
});
test('test policy is capped, allowlisted and serialized without enabling a live funding bypass',async()=>{
 const f=await testEnvironment();try{
  await f.activate();await assert.rejects(f.db.prepare('UPDATE rig_google_play_test_policy SET budget_credit_cents=10001').run());
  await assert.rejects(f.prepareTest(OTHER),{code:'play_funding_unavailable'});const a=await f.prepareTest();assert.equal(a.state,'prepared');assert.equal((await f.db.prepare('SELECT committed_credit_cents n FROM rig_google_play_test_exposure').first()).n,500);assert.equal(f.calls.length,0);
  await f.db.prepare("UPDATE rig_payment_environment SET mode='live'").run();await assert.rejects(f.snapshot(),{code:'play_license_test_setup'});assert.equal(await f.store.schemaReady(),false);
 }finally{await f.mf.dispose()}
});
test('test allowance counts cumulative claims, so spending or refunding test credit never recycles the budget',async()=>{
 const f=await testEnvironment();try{
  await f.activate();const i=await f.prepareTest(),proof=await f.testProof();const credited=await f.store.applyVerifiedPurchase({intentId:i.intentId,proof,sealedToken,funding:await f.snapshot(),creditAllowed:true,financial});assert.equal(credited.state,'credited');
  const consumed=await f.testProof({consumed:true});await f.store.recordConsumed({proof:consumed});await f.db.prepare("INSERT INTO rig_ledger(event_id,user_id,delta) VALUES('test-only-spend',?,-500)").bind(USER).run();
  await assert.rejects(f.prepareTest(),{code:'play_funding_unavailable'});const reversed=await f.testProof({consumed:true,refunded:true});await f.store.observeVerifiedPurchase({intentId:i.intentId,proof:reversed,sealedToken});await f.db.prepare('DELETE FROM rig_frozen_accounts WHERE user_id=?').bind(USER).run();
  assert.equal((await f.db.prepare('SELECT committed_credit_cents n FROM rig_google_play_test_exposure').first()).n,500);await assert.rejects(f.prepareTest(),{code:'play_funding_unavailable'});assert.equal(f.calls.length,0);
 }finally{await f.mf.dispose()}
});
