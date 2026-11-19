// Private operator API, deliberately NOT a fetch handler or production route.
// It never provides video, media, Fal or Mollie operations.
import {createGooglePlayCommerce,GOOGLE_PLAY_RTND_PATH} from './google-play-commerce.mjs';
import {prepareGooglePlayLicenseTestFunding} from './google-play-license-test-funding.mjs';
import {googlePlayFinancialDecision} from './google-play-financial.mjs';
import {orderForGooglePlayProof} from './google-play-publisher.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const USER=/^u-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ORIGIN='https://rig-license-test.invalid',BASE='/api/payments/google-play';
const failed=code=>Object.assign(Error('De geïsoleerde Google Play-licentietest is niet beschikbaar.'),{code});
const amount=m=>BigInt(m.units)*1000000000n+BigInt(m.nanos);

export function googlePlayLicenseFinancialDecision(proof,input){
 const o=orderForGooglePlayProof(proof);
 if(input?.mode!=='test'||o.mode!=='test')throw failed('play_license_finance');
 const result=googlePlayFinancialDecision(proof,input);
 if(result.state==='reversed'||result.state==='review')return result;
 // A real Google license purchase can report zero paid/net value. Test-wallet
 // credit is funded ONLY by the separate, bounded test-policy SQL branch.
 if(!o.developerRevenueInBuyerCurrency||amount(o.total)<0n||amount(o.lineTotal)!==amount(o.total)||amount(o.developerRevenueInBuyerCurrency)<0n||amount(o.developerRevenueInBuyerCurrency)>amount(o.total)||o.tax&&(amount(o.tax)<0n||amount(o.tax)>amount(o.total)))return {state:'review',record:result.record};
 return {state:'credit',record:Object.freeze({...result.record,licenseTest:true})};
}

export function createGooglePlayLicenseTestHarness({testDB,testDatabaseId,productionDatabaseId,allowedUserIds,providerEnv,network,clock=Date.now,adapters,limiter}={}){
 if(typeof testDB?.prepare!=='function'||typeof testDB?.batch!=='function'||!UUID.test(testDatabaseId||'')||!UUID.test(productionDatabaseId||'')||testDatabaseId===productionDatabaseId||!Array.isArray(allowedUserIds)||allowedUserIds.length<1||allowedUserIds.length>5||new Set(allowedUserIds).size!==allowedUserIds.length||allowedUserIds.some(user=>!USER.test(user))||typeof network!=='function'||typeof clock!=='function'||!providerEnv||typeof providerEnv!=='object'||Array.isArray(providerEnv)||['DB','PRODUCTION_DB','FAL_KEY','MOLLIE_LIVE_API_KEY','MOLLIE_API_KEY'].some(key=>Object.hasOwn(providerEnv,key)))throw failed('play_license_setup');
 const allowed=new Set(allowedUserIds);
 async function guard(userId=null){
  if(userId!==null&&!allowed.has(userId))throw failed('play_license_operator');
  if((await testDB.prepare('SELECT mode FROM rig_payment_environment WHERE id=1').first())?.mode!=='test')throw failed('play_license_isolation');
  const policy=await testDB.prepare('SELECT * FROM rig_google_play_test_policy WHERE id=1').first();let users;
  try{users=JSON.parse(policy?.allowed_users_json)}catch{throw failed('play_license_policy')}
  if(policy?.enabled!==1||!Number.isSafeInteger(policy.budget_credit_cents)||policy.budget_credit_cents<500||policy.budget_credit_cents>10000||!Number.isSafeInteger(policy.expires_at)||policy.expires_at<=clock()||!Array.isArray(users)||users.length<1||users.length>32||users.some(user=>!USER.test(user))||userId!==null&&!users.includes(userId))throw failed('play_license_policy');
 }
 // The .invalid origin is an internal Request namespace; no DNS lookup or
 // public website is created. Credentials are consulted only after isolation.
 let env;
 function environment(){return env??={...providerEnv,RIG_PRODUCTION_BRIDGE_ORIGIN:ORIGIN,RIG_GOOGLE_PLAY_PUBSUB_AUDIENCE:ORIGIN+GOOGLE_PLAY_RTND_PATH};}
 const commerce=createGooglePlayCommerce({mode:'test',network,clock,adapters,...(limiter?{limiter}:{}),financialDecision:googlePlayLicenseFinancialDecision,
  tenant:async()=>{await guard();return {DB:testDB,RIG_PUBLIC_ORIGIN:ORIGIN};},
  funding:async()=>{await guard();return prepareGooglePlayLicenseTestFunding({DB:testDB,now:clock()});}});
 async function request({userId,path,method='GET',body}={}){
  await guard(userId);
  const get=method==='GET'&&(path===BASE+'/config'||path===BASE+'/status'||typeof path==='string'&&new RegExp('^'+BASE+'/status\\?intentId='+UUID.source.slice(1,-1)+'$').test(path));
  const post=method==='POST'&&[BASE+'/intents',BASE+'/confirm'].includes(path);
  if(!get&&!post||get&&body!==undefined||post&&(!body||typeof body!=='object'||Array.isArray(body)))throw failed('play_license_path');
  const encoded=post?JSON.stringify(body):undefined;if(encoded&&new TextEncoder().encode(encoded).length>8192)throw failed('play_license_path');
  return commerce.handleUser(new Request(ORIGIN+path,{method,headers:{origin:ORIGIN,...(post?{'content-type':'application/json'}:{})},...(post?{body:encoded}:{})}),environment(),{userId});
 }
 async function collect(options){await guard();return commerce.collect(environment(),options);}
 return Object.freeze({request,collect,testDatabaseId,mode:'test'});
}
