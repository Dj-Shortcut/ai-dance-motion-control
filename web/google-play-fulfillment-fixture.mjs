// Actual isolated D1 plus synthetic provider reads. Never contacts Google/Fal.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createGooglePlayFulfillmentStore} from './google-play-fulfillment-store.mjs';
import {createGooglePlayPurchaseVerifier,googlePlayAccountId,GOOGLE_PLAY_PACKAGE} from './google-play-purchases.mjs';
import {preparePurchaseFundingSnapshot,prepareFundingAdmission} from './funding-coverage.mjs';
export const USER='u-12345678-1234-4123-8123-123456789abc',OTHER='u-22345678-1234-4123-8123-123456789abc';
const key='fixture-google-binding-key-never-real-secret',siteId='appgprj_fixture_rig';
const catalog=[{productId:'rig_credit_5',creditsCents:500},{productId:'rig_credit_10',creditsCents:1000},{productId:'rig_credit_25',creditsCents:2500}];
export const sealedToken='rig-play-token-v1.fixture.AAAAAAAAAAAAAAAA.'+'B'.repeat(64);
export const financial={version:1,source:'google_order_v1',orderId:'GPA.1234-5678-9012-34567',state:'PROCESSED',currency:'EUR',total:{currencyCode:'EUR',units:'9',nanos:0},developerRevenueInBuyerCurrency:{currencyCode:'EUR',units:'6',nanos:0}};
export async function applySql(db,path){
 const triggers=[],sql=(await readFile(new URL(path,import.meta.url),'utf8')).replace(/^\s*--.*$/gm,'').replace(/CREATE TRIGGER\b[\s\S]*?\n\s*END\s*;/gi,s=>{triggers.push(s);return '';});
 for(const statement of [...sql.split(';').map(s=>s.trim()).filter(Boolean),...triggers])await db.prepare(statement).run();
}
export async function googlePlayFulfillmentFixture({balance=100}={}){
 const mf=new Miniflare({cf:false,modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-01-01',d1Databases:['DB']}),db=await mf.getD1Database('DB');
 await applySql(db,'./production-schema.sql');await applySql(db,'./production-migrations/0015_funding_coverage.sql');
 await db.prepare("INSERT INTO rig_payment_environment VALUES(1,'live')").run();
 await db.prepare("UPDATE rig_funding_policy SET enabled=1,expected_username='fixture-team' WHERE id=1").run();
 const beforeSchema=await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'rig_%' ORDER BY name").all();
 await applySql(db,'./production-migrations/0018_google_play_fulfillment.sql');
 const env={DB:db,FAL_KEY:'fixture-fal-key',RIG_FUNDING_COVERAGE_ENABLED:'yes'},store=createGooglePlayFulfillmentStore(db),calls=[];
 function network(credits=balance){return async(url,init)=>{assert.equal(url,'https://api.fal.ai/v1/account/billing?expand=credits');assert.equal(init.method,'GET');calls.push('fal-read');return Response.json({username:'fixture-team',credits:{current_balance:credits,currency:'USD'}});};}
 const snapshot=credits=>preparePurchaseFundingSnapshot(env,{network:network(credits),now:Date.now()});
 async function prepare({userId=USER,requestId=crypto.randomUUID(),productId='rig_credit_5',creditsCents=500,...rest}={}){
  const accountId=await googlePlayAccountId({key,userId,siteId,mode:'live'});
  return store.prepareIntent({userId,requestId,productId,creditsCents,accountId,funding:await snapshot(),...rest});
 }
 async function inspect({userId=USER,productId='rig_credit_5',token='fixture-purchase-token-'+crypto.randomUUID(),state='PURCHASED',purchasedAt=Date.now()-50,consumed=false,refundableQuantity=1}={}){
  const accountId=await googlePlayAccountId({key,userId,siteId,mode:'live'}),clock=Date.now();
  const resource={kind:'androidpublisher#productPurchaseV2',obfuscatedExternalAccountId:accountId,purchaseStateContext:{purchaseState:state},productLineItem:[{productId,productOfferDetails:{quantity:1,refundableQuantity,consumptionState:consumed?'CONSUMPTION_STATE_CONSUMED':'CONSUMPTION_STATE_YET_TO_BE_CONSUMED'}}],acknowledgementState:consumed?'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED':'ACKNOWLEDGEMENT_STATE_PENDING',orderId:financial.orderId,...(state==='PURCHASED'?{purchaseCompletionTime:new Date(purchasedAt).toISOString()}:{})};
  const verifier=createGooglePlayPurchaseVerifier({enabled:true,mode:'live',accountKey:key,siteId,catalog,now:()=>clock,getAccessToken:async()=> 'fixture_google_access_token_123456789',network:async()=>Response.json(resource)});
  return {proof:await verifier.inspect({userId,productId,purchaseToken:token}),token,verifier};
 }
 async function grant(intentId,proof,options={}){return store.applyVerifiedPurchase({intentId,proof,sealedToken,funding:await snapshot(),creditAllowed:true,financial,...options});}
 async function backdate(id,{expiresAt=Date.now()-1000}={}){await db.prepare('UPDATE rig_google_play_intents SET created_at=?,expires_at=? WHERE id=?').bind(expiresAt-900000,expiresAt,id).run();return expiresAt;}
 async function counts(){return {orders:(await db.prepare('SELECT COUNT(*) n FROM rig_orders').first()).n,ledger:(await db.prepare('SELECT COUNT(*) n FROM rig_ledger').first()).n,claims:(await db.prepare('SELECT COUNT(*) n FROM rig_google_play_credit_claims').first()).n,receipts:(await db.prepare('SELECT COUNT(*) n FROM rig_google_play_receipts').first()).n};}
 return {mf,db,env,store,prepare,inspect,grant,snapshot,network,backdate,counts,beforeSchema:beforeSchema.results,calls,prepareMollie:args=>prepareFundingAdmission(env,{...args,network:network(),now:Date.now()})};
}
