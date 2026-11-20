// Synthetic billing replies only. No real account, credential or provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {handleNativeProviderBalance} from './native-provider-balance.mjs';
import {handleNativeApi,nativeApiPath,nativePath} from './native-api.mjs';
const SITE='https://rig-motion-studio.shortcutcomputerguy.chatgpt.site',BRIDGE='https://rig-api.shortcut-computerguy.workers.dev',PROJECT='appgprj_6aeec13b50448191b88da670dac8aa98';
const OWNER='u-12345678-1234-4123-8123-123456789abc',CUSTOMER='u-22345678-1234-4123-8123-123456789abc',NOW=Date.parse('2026-11-20T15:00:00Z');
const KEY='fixture-only-billing-key',ACCOUNT='fixture-only-account',TOKEN='rig_native_'+'n'.repeat(43);
const finance={id:1,version:'fixture-v1',eur_per_usd_micros:1000000,provider_vat_bps:2100,payment_fee_bps:500,failure_buffer_bps:1000,preparation_cents:10,min_margin_bps:3500,daily_provider_limit_usd_micros:10000000,min_price_cents:75,min_pro_price_cents:100};
function fixture({balance=9.37,response,maxAge=60000}={}){
 const state={reads:0,queries:[],balance,response,nativeUser:OWNER,policy:{id:1,enabled:1,version:'fixture-funding',expected_username:ACCOUNT,buffer_usd_micros:6000000,max_snapshot_age_ms:maxAge}};
 const db={batch(){throw Error('Balance display cannot write money');},prepare(sql){state.queries.push(sql);return {bind(){return this;},async first(){
  if(sql.includes('rig_native_sessions'))return {user_id:state.nativeUser,site_id:PROJECT,subject_hash:'a'.repeat(64),expires_at:Date.now()+60000};
  if(sql.includes('rig_production_tenant'))return {environment_id:'balance-fixture',mode:'live',site_id:PROJECT,site_origin:SITE,bridge_origin:BRIDGE,mollie_profile:'pfl_FIXTURE',webhook_url:BRIDGE+'/api/payments/webhook'};
  if(sql.includes('rig_payment_environment'))return {mode:'live'};
  if(sql.startsWith('INSERT INTO rig_rate_limits'))return {requests:1};
  if(sql.includes('rig_funding_policy'))return state.policy;
  if(sql.includes('rig_finance_policy'))return finance;
  if(sql.includes('rig_funding_exposure'))return {positive_wallet_cents:0,held_retail_cents:0,payable_order_cents:0,provider_reserved_usd_micros:0,wallet_type:'integer',held_type:'integer',orders_type:'integer',provider_type:'integer'};
  throw Error('Unexpected database operation');
 }}}};
 const env={DB:{},PRODUCTION_DB:db,RIG_PRIVATE_SERVICE_ONLY:'yes',RIG_PRODUCTION_PAYMENTS_ENABLED:'yes',MOLLIE_LIVE_API_KEY:'live_FIXTURE',RIG_PRODUCTION_MOLLIE_PROFILE:'pfl_FIXTURE',RIG_PRODUCTION_ENVIRONMENT_ID:'balance-fixture',RIG_PRODUCTION_SITE_ID:PROJECT,RIG_PRODUCTION_SITE_ORIGIN:SITE,RIG_PRODUCTION_BRIDGE_ORIGIN:BRIDGE,RIG_PRODUCTION_WEBHOOK_URL:BRIDGE+'/api/payments/webhook',RIG_PRODUCTION_PACKAGES:'[]',RIG_PRODUCTION_OWNER_USER_ID:OWNER,RIG_FUNDING_COVERAGE_ENABLED:'yes',FAL_KEY:KEY,RIG_GOOGLE_PLAY_SALES_ENABLED:'no'};
 const network=async(url,options)=>{state.reads++;assert.equal(url,'https://api.fal.ai/v1/account/billing?expand=credits');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');assert.equal(options.body,undefined);assert.equal(new Headers(options.headers).get('Authorization'),'Key '+env.FAL_KEY);return state.response?state.response():Response.json({username:ACCOUNT,credits:{current_balance:state.balance,currency:'USD'}});};
 const request=(path='/api/native/provider-balance',method='GET',headers={})=>new Request(BRIDGE+path,{method,headers});
 const read=({userId=OWNER,now=NOW,req=request()}={})=>handleNativeProviderBalance(req,env,{userId,network,now});
 return {state,db,env,network,request,read};
}
const safeUnavailable=async response=>{assert.equal(response.status,503);const body=await response.json();assert.equal(body.code,'provider_balance_unavailable');assert.deepEqual(Object.keys(body).sort(),['code','error']);assert.doesNotMatch(JSON.stringify(body),new RegExp(KEY+'|'+ACCOUNT+'|https?://|headroom|refill|limit|Authorization'));};

test('owner pin rejects every non-owner before any database, cache or Fal access',async()=>{
 const f=fixture();for(const userId of [undefined,CUSTOMER,'owner',OWNER.toUpperCase()]){
  const response=await handleNativeProviderBalance(f.request(),f.env,{userId,network:f.network,now:NOW});assert.equal(response.status,403);
 }
 f.env.RIG_PRODUCTION_OWNER_USER_ID='not-a-server-pin';assert.equal((await f.read()).status,403);assert.equal(f.state.reads,0);assert.equal(f.state.queries.length,0);
});

test('owner sees actual wallet USD, independent of new sales, without headroom, limits or account details',async()=>{
 const f=fixture(),response=await f.read();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(await response.json(),{availableUsdMicros:9370000,currency:'USD',fetchedAt:NOW,expiresAt:NOW+60000});assert.equal(f.state.reads,1);
 assert.ok(f.state.queries.every(sql=>sql.startsWith('SELECT ')||sql.startsWith('INSERT INTO rig_rate_limits')),'Only existing rate metadata may be written');
 const zero=fixture({balance:0});const z=await zero.read();assert.equal(z.status,200);assert.equal((await z.json()).availableUsdMicros,0,'Actual validated zero is permitted even when funding headroom is insufficient');
 const limited=fixture({maxAge:5000});assert.equal((await(await limited.read()).json()).expiresAt,NOW+5000,'Existing shorter freshness bound remains mandatory');
});

test('narrow native route is GET-only with no browser, query, owner parameter or broader finance path',async()=>{
 assert.equal(nativeApiPath('/api/native/provider-balance','GET'),'/api/provider-balance');assert.equal(nativePath('/api/native/provider-balance','GET'),true);
 for(const [path,method]of [['/api/native/provider-balance','POST'],['/api/native/provider-balance?userId='+OWNER,'GET'],['/api/native/provider-balance/','GET'],['/api/native/owner/finance/funding','GET']])assert.equal(nativePath(path,method),false);
 const f=fixture();for(const req of [f.request('/api/native/provider-balance?userId='+OWNER),f.request('/api/native/provider-balance','POST'),f.request('/api/native/provider-balance','GET',{origin:SITE})])assert.equal((await f.read({req})).status,404);assert.equal(f.state.reads,0);
});

test('existing validated cache deduplicates reads and is bound to key/account/policy, never shared with customers',async()=>{
 const f=fixture();const first=await f.read(),again=await f.read({now:NOW+1000});assert.equal(first.status,200);assert.equal(again.status,200);assert.equal(f.state.reads,1);assert.equal((await again.json()).fetchedAt,NOW);
 assert.equal((await f.read({userId:CUSTOMER})).status,403);assert.equal(f.state.reads,1);
 f.env.FAL_KEY='rotated-fixture-key';assert.equal((await f.read({now:NOW+2000})).status,200);assert.equal(f.state.reads,2,'A changed key cannot reuse the previous wallet observation');
 f.state.policy={...f.state.policy,expected_username:'another-account'};await safeUnavailable(await f.read({now:NOW+3000}));assert.equal(f.state.reads,3,'A changed account pin cannot reuse an old balance');
 const concurrent=fixture();const pair=await Promise.all([concurrent.read(),concurrent.read()]);assert.ok(pair.every(r=>r.status===200));assert.equal(concurrent.state.reads,1);
});

test('expired, wrong-account, wrong-currency and malformed readings show honest unavailable with no stale or zero fallback',async()=>{
 for(const response of [()=>Response.json({username:'wrong',credits:{current_balance:9.37,currency:'USD'}}),()=>Response.json({username:ACCOUNT,credits:{current_balance:9.37,currency:'EUR'}}),()=>Response.json({username:ACCOUNT,credits:{current_balance:'9.37',currency:'USD'}}),()=>Response.json({username:ACCOUNT,credits:{current_balance:-1,currency:'USD'}}),()=>Response.json({error:KEY+' '+ACCOUNT},{status:403}),()=>{throw Error(KEY+' '+ACCOUNT);},()=>Response.json({padding:'x'.repeat(17000)})]){const f=fixture({response});await safeUnavailable(await f.read());}
 const stale=fixture();assert.equal((await stale.read()).status,200);stale.state.response=()=>{throw Error('provider unavailable');};await safeUnavailable(await stale.read({now:NOW+60000}));assert.equal(stale.state.reads,2);
 const missing=fixture();delete missing.env.FAL_KEY;await safeUnavailable(await missing.read());assert.equal(missing.state.reads,0);
});

test('native API authenticates first, uses the server identity, and never dispatches a finance or identity override',async()=>{
 const f=fixture(),options={db:f.db,network:f.network,dispatch:async()=>{throw Error('Provider balance is not a broad finance relay');}};
 assert.equal((await handleNativeApi(f.request(),f.env,options)).status,401);assert.equal(f.state.reads,0);
 f.state.nativeUser=CUSTOMER;const forged=f.request('/api/native/provider-balance','GET',{authorization:'Bearer '+TOKEN,'oai-authenticated-user-id':OWNER,'x-rig-owner':'yes'});assert.equal((await handleNativeApi(forged,f.env,options)).status,403);assert.equal(f.state.reads,0);
 f.state.nativeUser=OWNER;const response=await handleNativeApi(f.request('/api/native/provider-balance','GET',{authorization:'Bearer '+TOKEN}),f.env,options);assert.equal(response.status,200);assert.equal((await response.json()).availableUsdMicros,9370000);assert.equal(f.state.reads,1);
});
