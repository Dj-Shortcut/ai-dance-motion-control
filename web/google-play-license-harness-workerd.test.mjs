// Actual isolated D1, actual controller/verifier/vault/publisher, mocked Google
// replies. No real credential, Google purchase, Fal call or production binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGooglePlayLicenseTestHarness} from './google-play-license-harness.mjs';
import {googlePlayAccountId} from './google-play-purchases.mjs';
import {googlePlayFulfillmentFixture,USER,OTHER} from './google-play-fulfillment-fixture.mjs';

test('real D1 license harness credits zero-money Google test purchase once, then consumes server-side within the separate lifetime budget',async()=>{
 const f=await googlePlayFulfillmentFixture();try{
  await f.db.prepare("UPDATE rig_payment_environment SET mode='test'").run();const at=Date.now();
  await f.db.prepare('UPDATE rig_google_play_test_policy SET enabled=1,budget_credit_cents=500,allowed_users_json=?,expires_at=? WHERE id=1').bind(JSON.stringify([USER]),at+86400000).run();
  const accountKey='fixture-license-harness-account-key-not-real',siteId='appgprj_fixture_rig',productId='rig_credit_5',token='fixture-license-harness-purchase-token',orderId='GPA.1234-5678-9012-34567';
  const accountId=await googlePlayAccountId({key:accountKey,userId:USER,siteId,mode:'test'}),zero={currencyCode:'EUR',units:'0',nanos:0},calls=[];let consumed=false;
  const network=async(url,init={})=>{
   url=String(url);assert.ok(url.startsWith('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/dev.andyarijs.rig/'),'only the synthetic Google transport is reachable');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'manual');calls.push({url,method:init.method});
   if(url.endsWith(':consume')){assert.equal((await f.db.prepare('SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?').bind(USER).first()).n,500,'durable wallet credit must precede consumption');consumed=true;return new Response(null,{status:204});}
   if(url.includes('/orders/'))return Response.json({orderId,purchaseToken:token,state:'PROCESSED',createTime:new Date(at).toISOString(),lastEventTime:new Date(at).toISOString(),total:zero,tax:zero,developerRevenueInBuyerCurrency:zero,lineItems:[{productId,total:zero,oneTimePurchaseDetails:{quantity:1}}]});
   return Response.json({kind:'androidpublisher#productPurchaseV2',obfuscatedExternalAccountId:accountId,purchaseStateContext:{purchaseState:'PURCHASED'},testPurchaseContext:{fopType:'TEST'},productLineItem:[{productId,productOfferDetails:{quantity:1,refundableQuantity:1,consumptionState:consumed?'CONSUMPTION_STATE_CONSUMED':'CONSUMPTION_STATE_YET_TO_BE_CONSUMED'}}],purchaseCompletionTime:new Date(at).toISOString(),acknowledgementState:consumed?'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED':'ACKNOWLEDGEMENT_STATE_PENDING',orderId});
  };
  const prices={version:'rig-play-prices-v1',currency:'EUR',products:[{productId,creditsCents:500,priceCents:899},{productId:'rig_credit_10',creditsCents:1000,priceCents:1799},{productId:'rig_credit_25',creditsCents:2500,priceCents:4499}]};
  const harness=createGooglePlayLicenseTestHarness({testDB:f.db,testDatabaseId:'11111111-1111-4111-8111-111111111111',productionDatabaseId:'22222222-2222-4222-8222-222222222222',allowedUserIds:[USER],clock:()=>at,network,limiter:async()=>true,adapters:{oauth:{getAccessToken:async()=> 'fixture_license_access_token_123456789'}},providerEnv:{RIG_GOOGLE_PLAY_PROCESSING_ENABLED:'yes',RIG_GOOGLE_PLAY_SALES_ENABLED:'yes',RIG_PRODUCTION_SITE_ID:siteId,RIG_GOOGLE_PLAY_ACCOUNT_HMAC_KEY:accountKey,RIG_GOOGLE_PLAY_TOKEN_KEY_ID:'fixture1',RIG_GOOGLE_PLAY_TOKEN_KEYS_JSON:JSON.stringify({fixture1:Buffer.alloc(32,7).toString('base64url')}),RIG_GOOGLE_PLAY_PUBSUB_EMAIL:'fixture-push@fixture-project.iam.gserviceaccount.com',RIG_GOOGLE_PLAY_PUBSUB_SUBSCRIPTION:'projects/fixture-project/subscriptions/rig-play',RIG_GOOGLE_PLAY_PRICES:JSON.stringify(prices)}});
  const request=(path,body)=>harness.request({userId:USER,path:'/api/payments/google-play/'+path,...(body?{method:'POST',body}:{})});
  const config=await (await request('config')).json();assert.equal(config.enabled,true);assert.equal(config.mode,'test');assert.equal(config.accountId,accountId);assert.equal(calls.length,0);
  const intentId=crypto.randomUUID(),prepared=await request('intents',{productId,requestId:intentId});assert.equal(prepared.status,201,await prepared.clone().text());
  const confirmed=await request('confirm',{intentId,productId,purchaseToken:token});assert.equal(confirmed.status,200,await confirmed.clone().text());const result=await confirmed.json();assert.equal(result.state,'credited');assert.equal(result.consumed,true);
  assert.equal((await request('confirm',{intentId,productId,purchaseToken:token})).status,200);assert.equal((await f.db.prepare('SELECT SUM(delta) n FROM rig_ledger WHERE user_id=?').bind(USER).first()).n,500);assert.equal(calls.filter(c=>c.url.endsWith(':consume')).length,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_orders').first()).n,0);
  const recorded=JSON.parse((await f.db.prepare('SELECT finance_json FROM rig_google_play_credit_claims').first()).finance_json);assert.equal(recorded.licenseTest,true);assert.deepEqual(recorded.total,zero);assert.deepEqual(recorded.developerRevenueInBuyerCurrency,zero);
  assert.equal((await request('intents',{productId,requestId:crypto.randomUUID()})).status,503,'the fixed lifetime allowance cannot be recycled');assert.equal(f.calls.length,0,'no Fal transport was used');
  await assert.rejects(harness.request({userId:OTHER,path:'/api/payments/google-play/config'}),{code:'play_license_operator'});
  await f.db.prepare("UPDATE rig_payment_environment SET mode='live'").run();await assert.rejects(request('config'),{code:'play_license_isolation'});assert.equal(Object.hasOwn(harness,'fetch'),false);
 }finally{await f.mf.dispose()}
});
