// Real isolated D1 transactions and the real verification/vault adapters, with
// synthetic Google/Fal replies only. No credentials or billable calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createGooglePlayCommerce} from './google-play-commerce.mjs';
import {googlePlayAccountId} from './google-play-purchases.mjs';
const USER='u-12345678-1234-4123-8123-123456789abc',OTHER='u-22345678-1234-4123-8123-123456789abc';
const origin='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',bridge='https://rig-api.shortcut-computerguy.workers.dev',site='appgprj_6aeec13b50448191b88da670dac8aa98',accountKey='fixture-account-binding-key-not-real-12345678';
const productId='rig_credit_5',token='fixture-commerce-purchase-token',orderId='GPA.1111-2222-3333-44444';
async function sql(db,file){let pending='',trigger=false;for(const line of (await readFile(new URL(file,import.meta.url),'utf8')).split('\n')){if(/^\s*--/.test(line))continue;pending+=line+'\n';if(/^\s*CREATE TRIGGER/.test(line))trigger=true;if(line.trim().endsWith(';')&&(!trigger||/^\s*END;\s*$/.test(line))){await db.prepare(pending.trim()).run();pending='';trigger=false;}}if(pending.trim())throw Error('incomplete SQL');}
async function fixture(){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:['DB']}),db=await mf.getD1Database('DB');
 await sql(db,'./production-schema.sql');await sql(db,'./production-migrations/0015_funding_coverage.sql');await sql(db,'./production-migrations/0018_google_play_fulfillment.sql');
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();await db.prepare("UPDATE rig_funding_policy SET enabled=1,expected_username='fixture-team' WHERE id=1").run();
 let at=Date.now(),purchasedAt=null,consumed=false,refunded=false,pending=false,orderFailure=false,consumeUncertain=false,balance=100,net='5',priceNanos=990000000,orderState='PROCESSED';
 const calls=[],env={PRODUCTION_DB:db,DB:db,RIG_PRODUCTION_SITE_ID:site,RIG_PRODUCTION_BRIDGE_ORIGIN:bridge,RIG_PUBLIC_ORIGIN:origin,RIG_GOOGLE_PLAY_PROCESSING_ENABLED:'yes',RIG_GOOGLE_PLAY_SALES_ENABLED:'yes',RIG_GOOGLE_PLAY_ACCOUNT_HMAC_KEY:accountKey,RIG_GOOGLE_PLAY_TOKEN_KEY_ID:'fixture1',RIG_GOOGLE_PLAY_TOKEN_KEYS_JSON:JSON.stringify({fixture1:Buffer.alloc(32,7).toString('base64url')}),RIG_GOOGLE_PLAY_PUBSUB_AUDIENCE:bridge+'/api/payments/google-play/rtdn',RIG_GOOGLE_PLAY_PUBSUB_SUBSCRIPTION:'projects/fixture-project/subscriptions/rig-play',RIG_FUNDING_COVERAGE_ENABLED:'yes',FAL_KEY:'fixture-generation-key',RIG_GOOGLE_PLAY_PRICES:JSON.stringify({version:'rig-play-prices-v1',currency:'EUR',products:[{productId,creditsCents:500,priceCents:899},{productId:'rig_credit_10',creditsCents:1000,priceCents:1799},{productId:'rig_credit_25',creditsCents:2500,priceCents:4499}]})};
 const accountId=await googlePlayAccountId({key:accountKey,userId:USER,siteId:site,mode:'live'}),money=(units,nanos=0)=>({currencyCode:'EUR',units,nanos});
 const network=async(url,init={})=>{
  url=String(url);calls.push({url,method:init.method??'GET'});assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');
  if(url==='https://api.fal.ai/v1/account/billing?expand=credits')return Response.json({username:'fixture-team',credits:{currency:'USD',current_balance:balance}});
  assert.ok(url.startsWith('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/dev.andyarijs.rig/'));
  if(url.includes(':consume')){
   assert.equal((await db.prepare('SELECT COALESCE(SUM(delta),0) n FROM rig_ledger WHERE user_id=?').bind(USER).first()).n,500,'consumption must follow the committed wallet credit');consumed=true;if(consumeUncertain){consumeUncertain=false;return Response.json({error:'unknown'},{status:503})}return new Response(null,{status:204});
  }
  if(url.includes(':refund?')){refunded=true;return new Response(null,{status:204});}
  if(url.includes('/purchases/voidedpurchases'))return Response.json({});
  if(url.includes('/orders/')){
   if(orderFailure){orderFailure=false;return Response.json({error:'temporary'},{status:503});}
   return Response.json({orderId,purchaseToken:token,state:refunded?'REFUNDED':orderState,createTime:new Date(purchasedAt??at).toISOString(),lastEventTime:new Date(at).toISOString(),total:money('8',priceNanos),tax:money('1',560330579),developerRevenueInBuyerCurrency:money(net,200000000),lineItems:[{productId,total:money('8',priceNanos),oneTimePurchaseDetails:{quantity:1}}]});
  }
  purchasedAt??=at;
  return Response.json({kind:'androidpublisher#productPurchaseV2',obfuscatedExternalAccountId:accountId,purchaseStateContext:{purchaseState:pending?'PENDING':'PURCHASED'},productLineItem:[{productId,productOfferDetails:{quantity:1,refundableQuantity:refunded?0:1,consumptionState:consumed?'CONSUMPTION_STATE_CONSUMED':'CONSUMPTION_STATE_YET_TO_BE_CONSUMED'}}],...(pending?{}:{purchaseCompletionTime:new Date(purchasedAt).toISOString()}),acknowledgementState:'ACKNOWLEDGEMENT_STATE_PENDING',orderId});
 };
 const commerce=createGooglePlayCommerce({network,clock:()=>at,tenant:async()=>({DB:db,RIG_PUBLIC_ORIGIN:origin}),limiter:async()=>true,adapters:{oauth:{getAccessToken:async()=> 'fixture_access_token_123456789'},push:{verifyAuthorization:async value=>{if(value!=='Bearer fixture-signed')throw Error('invalid')}}}});
 async function request(path,{user=USER,body,method=body?'POST':'GET'}={}){return commerce.handleUser(new Request(origin+'/api/payments/google-play/'+path,{method,headers:{origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env,{userId:user});}
 async function prepare(){const id=crypto.randomUUID(),res=await request('intents',{body:{productId,requestId:id}});assert.equal(res.status,201,await res.clone().text());return {id,intent:await res.json()};}
 const confirm=id=>request('confirm',{body:{intentId:id,productId,purchaseToken:token}});
 return {mf,db,env,commerce,request,prepare,confirm,calls,advance:n=>{at+=n;},dueNow:async()=>{at=Date.now();await db.prepare('UPDATE rig_google_play_receipts SET next_check_at=1').run();await db.prepare('UPDATE rig_google_play_attempts SET next_check_at=1').run();},set:opts=>{if('pending'in opts)pending=opts.pending;if('orderFailure'in opts)orderFailure=opts.orderFailure;if('consumeUncertain'in opts)consumeUncertain=opts.consumeUncertain;if('balance'in opts)balance=opts.balance;if('net'in opts)net=opts.net;if('orderState'in opts)orderState=opts.orderState;},balance:async()=> (await db.prepare('SELECT COALESCE(SUM(delta),0) n FROM rig_ledger WHERE user_id=?').bind(USER).first()).n};
}
test('Google verified purchase credits exactly once before server consumption; recovery does not create Mollie orders',async()=>{
 const f=await fixture();try{
  const config=await (await f.request('config')).json();assert.equal(config.enabled,true);assert.equal(config.recoveryReady,true);assert.equal(config.products[0].priceCents,899);assert.match(config.accountId,/^[a-f0-9]{64}$/);
  const {id}=await f.prepare();f.advance(1);const res=await f.confirm(id);assert.equal(res.status,200,await res.clone().text());const result=await res.json();assert.equal(result.state,'credited');assert.equal(result.consumed,true);assert.equal(result.newPurchasesBlocked,false);assert.equal(await f.balance(),500);
  assert.equal((await f.confirm(id)).status,200);assert.equal(await f.balance(),500);assert.equal(f.calls.filter(c=>c.url.includes(':consume')).length,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_orders').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_google_play_credit_claims').first()).n,1);
  assert.equal((await f.request('status?intentId='+id,{user:OTHER})).status,200);assert.deepEqual(await (await f.request('status?intentId='+id,{user:OTHER})).json(),{intent:null});
  const serialized=JSON.stringify(await (await f.request('status?intentId='+id)).json());assert.doesNotMatch(serialized,/sealed_token|purchase-token|GPA\.|fixture-generation-key/);
 }finally{await f.mf.dispose()}
});
test('paid purchase survives a failed financial read and disabling sales, then cron grants and consumes it',async()=>{
 const f=await fixture();try{
  const {id}=await f.prepare();f.set({orderFailure:true});assert.equal((await f.confirm(id)).status,202);assert.equal(await f.balance(),0);f.env.RIG_GOOGLE_PLAY_SALES_ENABLED='no';await f.dueNow();
  const config=await (await f.request('config')).json();assert.equal(config.enabled,false);assert.equal(config.recoveryReady,true);
  const stats=await f.commerce.collect(f.env,{limit:2});assert.equal(stats.unavailable,0);assert.equal(await f.balance(),500);assert.equal((await (await f.request('status?intentId='+id)).json()).intent.consumed,true);
  const blocked=await f.request('intents',{body:{productId,requestId:crypto.randomUUID()}});assert.equal(blocked.status,503);
 }finally{await f.mf.dispose()}
});
test('pending payment gives no credit, then completes automatically with exactly one ledger event',async()=>{
 const f=await fixture();try{
  f.set({pending:true});const {id}=await f.prepare();const res=await f.confirm(id);assert.equal((await res.json()).state,'pending');assert.equal(await f.balance(),0);assert.equal(f.calls.some(c=>c.method==='POST'),false);
  f.set({pending:false});await f.dueNow();await f.commerce.collect(f.env,{limit:2});assert.equal(await f.balance(),500);assert.equal(f.calls.filter(c=>c.url.includes(':consume')).length,1);
 }finally{await f.mf.dispose()}
});
test('an uncertain consumption reply is reconciled by reading Google, without a second charge or consume',async()=>{
 const f=await fixture();try{
  f.set({consumeUncertain:true});const {id}=await f.prepare();const first=await (await f.confirm(id)).json();assert.equal(first.state,'credited');assert.equal(first.recoveryPending,true);assert.equal(await f.balance(),500);await f.dueNow();await f.commerce.collect(f.env,{limit:2});assert.equal((await (await f.request('status?intentId='+id)).json()).intent.consumed,true);assert.equal(f.calls.filter(c=>c.url.includes(':consume')).length,1);assert.equal(await f.balance(),500);
 }finally{await f.mf.dispose()}
});
test('a valid paid offer that does not cover issued credit is explicitly refunded, never consumed or minted',async()=>{
 const f=await fixture();try{
  f.set({net:'4'});const {id}=await f.prepare();const res=await f.confirm(id);assert.equal(res.status,202,await res.clone().text());assert.equal((await res.json()).state,'refunded');assert.equal(await f.balance(),0);assert.equal(f.calls.filter(c=>c.url.includes(':refund?')).length,1);assert.equal(f.calls.some(c=>c.url.includes(':consume')),false);assert.equal((await f.confirm(id)).status,202);assert.equal(f.calls.filter(c=>c.url.includes(':refund?')).length,1);
 }finally{await f.mf.dispose()}
});
test('only an authenticated Google notification is durably queued; its body alone never credits',async()=>{
 const f=await fixture();try{
  const {id}=await f.prepare(),envelope={subscription:f.env.RIG_GOOGLE_PLAY_PUBSUB_SUBSCRIPTION,message:{messageId:'fixture-message-1',data:Buffer.from(JSON.stringify({version:'1.0',packageName:'dev.andyarijs.rig',eventTimeMillis:String(Date.now()),oneTimeProductNotification:{version:'1.0',notificationType:1,sku:productId,purchaseToken:token}})).toString('base64')}};
  const req=auth=>new Request(bridge+'/api/payments/google-play/rtdn',{method:'POST',headers:{'content-type':'application/json',authorization:auth},body:JSON.stringify(envelope)});
  assert.equal((await f.commerce.handleNotification(req('Bearer attacker'),f.env)).status,401);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_google_play_notifications').first()).n,0);
  assert.equal((await f.commerce.handleNotification(req('Bearer fixture-signed'),f.env)).status,200);assert.equal(await f.balance(),0);const row=await f.db.prepare('SELECT * FROM rig_google_play_notifications').first();assert.doesNotMatch(JSON.stringify(row),new RegExp(token));assert.equal(row.state,'queued');
  const stats=await f.commerce.collect(f.env,{limit:2});assert.equal(stats.unavailable,0);assert.equal(await f.balance(),500);assert.equal((await (await f.request('status?intentId='+id)).json()).intent.state,'credited');
 }finally{await f.mf.dispose()}
});
test('a partial refund after consumption remains durable review and blocks spending without clawing back the entire credit',async()=>{
 const f=await fixture();try{
  const {id}=await f.prepare();assert.equal((await f.confirm(id)).status,200);f.set({orderState:'PARTIALLY_REFUNDED'});
  const envelope={subscription:f.env.RIG_GOOGLE_PLAY_PUBSUB_SUBSCRIPTION,message:{messageId:'fixture-partial-refund',data:Buffer.from(JSON.stringify({version:'1.0',packageName:'dev.andyarijs.rig',eventTimeMillis:String(Date.now()),voidedPurchaseNotification:{productType:2,refundType:2,orderId,purchaseToken:token}})).toString('base64')}};
  const response=await f.commerce.handleNotification(new Request(bridge+'/api/payments/google-play/rtdn',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture-signed'},body:JSON.stringify(envelope)}),f.env);assert.equal(response.status,200);
  const stats=await f.commerce.collect(f.env,{limit:2});assert.equal(stats.unavailable,1);assert.equal(await f.balance(),500,'a monetary partial refund is not proof that every purchased credit was reversed');
  assert.equal((await f.db.prepare('SELECT state FROM rig_google_play_receipts').first()).state,'review');assert.ok(await f.db.prepare('SELECT reason FROM rig_frozen_accounts WHERE user_id=?').bind(USER).first());assert.equal((await f.db.prepare('SELECT state FROM rig_google_play_notifications').first()).state,'queued','the last partial-refund notification must not be lost');assert.equal(f.calls.filter(c=>c.url.includes(':consume')).length,1);
 }finally{await f.mf.dispose()}
});
test('a genuine Google payment without a deliverable RIG intent is refunded to its original payer, never stranded or credited',async()=>{
 const f=await fixture();try{
  const envelope={subscription:f.env.RIG_GOOGLE_PLAY_PUBSUB_SUBSCRIPTION,message:{messageId:'fixture-orphan-purchase',data:Buffer.from(JSON.stringify({version:'1.0',packageName:'dev.andyarijs.rig',eventTimeMillis:String(Date.now()),oneTimeProductNotification:{version:'1.0',notificationType:1,sku:productId,purchaseToken:token}})).toString('base64')}};
  const req=()=>new Request(bridge+'/api/payments/google-play/rtdn',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture-signed'},body:JSON.stringify(envelope)});
  assert.equal((await f.commerce.handleNotification(req(),f.env)).status,200);const first=await f.commerce.collect(f.env,{limit:2});assert.equal(first.unavailable,0);assert.equal(first.notifications,1);assert.equal(await f.balance(),0);assert.equal(f.calls.filter(c=>c.url.includes(':refund?')).length,1);assert.equal(f.calls.some(c=>c.url.includes(':consume')),false);
  assert.equal((await f.db.prepare('SELECT state FROM rig_google_play_notifications').first()).state,'complete');assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_google_play_receipts').first()).n,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM rig_orders').first()).n,0);
  assert.equal((await f.commerce.handleNotification(req(),f.env)).status,200);await f.commerce.collect(f.env,{limit:2});assert.equal(f.calls.filter(c=>c.url.includes(':refund?')).length,1);assert.equal(await f.balance(),0);
 }finally{await f.mf.dispose()}
});
