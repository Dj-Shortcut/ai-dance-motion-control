import test from 'node:test';
import assert from 'node:assert/strict';
import {createGooglePlayLicenseTestHarness,googlePlayLicenseFinancialDecision} from './google-play-license-harness.mjs';
import {createGooglePlayPublisherClient} from './google-play-publisher.mjs';
import {googlePlaySalePolicy} from './google-play-financial.mjs';
import {playSha256} from './google-play-provider-common.mjs';
import {USER,OTHER,now} from './google-play-test-fixture.mjs';
const testDatabaseId='11111111-1111-4111-8111-111111111111',productionDatabaseId='22222222-2222-4222-8222-222222222222';
// Synthetic prices exercise the contract; they are not an approved store catalog.
const prices={version:'rig-play-prices-v1',currency:'EUR',products:[{productId:'rig_credit_5',creditsCents:500,priceCents:899},{productId:'rig_credit_10',creditsCents:1000,priceCents:1799},{productId:'rig_credit_25',creditsCents:2500,priceCents:4499}]};
function fixture({mode='test',enabled=1}={}){
 let calls=0,secretReads=0;
 const testDB={prepare(sql){return {first:async()=>sql.includes('rig_payment_environment')?{mode}:{enabled,budget_credit_cents:1000,allowed_users_json:JSON.stringify([USER]),expires_at:now+60000}}},batch:async()=>{throw Error('unexpected write')}};
 const options={testDB,testDatabaseId,productionDatabaseId,allowedUserIds:[USER],clock:()=>now,network:async()=>{calls++;throw Error('unexpected network')},limiter:async()=>true,
  providerEnv:{RIG_GOOGLE_PLAY_PROCESSING_ENABLED:'yes',RIG_GOOGLE_PLAY_SALES_ENABLED:'yes',RIG_GOOGLE_PLAY_PRICES:JSON.stringify(prices),RIG_GOOGLE_PLAY_PUBSUB_SUBSCRIPTION:'projects/rig-fixture/subscriptions/rig-push',get GOOGLE_PLAY_SERVICE_ACCOUNT_JSON(){secretReads++;return 'fixture'}}};
 return {options,get calls(){return calls},get secretReads(){return secretReads}};
}
test('private license harness guards physical test realm, policy, operator and path before credentials or network',async()=>{
 const same=fixture();assert.throws(()=>createGooglePlayLicenseTestHarness({...same.options,productionDatabaseId:testDatabaseId}),{code:'play_license_setup'});assert.equal(same.secretReads,0);
 for(const setup of [{mode:'live'},{enabled:0}]){
  const f=fixture(setup),h=createGooglePlayLicenseTestHarness(f.options);
  await assert.rejects(h.request({userId:USER,path:'/api/payments/google-play/config'}));assert.equal(f.secretReads,0);assert.equal(f.calls,0);assert.equal(Object.hasOwn(h,'fetch'),false);
 }
 const f=fixture(),h=createGooglePlayLicenseTestHarness(f.options);
 await assert.rejects(h.request({userId:OTHER,path:'/api/payments/google-play/config'}),{code:'play_license_operator'});
 for(const path of ['/api/jobs','/api/payments/mollie','https://evil.invalid/','/api/payments/google-play/config?mode=live'])await assert.rejects(h.request({userId:USER,path}),{code:'play_license_path'});
 assert.equal(f.secretReads,0);assert.equal(f.calls,0);
 const configured=createGooglePlayLicenseTestHarness({...f.options,adapters:{oauth:{},verifier:{accountId:async()=> 'a'.repeat(64)},vault:{},publisher:{},push:{},store:{schemaReady:async()=>true}}});
 const response=await configured.request({userId:USER,path:'/api/payments/google-play/config'}),config=await response.json();assert.equal(response.status,200);assert.equal(config.mode,'test');assert.equal(config.enabled,true);assert.equal(config.accountId,'a'.repeat(64));assert.equal(f.calls,0);
});
test('license financial exception requires actual private test Orders proof; preserves reported zero money and refuses live/partial/missing proof',async()=>{
 const purchaseToken='fixture-license-token',orderId='GPA.fixture-license-1',money={currencyCode:'EUR',units:'0',nanos:0},policy=googlePlaySalePolicy(JSON.stringify(prices)),tokenHash=await playSha256(purchaseToken);
 async function proof({mode='test',state='PROCESSED',missingRevenue=false}={}){
  const body={orderId,purchaseToken,state,createTime:new Date(now-1000).toISOString(),lastEventTime:new Date(now).toISOString(),total:money,...(!missingRevenue?{developerRevenueInBuyerCurrency:money}:{}),lineItems:[{productId:'rig_credit_5',oneTimePurchaseDetails:{quantity:1},total:money}]};
  return createGooglePlayPublisherClient({enabled:true,mode,now:()=>now,getAccessToken:async()=> 'fixture-access-token',network:async()=>Response.json(body)}).getOrder({orderId});
 }
 const input={tokenHash,productId:'rig_credit_5',mode:'test',policy},result=googlePlayLicenseFinancialDecision(await proof(),input);
 assert.equal(result.state,'credit');assert.equal(result.record.licenseTest,true);assert.equal(result.record.source,'google_order_v1');assert.deepEqual(result.record.total,money);assert.deepEqual(result.record.developerRevenueInBuyerCurrency,money);assert.equal(result.record.settlementVerified,false);
 assert.throws(()=>googlePlayLicenseFinancialDecision(JSON.parse(JSON.stringify(result)),input),{code:'play_order_proof'});
 const live=await proof({mode:'live'});assert.throws(()=>googlePlayLicenseFinancialDecision(live,input),{code:'play_license_finance'});
 assert.equal(googlePlayLicenseFinancialDecision(await proof({state:'PARTIALLY_REFUNDED'}),input).state,'review');
 assert.equal(googlePlayLicenseFinancialDecision(await proof({missingRevenue:true}),input).state,'review');
});
